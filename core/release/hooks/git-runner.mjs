// GENERATED from core/worktrees/git.ts by core/release/hooks/build-detector.mjs. Do not edit.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
];
const DIFF_COMMANDS = new Set(["diff", "show", "log", "diff-tree", "diff-index", "diff-files"]);
const WORKTREE_COMMANDS = new Set(["merge", "worktree", "status", "diff", "add", "checkout", "switch", "reset", "stash", "commit", "read-tree", "checkout-index", "apply", "restore", "rm", "mv", "cherry-pick", "rebase", "revert", "am", "pull"]);
let hardening;
function hardeningFiles(program) {
    if (hardening)
        return hardening;
    const root = mkdtempSync(path.join(os.tmpdir(), "pp-git-"));
    const hooksPath = path.join(root, "no-hooks");
    mkdirSync(hooksPath);
    const attributesFile = path.join(root, "attributes");
    writeFileSync(attributesFile, "");
    const globalConfig = path.join(root, "gitconfig");
    writeFileSync(globalConfig, "");
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
                execFileSync(program, ["config", "--file", globalConfig, "--add", key, value], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, stdio: "ignore", windowsHide: true, timeout: 10_000 });
            }
        }
    }
    hardening = { hooksPath, attributesFile, globalConfig };
    return hardening;
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
    };
    for (const key of Object.keys(env)) {
        if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|SYSTEM)$/.test(key))
            delete env[key];
    }
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_TEMPLATE_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OBJECT_DIRECTORY"])
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
export async function filterPrograms(cwd) {
    const result = await spawnGit(cwd, ["config", "--includes", "--get-regexp", "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver)$"], {});
    return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split(" ")[0]);
}
export async function runGit(cwd, args, options = {}) {
    const command = subcommand(args);
    const checksOut = command === "worktree" ? args[args.indexOf(command) + 1] === "add" : !!command && WORKTREE_COMMANDS.has(command);
    if (checksOut) {
        const programs = await filterPrograms(cwd);
        if (programs.length) {
            throw new GitProgramRefusedError(`This repo's git settings run a program (${programs.join(", ")}) when files are checked out, compared or merged. Perfect Planner will not run it; a person must review and remove it (git config --unset) before continuing.`);
        }
    }
    return spawnGit(cwd, args, options);
}
function spawnGit(cwd, args, options) {
    return new Promise((resolve, reject) => {
        let program;
        let files;
        try {
            program = gitExecutable(cwd);
            files = hardeningFiles(program);
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
