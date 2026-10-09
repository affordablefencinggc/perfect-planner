export declare const SECRET_PATTERNS: [string, RegExp][];
export declare function scanDiff(diff: string): { file: string; line: number; rule: string }[];
export declare function resolveGit(env: NodeJS.ProcessEnv, cwd: string, platform?: NodeJS.Platform, io?: { realpath?: (file: string) => string; isProgram?: (file: string, windows: boolean) => boolean }): string | null;
