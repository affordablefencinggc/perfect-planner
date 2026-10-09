// Test-command parsing and shell-free executable resolution for the test gate.
// A done-when command is either an argv array or a simple string; it is never
// handed to a shell. On Windows, npm/npx are resolved through their .cmd shims
// to `node <npm-cli.js>` so no cmd.exe is involved; any other .cmd/.bat shim is
// run through cmd.exe only when every argument is free of cmd metacharacters.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

const fail = (code, message) => { const error = new Error(message ?? code); error.code = code; throw error; };
const SHELL_OPERATORS = /[|&;<>`]|\$\(/;
const CMD_UNSAFE = /[&|<>^%!"()\r\n]/;
// The resolved shim path is always passed inside "..." to cmd.exe, where & | < > ^ ( ) are
// literal (so "C:\Program Files (x86)\..." works); % and ! still expand and " would end the quote.
const CMD_PATH_UNSAFE = /[%!"\r\n]/;

// Credentials must never reach the ledger through a test command (it is stored forever).
const SECRET_WORD = "(?:token|secret|password|passwd|passphrase|credentials?|api[-_]?key|private[-_]?key|access[-_]?key|auth|cookie|pat|dsn)";
// --token=x, --token x, --github-token, --api-key ... (a secret word as a whole dash/underscore-separated part)
const SECRET_FLAG = new RegExp(`^--?(?!no-)(?:[a-z0-9]+[-_])*${SECRET_WORD}(?:[-_][a-z0-9]+)*(?:=|$)`, "i");
// GITHUB_TOKEN=x, DB_PASSWORD=y, NPM_CONFIG__AUTH=z
const SECRET_ASSIGN = new RegExp(`^(?:[A-Za-z0-9]+_+)*${SECRET_WORD}(?:_+[A-Za-z0-9]+)*=.`, "i");
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const TOKEN_SHAPES = /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/;

/** Index of the first argument that looks like (or introduces) a credential, else null. */
export function findSecretArgument(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (SECRET_FLAG.test(arg) || SECRET_ASSIGN.test(arg) || CREDENTIAL_URL.test(arg) || TOKEN_SHAPES.test(arg)) return i;
  }
  return null;
}

/** Parse "npm test -- --grep 'a b'" into argv. Quotes group; shell operators are refused. */
export function parseCommandString(text) {
  if (typeof text !== "string" || !text.trim()) fail("TEST_COMMAND_INVALID", "Test command must be a non-empty string or argv array");
  if (/[\r\n\0]/.test(text)) fail("TEST_COMMAND_INVALID", "Test command must be a single line");
  const argv = [];
  let current = "", quote = null, started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // Inside double quotes only \" and \\ are escapes; Windows paths stay literal.
      if (quote === '"' && ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) { current += text[i + 1]; i += 1; continue; }
      current += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) { argv.push(current); current = ""; started = false; } continue; }
    if (SHELL_OPERATORS.test(ch) || (ch === "$" && text[i + 1] === "(")) fail("TEST_COMMAND_INVALID", `Shell operator ${JSON.stringify(ch)} is not allowed; the test gate runs commands without a shell`);
    current += ch; started = true;
  }
  if (quote) fail("TEST_COMMAND_INVALID", "Unterminated quote in test command");
  if (started) argv.push(current);
  return argv;
}

/** Normalize a command (string or argv array) to a validated argv array. */
export function normalizeCommand(command) {
  const argv = Array.isArray(command) ? [...command] : parseCommandString(command);
  if (!argv.length || argv.some((part) => typeof part !== "string" || part.includes("\0") || /[\r\n]/.test(part))) fail("TEST_COMMAND_INVALID", "Test command argv must be single-line strings");
  if (!argv[0].trim()) fail("TEST_COMMAND_INVALID", "Test command executable is empty");
  return argv;
}

/** Display form for ledger summaries (one line). */
export function displayCommand(argv) {
  return argv.map((part) => (part === "" || /[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function envValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(file) { try { return statSync(file).isFile(); } catch { return false; } }
function isExecutable(file) { if (!isFile(file)) return false; try { accessSync(file, constants.X_OK); return true; } catch { return false; } }

function hasPathSeparator(name) { return name.includes("/") || name.includes("\\"); }

function candidatesFor(name, { platform, env, cwd }) {
  const windows = platform === "win32";
  const extensions = windows
    ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase())
    : [""];
  const withExt = (base) => {
    if (!windows) return [base];
    const ext = path.extname(base).toLowerCase();
    return extensions.includes(ext) ? [base] : extensions.map((e) => base + e);
  };
  if (hasPathSeparator(name) || path.isAbsolute(name)) return withExt(path.resolve(cwd, name));
  const dirs = (envValue(env, "PATH") || "").split(windows ? ";" : ":").filter(Boolean);
  return dirs.flatMap((dir) => withExt(path.join(dir.replace(/^"(.*)"$/, "$1"), name)));
}

function findExecutable(name, options) {
  const windows = options.platform === "win32";
  for (const candidate of candidatesFor(name, options)) {
    if (windows ? isFile(candidate) : isExecutable(candidate)) return candidate;
  }
  return null;
}

function cmdQuotePath(file) {
  if (CMD_PATH_UNSAFE.test(file)) fail("TEST_COMMAND_INVALID", `Shim path ${JSON.stringify(file)} contains % ! or " and cannot be run through cmd.exe safely`);
  return /[\s&|<>^()]/.test(file) ? `"${file}"` : file;
}

function cmdQuote(arg) {
  if (CMD_UNSAFE.test(arg)) fail("TEST_COMMAND_INVALID", `Argument ${JSON.stringify(arg)} contains cmd.exe metacharacters and cannot be passed to a .cmd/.bat shim safely`);
  return arg === "" || /[\s]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Resolve argv to a concrete spawn plan: { file, args, windowsVerbatimArguments, via }.
 * `platform`, `env`, `nodePath` and `comspec` are injectable so Windows logic is testable everywhere.
 */
export function resolveCommand(command, { cwd = process.cwd(), env = process.env, platform = process.platform, nodePath = process.execPath, comspec } = {}) {
  const argv = normalizeCommand(command);
  const [name, ...rest] = argv;
  const lower = name.toLowerCase();
  // `node` always means the Node running Perfect Planner: deterministic, no PATH hijack.
  if (lower === "node" || (platform === "win32" && lower === "node.exe")) return { file: nodePath, args: rest, windowsVerbatimArguments: false, via: "node" };
  const options = { platform, env, cwd };
  const found = findExecutable(name, options);
  if (!found) fail("TEST_COMMAND_NOT_FOUND", `Test command executable not found: ${name}`);
  if (platform !== "win32") return { file: found, args: rest, windowsVerbatimArguments: false, via: "path" };
  const ext = path.extname(found).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { file: found, args: rest, windowsVerbatimArguments: false, via: "path" };
  if (ext === ".cmd" || ext === ".bat") {
    const base = path.basename(found, path.extname(found)).toLowerCase();
    if (base === "npm" || base === "npx") {
      const dir = path.dirname(found);
      const cli = path.join(dir, "node_modules", "npm", "bin", `${base}-cli.js`);
      if (isFile(cli)) {
        const siblingNode = path.join(dir, "node.exe");
        return { file: isFile(siblingNode) ? siblingNode : nodePath, args: [cli, ...rest], windowsVerbatimArguments: false, via: `${base}-cli` };
      }
    }
    // Generic shim: cmd.exe /d /s /c "<shim> args", only with metacharacter-free arguments.
    const shell = comspec || path.join(envValue(env, "SYSTEMROOT") || "C:\\Windows", "System32", "cmd.exe");
    const line = [cmdQuotePath(found), ...rest.map(cmdQuote)].join(" ");
    return { file: shell, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, via: "cmd-shim" };
  }
  fail("TEST_COMMAND_INVALID", `Unsupported executable type on Windows: ${found}`);
}
