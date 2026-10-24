import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { keyStoreTool, type KeyStoreTool } from "../exec";
import { keyIdOf, newKeyPair, signWith, type KeyProvider, type KeyState, type TrustedKey } from "./signing";

/**
 * A small secret store backed by the operating system's keychain: Windows
 * Credential Locker (PasswordVault, through Windows PowerShell), the macOS
 * login keychain (`security`) and the Linux Secret Service (`secret-tool`).
 * Secrets go to the tool on stdin, never on a command line, and are never
 * logged or written anywhere else. Each tool is started by its absolute path
 * (core/exec keyStoreTool), never by bare name.
 */
export interface SecretStore {
  readonly description: string;
  state(): KeyState;
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  remove(account: string): void;
}

const TIMEOUT = 20_000;

/** Finds a key-store helper's absolute path; null when it is not installed. */
export type ToolLocator = (tool: KeyStoreTool) => string | null;

export function osSecretStore(service = "perfect-planner", platform: NodeJS.Platform = process.platform, locate: ToolLocator = (tool) => keyStoreTool(tool, { platform })): SecretStore {
  const tool = (name: KeyStoreTool) => (args: string[], options?: RunOptions) => run(name, locate(name), args, options);
  if (platform === "win32") return new WindowsVault(service, tool("powershell"));
  if (platform === "darwin") return new MacKeychain(service, tool("security"));
  if (platform === "linux") return new SecretTool(service, tool("secret-tool"));
  return new Unavailable(`there is no supported keychain on ${platform}`);
}

/** Account names are ASCII-safe so no tool has to quote them. */
function account(name: string): string {
  return name.replace(/[^A-Za-z0-9._:@-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
const decode = (value: string) => Buffer.from(value.trim(), "base64").toString("utf8");

type RunOptions = { input?: string; env?: Record<string, string> };
type RunResult = { status: number; stdout: string; stderr: string };
type Tool = (args: string[], options?: RunOptions) => RunResult;

function run(name: string, file: string | null, args: string[], options: RunOptions = {}): RunResult {
  if (file === null) return { status: -1, stdout: "", stderr: `${name} is not installed` };
  try {
    const stdout = execFileSync(file, args, {
      input: options.input ?? "",
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: TIMEOUT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; stderr?: string; code?: string; message: string };
    // No exit status means the tool did not run at all (not installed, timed out).
    if (e.status == null) {
      return { status: -1, stdout: "", stderr: e.code === "ENOENT" ? `${name} is not installed` : `${name}: ${e.code ?? firstLine(e.message)}` };
    }
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Writes, reads back and removes a probe secret once; any failure makes the store unavailable. */
abstract class ProbedStore implements SecretStore {
  abstract readonly description: string;
  private probed?: KeyState;

  state(): KeyState {
    if (!this.probed) {
      try {
        const probe = `probe-${process.pid}-${Date.now()}`;
        this.set("probe", probe);
        const back = this.get("probe");
        this.remove("probe");
        this.probed = back === probe ? { available: true } : { available: false, reason: `${this.description} did not return what was stored` };
      } catch (error) {
        const message = firstLine((error as Error).message);
        const help = / is not installed$/.test(message) ? this.missingHelp() : "";
        this.probed = { available: false, reason: `${this.description} is not usable here: ${message}${help}` };
      }
    }
    return this.probed;
  }

  /** Plain-words next step, appended when the helper program is missing. */
  protected missingHelp(): string {
    return "";
  }

  abstract get(account: string): string | undefined;
  abstract set(account: string, value: string): void;
  abstract remove(account: string): void;
}

function firstLine(text: string): string {
  return String(text).trim().split(/\r?\n/)[0].slice(0, 200);
}

class MacKeychain extends ProbedStore {
  readonly description = "the macOS keychain";
  constructor(
    private readonly service: string,
    private readonly run: Tool,
  ) {
    super();
  }

  get(name: string): string | undefined {
    const result = this.run(["find-generic-password", "-s", this.service, "-a", account(name), "-w"]);
    if (result.status === 44) return undefined;
    if (result.status !== 0) throw new Error(firstLine(result.stderr));
    return decode(result.stdout);
  }

  set(name: string, value: string): void {
    // `security -i` reads the command from stdin, so the secret is not on a command line.
    const result = this.run(["-i"], { input: `add-generic-password -U -s ${this.service} -a ${account(name)} -w ${encode(value)}\n` });
    if (result.status !== 0 || /error|fail/i.test(result.stderr)) throw new Error(firstLine(result.stderr) || "security add-generic-password failed");
    if (this.get(name) !== value) throw new Error("the keychain did not keep the value");
  }

  remove(name: string): void {
    const result = this.run(["delete-generic-password", "-s", this.service, "-a", account(name)]);
    if (result.status !== 0 && result.status !== 44) throw new Error(firstLine(result.stderr));
  }
}

/** The exact commands that install `secret-tool` (Debian/Ubuntu libsecret-tools; Fedora libsecret). */
export const SECRET_TOOL_INSTALL = { apt: "sudo apt install libsecret-tools", dnf: "sudo dnf install libsecret" } as const;

class SecretTool extends ProbedStore {
  readonly description = "the Secret Service (secret-tool)";
  constructor(
    private readonly service: string,
    private readonly run: Tool,
  ) {
    super();
  }

  protected missingHelp(): string {
    return ` To fix it, install it and restart Perfect Planner. Ubuntu or Debian: ${SECRET_TOOL_INSTALL.apt}. Fedora: ${SECRET_TOOL_INSTALL.dnf}.`;
  }

  get(name: string): string | undefined {
    const result = this.run(["lookup", "service", this.service, "account", account(name)]);
    if (result.status !== 0) {
      // Not found exits 1 with nothing on stderr; anything else is a real error.
      if (result.status === 1 && result.stderr.trim() === "") return undefined;
      throw new Error(firstLine(result.stderr) || `secret-tool exited ${result.status}`);
    }
    return result.stdout.trim() === "" ? undefined : decode(result.stdout);
  }

  set(name: string, value: string): void {
    const result = this.run(["store", "--label", `Perfect Planner ${name}`, "service", this.service, "account", account(name)], {
      input: encode(value),
    });
    if (result.status !== 0) throw new Error(firstLine(result.stderr) || "secret-tool store failed");
  }

  remove(name: string): void {
    const result = this.run(["clear", "service", this.service, "account", account(name)]);
    if (result.status !== 0 && result.stderr.trim() !== "") throw new Error(firstLine(result.stderr));
  }
}

/**
 * Windows Credential Locker through Windows PowerShell 5.1 (always present on
 * Windows 10 and 11; PowerShell 7 cannot load the WinRT type). Names go in
 * environment variables, the secret on stdin.
 */
class WindowsVault extends ProbedStore {
  readonly description = "Windows Credential Locker";
  constructor(
    private readonly service: string,
    private readonly run: Tool,
  ) {
    super();
  }

  private ps(body: string, name: string, input?: string): string {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]",
      "$vault = New-Object Windows.Security.Credentials.PasswordVault",
      "function Find-Item { try { @($vault.FindAllByResource($env:PP_RESOURCE)) | Where-Object { $_.UserName -eq $env:PP_ACCOUNT } | Select-Object -First 1 } catch { if ($_.Exception.HResult -eq -2147023728) { $null } else { throw } } }",
      body,
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = this.run(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      input,
      env: { PP_RESOURCE: this.service, PP_ACCOUNT: account(name) },
    });
    if (result.status !== 0) throw new Error(firstLine(result.stderr) || "PowerShell failed");
    return result.stdout;
  }

  get(name: string): string | undefined {
    const out = this.ps("$c = Find-Item; if ($c) { $c.RetrievePassword(); [Console]::Out.Write('found:' + $c.Password) } else { [Console]::Out.Write('missing') }", name);
    return out.startsWith("found:") ? decode(out.slice("found:".length)) : undefined;
  }

  set(name: string, value: string): void {
    this.ps(
      [
        "$secret = [Console]::In.ReadToEnd().Trim()",
        "$old = Find-Item; if ($old) { $vault.Remove($old) }",
        "$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($env:PP_RESOURCE, $env:PP_ACCOUNT, $secret)))",
      ].join("\n"),
      name,
      encode(value),
    );
    if (this.get(name) !== value) throw new Error("the Credential Locker did not keep the value");
  }

  remove(name: string): void {
    this.ps("$old = Find-Item; if ($old) { $vault.Remove($old) }", name);
  }
}

class Unavailable implements SecretStore {
  readonly description = "no keychain";
  constructor(private readonly reason: string) {}
  state(): KeyState {
    return { available: false, reason: this.reason };
  }
  get(): string | undefined {
    throw new Error(this.reason);
  }
  set(): void {
    throw new Error(this.reason);
  }
  remove(): void {
    throw new Error(this.reason);
  }
}

/**
 * Keeps each private signing key in this process's memory after its first read, so signing does not
 * start a keychain tool (a ~2 s PowerShell on Windows) for every entry. Memory only: never written,
 * logged or returned, and gone when the process ends. Own writes and removes drop the entry, and
 * `forget` drops it on demand (the provider does when the public record shows another instance rotated the key).
 */
export class PrivateKeyMemory implements SecretStore {
  private readonly keys = new Map<string, string>();
  readonly description: string;

  constructor(private readonly inner: SecretStore) {
    this.description = inner.description;
  }

  state(): KeyState {
    return this.inner.state();
  }

  get(name: string): string | undefined {
    if (!name.startsWith("private.")) return this.inner.get(name);
    const kept = this.keys.get(name);
    if (kept !== undefined) return kept;
    const value = this.inner.get(name);
    if (value !== undefined) this.keys.set(name, value);
    return value;
  }

  set(name: string, value: string): void {
    this.keys.delete(name);
    this.inner.set(name, value);
  }

  remove(name: string): void {
    this.keys.delete(name);
    this.inner.remove(name);
  }

  forget(name: string): void {
    this.keys.delete(name);
  }
}

/** Accounts that hold only public data: the principal list, pinned public keys and each principal's public keys. */
const isPublicAccount = (name: string) => name === "principals" || name === "pins" || name.startsWith("public.");

/**
 * Remembers the public accounts for a few seconds, so verifying or signing one ledger entry does not
 * start a keychain tool (a PowerShell process on Windows, 2 to 3 seconds each) for every lookup.
 * Private keys are never remembered here: they are read from the store each time they sign. Own
 * writes drop the entry, and the TTL (10 s) bounds how stale a change made by another process can be.
 */
export class PublicAccountCache implements SecretStore {
  private readonly seen = new Map<string, { at: number; value: string | undefined }>();
  readonly description: string;

  constructor(
    private readonly inner: SecretStore,
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    this.description = inner.description;
  }

  state(): KeyState {
    return this.inner.state();
  }

  get(name: string): string | undefined {
    if (!isPublicAccount(name)) return this.inner.get(name);
    const hit = this.seen.get(name);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = this.inner.get(name);
    this.seen.set(name, { at: this.now(), value });
    return value;
  }

  set(name: string, value: string): void {
    this.seen.delete(name);
    this.inner.set(name, value);
  }

  remove(name: string): void {
    this.seen.delete(name);
    this.inner.remove(name);
  }
}

/**
 * Signing keys in the OS keychain: one Ed25519 key per principal
 * ("person:<id>", or "system" for the gate and watcher). The private key is
 * read from the keychain only to sign and is never returned, logged or
 * written anywhere else. When the keychain is unavailable nothing is signed
 * and `state()` says why.
 */
export class KeychainKeyProvider implements KeyProvider {
  readonly description: string;
  private readonly store: SecretStore;
  private readonly memory: PrivateKeyMemory;

  constructor(store: SecretStore = osSecretStore()) {
    this.memory = new PrivateKeyMemory(store);
    this.store = new PublicAccountCache(this.memory);
    this.description = store.description;
  }

  state(): KeyState {
    return this.store.state();
  }

  trustedKeys(): TrustedKey[] {
    if (!this.state().available) return [];
    return [...this.principals().flatMap((principal) => this.publicKeys(principal)), ...this.pins()];
  }

  signingKeys(): TrustedKey[] {
    if (!this.state().available) return [];
    return this.principals().flatMap((principal) => this.publicKeys(principal).filter((k) => !k.retired));
  }

  /**
   * Trusts someone else's public key on this device only (the owner's key on
   * a helper's device), after the person checked its fingerprint.
   */
  pinKey(key: TrustedKey): void {
    this.requireAvailable();
    if (keyIdOf(key.publicKey) !== key.keyId || !/^(person:.+|system)$/.test(key.principal)) throw new RangeError("not a valid key");
    const pins = this.pins().filter((k) => k.keyId !== key.keyId);
    this.store.set("pins", JSON.stringify([...pins, { keyId: key.keyId, principal: key.principal, publicKey: key.publicKey }]));
  }

  /** The principal's active key, made on first call. A person action in the app, never an agent's. */
  ensureKey(principal: string): TrustedKey {
    this.requireAvailable();
    return this.publicKeys(principal).find((k) => !k.retired) ?? this.createKey(principal);
  }

  /** Retires the active key (it still verifies what it signed) and makes a new one. */
  rotateKey(principal: string): TrustedKey {
    this.requireAvailable();
    const keys = this.publicKeys(principal).map((k) => ({ ...k, retired: true }));
    this.writePublic(principal, keys);
    return this.createKey(principal);
  }

  /** A new key that does not sign yet; see KeyProvider.stageKey. */
  stageKey(principal: string): TrustedKey {
    this.requireAvailable();
    if (!/^(person:.+|system)$/.test(principal)) throw new RangeError(`not a principal: ${principal}`);
    const pair = newKeyPair();
    this.store.set(`staged.${principal}`, pair.privateKey);
    return { keyId: keyIdOf(pair.publicKey), principal, publicKey: pair.publicKey };
  }

  activateKey(principal: string, keyId: string): void {
    this.requireAvailable();
    const privateKey = this.store.get(`staged.${principal}`);
    if (!privateKey) throw new Error(`no staged key for ${principal}`);
    const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }))
      .export({ format: "der", type: "spki" })
      .toString("base64");
    if (keyIdOf(publicKey) !== keyId) throw new Error(`the staged key for ${principal} is not ${keyId}`);
    const key: TrustedKey = { keyId, principal, publicKey };
    this.store.set(`private.${principal}`, privateKey);
    this.writePublic(principal, [...this.publicKeys(principal).map((k) => ({ ...k, retired: true })), key]);
    const principals = this.principals();
    if (!principals.includes(principal)) this.store.set("principals", JSON.stringify([...principals, principal]));
    this.store.remove(`staged.${principal}`);
  }

  discardStagedKey(principal: string): void {
    this.store.remove(`staged.${principal}`);
  }

  sign(principal: string, message: Buffer): { keyId: string; signature: string } {
    this.requireAvailable();
    const account = `private.${principal}`;
    let signer = this.signer(account, principal);
    // Another instance may have rotated the key since this one remembered it: the public record names the active key.
    const active = this.publicKeys(principal).find((k) => !k.retired);
    if (active && active.keyId !== signer.keyId) {
      this.memory.forget(account);
      signer = this.signer(account, principal);
    }
    return { keyId: signer.keyId, signature: signWith(signer.privateKey, message) };
  }

  /** The key id comes from the private key that signs, so a rotation can never pair a new signature with an old id. */
  private signer(account: string, principal: string): { privateKey: string; keyId: string } {
    const privateKey = this.store.get(account);
    if (!privateKey) throw new Error(`there is no signing key for ${principal} on this device; set one up in Settings`);
    const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }))
      .export({ format: "der", type: "spki" })
      .toString("base64");
    return { privateKey, keyId: keyIdOf(publicKey) };
  }

  /** Removes every key this provider stored; for tests and for an explicit reset by the person. */
  removeAll(): void {
    for (const principal of this.principals()) {
      this.store.remove(`staged.${principal}`);
      this.store.remove(`private.${principal}`);
      this.store.remove(`public.${principal}`);
    }
    this.store.remove("principals");
    this.store.remove("pins");
  }

  private pins(): TrustedKey[] {
    const raw = this.store.get("pins");
    if (!raw) return [];
    const list = JSON.parse(raw) as TrustedKey[];
    return Array.isArray(list) ? list.filter((k) => k && typeof k.publicKey === "string" && keyIdOf(k.publicKey) === k.keyId) : [];
  }

  private createKey(principal: string): TrustedKey {
    if (!/^(person:.+|system)$/.test(principal)) throw new RangeError(`not a principal: ${principal}`);
    const pair = newKeyPair();
    // Check the pair before storing it.
    createPublicKey(createPrivateKey({ key: Buffer.from(pair.privateKey, "base64"), format: "der", type: "pkcs8" }));
    const key: TrustedKey = { keyId: keyIdOf(pair.publicKey), principal, publicKey: pair.publicKey };
    this.store.set(`private.${principal}`, pair.privateKey);
    this.writePublic(principal, [...this.publicKeys(principal).map((k) => ({ ...k, retired: true })), key]);
    const principals = this.principals();
    if (!principals.includes(principal)) this.store.set("principals", JSON.stringify([...principals, principal]));
    return { ...key };
  }

  private principals(): string[] {
    const raw = this.store.get("principals");
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  }

  private publicKeys(principal: string): TrustedKey[] {
    const raw = this.store.get(`public.${principal}`);
    if (!raw) return [];
    const list = JSON.parse(raw) as TrustedKey[];
    return Array.isArray(list) ? list.filter((k) => k && k.principal === principal && keyIdOf(k.publicKey) === k.keyId) : [];
  }

  private writePublic(principal: string, keys: TrustedKey[]): void {
    this.store.set(`public.${principal}`, JSON.stringify(keys));
  }

  private requireAvailable(): void {
    const state = this.state();
    if (!state.available) throw new Error(state.reason ?? `${this.description} is unavailable`);
  }
}
