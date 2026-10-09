// GENERATED from core/exec/executable.ts by core/release/hooks/build-detector.mjs. Do not edit.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
export const NO_CWD_SEARCH_ENV = { NoDefaultCurrentDirectoryInExePath: "1" };
const isNetworkPath = (dir, platform) => platform === "win32" && /^[\\/]{2}/.test(dir);
export function findExecutable(name, env, cwd, platform = process.platform) {
    const windows = platform === "win32";
    const pathValue = Object.entries(env).find(([key]) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"))?.[1] ?? "";
    const here = path.resolve(cwd);
    const extensions = windows ? [".exe"] : [""];
    for (const entry of pathValue.split(windows ? ";" : ":")) {
        const dir = entry.trim().replace(/^"(.*)"$/, "$1");
        if (!dir || !path.isAbsolute(dir) || isNetworkPath(dir, platform))
            continue;
        if (isWithin(here, path.resolve(dir)))
            continue;
        for (const extension of extensions) {
            const candidate = path.join(dir, `${name}${extension}`);
            try {
                if (!statSync(candidate).isFile())
                    continue;
                if (!windows)
                    accessSync(candidate, constants.X_OK);
                return candidate;
            }
            catch {
            }
        }
    }
    return null;
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
    if (isWithin(path.resolve(cwd), cached.file)) {
        throw new ExecutableNotFoundError(`The git on PATH (${cached.file}) is inside ${cwd}, so it could be the repo's own; refusing to run it.`);
    }
    return cached.file;
}
