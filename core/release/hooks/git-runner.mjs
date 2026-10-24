// GENERATED from core/worktrees/git.ts by core/release/hooks/build-detector.mjs. Do not edit.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitExecutable, NO_CWD_SEARCH_ENV } from "./git-exec.mjs";
const CARRIED_SETTINGS = ["user.name", "user.email", "safe.directory", "core.autocrlf", "core.eol", "core.longpaths", "core.symlinks"];
const fixedConfig = (hooksPath, attributesFile) => [
    `core.hooksPath=${hooksPath}`,
    "core.fsmonitor=false",
    "core.untrackedCache=false",
    "diff.external=",
    `core.attributesFile=${attributesFile}`,
    "core.askPass=",
    "core.quotepath=off",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "gc.auto=0",
    "maintenance.auto=false",
    "diff.relative=false",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    `diff.orderFile=${attributesFile}`,
    "diff.ignoreSubmodules=none",
    "color.ui=false",
    "log.showSignature=false",
    "merge.verifySignatures=false",
    "protocol.allow=never",
];
const DIFF_COMMANDS = new Set(["diff", "show", "log", "diff-tree", "diff-index", "diff-files"]);
const NO_PROGRAM_COMMANDS = new Set(["rev-parse", "symbolic-ref", "show-ref", "for-each-ref", "merge-base", "ls-tree", "rev-list", "update-ref", "config", "init", "var", "count-objects", "verify-commit", "check-ref-format", "branch"]);
function mayRunPrograms(args, command) {
    if (!command)
        return false;
    const rest = args.slice(args.indexOf(command) + 1);
    if (command === "worktree")
        return rest[0] === "add" || rest[0] === "move" || rest[0] === "repair";
    if (command === "cat-file")
        return rest.some((arg) => arg.startsWith("--filters") || arg.startsWith("--textconv") || arg.startsWith("--batch"));
    return !NO_PROGRAM_COMMANDS.has(command);
}
let hardening;
export function hooklessPath(program, platform = process.platform) {
    return platform === "win32" ? program : "/dev/null";
}
function copyCarriedSettings(program, root, target) {
    for (const key of CARRIED_SETTINGS) {
        for (const scope of ["--system", "--global"]) {
            let values = [];
            try {
                const out = execFileSync(program, ["config", scope, "--get-all", key], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 });
                values = out.split(/\r?\n/).filter(Boolean);
            }
            catch {
            }
            for (const value of values) {
                execFileSync(program, ["config", "--file", target, "--add", key, value], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, stdio: "ignore", windowsHide: true, timeout: 10_000 });
            }
        }
    }
}
export function refreshCarriedSettings() {
    if (!hardening)
        return;
    const { globalConfig } = hardening;
    const root = path.dirname(globalConfig);
    const next = path.join(root, `gitconfig.${process.pid}.next`);
    try {
        const program = gitExecutable(root);
        writeFileSync(next, "");
        copyCarriedSettings(program, root, next);
        chmodSync(next, 0o444);
        chmodSync(globalConfig, 0o644);
        renameSync(next, globalConfig);
    }
    catch {
        try {
            rmSync(next, { force: true });
            chmodSync(globalConfig, 0o444);
        }
        catch {
        }
    }
}
function hardeningFiles(program) {
    if (hardening)
        return hardening;
    const root = mkdtempSync(path.join(os.tmpdir(), "pp-git-"));
    const hooksPath = hooklessPath(program);
    const attributesFile = path.join(root, "attributes");
    writeFileSync(attributesFile, "");
    const globalConfig = path.join(root, "gitconfig");
    writeFileSync(globalConfig, "");
    copyCarriedSettings(program, root, globalConfig);
    chmodSync(attributesFile, 0o444);
    chmodSync(globalConfig, 0o444);
    process.once("exit", () => {
        try {
            chmodSync(attributesFile, 0o644);
            chmodSync(globalConfig, 0o644);
            rmSync(root, { recursive: true, force: true });
        }
        catch {
        }
    });
    hardening = { hooksPath, attributesFile, globalConfig };
    return hardening;
}
export class GitHardeningError extends Error {
}
function checkHardening(files) {
    let size = -1;
    try {
        const stat = lstatSync(files.attributesFile);
        if (stat.isFile())
            size = stat.size;
    }
    catch {
    }
    if (size !== 0) {
        throw new GitHardeningError(`Perfect Planner's empty git attributes file (${files.attributesFile}) was changed, so git could be told to run a program. Git was not run. Restart Perfect Planner; it makes a fresh one.`);
    }
}
const baseEnv = (globalConfig) => {
    const env = {
        ...process.env,
        ...NO_CWD_SEARCH_ENV,
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_PROTOCOL_FROM_USER: "0",
    };
    for (const key of Object.keys(env)) {
        if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|SYSTEM)$/.test(key))
            delete env[key];
    }
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_TEMPLATE_DIR", "GIT_ALLOW_PROTOCOL", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OBJECT_DIRECTORY"])
        delete env[key];
    return env;
};
function subcommand(args) {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "-c" || arg === "-C")
            index += 1;
        else if (!arg.startsWith("-"))
            return arg;
    }
    return undefined;
}
export class GitProgramRefusedError extends Error {
}
const PROGRAM_KEYS = "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver)$";
const MAX_INCLUDE_FILES = 64;
function originRecords(stdout) {
    const fields = stdout.split("\0");
    if (fields.at(-1) === "")
        fields.pop();
    const records = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const entry = fields[index + 1];
        const newline = entry.indexOf("\n");
        records.push(newline < 0 ? { origin: fields[index], key: entry } : { origin: fields[index], key: entry.slice(0, newline), value: entry.slice(newline + 1) });
    }
    if (fields.length % 2)
        records.push({ origin: "", key: "" });
    return records;
}
function includeTarget(origin, value, cwd) {
    if (!origin.startsWith("file:"))
        return { refused: `an include from ${origin || "an unreadable origin"}` };
    if (value === undefined || value === "")
        return { refused: "an include with no path" };
    if (value.startsWith("%("))
        return { refused: `an include path git expands itself (${value})` };
    if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
        return { file: path.join(os.homedir(), value.slice(2)) };
    if (value.startsWith("~"))
        return { refused: `an include path in another user's home folder (${value})` };
    return { file: path.resolve(path.dirname(path.resolve(cwd, origin.slice("file:".length))), value) };
}
export async function filterPrograms(cwd) {
    const found = new Set();
    const seen = new Set();
    const queue = [[]];
    while (queue.length) {
        const source = queue.shift();
        const programs = await spawnGit(cwd, ["config", ...source, "--includes", "-z", "--get-regexp", PROGRAM_KEYS], {});
        for (const entry of programs.stdout.split("\0").filter(Boolean))
            found.add(entry.split("\n")[0]);
        const includes = await spawnGit(cwd, ["config", ...source, "--includes", "-z", "--show-origin", "--get-regexp", "^includeif\\..*\\.path$"], {});
        for (const record of originRecords(includes.stdout)) {
            const target = includeTarget(record.origin, record.value, cwd);
            if ("refused" in target) {
                found.add(`includeIf (${target.refused})`);
                continue;
            }
            if (seen.has(target.file))
                continue;
            seen.add(target.file);
            if (seen.size > MAX_INCLUDE_FILES) {
                found.add(`includeIf (more than ${MAX_INCLUDE_FILES} conditional config files)`);
                return [...found];
            }
            if (existsSync(target.file))
                queue.push(["--file", target.file]);
        }
    }
    return [...found];
}
function refuseFilters(programs) {
    if (!programs.length)
        return;
    throw new GitProgramRefusedError(`This repo's git settings run a program (${programs.join(", ")}) when files are checked out, compared or merged. Perfect Planner will not run it; a person must review and remove it (git config --unset) before continuing.`);
}
function worktreeAddPath(args, at) {
    for (let index = at + 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--")
            return args[index + 1];
        if (arg === "-b" || arg === "-B" || arg === "--reason")
            index += 1;
        else if (!arg.startsWith("-"))
            return arg;
    }
    return undefined;
}
export async function runGit(cwd, args, options = {}) {
    const command = subcommand(args);
    const at = command ? args.indexOf(command) : -1;
    const addsWorktree = command === "worktree" && args[at + 1] === "add";
    if (mayRunPrograms(args, command))
        refuseFilters(await filterPrograms(cwd));
    if (!addsWorktree)
        return spawnGit(cwd, args, options);
    const rest = args.slice(at + 2).filter((arg) => arg !== "--checkout");
    const wantsFiles = !rest.includes("--no-checkout");
    const target = worktreeAddPath(args, at + 1);
    const added = await spawnGit(cwd, [...args.slice(0, at + 2), ...(wantsFiles ? ["--no-checkout"] : []), ...rest], options);
    if (added.code !== 0 || !target)
        return added;
    const folder = path.resolve(cwd, target);
    const programs = await filterPrograms(folder);
    if (programs.length) {
        await spawnGit(cwd, ["worktree", "remove", "--force", folder], {});
        refuseFilters(programs);
    }
    if (!wantsFiles || rest.includes("--orphan"))
        return added;
    const filled = await spawnGit(folder, ["reset", "--hard", "-q"], options);
    return filled.code === 0 ? added : { ...filled, stderr: `${added.stderr}${filled.stderr}` };
}
function spawnGit(cwd, args, options) {
    return new Promise((resolve, reject) => {
        let program;
        let files;
        try {
            program = gitExecutable(cwd);
            files = hardeningFiles(program);
            checkHardening(files);
        }
        catch (error) {
            reject(error);
            return;
        }
        const command = subcommand(args);
        let finalArgs = args;
        if (command && DIFF_COMMANDS.has(command)) {
            const at = args.indexOf(command);
            finalArgs = [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)];
        }
        const fixed = fixedConfig(options.hooksPath ?? files.hooksPath, files.attributesFile).flatMap((setting) => ["-c", setting]);
        const child = spawn(program, ["--no-pager", ...fixed, ...finalArgs], { cwd, env: { ...baseEnv(files.globalConfig), ...options.env, ...NO_CWD_SEARCH_ENV }, windowsHide: true, shell: false });
        const out = [];
        const err = [];
        const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
        child.stdout.on("data", (chunk) => out.push(chunk));
        child.stderr.on("data", (chunk) => err.push(chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            const bytes = Buffer.concat(out);
            resolve({ code: code ?? -1, stdout: bytes.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), stdoutBytes: bytes });
        });
    });
}
export class GitError extends Error {
    args;
    result;
    constructor(args, result) {
        super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
        this.args = args;
        this.result = result;
    }
}
export async function git(cwd, args, options = {}) {
    const result = await runGit(cwd, args, options);
    if (result.code !== 0)
        throw new GitError(args, result);
    return result.stdout.replace(/\r?\n$/, "");
}
