import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateKeyMemory, PublicAccountCache, powershellError } from "./keychain";
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

/** Counts reads, because each real read starts a keychain tool (a ~2 s PowerShell on Windows). */
class CountingSecrets extends FakeSecrets {
  reads: string[] = [];
  get(account: string) {
    this.reads.push(account);
    return super.get(account);
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

  it("names the install command for apt and dnf when secret-tool is missing", () => {
    const store = osSecretStore("perfect-planner-test", "linux", () => null);
    const state = store.state();
    expect(state.available).toBe(false);
    expect(state.reason).toContain("sudo apt install libsecret-tools");
    expect(state.reason).toContain("sudo dnf install libsecret");
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

/**
 * Linux stand-ins for Windows PowerShell. They only imitate how powershell.exe ends (exit code, stdout,
 * stderr) and read the real script it is given; they cannot run the WinRT Credential Locker. The
 * windows-latest keychain-ci job is the real proof.
 */
describe("the Windows vault through a stand-in powershell", () => {
  const clixml = (text: string) => `#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64></MS></Obj><S S="Error">${text}</S></Objs>`;

  /** mode "ok": a working vault kept in a file; "missing-key": get finds nothing; otherwise exit 1 with `stderr`. */
  function standIn(behaviour: { exit?: number; stderr?: string; okNoise?: string }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ps-"));
    const tool = path.join(dir, "powershell");
    const data = path.join(dir, "secret");
    const scripts = path.join(dir, "scripts");
    fs.writeFileSync(
      tool,
      `#!${process.execPath}
const fs = require("fs");
const b = ${JSON.stringify(behaviour)};
const script = Buffer.from(process.argv[process.argv.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
fs.appendFileSync(${JSON.stringify(scripts)}, script + "\\n=====\\n");
const input = fs.readFileSync(0, "utf8");
if (b.exit) { process.stderr.write(b.stderr || ""); process.exit(b.exit); }
if (b.okNoise) process.stderr.write(b.okNoise);
if (script.includes("RetrievePassword")) process.stdout.write(fs.existsSync(${JSON.stringify(data)}) ? "found:" + fs.readFileSync(${JSON.stringify(data)}, "utf8") : "missing");
else if (script.includes("Vault.Add") || script.includes("vault.Add")) fs.writeFileSync(${JSON.stringify(data)}, input.trim());
else if (fs.existsSync(${JSON.stringify(data)})) fs.unlinkSync(${JSON.stringify(data)});
`,
    );
    fs.chmodSync(tool, 0o755);
    return {
      store: osSecretStore("perfect-planner-test", "win32", () => tool),
      scripts: () => fs.readFileSync(scripts, "utf8"),
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  it.skipIf(process.platform === "win32")("shows the decoded error, not '#< CLIXML', when PowerShell exits 1", () => {
    const t = standIn({ exit: 1, stderr: clixml("Element not found._x000D__x000A_") });
    try {
      const state = t.store.state();
      expect(state).toMatchObject({ available: false, reason: expect.stringContaining("Element not found") });
      expect((state as { reason: string }).reason).not.toContain("CLIXML");
      expect(() => t.store.get("k")).toThrow(/Element not found/);
    } finally {
      t.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("tolerates stderr noise when PowerShell exits 0", () => {
    const t = standIn({ okNoise: clixml("ignored") });
    try {
      expect(t.store.state()).toEqual({ available: true });
      t.store.set("k", "v");
      expect(t.store.get("k")).toBe("v");
    } finally {
      t.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("treats a never-saved key as missing while the vault stays available", () => {
    const t = standIn({});
    try {
      expect(t.store.get("never-saved")).toBeUndefined();
      expect(t.store.state()).toEqual({ available: true });
    } finally {
      t.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("sends a script that looks for not-found down the inner-exception chain and silences progress", () => {
    const t = standIn({});
    try {
      t.store.get("k");
      const script = t.scripts();
      expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
      expect(script).toContain("-2147023728");
      expect(script).toContain("$e = $e.InnerException");
      expect(script).toContain("if (Test-NotFound $_.Exception) { $null } else { throw }");
    } finally {
      t.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("reads any other failure as unavailable, never as a missing key", () => {
    const t = standIn({ exit: 1, stderr: clixml("Access is denied._x000D__x000A_") });
    try {
      expect(t.store.state()).toMatchObject({ available: false, reason: expect.stringContaining("Access is denied") });
      expect(() => t.store.get("k")).toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("powershellError decodes CLIXML error text and passes plain text through", () => {
    expect(powershellError(clixml("a &lt;b&gt; &amp; c_x000D__x000A_d"))).toBe("a <b> & c\nd");
    expect(powershellError("plain failure")).toBe("plain failure");
    expect(powershellError("#< CLIXML\n<Objs></Objs>")).toBe("PowerShell reported an error");
  });
});

describe("PublicAccountCache", () => {
  it("reads the keychain once per key, not once per signed write", () => {
    const secrets = new CountingSecrets();
    const keys = new KeychainKeyProvider(secrets);
    keys.ensureKey("person:owner");
    keys.ensureKey("system");
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { keys });
    ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Warm up" });
    secrets.reads = [];
    for (let i = 2; i <= 11; i++) ledger.append({ actor: owner, type: "task.created", subject: `T-${i}`, summary: "Task" });
    ledger.close();
    expect(secrets.reads).toEqual([]);
    expect(secrets.reads.filter((a) => !a.startsWith("private."))).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("the public cache itself never remembers a private key", () => {
    const secrets = new CountingSecrets();
    const cache = new PublicAccountCache(secrets);
    secrets.set("private.system", "k");
    cache.get("private.system");
    cache.get("private.system");
    expect(secrets.reads).toEqual(["private.system", "private.system"]);
  });

  it("drops an entry on its own write or remove, and after the TTL", () => {
    const secrets = new CountingSecrets();
    let now = 0;
    const cache = new PublicAccountCache(secrets, 1000, () => now);
    expect(cache.get("pins")).toBeUndefined();
    expect(cache.get("pins")).toBeUndefined();
    expect(secrets.reads).toEqual(["pins"]);
    cache.set("pins", "[]");
    expect(cache.get("pins")).toBe("[]");
    cache.remove("pins");
    expect(cache.get("pins")).toBeUndefined();
    secrets.values.set("pins", "changed elsewhere");
    expect(cache.get("pins")).toBeUndefined();
    now = 1000;
    expect(cache.get("pins")).toBe("changed elsewhere");
  });

  it("two instances over one keychain: after one rotates, the other still signs with a matching key id", () => {
    const secrets = new FakeSecrets();
    const a = new KeychainKeyProvider(secrets);
    const b = new KeychainKeyProvider(secrets);
    a.ensureKey("person:owner");
    b.trustedKeys(); // b has now remembered the old public record
    const rotated = a.rotateKey("person:owner");
    const signed = b.sign("person:owner", Buffer.from("x"));
    expect(signed.keyId).toBe(rotated.keyId);
  });

  it("does not remember a failed read as missing", () => {
    let fail = true;
    const store: SecretStore = {
      description: "flaky",
      state: () => ({ available: true }),
      get: () => {
        if (fail) throw new Error("PowerShell failed");
        return "[]";
      },
      set: () => {},
      remove: () => {},
    };
    const cache = new PublicAccountCache(store);
    expect(() => cache.get("pins")).toThrow("PowerShell failed");
    fail = false;
    expect(cache.get("pins")).toBe("[]");
  });

  it("after this instance rotates, it signs with the new key and a matching id", () => {
    const keys = new KeychainKeyProvider(new FakeSecrets());
    keys.ensureKey("person:owner");
    keys.sign("person:owner", Buffer.from("x")); // remembers the first private key
    const rotated = keys.rotateKey("person:owner");
    expect(keys.sign("person:owner", Buffer.from("y")).keyId).toBe(rotated.keyId);
  });
});

describe("PrivateKeyMemory", () => {
  it("reads a private key once, and drops it on its own write, remove or forget; other accounts pass through", () => {
    const secrets = new CountingSecrets();
    const memory = new PrivateKeyMemory(secrets);
    secrets.set("private.system", "k1");
    secrets.set("pins", "[]");
    expect(memory.get("private.system")).toBe("k1");
    expect(memory.get("private.system")).toBe("k1");
    expect(secrets.reads).toEqual(["private.system"]);
    memory.set("private.system", "k2");
    expect(memory.get("private.system")).toBe("k2");
    memory.forget("private.system");
    memory.get("private.system");
    memory.remove("private.system");
    expect(memory.get("private.system")).toBeUndefined();
    memory.get("pins");
    memory.get("pins");
    expect(secrets.reads.filter((a) => a === "pins")).toHaveLength(2);
  });

  it("does not remember a missing key", () => {
    const secrets = new CountingSecrets();
    const memory = new PrivateKeyMemory(secrets);
    expect(memory.get("private.system")).toBeUndefined();
    secrets.values.set("private.system", "late");
    expect(memory.get("private.system")).toBe("late");
  });
});
