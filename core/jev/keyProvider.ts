// Where Jev's TypeSafe key comes from: the operating system's secure store,
// and nowhere else (spec §6.6). Settings (PR #2) saves it from a masked field;
// this provider reads it when a review is about to be sent, hands it to the
// transport for one request, and keeps no copy. It never reads the clipboard,
// the environment, the repo or the ledger.
//
// The entry is the one PR #2 writes: service/target "PerfectPlanner/JevReviewerKey",
// account "jev", value the UTF-8 key.
//   Windows: Credential Manager generic credential (CredReadW/CredWriteW via PowerShell)
//   macOS:   login keychain generic password (security)
//   Linux:   Secret Service (secret-tool, libsecret)
// No command line ever carries the key: it travels on stdin and stdout only.
import { spawn } from "node:child_process";
import { SecretKey, validateKey } from "./secret";

export const KEYCHAIN_SERVICE = "PerfectPlanner/JevReviewerKey";
export const KEYCHAIN_ACCOUNT = "jev";

export type KeyStoreName = "windows-credential-manager" | "macos-keychain" | "linux-secret-service" | "memory" | "unavailable";

export interface KeyStatus {
  available: boolean;
  stored: boolean;
  store: KeyStoreName;
  /** Why the store is unavailable, in plain words. Never contains the key. */
  detail?: string;
}

export interface JevKeyProvider {
  status(): Promise<KeyStatus>;
  /** The key, or null when none is stored. */
  read(): Promise<SecretKey | null>;
  save(key: string): Promise<KeyStatus>;
  clear(): Promise<KeyStatus>;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started (not installed). */
  missing?: boolean;
}

export type Runner = (command: string, args: string[], stdin?: string) => Promise<RunResult>;

/** Spawns without a shell, so nothing is interpreted, and writes stdin once. */
export const spawnRunner: Runner = (command, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error: NodeJS.ErrnoException) => resolve({ code: null, stdout: "", stderr: error.message, missing: error.code === "ENOENT" }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? "");
  });

export interface OsKeychainOptions {
  platform?: NodeJS.Platform;
  run?: Runner;
  /** Tests use their own entry so they never touch the real key. */
  service?: string;
}

export function createOsKeyProvider(options: OsKeychainOptions = {}): JevKeyProvider {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? spawnRunner;
  const service = options.service ?? KEYCHAIN_SERVICE;
  if (platform === "win32") return windowsProvider(run, service);
  if (platform === "darwin") return macProvider(run, service);
  if (platform === "linux") return linuxProvider(run, service);
  return unavailableProvider(`No secure key store is connected on ${platform}.`);
}

function unavailableProvider(detail: string): JevKeyProvider {
  const status: KeyStatus = { available: false, stored: false, store: "unavailable", detail };
  return {
    status: async () => status,
    read: async () => null,
    save: async () => {
      throw new Error(detail);
    },
    clear: async () => status,
  };
}

function fail(store: string, what: string, result: RunResult): never {
  // stderr from these tools names the item, never its value, but trim it hard anyway.
  const detail = result.stderr.replace(/\s+/g, " ").trim().slice(0, 160);
  throw new Error(`${store} could not ${what}${detail ? `: ${detail}` : ""}.`);
}

// ---------- Windows: Credential Manager through PowerShell P/Invoke ----------

const WIN_TYPES = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PPCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL cred, UInt32 flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
}
"@
`;

const WIN_OPS = {
  // exit 2 = not found
  status: `$p=[IntPtr]::Zero; if (-not [PPCred]::CredReadW($t,1,0,[ref]$p)) { exit 2 }; [PPCred]::CredFree($p); exit 0`,
  read: `$p=[IntPtr]::Zero; if (-not [PPCred]::CredReadW($t,1,0,[ref]$p)) { exit 2 }
try { $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][PPCred+CREDENTIAL]); $b=New-Object byte[] $c.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize); [Console]::Out.Write([Convert]::ToBase64String($b)) } finally { [PPCred]::CredFree($p) }`,
  save: `$k=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($k); $c=New-Object PPCred+CREDENTIAL
$c.Type=1; $c.TargetName=$t; $c.UserName='${KEYCHAIN_ACCOUNT}'; $c.Persist=2; $c.CredentialBlobSize=$b.Length
$c.CredentialBlob=[Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max($b.Length,1))
try { [Runtime.InteropServices.Marshal]::Copy($b,0,$c.CredentialBlob,$b.Length); if (-not [PPCred]::CredWriteW([ref]$c,0)) { exit 3 } }
finally { for ($i=0; $i -lt $b.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($c.CredentialBlob,$i,0); $b[$i]=0 }; [Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob) }`,
  // exit 2 = nothing deleted; the caller confirms with status (last-error is unreliable through PowerShell)
  clear: `if (-not [PPCred]::CredDeleteW($t,1,0)) { exit 2 }`,
} as const;

/** The full PowerShell script for one operation; exported for tests. Holds the target name only, never a key. */
export function windowsScript(op: keyof typeof WIN_OPS, service: string): string {
  const target = service.replace(/'/g, "''");
  return `$ErrorActionPreference='Stop'\n${WIN_TYPES}\n$t='${target}'\n${WIN_OPS[op]}\n`;
}

function windowsProvider(run: Runner, service: string): JevKeyProvider {
  const store: KeyStoreName = "windows-credential-manager";
  const ps = (op: keyof typeof WIN_OPS, stdin?: string) =>
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(windowsScript(op, service), "utf16le").toString("base64")], stdin);
  const status = async (): Promise<KeyStatus> => {
    const result = await ps("status");
    if (result.missing) return { available: false, stored: false, store: "unavailable", detail: "PowerShell is not available." };
    if (result.code === 0) return { available: true, stored: true, store };
    if (result.code === 2) return { available: true, stored: false, store };
    return fail("Windows Credential Manager", "be checked", result);
  };
  return {
    status,
    async read() {
      const result = await ps("read");
      if (result.code === 2 || result.missing) return null;
      if (result.code !== 0) fail("Windows Credential Manager", "read the Jev key", result);
      const key = Buffer.from(result.stdout.trim(), "base64").toString("utf8");
      return key ? new SecretKey(key) : null;
    },
    async save(raw) {
      const result = await ps("save", validateKey(raw));
      if (result.code !== 0) fail("Windows Credential Manager", "save the Jev key", result);
      return status();
    },
    async clear() {
      const result = await ps("clear");
      const after = await status();
      if (result.code !== 0 && after.stored) fail("Windows Credential Manager", "remove the Jev key", result);
      return after;
    },
  };
}

// ---------- macOS: login keychain through `security` ----------

/** `security -i` reads commands from stdin; quote one argument for it. */
function securityQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function macProvider(run: Runner, service: string): JevKeyProvider {
  const store: KeyStoreName = "macos-keychain";
  const find = (reveal: boolean) => run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, ...(reveal ? ["-w"] : [])]);
  const status = async (): Promise<KeyStatus> => {
    const result = await find(false);
    if (result.missing) return { available: false, stored: false, store: "unavailable", detail: "The security tool is not available." };
    if (result.code === 0) return { available: true, stored: true, store };
    if (result.code === 44) return { available: true, stored: false, store };
    return fail("The macOS keychain", "be checked", result);
  };
  return {
    status,
    async read() {
      const result = await find(true);
      if (result.code === 44 || result.missing) return null;
      if (result.code !== 0) fail("The macOS keychain", "read the Jev key", result);
      const key = result.stdout.replace(/\r?\n$/, "");
      return key ? new SecretKey(key) : null;
    },
    async save(raw) {
      const key = validateKey(raw);
      // Interactive mode keeps the key off the command line, where other processes could see it.
      const command = `add-generic-password -U -s ${securityQuote(service)} -a ${securityQuote(KEYCHAIN_ACCOUNT)} -l ${securityQuote("Perfect Planner Jev key")} -w ${securityQuote(key)}\n`;
      const result = await run("/usr/bin/security", ["-i"], command);
      if (result.code !== 0 || /error|fail/i.test(result.stderr)) fail("The macOS keychain", "save the Jev key", { ...result, stderr: result.stderr.split(key).join("[redacted]") });
      return status();
    },
    async clear() {
      const result = await run("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT]);
      if (result.code !== 0 && result.code !== 44) fail("The macOS keychain", "remove the Jev key", result);
      return status();
    },
  };
}

// ---------- Linux: Secret Service through `secret-tool` ----------

function linuxProvider(run: Runner, service: string): JevKeyProvider {
  const store: KeyStoreName = "linux-secret-service";
  const attrs = ["service", service, "account", KEYCHAIN_ACCOUNT];
  const lookup = () => run("secret-tool", ["lookup", ...attrs]);
  const unavailable: KeyStatus = { available: false, stored: false, store: "unavailable", detail: "secret-tool (libsecret) is not installed, or no Secret Service is running." };
  const status = async (): Promise<KeyStatus> => {
    const result = await lookup();
    if (result.missing) return unavailable;
    if (result.code === 0 && result.stdout.length > 0) return { available: true, stored: true, store };
    // secret-tool exits 1 both for "not found" and "no service"; stderr tells them apart.
    if (result.code === 1 && !result.stderr.trim()) return { available: true, stored: false, store };
    return { ...unavailable, detail: `The Secret Service did not answer: ${result.stderr.replace(/\s+/g, " ").trim().slice(0, 120)}` };
  };
  return {
    status,
    async read() {
      const result = await lookup();
      if (result.code !== 0 || result.missing) return null;
      const key = result.stdout.replace(/\r?\n$/, "");
      return key ? new SecretKey(key) : null;
    },
    async save(raw) {
      const result = await run("secret-tool", ["store", "--label=Perfect Planner Jev key", ...attrs], validateKey(raw));
      if (result.missing) throw new Error(unavailable.detail);
      if (result.code !== 0) fail("The Secret Service", "save the Jev key", result);
      return status();
    },
    async clear() {
      const result = await run("secret-tool", ["clear", ...attrs]);
      if (result.missing) return unavailable;
      if (result.code !== 0 && result.code !== 1) fail("The Secret Service", "remove the Jev key", result);
      return status();
    },
  };
}

/** For tests and previews: keeps the key in memory only. */
export class MemoryKeyProvider implements JevKeyProvider {
  private key: SecretKey | null;
  reads = 0;
  constructor(key?: string) {
    this.key = key ? new SecretKey(validateKey(key)) : null;
  }
  async status(): Promise<KeyStatus> {
    return { available: true, stored: this.key !== null, store: "memory" };
  }
  async read(): Promise<SecretKey | null> {
    this.reads++;
    return this.key;
  }
  async save(raw: string): Promise<KeyStatus> {
    this.key = new SecretKey(validateKey(raw));
    return this.status();
  }
  async clear(): Promise<KeyStatus> {
    this.key = null;
    return this.status();
  }
}
