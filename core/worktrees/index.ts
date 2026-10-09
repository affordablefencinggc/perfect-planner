export { WorktreeManager, WorktreeError, type CreateOptions, type ClaimConflict, type Installer, type RemoveResult, type WorktreeManagerOptions } from "./manager";
export { filterPrograms, git, GitError, GitProgramRefusedError, runGit, type GitOptions, type GitResult } from "./git";
export { caseInsensitiveFs, isWithin, lines, pathKey, realDir, samePath, toRepoPath } from "./platform";
export { evidenceValue, GATE_ACTOR, WATCHER_ACTOR, WORKTREES_ACTOR, type LedgerPort } from "./ports";
export { copyLocalSettings, placeholderSecrets, PLACEHOLDER } from "./settings";
export { branchFor, TASK_ID, type WorktreeInfo } from "./types";
export { ensureRequiredIgnores, PRIVATE_DIR, privatePaths, REQUIRED_IGNORES, stagedPrivatePaths } from "./ignores";
export { ExecutableNotFoundError, findExecutable, gitExecutable, NO_CWD_SEARCH_ENV } from "../exec/index";
export { INSTALL_SCRIPTS_HINT, npmCliPath, NPM_CONFIG_HINT, NpmNotFoundError, runNpm, type NpmRunOptions } from "./npm";
