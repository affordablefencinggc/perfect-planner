// GENERATED from core/exec/executable.ts by core/release/hooks/build-detector.mjs. Do not edit.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
export const NO_CWD_SEARCH_ENV = { NoDefaultCurrentDirectoryInExePath: "1" };
export function isLocalWindowsPath(file) {
    return /^[A-Za-z]:[\\/]/.test(file);
}
const isNetworkPath = (dir, platform) => platform === "win32" && !isLocalWindowsPath(dir);
export function findExecutable(name, env, cwd, platform = process.platform) {
    const windows = platform === "win32";
    const pathValue = Object.entries(env).find(([key]) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"))?.[1] ?? "";
    const roots = protectedRoots(cwd);
    const extensions = windows ? [".exe"] : [""];
    for (const entry of pathValue.split(windows ? ";" : ":")) {
        const dir = entry.trim().replace(/^"(.*)"$/, "$1");
        if (!dir || !path.isAbsolute(dir) || isNetworkPath(dir, platform))
            continue;
        const realDir = realPath(dir);
        if (!realDir || isNetworkPath(realDir, platform) || insideAny(roots, path.resolve(dir), realDir))
            continue;
        for (const extension of extensions) {
            const candidate = path.join(dir, `${name}${extension}`);
            try {
                if (!statSync(candidate).isFile())
                    continue;
                if (!windows)
                    accessSync(candidate, constants.X_OK);
                const realFile = realPath(candidate);
                if (!realFile || insideAny(roots, realFile))
                    continue;
                return candidate;
            }
            catch {
            }
        }
    }
    return null;
}
function realPath(p) {
    try {
        return realpathSync.native(p);
    }
    catch {
        return undefined;
    }
}
function protectedRoots(cwd) {
    const here = path.resolve(cwd);
    const real = realPath(here);
    return real && real !== here ? [here, real] : [here];
}
function insideAny(roots, ...candidates) {
    return roots.some((root) => candidates.some((candidate) => isWithin(root, candidate)));
}
export function isWithin(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export class ExecutableNotFoundError extends Error {
}
let cached;
export function gitExecutable(cwd = process.cwd()) {
    const pathValue = process.env.PATH ?? process.env.Path ?? "";
    if (cached?.pathValue !== pathValue) {
        const file = findExecutable("git", process.env, cwd);
        if (!file)
            throw new ExecutableNotFoundError("git was not found on PATH (relative PATH entries and the repo folder are never searched). Install Git and restart Perfect Planner.");
        cached = { pathValue, file };
    }
    if (insideAny(protectedRoots(cwd), path.resolve(cached.file), realPath(cached.file) ?? path.resolve(cached.file))) {
        throw new ExecutableNotFoundError(`The git on PATH (${cached.file}) is inside ${cwd}, so it could be the repo's own; refusing to run it.`);
    }
    return cached.file;
}
