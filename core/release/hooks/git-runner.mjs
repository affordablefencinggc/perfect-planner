// GENERATED from core/worktrees/git.ts by core/release/hooks/build-detector.mjs. Do not edit.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitExecutable, isLocalWindowsPath, isWithin, NO_CWD_SEARCH_ENV } from "./git-exec.mjs";
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
const directGitCache = new Map();
export function directGit(program, platform = process.platform) {
    if (platform !== "win32")
        return program;
    const known = directGitCache.get(program);
    if (known !== undefined)
        return known;
    let chosen = program;
    try {
        const launcherDir = path.win32.dirname(program);
        if (path.win32.basename(program).toLowerCase() === "git.exe" && path.win32.basename(launcherDir).toLowerCase() === "cmd") {
            const installDir = path.win32.dirname(launcherDir);
            const candidate = path.win32.join(installDir, "mingw64", "bin", "git.exe");
            const realInstall = realpathSync.native(installDir);
            const realCandidate = realpathSync.native(candidate);
            if (statSync(realCandidate).isFile() && isLocalWindowsPath(realCandidate) && isWithin(realInstall, realCandidate, path.win32))
                chosen = candidate;
        }
    }
    catch {
    }
    directGitCache.set(program, chosen);
    return chosen;
}
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
export function copyCarriedSettings(program, root, target) {
    const pattern = "^(" + CARRIED_SETTINGS.map((key) => key.replaceAll(".", "\\.")).join("|") + ")$";
    const scopes = [];
    for (const scope of ["--system", "--global"]) {
        const settings = new Map();
        try {
            const out = execFileSync(program, ["config", scope, "--null", "--get-regexp", pattern], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 });
            for (const record of out.split("\0")) {
                const split = record.indexOf("\n");
                if (split < 0)
                    continue;
                const key = record.slice(0, split), value = record.slice(split + 1);
                if (!CARRIED_SETTINGS.includes(key) || !value)
                    continue;
                settings.set(key, [...(settings.get(key) ?? []), value]);
            }
        }
        catch { }
        scopes.push(settings);
    }
    for (const key of CARRIED_SETTINGS)
        for (const settings of scopes)
            for (const value of settings.get(key) ?? []) {
                execFileSync(program, ["config", "--file", target, "--add", key, value], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, stdio: "ignore", windowsHide: true, timeout: 10_000 });
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
    createdBranch;
    constructor(message, createdBranch = false) {
        super(message);
        this.createdBranch = createdBranch;
        this.name = "GitProgramRefusedError";
    }
}
const PROGRAM_KEYS = "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver)$";
const POLICY_KEYS = "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|include\\.path|includeif\\..*\\.path)$";
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
const FILTER_CACHE_LIMIT = 128;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const filterCache = new Map();
function isMissingPath(error) {
    const code = error?.code;
    return code === "ENOENT" || code === "ENOTDIR";
}
function fingerprintPath(file) {
    let linkStat;
    try {
        linkStat = lstatSync(file);
    }
    catch (error) {
        return isMissingPath(error) ? "missing" : undefined;
    }
    let link = "";
    if (linkStat.isSymbolicLink()) {
        try {
            link = readlinkSync(file);
        }
        catch {
            return undefined;
        }
    }
    let targetStat = linkStat;
    if (linkStat.isSymbolicLink()) {
        try {
            targetStat = statSync(file);
        }
        catch (error) {
            return isMissingPath(error) ? "link:" + link + ":missing" : undefined;
        }
    }
    let content = "";
    if (targetStat.isFile()) {
        if (targetStat.size > MAX_CONFIG_FILE_BYTES)
            return undefined;
        let bytes;
        let after;
        try {
            bytes = readFileSync(file);
            after = statSync(file);
        }
        catch {
            return undefined;
        }
        if (after.dev !== targetStat.dev || after.ino !== targetStat.ino ||
            after.size !== targetStat.size || after.mtimeMs !== targetStat.mtimeMs)
            return undefined;
        content = createHash("sha256").update(bytes).digest("hex");
    }
    if (targetStat.isDirectory())
        return ["directory", link, targetStat.dev, targetStat.ino].join("\0");
    const kind = targetStat.isFile() ? "file" : "other";
    return [kind, link, targetStat.dev, targetStat.ino, targetStat.size, targetStat.mtimeMs, content].join("\0");
}
function configDiscoveryPaths(cwd) {
    const paths = new Set();
    if (hardening)
        paths.add(hardening.globalConfig);
    let directory = path.resolve(cwd);
    let gitDir;
    while (true) {
        const marker = path.join(directory, ".git");
        paths.add(marker);
        let markerStat;
        try {
            markerStat = lstatSync(marker);
        }
        catch (error) {
            if (!isMissingPath(error))
                return undefined;
        }
        if (markerStat) {
            let targetStat = markerStat;
            if (markerStat.isSymbolicLink()) {
                try {
                    targetStat = statSync(marker);
                }
                catch {
                    return undefined;
                }
            }
            if (targetStat.isDirectory()) {
                gitDir = marker;
                break;
            }
            if (targetStat.isFile()) {
                if (targetStat.size > 4096)
                    return undefined;
                let contents;
                try {
                    contents = readFileSync(marker, "utf8");
                }
                catch {
                    return undefined;
                }
                const match = contents.match(/^\s*gitdir:\s*(.+?)\s*$/im);
                if (!match)
                    return undefined;
                gitDir = path.resolve(directory, match[1]);
                paths.add(gitDir);
                break;
            }
            return undefined;
        }
        const parent = path.dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    if (!gitDir) {
        const head = path.join(path.resolve(cwd), "HEAD");
        const objects = path.join(path.resolve(cwd), "objects");
        const refs = path.join(path.resolve(cwd), "refs");
        try {
            if (lstatSync(head).isFile() && lstatSync(objects).isDirectory() && lstatSync(refs).isDirectory())
                gitDir = path.resolve(cwd);
        }
        catch (error) {
            if (!isMissingPath(error))
                return undefined;
        }
    }
    if (gitDir) {
        paths.add(path.join(gitDir, "config"));
        paths.add(path.join(gitDir, "config.worktree"));
        const commonFile = path.join(gitDir, "commondir");
        paths.add(commonFile);
        try {
            const commonStat = statSync(commonFile);
            if (!commonStat.isFile() || commonStat.size > 4096)
                return undefined;
            const common = readFileSync(commonFile, "utf8").trim();
            if (common) {
                const commonDir = path.resolve(gitDir, common);
                paths.add(commonDir);
                paths.add(path.join(commonDir, "config"));
                paths.add(path.join(commonDir, "config.worktree"));
            }
        }
        catch (error) {
            if (!isMissingPath(error))
                return undefined;
        }
    }
    return [...paths];
}
function policyFingerprint(cwd, extraPaths) {
    const discovered = configDiscoveryPaths(cwd);
    if (!discovered)
        return undefined;
    const paths = new Set([...discovered, ...extraPaths]);
    const hash = createHash("sha256");
    for (const file of [...paths].sort()) {
        const value = fingerprintPath(file);
        if (value === undefined)
            return undefined;
        hash.update(path.resolve(file)).update("\0").update(value).update("\0");
    }
    return hash.digest("hex");
}
function filterCacheKey(cwd) {
    try {
        const resolved = path.resolve(cwd);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    }
    catch {
        return undefined;
    }
}
function readFilterCache(key) {
    const entry = filterCache.get(key);
    if (!entry)
        return undefined;
    filterCache.delete(key);
    filterCache.set(key, entry);
    return entry;
}
function writeFilterCache(key, entry) {
    filterCache.delete(key);
    filterCache.set(key, entry);
    if (filterCache.size > FILTER_CACHE_LIMIT) {
        const oldest = filterCache.keys().next().value;
        if (oldest !== undefined)
            filterCache.delete(oldest);
    }
}
function sameStrings(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
async function scanFilterPrograms(cwd) {
    const found = new Set();
    const discovered = configDiscoveryPaths(cwd);
    const paths = new Set(discovered ?? []);
    let cacheable = discovered !== undefined;
    const seen = new Set();
    const queue = [[]];
    while (queue.length) {
        const source = queue.shift();
        const policy = await spawnGit(cwd, ["config", ...source, "--includes", "-z", "--show-origin", "--get-regexp", POLICY_KEYS], {});
        if (policy.code !== 0 && policy.code !== 1)
            cacheable = false;
        for (const record of originRecords(policy.stdout)) {
            if (!record.key || !record.origin)
                cacheable = false;
            if (record.origin.startsWith("file:"))
                paths.add(path.resolve(record.origin.slice("file:".length)));
            if (new RegExp(PROGRAM_KEYS).test(record.key))
                found.add(record.key);
            if (record.key === "include.path") {
                const target = includeTarget(record.origin, record.value, cwd);
                if ("refused" in target)
                    cacheable = false;
                else
                    paths.add(target.file);
                continue;
            }
            if (!/^includeif\..*\.path$/.test(record.key))
                continue;
            const target = includeTarget(record.origin, record.value, cwd);
            if ("refused" in target) {
                found.add("includeIf (" + target.refused + ")");
                continue;
            }
            paths.add(target.file);
            if (seen.has(target.file))
                continue;
            seen.add(target.file);
            if (seen.size > MAX_INCLUDE_FILES) {
                found.add("includeIf (more than " + MAX_INCLUDE_FILES + " conditional config files)");
                cacheable = false;
                return { programs: [...found], paths, cacheable };
            }
            if (existsSync(target.file))
                queue.push(["--file", target.file]);
        }
    }
    if (hardening)
        paths.add(hardening.globalConfig);
    return { programs: [...found], paths, cacheable };
}
function validCachedPrograms(cwd, key) {
    const cached = readFilterCache(key);
    if (!cached)
        return undefined;
    const current = policyFingerprint(cwd, cached.paths);
    if (current && current === cached.fingerprint)
        return [...cached.programs];
    filterCache.delete(key);
    return undefined;
}
const filterScansInFlight = new Map();
export async function filterPrograms(cwd) {
    const key = filterCacheKey(cwd);
    if (key) {
        const cached = validCachedPrograms(cwd, key);
        if (cached)
            return cached;
        const running = filterScansInFlight.get(key);
        if (running) {
            await running.catch(() => undefined);
            const shared = validCachedPrograms(cwd, key);
            if (shared)
                return shared;
        }
    }
    const scan = scanAndCacheFilterPrograms(cwd, key);
    if (!key)
        return scan;
    const mine = scan.catch(() => undefined);
    filterScansInFlight.set(key, mine);
    try {
        return await scan;
    }
    finally {
        if (filterScansInFlight.get(key) === mine)
            filterScansInFlight.delete(key);
    }
}
async function scanAndCacheFilterPrograms(cwd, key) {
    const first = await scanFilterPrograms(cwd);
    if (!key || !first.cacheable)
        return first.programs;
    const firstPaths = [...first.paths].sort();
    const firstFingerprint = policyFingerprint(cwd, firstPaths);
    if (!firstFingerprint)
        return first.programs;
    const second = await scanFilterPrograms(cwd);
    const secondPaths = [...second.paths].sort();
    const secondFingerprint = policyFingerprint(cwd, secondPaths);
    const samePrograms = sameStrings([...first.programs].sort(), [...second.programs].sort());
    if (second.cacheable && sameStrings(firstPaths, secondPaths) &&
        firstFingerprint === secondFingerprint && samePrograms) {
        writeFilterCache(key, { paths: secondPaths, fingerprint: secondFingerprint, programs: [...second.programs] });
        return second.programs;
    }
    return [...new Set([...first.programs, ...second.programs])];
}
function gitEntryMarker(cwd) {
    let directory = path.resolve(cwd);
    while (true) {
        const entry = path.join(directory, ".git");
        try {
            const stat = lstatSync(entry);
            if (stat.isDirectory())
                return ["folder", entry, stat.dev, stat.ino, stat.birthtimeMs].join("\0");
            if (stat.isFile() && stat.size <= 4096)
                return ["file", entry, stat.dev, stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs, readFileSync(entry, "utf8")].join("\0");
            return undefined;
        }
        catch (error) {
            if (!isMissingPath(error))
                return undefined;
        }
        const parent = path.dirname(directory);
        if (parent === directory)
            return undefined;
        directory = parent;
    }
}
function statSignature(file) {
    try {
        const stat = statSync(file);
        return `${stat.size}:${stat.mtimeMs}`;
    }
    catch {
        return "none";
    }
}
export function headIdentity(cwd) {
    const marker = gitEntryMarker(cwd);
    if (!marker)
        return undefined;
    try {
        const parts = marker.split("\0");
        const entry = parts[1];
        let gitDir = entry;
        if (parts[0] === "file") {
            const match = /^gitdir:\s*(.+?)\s*$/im.exec(parts.slice(7).join("\0"));
            if (!match)
                return undefined;
            gitDir = path.resolve(path.dirname(entry), match[1]);
        }
        let commonDir = gitDir;
        if (existsSync(path.join(gitDir, "commondir")))
            commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
        const head = readFileSync(path.join(gitDir, "HEAD"), "utf8");
        const named = /^ref:\s*(refs\/[^\r\n]+?)\s*$/.exec(head);
        if (!named || named[1].includes(".."))
            return undefined;
        const tip = readFileSync(path.join(commonDir, ...named[1].split("/")), "utf8").trim();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(tip))
            return undefined;
        return [marker, head, tip, statSignature(path.join(commonDir, "config")), statSignature(path.join(gitDir, "config.worktree"))].join("\u0001");
    }
    catch {
        return undefined;
    }
}
const COMMON_DIR_TTL_MS = 5 * 60_000;
const COMMON_DIR_LIMIT = 256;
const commonDirCache = new Map();
export async function commonGitDir(cwd) {
    const key = filterCacheKey(cwd);
    const marker = key ? gitEntryMarker(cwd) : undefined;
    if (key && marker) {
        const known = commonDirCache.get(key);
        if (known && known.marker === marker && Date.now() - known.at < COMMON_DIR_TTL_MS && existsSync(known.dir))
            return known.dir;
    }
    const result = await runGit(cwd, ["rev-parse", "--git-common-dir"]).catch(() => null);
    if (!result || result.code !== 0 || !result.stdout.trim())
        return null;
    const dir = path.resolve(cwd, result.stdout.trim());
    if (key && marker) {
        commonDirCache.delete(key);
        commonDirCache.set(key, { dir, marker, at: Date.now() });
        if (commonDirCache.size > COMMON_DIR_LIMIT) {
            const oldest = commonDirCache.keys().next().value;
            if (oldest !== undefined)
                commonDirCache.delete(oldest);
        }
    }
    return dir;
}
function refuseFilters(programs, createdBranch = false) {
    if (!programs.length)
        return;
    throw new GitProgramRefusedError(`This repo's git settings run a program (${programs.join(", ")}) when files are checked out, compared or merged. Perfect Planner will not run it; a person must review and remove it (git config --unset) before continuing.`, createdBranch);
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
function worktreeAddCreatesBranch(args, at) {
    for (let index = at + 2; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--")
            return false;
        if (arg === "-b")
            return Boolean(args[index + 1]);
        if (arg === "-B")
            return false;
        if (arg === "--reason") {
            index += 1;
            continue;
        }
        if (arg.startsWith("-"))
            continue;
        return false;
    }
    return false;
}
export async function runGit(cwd, args, options = {}) {
    const command = subcommand(args);
    const at = command ? args.indexOf(command) : -1;
    const addsWorktree = command === "worktree" && args[at + 1] === "add";
    const createsBranch = addsWorktree && worktreeAddCreatesBranch(args, at);
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
        refuseFilters(programs, createsBranch);
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
            program = directGit(gitExecutable(cwd));
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
