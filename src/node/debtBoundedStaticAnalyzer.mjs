import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const within = (root, candidate) => { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return number;
}

async function executeProcess({ executablePath, args, cwd, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false; let timer; let bytes = 0; const stdout = []; const stderr = [];
    const child = spawn(executablePath, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const collect = (target) => (chunk) => { bytes += chunk.length; if (bytes > maxOutputBytes) { child.kill(); finish(new Error("Analyzer output exceeded the configured bound.")); return; } target.push(chunk); };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(error));
    child.once("exit", (exitCode, signal) => finish(null, { exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut: false }));
    timer = setTimeout(() => { child.kill(); finish(new Error("Analyzer execution timed out.")); }, timeoutMs);
  });
}

export function createBoundedStaticAnalyzerAdapter(options = {}) {
  if (!options.executablePath || !path.isAbsolute(options.executablePath)) throw new Error("Analyzer executable path must be absolute.");
  const executablePath = path.resolve(options.executablePath);
  const fixedArgs = options.fixedArgs ?? [];
  if (!Array.isArray(fixedArgs) || fixedArgs.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Analyzer arguments must be a fixed string array.");
  const timeoutMs = boundedInteger(options.timeoutMs, 60_000, 50, 300_000, "Analyzer timeout");
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, 2_000_000, 1024, 20_000_000, "Analyzer output bound");
  const execute = options.execute ?? executeProcess;
  if (typeof execute !== "function") throw new Error("Analyzer executor must be callable.");
  const analyzerName = String(options.analyzerName ?? path.basename(executablePath)).trim();
  if (!analyzerName) throw new Error("Analyzer name is required.");
  return async ({ workspaceRoot, files, surface }) => {
    const root = path.resolve(workspaceRoot);
    const coveredFiles = [...new Set((files ?? []).map((file) => String(file).split(path.sep).join("/")))].sort();
    if (!coveredFiles.length || coveredFiles.some((file) => path.isAbsolute(file) || file.startsWith("../") || !within(root, path.join(root, file)))) throw new Error("Analyzer requires contained relative target files.");
    const started = Date.now();
    const controller = new AbortController(); let timer;
    let result;
    try {
      result = await Promise.race([
        execute({ executablePath, args: [...fixedArgs, ...coveredFiles], cwd: root, timeoutMs, maxOutputBytes, shell: false, windowsHide: true, signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Analyzer execution timed out.")); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
    const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout : Buffer.from(result?.stdout ?? "");
    const stderr = Buffer.isBuffer(result?.stderr) ? result.stderr : Buffer.from(result?.stderr ?? "");
    if (stdout.length + stderr.length > maxOutputBytes) throw new Error("Analyzer output exceeded the configured bound.");
    const passed = result?.exitCode === 0 && result?.timedOut !== true && !result?.signal;
    return Object.freeze({ state: passed ? "PASSED" : "FAILED", name: analyzerName, surface, coveredFiles: passed ? coveredFiles : [], exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null, signal: result?.signal ?? null, timedOut: result?.timedOut === true, durationMs: Date.now() - started, outputHash: sha256(Buffer.concat([stdout, Buffer.from("\0"), stderr])), outputBytes: stdout.length + stderr.length, shell: false });
  };
}
