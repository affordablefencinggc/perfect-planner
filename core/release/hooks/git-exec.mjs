// GENERATED from core/exec/executable.ts by core/release/hooks/build-detector.mjs. Do not edit.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
export const NO_CWD_SEARCH_ENV = { NoDefaultCurrentDirectoryInExePath: "1" };
export function isLocalWindowsPath(file) {
    return /^[A-Za-z]:[\\/]/.test(file);
}
const isProgram = (file, windows) => {
    if (!statSync(file).isFile())
        return false;
    if (!windows)
        accessSync(file, constants.X_OK);
    return true;
};
export function findExecutable(name, env, cwd, platform = process.platform, protect = [], io = {}) {
    const windows = platform === "win32";
    const p = windows ? path.win32 : path.posix;
    const real = (file) => realPath(file, io.realpath);
    const program = io.isProgram ?? isProgram;
    const local = (file) => !windows || isLocalWindowsPath(file);
    const pathValue = Object.entries(env).find(([key]) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"))?.[1] ?? "";
    const roots = protectedRoots(cwd, protect, p, real);
    const extensions = windows ? [".exe"] : [""];
    for (const entry of pathValue.split(windows ? ";" : ":")) {
        const dir = entry.trim().replace(/^"(.*)"$/, "$1");
        if (!dir || !p.isAbsolute(dir) || !local(dir))
            continue;
        const realDir = real(dir);
        if (!realDir || !local(realDir) || insideAny(p, roots, p.resolve(dir), realDir))
            continue;
        for (const extension of extensions) {
            const candidate = p.join(dir, `${name}${extension}`);
            try {
                if (!program(candidate, windows))
                    continue;
                const realFile = real(candidate);
                if (!realFile || !local(realFile) || insideAny(p, roots, realFile))
                    continue;
                return candidate;
            }
            catch {
            }
        }
    }
    return null;
}
function realPath(file, realpath = realpathSync.native) {
    try {
        return realpath(file);
    }
    catch {
        return undefined;
    }
}
function protectedRoots(cwd, protect = [], p = path, realOf = (file) => realPath(file)) {
    const roots = new Set();
    for (const root of [cwd, ...protect]) {
        if (typeof root !== "string" || root === "")
            continue;
        const here = p.resolve(root);
        roots.add(here);
        const real = realOf(here);
        if (real)
            roots.add(real);
    }
    return [...roots];
}
function insideAny(p, roots, ...candidates) {
    return roots.some((root) => candidates.some((candidate) => isWithin(root, candidate, p)));
}
export function isWithin(root, candidate, p = path) {
    const relative = p.relative(p.resolve(root), p.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !p.isAbsolute(relative));
}
export class ExecutableNotFoundError extends Error {
}
let cached;
export function gitExecutable(cwd = process.cwd(), protect = []) {
    const pathValue = process.env.PATH ?? process.env.Path ?? "";
    if (cached?.pathValue !== pathValue) {
        const file = findExecutable("git", process.env, cwd);
        if (!file)
            throw new ExecutableNotFoundError("git was not found on PATH (relative PATH entries and the repo folder are never searched). Install Git and restart Perfect Planner.");
        cached = { pathValue, file };
    }
    const roots = protectedRoots(cwd, protect);
    if (insideAny(path, roots, path.resolve(cached.file), realPath(cached.file) ?? path.resolve(cached.file))) {
        const other = findExecutable("git", process.env, cwd, process.platform, protect);
        if (other)
            return other;
        throw new ExecutableNotFoundError(`The only git on PATH (${cached.file}) is inside ${[cwd, ...protect].join(" or ")}, so it could be the repo's own; refusing to run it.`);
    }
    return cached.file;
}
