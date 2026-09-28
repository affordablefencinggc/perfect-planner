import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_TIMEOUT = 120_000;
const MAX_OUTPUT = 8_000_000;
const routingKeys = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_EXEC_PATH"]);
const commands = new Set(["rev-parse", "rev-list", "cat-file", "ls-tree", "ls-files", "status", "diff", "show", "log", "for-each-ref", "symbolic-ref", "check-ref-format", "worktree", "merge"]);
const within = (root, file) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
const refuse = (reason) => { throw new Error(reason); };
const defaultGitExecutable = process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";

// Only authority-side callers may configure this path. Never accept it from a
// repository manifest, MCP arguments or a webview. PATH is not executable trust.
async function inspectGitExecutable(executable, root) {
  if (typeof executable !== "string" || !path.isAbsolute(executable) || executable.includes("\0")) refuse("git-executable-path-refused");
  const resolved = path.resolve(executable);
  if (within(root, resolved)) refuse("git-executable-inside-repository-refused");
  let canonical, stat;
  try { canonical = await realpath(resolved); stat = await lstat(resolved); }
  catch { refuse("git-executable-unavailable"); }
  if (within(root, canonical) || path.relative(resolved, canonical) !== "" || stat.isSymbolicLink() || !stat.isFile()) refuse("git-executable-path-refused");
  return { executable: canonical, stamp: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":") };
}

function environment(source) {
  for (const key of Object.keys(source)) {
    const upper = key.toUpperCase();
    if (routingKeys.has(upper) || upper.startsWith("GIT_CONFIG")) refuse("git-environment-override-refused");
    if (/^(?:LD_|DYLD_|COMPLUS_|COR_|CORECLR_)/.test(upper) || upper === "DOTNET_STARTUP_HOOKS") refuse("git-loader-environment-refused");
  }
  return { ...source, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
}

// Windows children run inside a Job Object before any Git process starts.
// Killing or exiting this helper closes its sole job handle, terminating all
// descendants even if the direct Git child has already exited.
const windowsJobSource = String.raw`
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class PlannerGuardedJob {
  static async Task PumpInput(System.IO.Stream source, System.IO.Stream destination) {
    byte[] buffer = new byte[8192]; int count;
    while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) != 0) {
      await destination.WriteAsync(buffer, 0, count); await destination.FlushAsync();
    }
  }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint length, out uint returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static int Run(string executable, string arguments, string cwd) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return 125;
    Extended limits = new Extended(); limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Extended))) || !AssignProcessToJobObject(job, GetCurrentProcess())) return 125;
    var start = new ProcessStartInfo(executable, arguments); start.WorkingDirectory = cwd; start.UseShellExecute = false; start.CreateNoWindow = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true; start.RedirectStandardInput = true;
    using (var child = Process.Start(start)) {
      PumpInput(Console.OpenStandardInput(),child.StandardInput.BaseStream).ContinueWith(task => { try { child.StandardInput.Close(); } catch {} });
      Task output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      Task error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      child.WaitForExit(); int exit = child.ExitCode;
      IntPtr list = Marshal.AllocHGlobal(65536);
      try {
        bool empty = false;
        for (int pass = 0; pass < 8; pass++) {
          uint returned;
          if (!QueryInformationJobObject(job, 3, list, 65536, out returned)) return 125;
          int count = Marshal.ReadInt32(list, 4); empty = true;
          for (int i = 0; i < count; i++) {
            int pid = (int)Marshal.ReadIntPtr(list, 8 + i * IntPtr.Size);
            if (pid == Process.GetCurrentProcess().Id || pid == child.Id) continue;
            try { using (var descendant = Process.GetProcessById(pid)) { if (descendant.HasExited) continue; empty = false; descendant.Kill(); descendant.WaitForExit(200); } }
            catch (ArgumentException) {} catch (InvalidOperationException) {}
          }
          if (empty) break;
        }
        if (!empty || !Task.WaitAll(new Task[] { output, error }, 500)) return 125;
      } finally { Marshal.FreeHGlobal(list); }
      return exit;
    }
    // The helper owns the handle until exit; explicitly closing it would kill
    // the helper before its exit code could reach the caller.
  }
}`;
function windowsQuote(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function windowsLaunch(command, args, cwd) {
  const payload = Buffer.from(JSON.stringify({ command, arguments: args.map(windowsQuote).join(" "), cwd })).toString("base64");
  const source = Buffer.from(windowsJobSource).toString("base64");
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $PSModuleAutoLoadingPreference='None'; try { Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))); $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; exit [PlannerGuardedJob]::Run($p.command,$p.arguments,$p.cwd) } catch { exit 125 }`;
  // This is the process-containment boundary, not a child-selectable tool.
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  return { command: executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
}

/** Bounded process primitive. Authorization and executable selection belong to callers. */
export function runBoundedProcess(command,args,options={}){return boundedProcess(command,args,options,MAX_TIMEOUT,MAX_OUTPUT);}
// Five-minute checks plus 30s candidate acquisition, 1s guard settlement and
// 14s helper startup/transport margin. JSON output can expand to 12 MiB.
export function runBoundedTaskProcess(command,args,options={}){return boundedProcess(command,args,options,345_000,13*1024*1024);}
// Private three-frame native custody conversation. Each asynchronous handler
// settles before the next frame is accepted, including after cancellation.
export function runBoundedTaskConversation(command,args,options,onFrame){
 if(typeof onFrame!=='function')refuse('invalid-command-conversation');
 return boundedProcess(command,args,options,555_000,13*1024*1024,onFrame);
}
function boundedProcess(command, args, { cwd, env = process.env, timeoutMs = 10_000, maxBytes = 65_536, input = "", signal: abortSignal } = {}, timeoutLimit,outputLimit,onFrame) {
  if(abortSignal!==undefined&&!(abortSignal instanceof AbortSignal))refuse('invalid-command-signal');
  if(abortSignal?.aborted)return Promise.resolve({exit:null,signal:null,stdout:'',stderr:'',reason:'git-cancelled',timedOut:false,outputBytes:0,outputComplete:false,cleanupComplete:true});
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > timeoutLimit || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > outputLimit) refuse("invalid-command-bounds");
  if ((!Buffer.isBuffer(input) && typeof input !== "string") || Buffer.byteLength(input) > MAX_OUTPUT) refuse("invalid-command-input");
  if (process.platform === "win32") {
    env = { ...Object.fromEntries(Object.entries(env).filter(([key]) => !["SYSTEMROOT", "WINDIR"].includes(key.toUpperCase()))), SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" };
  }
  return new Promise((resolve) => {
    const launch = process.platform === "win32" ? windowsLaunch(command, args, cwd) : { command, args };
    const child = spawn(launch.command, launch.args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let bytes = 0, reason = null, finished = false, fallback, timer;
    let exchange=Promise.resolve(),frameBuffer=Buffer.alloc(0),frameCount=0,awaitingReply=false,conversationEnded=false,callbackCleanupComplete=true;
    const conversationAbort=new AbortController();
    const killTree = () => {
      if (!child.pid) return;
      if (process.platform === "win32") child.kill("SIGKILL");
      else { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); } }
    };
    const finish = (exit, signal, cleanupComplete = true) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(fallback);
      abortSignal?.removeEventListener('abort',onAbort);
      if(onFrame&&(frameBuffer.length||frameCount!==3||!conversationEnded))reason??='native-conversation-incomplete';
      conversationAbort.abort();
      // Never report settlement while a retention write is still in flight.
      exchange.finally(()=>resolve({ exit: reason ? null : exit, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), reason, timedOut: reason === "git-time-limit", outputBytes: bytes, outputComplete: !reason, cleanupComplete:cleanupComplete&&callbackCleanupComplete }));
    };
    const stop = (failure) => {
      if (reason || finished) return;
      reason = failure;
      conversationAbort.abort();
      killTree();
      fallback = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null, null, false); }, 1_500);
    };
    const collect = (chunk, destination) => {
      if (reason || finished) return;
      const remaining = maxBytes - bytes;
      bytes += chunk.length;
      if (chunk.length > remaining) { if (remaining > 0) destination.push(Buffer.from(chunk.subarray(0, remaining))); stop("git-output-limit"); }
      else destination.push(Buffer.from(chunk));
    };
    const onAbort=()=>stop('git-cancelled');
    timer = setTimeout(() => stop("git-time-limit"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      collect(chunk,stdout);if(!onFrame||reason||finished)return;
      frameBuffer=Buffer.concat([frameBuffer,chunk]);
      const newline=frameBuffer.indexOf(10);if(newline<0)return;
      // Native must wait for our reply. Pipelined/extra frames are not allowed.
      if(awaitingReply||conversationEnded||frameCount>=3||newline!==frameBuffer.length-1){stop('native-conversation-order');return;}
      const frame=frameBuffer.subarray(0,newline);frameBuffer=Buffer.alloc(0);frameCount++;awaitingReply=true;
      exchange=exchange.then(async()=>{
        if(reason||finished)return;
        const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame));
        const reply=await onFrame(value,{signal:conversationAbort.signal});
        if(reason||finished)return;
        if(reply===null){conversationEnded=true;awaitingReply=false;child.stdin.end();return;}
        const encoded=JSON.stringify(reply);
        if(!encoded||Buffer.byteLength(encoded)>65536)throw Error('native-conversation-input');
        awaitingReply=false;child.stdin.write(encoded+'\n');
      }).catch(error=>{if(error?.cleanupComplete===false)callbackCleanupComplete=false;if(finished)reason??='native-conversation-handler';else stop('native-conversation-handler');});
    });
    child.stderr.on("data", (chunk) => collect(chunk, stderr));
    child.once("error", () => {
      if(!child.pid){reason ??= 'git-process-unavailable';finish(null,null);return;}
      // A post-spawn error can mean termination failed. Only close or the
      // uncertainty fallback may settle cleanup; preserve cancellation reason.
      if(!reason)stop('git-process-error');
    });
    child.once("exit", () => { if (process.platform !== "win32") killTree(); });
    child.once("close", (exit, signal) => {
      if (process.platform === "win32" && exit === 125 && !reason) reason = "git-process-containment-unavailable";
      finish(exit, signal);
    });
    child.stdin.on("error", () => {if(onFrame&&!conversationEnded)stop('native-conversation-input');});
    if(onFrame)child.stdin.write(input+'\n');else child.stdin.end(input);
    abortSignal?.addEventListener('abort',onAbort,{once:true});
    if(abortSignal?.aborted)onAbort();
  });
}

export async function runGuardedGit(cwd, args, options = {}) {
  if(options.signal!==undefined&&!(options.signal instanceof AbortSignal))refuse('invalid-command-signal');
  if(options.signal?.aborted)refuse('git-cancelled');
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 65_536;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT) refuse("invalid-command-bounds");
  let consumedBytes = 0;
  if (!Array.isArray(args) || !commands.has(args[0]) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) refuse("git-command-refused");
  if (args.some((arg) => /^(?:--ext-diff|--textconv|--filters|--output(?:=|$)|--config-env(?:=|$)|--exec-path(?:=|$)|--strategy(?:=|$))/.test(arg)) || args.includes("-s") || args.includes("-c")) refuse("git-command-override-refused");
  if (args[0] === "symbolic-ref" && (args.slice(1).filter((arg) => !arg.startsWith("-")).length !== 1 || args.slice(1).some((arg) => arg.startsWith("-") && !["--quiet", "--short"].includes(arg)))) refuse("git-symbolic-ref-write-refused");
  if (args[0] === "merge" && args.some((arg) => /^-s./.test(arg))) refuse("git-command-override-refused");
  const env = environment(options.env ?? process.env);
  const root = await realpath(cwd);
  if (path.relative(path.resolve(cwd), root) !== "") refuse("git-cwd-alias-refused");
  const selectedExecutable = options.gitExecutable ?? defaultGitExecutable;
  const executable = await inspectGitExecutable(selectedExecutable, root);
  const temporaryRoot = await realpath(tmpdir());
  if (within(root, temporaryRoot)) refuse("git-hook-directory-inside-repository-refused");
  const hookDirectory = await mkdtemp(path.join(temporaryRoot, "pp-empty-git-hooks-"));
  try {
    const stat = await lstat(hookDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(await realpath(hookDirectory), hookDirectory) !== "" || (await readdir(hookDirectory)).length !== 0 || within(root, hookDirectory)) refuse("git-hook-directory-untrusted");
    const prefix = ["--no-pager", "--no-optional-locks", "-c", `core.hooksPath=${hookDirectory.replaceAll("\\", "/")}`, "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "merge.gpgSign=false", "-c", "protocol.allow=never"];
    const run = async (commandArgs, input = "") => {
      if(options.signal?.aborted)refuse('git-cancelled');
      const currentExecutable = await inspectGitExecutable(selectedExecutable, root);
      if (currentExecutable.executable !== executable.executable || currentExecutable.stamp !== executable.stamp) refuse("git-executable-changed");
      const remainingMs = timeoutMs - (Date.now() - started), remainingBytes = maxBytes - consumedBytes;
      if (remainingMs < 1) refuse("git-time-limit");
      if (remainingBytes < 1) refuse("git-output-limit");
      const result = await runBoundedProcess(executable.executable, [...prefix, ...commandArgs], { cwd: root, env, timeoutMs: remainingMs, maxBytes: remainingBytes, input, signal:options.signal });
      consumedBytes += result.outputBytes;
      if (result.cleanupComplete !== true) throw Object.assign(new Error("git-process-cleanup-uncertain"), { code: "GIT_PROCESS_UNCERTAIN", cleanupComplete: false });
      return result;
    };
    const drivers = ["status", "diff", "worktree", "merge"].includes(args[0])
      ? await run(["config", "--name-only", "--get-regexp", "^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$"])
      : { exit: 1, reason: null, stdout: "" };
    if (drivers.reason || ![0, 1].includes(drivers.exit)) refuse("git-driver-config-unverified");
    const configured = [...new Set(drivers.stdout.trim().split(/\r?\n/).filter(Boolean))];
    const disabledFilters = new Set();
    for (const key of configured) {
      if (/[\x00-\x1f=]/.test(key)) refuse("git-driver-config-unverified");
      const filter = /^filter\.(.+)\.(clean|smudge|process)$/.exec(key);
      if (filter) disabledFilters.add(filter[1]);
      else if (args[0] === "merge") refuse("git-external-merge-driver-refused");
    }
    // External filters (such as LFS) must neither execute during checkout/status
    // nor block unrelated repos. Git's text/EOL checkout conversions still apply;
    // worktree bytes are not necessarily identical to canonical blob bytes.
    for (const name of disabledFilters) prefix.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
    if ((args[0] === "worktree" && args[1] === "add") || args[0] === "merge") {
      const candidates = args[0] === "worktree" ? [args.at(-1)] : args.includes("--abort") ? ["HEAD"] : ["HEAD", args.at(-1)];
      for (const candidate of new Set(candidates)) {
        if (!candidate || candidate.startsWith("-")) refuse("git-candidate-tree-required");
        const listing = await run(["ls-tree", "-r", "--name-only", "-z", candidate]);
        if (listing.reason || listing.exit !== 0) refuse("git-candidate-attributes-unverified");
        const files = listing.stdout.split("\0").filter(Boolean);
        if (!files.length) continue;
        const attributes = await run(["check-attr", `--source=${candidate}`, "-z", "--stdin", "filter", "merge"], listing.stdout);
        if (attributes.reason || attributes.exit !== 0) refuse("git-candidate-attributes-unverified");
        const entries = attributes.stdout.split("\0");
        if (entries.pop() !== "" || entries.length !== files.length * 6) refuse("git-candidate-attributes-unverified");
        const expected = new Set(files.flatMap((file) => [file + "\0filter", file + "\0merge"]));
        for (let index = 0; index < entries.length; index += 3) {
          const [file, name, value] = entries.slice(index, index + 3);
          if (!expected.delete(file + "\0" + name)) refuse("git-candidate-attributes-unverified");
          if (name === "filter" && !["unspecified", "unset"].includes(value)) refuse("git-candidate-filter-required");
          if (name === "merge" && !["unspecified", "unset", "set", "text", "binary", "union"].includes(value)) refuse("git-candidate-custom-merge-required");
        }
        if (expected.size) refuse("git-candidate-attributes-unverified");
      }
    }
    const safeArgs = ["diff", "show", "log"].includes(args[0]) ? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
    const result = await run(safeArgs);
    return { ...result, outputBytes: consumedBytes, disabledFilters: [...disabledFilters] };
  } finally {
    // Empty-only removal preserves unexpected content rather than deleting it.
    await rmdir(hookDirectory).catch(() => {});
  }
}

export const guardedGitRunnerContract = Object.freeze({ executable: defaultGitExecutable, executableSelection: "Absolute authority-configured executable outside the checkout; never PATH lookup", shell: false, maxTimeoutMs: MAX_TIMEOUT, maxOutputBytes: MAX_OUTPUT, terminationGraceMs: 1500, authorization: "Exact repository/worktree authority remains with the caller", hooks: "Unique verified empty directory outside the checkout", filters: "External filters are disabled; Git text/EOL checkout conversions still apply", windowsContainment: "Kill-on-close Job Object before child creation" });
