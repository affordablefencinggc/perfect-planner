import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore, KeychainKeyProvider, Ledger, LedgerError, isAuthoritative, osSecretStore, type SecretStore } from "./index";

/** A SecretStore in memory, so the provider's own logic is tested on every machine. */
class FakeSecrets implements SecretStore {
  readonly description = "fake secrets";
  readonly values = new Map<string, string>();
  constructor(private readonly broken?: string) {}
  state() {
    return this.broken ? { available: false, reason: this.broken } : { available: true };
  }
  get(account: string) {
    return this.values.get(account);
  }
  set(account: string, value: string) {
    this.values.set(account, value);
  }
  remove(account: string) {
    this.values.delete(account);
  }
}

const owner = { kind: "person" as const, id: "owner" };

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pp-keychain-"));
}

describe("KeychainKeyProvider", () => {
  it("makes a key on a person action, signs with it and trusts it on the next open", () => {
    const secrets = new FakeSecrets();
    const keys = new KeychainKeyProvider(secrets);
    keys.ensureKey("person:owner");
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { keys });
    ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "First task" });
    ledger.close();

    const reopened = Ledger.openSync(new FileStore(root), { keys: new KeychainKeyProvider(secrets), readOnly: true });
    expect(reopened.status.ok).toBe(true);
    expect(isAuthoritative(reopened.get("L-000001")!)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never creates a key while signing: an unset person is refused", () => {
    const keys = new KeychainKeyProvider(new FakeSecrets());
    const ledger = Ledger.openSync(new FileStore(tempRoot()), { keys });
    let error: unknown;
    try {
      ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "First task" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe("NOT_SIGNED");
    expect((error as LedgerError).message).toContain("set one up in Settings");
    expect(ledger.entries()).toHaveLength(0);
  });

  it("keeps the retired key's public half after a rotation", () => {
    const keys = new KeychainKeyProvider(new FakeSecrets());
    const first = keys.ensureKey("person:owner");
    const second = keys.rotateKey("person:owner");
    expect(keys.trustedKeys()).toEqual([{ ...first, retired: true }, second]);
    expect(keys.sign("person:owner", Buffer.from("x")).keyId).toBe(second.keyId);
    expect(keys.signingKeys()).toEqual([second]);
  });

  it("pins another person's public key on this device without being able to sign for them", () => {
    const keys = new KeychainKeyProvider(new FakeSecrets());
    const other = new KeychainKeyProvider(new FakeSecrets()).ensureKey("person:owner");
    keys.pinKey(other);
    expect(keys.trustedKeys()).toEqual([other]);
    expect(keys.signingKeys()).toEqual([]);
    expect(() => keys.sign("person:owner", Buffer.from("x"))).toThrow("no signing key");
  });

  it("rotates through the ledger so the old key vouches for the new one", () => {
    const secrets = new FakeSecrets();
    const keys = new KeychainKeyProvider(secrets);
    const first = keys.ensureKey("person:owner");
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { keys });
    ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "First task" });
    const { trusted, retired } = ledger.rotateKey(owner, "New laptop");
    expect(trusted.sig!.key).toBe(first.keyId);
    expect(retired.sig!.key).not.toBe(first.keyId);
    expect(keys.trustedKeys().find((k) => !k.retired)!.keyId).toBe(retired.sig!.key);
    expect(secrets.get("staged.person:owner")).toBeUndefined();
    expect(ledger.status.ok).toBe(true);
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses to sign when the keychain is unavailable and says why", () => {
    const keys = new KeychainKeyProvider(new FakeSecrets("No Secret Service is running"));
    expect(keys.state()).toEqual({ available: false, reason: "No Secret Service is running" });
    expect(keys.trustedKeys()).toEqual([]);
    expect(() => keys.sign("person:owner", Buffer.from("x"))).toThrow("No Secret Service is running");
  });

  it("stores no secret in a file", () => {
    const secrets = new FakeSecrets();
    const keys = new KeychainKeyProvider(secrets);
    keys.ensureKey("person:owner");
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { keys });
    ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "First task" });
    ledger.close();
    const privateKey = secrets.get("private.person:owner")!;
    const files = fs.readdirSync(path.join(root, ".perfect-planner", "ledger"));
    for (const file of files) {
      expect(fs.readFileSync(path.join(root, ".perfect-planner", "ledger", file), "utf8")).not.toContain(privateKey);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// The real OS keychain, only where CI asks for it (PP_KEYCHAIN_TEST=1), so a
// developer's own keychain is never written by a plain test run.
describe.runIf(process.env.PP_KEYCHAIN_TEST === "1")(`the real keychain on ${process.platform}`, () => {
  it("either signs and verifies with a real key, or refuses with a reason; never writes unsigned", () => {
    const keys = new KeychainKeyProvider(osSecretStore(`perfect-planner-test-${process.pid}`));
    const state = keys.state();
    console.log(`keychain on ${process.platform}: ${keys.description}: ${state.available ? "available" : `unavailable (${state.reason})`}`);
    const root = tempRoot();
    try {
      if (state.available) {
        keys.ensureKey("person:owner");
        const ledger = Ledger.openSync(new FileStore(root), { keys });
        ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Signed with the OS keychain" });
        ledger.close();
        const reopened = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
        expect(reopened.status.ok).toBe(true);
        expect(isAuthoritative(reopened.get("L-000001")!)).toBe(true);
      } else {
        expect(state.reason).toBeTruthy();
        const ledger = Ledger.openSync(new FileStore(root), { keys });
        expect(() => ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "x" })).toThrow(LedgerError);
        expect(ledger.entries()).toHaveLength(0);
        ledger.close();
      }
      if (process.env.PP_KEYCHAIN_REQUIRED === "1") expect(state).toEqual({ available: true });
    } finally {
      if (state.available) keys.removeAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("keychain helpers are started by full path", () => {
  it("is unavailable, and starts nothing, when the helper cannot be found", () => {
    const asked: string[] = [];
    const store = osSecretStore("perfect-planner-test", "linux", (tool) => (asked.push(tool), null));
    expect(store.state()).toMatchObject({ available: false, reason: expect.stringContaining("secret-tool is not installed") });
    expect(asked).toEqual(["secret-tool"]);
  });

  it.skipIf(process.platform === "win32")("runs exactly the path the locator gives", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-keytool-"));
    try {
      const marker = path.join(dir, "ran");
      const tool = path.join(dir, "tool");
      fs.writeFileSync(tool, `#!/bin/sh\necho "$1" >> '${marker}'\necho refused >&2\nexit 2\n`);
      fs.chmodSync(tool, 0o755);
      const store = osSecretStore("perfect-planner-test", "linux", () => tool);
      expect(store.state()).toMatchObject({ available: false, reason: expect.stringContaining("refused") });
      expect(fs.readFileSync(marker, "utf8")).toBe("store\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
