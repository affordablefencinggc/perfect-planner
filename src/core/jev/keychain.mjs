// OS keychain storage for the owner's TypeSafe Jev API key.
//
// The key lives only in the operating system's credential store:
//   Windows: Credential Manager via PowerShell + advapi32 CredWrite/CredRead (P/Invoke)
//   macOS:   Keychain via /usr/bin/security (interactive mode, command on stdin)
//   Linux:   Secret Service via secret-tool (libsecret)
// The secret always travels over the child's stdin, never argv or the
// environment. It is never logged, never placed in an error message, never
// written to the repository, ledger or any file. No code here reads a key
// from anywhere but the OS keychain (no paste buffers, no environment).

import { spawn as nodeSpawn } from "node:child_process";
import { Buffer } from "node:buffer";

export const JEV_KEY_SERVICE = "perfect-planner";
export const JEV_KEY_ACCOUNT = "jev-api-key";
const LABEL = "Perfect Planner TypeSafe Jev API key";
const IDENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class KeychainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KeychainError";
    this.code = code;
  }
}

/** API keys are printable ASCII without whitespace; anything else is refused before any process starts. */
export function validateSecret(secret) {
  if (typeof secret !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(secret)) {
    throw new KeychainError("KEYCHAIN_INVALID_SECRET", "The key must be 8-4096 printable characters with no spaces or line breaks.");
  }
  return secret;
}

function checkIdent(service, account) {
  if (!IDENT.test(service) || !IDENT.test(account)) throw new KeychainError("KEYCHAIN_INVALID_NAME", "Keychain service/account names must be short lowercase identifiers.");
}

function redact(text, secret) {
  let out = String(text ?? "");
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Runs a command with shell:false and writes `input` to stdin. Never rejects. */
export function runWithStdin(spawnImpl, command, args, { input = "", timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    const finish = (result) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* already gone */ } finish({ error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }); }, timeoutMs);
    try {
      child = spawnImpl(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      finish({ error });
      return;
    }
    const out = [];
    const err = [];
    child.on("error", (error) => finish({ error }));
    child.stdout?.on("data", (c) => out.push(Buffer.from(c)));
    child.stderr?.on("data", (c) => err.push(Buffer.from(c)));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

// ---------------------------------------------------------------- Windows
const WINDOWS_CRED_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class PerfectPlannerCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);
  const UInt32 GENERIC = 1; const UInt32 PERSIST_LOCAL_MACHINE = 2; const int NOT_FOUND = 1168;
  public static void Write(string target, string user, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = GENERIC; c.TargetName = target; c.UserName = user; c.Persist = PERSIST_LOCAL_MACHINE;
      c.CredentialBlobSize = (UInt32)bytes.Length; c.CredentialBlob = blob; c.Comment = "${LABEL}";
      if (!CredWrite(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int i = 0; i < bytes.Length; i++) { Marshal.WriteByte(blob, i, 0); bytes[i] = 0; }
      Marshal.FreeHGlobal(blob);
    }
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, GENERIC, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == NOT_FOUND) return null;
      throw new Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] bytes = new byte[c.CredentialBlobSize];
      if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, (int)c.CredentialBlobSize);
      return Encoding.Unicode.GetString(bytes);
    } finally { CredFree(p); }
  }
  public static bool Exists(string target) {
    IntPtr p;
    if (!CredRead(target, GENERIC, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == NOT_FOUND) return false;
      throw new Win32Exception(e);
    }
    CredFree(p);
    return true;
  }
  public static bool Delete(string target) {
    if (CredDelete(target, GENERIC, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == NOT_FOUND) return false;
    throw new Win32Exception(e);
  }
}`;

/** Builds the PowerShell script for one operation. The script contains no secret; the secret is read from stdin as base64. */
export function windowsScript(op, target, user) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    WINDOWS_CRED_SOURCE,
    "'@",
    `$target = '${target}'`,
    `$user = '${user}'`,
    op === "store"
      ? "$b64 = [Console]::In.ReadToEnd().Trim(); [PerfectPlannerCred]::Write($target, $user, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))); exit 0"
      : op === "read"
        ? "$s = [PerfectPlannerCred]::Read($target); if ($null -eq $s) { exit 3 }; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))); exit 0"
        : op === "exists"
          ? "if ([PerfectPlannerCred]::Exists($target)) { exit 0 } else { exit 3 }"
          : "if ([PerfectPlannerCred]::Delete($target)) { exit 0 } else { exit 3 }",
  ].join("\n");
}

function windowsCommand(op, service, account) {
  const encoded = Buffer.from(windowsScript(op, `${service}/${account}`, account), "utf16le").toString("base64");
  return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] };
}

// ------------------------------------------------------------------ macOS
function macQuote(value) {
  return `"${value.replace(/[\\"]/g, (c) => "\\" + c)}"`;
}

// ------------------------------------------------------------------ Linux
const LINUX_UNAVAILABLE = /dbus|d-bus|secret service|org\.freedesktop\.secrets|no such interface|cannot autolaunch/i;

/**
 * The real OS keychain backend for `platform`. `spawn` is injectable so the
 * per-platform argv/stdin contract can be tested on any host.
 */
export function createSystemKeychain({ platform = process.platform, spawn = nodeSpawn, timeoutMs = 30_000 } = {}) {
  const run = (command, args, input) => runWithStdin(spawn, command, args, { input, timeoutMs });
  const tool = platform === "win32" ? "PowerShell (Windows Credential Manager)" : platform === "darwin" ? "security (macOS Keychain)" : platform === "linux" ? "secret-tool (Secret Service)" : null;

  const unavailable = (detail) => new KeychainError("KEYCHAIN_UNAVAILABLE", `The OS keychain is not available on this computer: ${detail}`);
  const failed = (op, result, secret) => new KeychainError("KEYCHAIN_FAILED", `Keychain ${op} failed (exit ${result.code}): ${redact(result.stderr, secret) || "no detail"}`);
  const spawnFailure = (result) => {
    if (result.error?.code === "ENOENT") return unavailable(`${tool} was not found.${platform === "linux" ? " Install libsecret-tools (secret-tool) and a Secret Service such as GNOME Keyring or KWallet." : ""}`);
    if (result.error?.code === "ETIMEDOUT") return new KeychainError("KEYCHAIN_TIMEOUT", "The keychain did not respond in time (it may be locked or waiting for approval).");
    return unavailable(`${tool} could not start.`);
  };

  async function store(service, account, secret) {
    checkIdent(service, account);
    validateSecret(secret);
    let result;
    if (platform === "win32") {
      const { command, args } = windowsCommand("store", service, account);
      result = await run(command, args, Buffer.from(secret, "utf8").toString("base64"));
    } else if (platform === "darwin") {
      // `security -i` reads its command line from stdin, so the secret never appears in argv.
      result = await run("security", ["-i"], `add-generic-password -U -s ${macQuote(service)} -a ${macQuote(account)} -l ${macQuote(LABEL)} -w ${macQuote(secret)}\n`);
    } else if (platform === "linux") {
      result = await run("secret-tool", ["store", `--label=${LABEL}`, "service", service, "account", account], secret);
    } else throw unavailable(`platform ${platform} has no supported keychain.`);
    if (result.error) throw spawnFailure(result);
    if (platform === "linux" && result.code !== 0 && LINUX_UNAVAILABLE.test(result.stderr)) throw unavailable("no Secret Service is running.");
    if (result.code !== 0 || (platform === "darwin" && /error|fail/i.test(result.stderr))) throw failed("store", result, secret);
    if (platform === "darwin" && (await read(service, account)) !== secret) throw new KeychainError("KEYCHAIN_FAILED", "Keychain store could not be confirmed by reading it back.");
  }

  async function read(service, account) {
    checkIdent(service, account);
    let result;
    if (platform === "win32") {
      const { command, args } = windowsCommand("read", service, account);
      result = await run(command, args, "");
      if (result.error) throw spawnFailure(result);
      if (result.code === 3) return null;
      if (result.code !== 0) throw failed("read", result);
      const value = Buffer.from(result.stdout.trim(), "base64").toString("utf8");
      return value || null;
    }
    if (platform === "darwin") {
      result = await run("security", ["find-generic-password", "-s", service, "-a", account, "-w"], "");
      if (result.error) throw spawnFailure(result);
      if (result.code === 44) return null;
      if (result.code !== 0) throw failed("read", result);
      return result.stdout.replace(/\r?\n$/, "") || null;
    }
    if (platform === "linux") {
      result = await run("secret-tool", ["lookup", "service", service, "account", account], "");
      if (result.error) throw spawnFailure(result);
      if (result.code !== 0 && LINUX_UNAVAILABLE.test(result.stderr)) throw unavailable("no Secret Service is running.");
      if (result.code !== 0 && result.stderr.trim()) throw failed("read", result);
      if (result.code !== 0) return null;
      return result.stdout.replace(/\r?\n$/, "") || null;
    }
    throw unavailable(`platform ${platform} has no supported keychain.`);
  }

  /**
   * Whether an item exists, without bringing the secret into this process
   * where the OS allows it: Windows frees the CredRead result without printing
   * it, macOS omits -w so only attributes are printed. Linux's secret-tool has
   * no metadata-only lookup, so the value is read and discarded at once.
   */
  async function exists(service, account) {
    checkIdent(service, account);
    let result;
    if (platform === "win32") {
      const { command, args } = windowsCommand("exists", service, account);
      result = await run(command, args, "");
      if (result.error) throw spawnFailure(result);
      if (result.code === 3) return false;
      if (result.code !== 0) throw failed("lookup", result);
      return true;
    }
    if (platform === "darwin") {
      result = await run("security", ["find-generic-password", "-s", service, "-a", account], "");
      if (result.error) throw spawnFailure(result);
      if (result.code === 44) return false;
      if (result.code !== 0) throw failed("lookup", result);
      return true;
    }
    if (platform === "linux") return (await read(service, account)) !== null;
    throw unavailable(`platform ${platform} has no supported keychain.`);
  }

  async function remove(service, account) {
    checkIdent(service, account);
    let result;
    if (platform === "win32") {
      const { command, args } = windowsCommand("delete", service, account);
      result = await run(command, args, "");
      if (result.error) throw spawnFailure(result);
      if (result.code === 3) return false;
      if (result.code !== 0) throw failed("delete", result);
      return true;
    }
    if (platform === "darwin") {
      result = await run("security", ["delete-generic-password", "-s", service, "-a", account], "");
      if (result.error) throw spawnFailure(result);
      if (result.code === 44) return false;
      if (result.code !== 0) throw failed("delete", result);
      return true;
    }
    if (platform === "linux") {
      const existed = (await read(service, account)) !== null;
      result = await run("secret-tool", ["clear", "service", service, "account", account], "");
      if (result.error) throw spawnFailure(result);
      if (result.code !== 0 && LINUX_UNAVAILABLE.test(result.stderr)) throw unavailable("no Secret Service is running.");
      if (result.code !== 0 && existed) throw failed("delete", result);
      return existed;
    }
    throw unavailable(`platform ${platform} has no supported keychain.`);
  }

  return Object.freeze({ name: tool ?? `unsupported:${platform}`, store, read, exists, remove });
}

/** In-memory backend for tests and previews. Never persists anything. */
export function createMemoryKeychain() {
  const items = new Map();
  return Object.freeze({
    name: "memory",
    async store(service, account, secret) { checkIdent(service, account); validateSecret(secret); items.set(`${service}/${account}`, secret); },
    async read(service, account) { checkIdent(service, account); return items.get(`${service}/${account}`) ?? null; },
    async exists(service, account) { checkIdent(service, account); return items.has(`${service}/${account}`); },
    async remove(service, account) { checkIdent(service, account); return items.delete(`${service}/${account}`); },
  });
}

let defaultBackend = null;
const backendOf = (options) => options?.keychain ?? (defaultBackend ??= createSystemKeychain());

/** Settings UI: stores the owner's key from the masked field. Resolves to nothing; the key is never echoed. */
export async function setJevKey(secret, options) {
  await backendOf(options).store(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT, validateSecret(secret));
}

/** Settings UI: whether a key is stored. Returns a boolean only. */
export async function hasJevKey(options) {
  const backend = backendOf(options);
  if (typeof backend.exists === "function") return (await backend.exists(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT)) === true;
  return (await backend.read(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT)) !== null;
}

/** Settings UI: removes the stored key. Returns whether one existed. */
export async function clearJevKey(options) {
  return backendOf(options).remove(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT);
}

/**
 * For the TypeSafe provider only: returns a function that fetches the key at
 * call time, so it is held in memory only for the duration of a request.
 * Not re-exported from the module index.
 */
export function providerKeySource(options) {
  return async () => backendOf(options).read(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT);
}
