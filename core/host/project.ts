// One open core project: its ledger (single writer, spec §2.6) and the agent
// service that agents check in through. The host keeps one per project key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore, Ledger, type LedgerEntry } from "../ledger/index";
import { installClauseRules } from "../lookup/index";
import { TestGate, appNodeDir, gateRule, resolveCommand, runTestCommand, scrubbedEnv, testEnv, type GatePolicy, type TestRunner } from "../gate/index";
import { AgentService } from "../mcp/index";
import type { HostKeys } from "./keys";
import { hostWitness } from "./witness";
import { readOwnerPin, rememberedGenesis, rememberFolder, writeOwnerPin, type OwnerPin } from "./owner";
import { DEFAULT_LOCAL_PERSON } from "./routes/people";
import { installNumberingRules } from "../numbering/index";
import { installPeopleRules, listAgent } from "../people/index";
import { installPlanningRules } from "../planning/index";
import { installReleaseRules, protectProject, type CommandRunner, type ProtectionReport } from "../release/index";
import { extraRepoRoots } from "../repos/index";
import { ensureRequiredIgnores, PRIVATE_DIR, runGit } from "../worktrees/index";
import { containedRunner, protectRoots, registeredRoots } from "../exec/index";
import type { ProjectWatch } from "./watch";

export interface CoreProject {
  /** Safe key from the client ("default" when none was given). */
  key: string;
  /** Folder whose .perfect-planner/ledger holds this project's ledger. */
  root: string;
  /** True when `root` is the app's own data folder (the normal case), not a folder the person's project lives in. */
  appData: boolean;
  ledger: Ledger;
  service: AgentService;
  /**
   * The gate policy, shared by the ledger rule and the gate. requireJevTestReview is on while a Jev
   * key is saved in Settings (host.ts syncs it on every request), so work waits for Jev's test review.
   */
  policy: GatePolicy;
  /** Whether the owner key this ledger was opened with is pinned and signed (core/host/owner.ts). */
  owner: OwnerPin;
  /** Done once .perfect-planner/ is in the repo's info/exclude (when the project folder is inside a git repo). */
  ready: Promise<void>;
  /** Shipping safety (core/release protectProject): release rules on the ledger, pre-push scan in the repo. */
  protection: Promise<ProtectionReport>;
  /**
   * Adds folders the host itself chose for this project (the repo the person picked, worktrees it made) to
   * the roots no program is ever started from (core/exec protectRoots). The project folder is added at open.
   * Never fed from a walk up to .git: a home-folder dotfiles repo must not block ~/bin.
   */
  protectRoots(roots: readonly string[]): void;
  /** Removes this project's protected roots (the host calls it when it closes the project). */
  releaseRoots(): void;
  /** The git watcher the host started for this project (core/host/watch.ts); the host stops it before the ledger closes. */
  watch?: ProjectWatch;
  /** Per-screen scratch state that is not ledger truth (e.g. a planning session in progress). */
  state: Map<string, unknown>;
  entries(): readonly LedgerEntry[];
}

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Names Windows treats as devices (with or without an extension), wherever the folder is made. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Whether a (trimmed, non-empty) name may become a project's folder name on every OS the app runs on. */
function safeFolderName(key: string): boolean {
  // A trailing dot is dropped by Windows ("beta." would be "beta"); a device name is not a folder there.
  return KEY.test(key) && !key.endsWith(".") && !DEVICE_NAME.test(key);
}

export function projectKey(raw: string | null | undefined): string {
  const key = (raw ?? "").trim();
  return safeFolderName(key) ? key : "default";
}

/**
 * Why a project name sent with a request cannot be used, or undefined when it can. No name (or an empty
 * one) means the "default" project. A name that is present but unusable is refused, never turned into
 * "default": two different bad names must not end up sharing one project's ledger.
 */
export function projectKeyProblem(raw: string | null | undefined): string | undefined {
  const key = (raw ?? "").trim();
  if (!key || safeFolderName(key)) return undefined;
  return "That project name cannot be used. Use letters, digits, dots, dashes and underscores, start with a letter or digit, stay under 64 characters, do not end with a dot and do not use a name Windows reserves for devices (con, nul, aux, prn, com1, lpt1).";
}

/**
 * Runs git, and only git, for what the host asks (protectProject, the private-folder exclude, earlier-use
 * signals) through core/worktrees' runner: git by absolute path, never one in the user's repo, with the
 * runner's own protections against repo configuration. Anything else is refused.
 */
export const runCommand: CommandRunner = async (command, args, options) => {
  if (command !== "git") return { code: 127, stdout: "", stderr: `The host only runs git, not ${command}.` };
  try {
    // The runner fixes core.hooksPath to an empty folder for its own calls, so asking it where hooks live
    // would name that folder. The pre-push shim must land where the person's own git push looks.
    if (args.length === 3 && args[0] === "rev-parse" && args[1] === "--git-path" && args[2] === "hooks") return await repoHooksDir(options?.cwd ?? process.cwd());
    const result = await runGit(options?.cwd ?? process.cwd(), [...args]);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: (error as Error).message };
  }
};

/**
 * Where the person's own git looks for this repo's hooks: core.hooksPath from their system, global, repo or
 * worktree config (the last one set wins, as in git; command-line values are the runner's own and skipped),
 * else the hooks folder in the repo's common git folder. Reading config runs nothing.
 */
async function repoHooksDir(cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const own = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL || path.join(os.homedir(), ".gitconfig"), GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM ?? "0" };
  const set = await runGit(cwd, ["config", "--show-scope", "--get-all", "core.hooksPath"], { env: own });
  const values = set.code === 0 ? set.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t")).filter(([scope, value]) => scope !== "command" && value) : [];
  const chosen = values.at(-1)?.[1];
  if (chosen) {
    const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return top;
    const expanded = chosen.startsWith("~/") ? path.join(os.homedir(), chosen.slice(2)) : chosen;
    return { code: 0, stdout: path.resolve(top.stdout.trim(), expanded), stderr: "" };
  }
  const common = await runGit(cwd, ["rev-parse", "--git-common-dir"]);
  return common.code === 0 ? { code: 0, stdout: path.join(path.resolve(cwd, common.stdout.trim()), "hooks"), stderr: "" } : common;
}

/**
 * protectProject for a folder, but only when the folder is itself the top of a git repository: a
 * project folder that merely sits inside some other checkout must never get that checkout's hook.
 */
export async function protectRepository(ledger: Ledger, dir: string): Promise<ProtectionReport> {
  await excludePrivateFolder(dir);
  try {
    const top = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    const real = (p: string) => fs.realpathSync.native(p);
    if (top.code === 0 && top.stdout.trim() && real(top.stdout.trim()) === real(dir)) return await protectProject(ledger, { run: runCommand, cwd: dir, protect: registeredRoots() });
  } catch (error) {
    installReleaseRules(ledger);
    return { rules: "on", prePush: { state: "not-a-repo", reason: (error as Error).message } };
  }
  installReleaseRules(ledger);
  return { rules: "on", prePush: { state: "not-a-repo", reason: `${dir} is not the top of a git repository, so there is nothing to scan before a push.` } };
}

/** A whole drive or the home folder: never a project's repo, never a protected root (it would block ~/bin). */
export function isHomeOrDrive(dir: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const resolved = real(dir);
  return same(path.dirname(resolved), resolved) || same(resolved, real(os.homedir()));
}

/**
 * The workers' git folder a person chose for this project (POST /tasks/repo writes repo.json), if any.
 * Never a whole drive or the home folder.
 */
export function chosenRepository(root: string): string | null {
  try {
    const chosen = (JSON.parse(fs.readFileSync(path.join(root, PRIVATE_DIR, "repo.json"), "utf8")) as { root?: unknown }).root;
    if (typeof chosen !== "string" || !path.isAbsolute(chosen) || !fs.existsSync(chosen)) return null;
    return isHomeOrDrive(chosen) ? null : chosen;
  } catch {
    return null;
  }
}

/** Folder whose .perfect-planner/ holds a project's ledger. */
export function projectRootFor(baseRoot: string, key: string, override?: string): string {
  if (override) return override;
  const projects = path.join(baseRoot, "projects");
  const root = path.join(projects, key);
  // Defence in depth: the host refuses odd names first, but nothing may build a path outside projects/.
  if (!safeFolderName(key) || path.dirname(root) !== projects) throw new Error(`"${key}" is not a project name that can be a folder.`);
  return root;
}

/**
 * Keeps a folder's .perfect-planner/ (ledger, worker tokens, briefs, worktrees) out of git when the folder
 * is inside a repository, so `git add -A` can never stage it (core/worktrees ensureRequiredIgnores).
 * Never throws: a folder outside git has nothing to exclude.
 */
export async function excludePrivateFolder(dir: string): Promise<string[]> {
  try {
    const top = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    if (top.code !== 0 || !top.stdout.trim()) return [];
    const rel = path.relative(fs.realpathSync.native(top.stdout.trim()), fs.realpathSync.native(dir)).split(path.sep).join("/");
    if (rel.startsWith("..")) return [];
    return await ensureRequiredIgnores(dir, rel ? [`/${rel}/${PRIVATE_DIR}/`] : []);
  } catch {
    return [];
  }
}

/**
 * The owner key to open with (core/host/owner.ts). A signed pin for this ledger's genesis is used. A ledger
 * nobody has written to as a person opens with this device's person key, which the host pins on the first
 * write from the person's window. A ledger with person entries but no usable pin opens with no owner, and
 * a folder whose ledger was deleted or swapped is reported, never treated as new.
 */
function ownerPinFor(baseRoot: string, root: string, keys: HostKeys): OwnerPin {
  const entries = new FileStore(root).load().entries;
  const genesis = entries[0]?.hash;
  const remembered = rememberedGenesis(baseRoot, root, keys);
  if (remembered && remembered !== genesis) {
    return { state: "replaced", ...(genesis ? { genesis } : {}), reason: genesis ? "This folder's ledger was swapped for another one since this computer last opened it." : "This folder's ledger was deleted since this computer last opened it." };
  }
  if (genesis) {
    const pin = readOwnerPin(baseRoot, genesis, keys);
    if (pin.state === "pinned") {
      if (!remembered) rememberFolder(baseRoot, root, genesis, keys);
      return pin;
    }
    if (entries.some((e) => e.actor?.kind === "person")) {
      return pin.state === "missing" ? { state: "missing", genesis, reason: "This computer has no owner record for this project: it was made on another computer, or before Perfect Planner recorded owners." } : pin;
    }
  }
  const principal = `person:${DEFAULT_LOCAL_PERSON}`;
  const ownerKey = keys.ownerKeyFor(principal);
  if (!ownerKey) return { state: "unavailable", reason: `This device has no key store, so the project has no owner.${keys.state().reason ? ` ${keys.state().reason}` : ""}` };
  return { state: "new", ownerKey, principal, ...(genesis ? { genesis } : {}) };
}

/**
 * Signs that Perfect Planner was used in a folder's repo before: our pre-push scan hook, pp/* task
 * branches, or .perfect-planner in the repo's info/exclude. Read before the app touches the repo (the open
 * itself adds the exclude line and the hook). Signals, not proof; never throws.
 */
export async function priorUseSignals(dir: string): Promise<string[]> {
  const signals: string[] = [];
  const gitPath = async (name: string) => {
    const result = await runCommand("git", ["rev-parse", "--git-path", name], { cwd: dir });
    return result.code === 0 && result.stdout.trim() ? path.resolve(dir, result.stdout.trim()) : null;
  };
  const read = (file: string | null) => {
    try {
      return file ? fs.readFileSync(file, "utf8") : "";
    } catch {
      return "";
    }
  };
  try {
    if ((await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir })).code !== 0) return [];
    const hooks = await gitPath("hooks");
    if (read(hooks && path.join(hooks, "pre-push")).includes("Perfect Planner")) signals.push("This repo has Perfect Planner's pre-push scan installed.");
    const branches = await runCommand("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/pp/"], { cwd: dir });
    const names = branches.code === 0 ? branches.stdout.split(/\r?\n/).filter(Boolean) : [];
    if (names.length) signals.push(`This repo has ${names.length} Perfect Planner task branch${names.length === 1 ? "" : "es"} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}).`);
    if (/\.perfect-planner\//.test(read(await gitPath("info/exclude")))) signals.push("This repo already keeps a .perfect-planner folder out of git.");
  } catch {
    return signals;
  }
  return signals;
}

/**
 * Pins a new project's owner after a write from the person's own window (host.ts): the ledger now has a
 * genesis, and the pin for it is signed and kept in the app's data folder.
 */
export function pinOwnerAfterWrite(baseRoot: string, project: CoreProject, keys: HostKeys): void {
  const owner = project.owner;
  const genesis = project.entries()[0]?.hash;
  if (owner.state !== "new" || !owner.ownerKey || !owner.principal || !genesis) return;
  if (writeOwnerPin(baseRoot, project.root, genesis, keys, owner.ownerKey, owner.principal)) {
    project.owner = { ownerKey: owner.ownerKey, principal: owner.principal, state: "pinned", genesis };
  }
}

/**
 * Supplies a project's owner key id in place of the app's signed pin (CoreHostOptions.ownerKey). The
 * app itself never passes one: its supplier is the pin above. Undefined: the project opens unowned.
 */
export type OwnerKeySource = (project: { key: string; root: string }) => string | undefined;

function ownerFromSource(source: OwnerKeySource, key: string, root: string, keys: HostKeys): OwnerPin {
  const ownerKey = source({ key, root });
  if (!ownerKey) return { state: "missing", reason: "No owner key was supplied for this project." };
  const principal = keys.trustedKeys().find((k) => k.keyId === ownerKey)?.principal;
  return principal ? { state: "pinned", ownerKey, principal } : { state: "key-missing", ownerKey, reason: `The owner's key ${ownerKey} is not on this device.` };
}

export type IntegrityState =
  /** The chain checks out and the head matches the copy kept outside the project. */
  | "ok"
  /** Entries this computer saw written are gone: an older copy of the ledger was put back, or its end was cut. */
  | "rolled-back"
  /** The ledger fails its fingerprint or signature check for another reason. */
  | "damaged"
  /** The chain checks out, but the head copy outside the project cannot be read or updated. */
  | "witness-problem";

export interface LedgerIntegrity {
  state: IntegrityState;
  reason?: string;
  /** Whether the ledger accepts writes (a broken chain refuses them until a person acknowledges it). */
  writesStopped: boolean;
}

/** What GET /status reports about the ledger's own integrity, in one place for the window's stop notice. */
export function ledgerIntegrity(ledger: Ledger): LedgerIntegrity {
  const status = ledger.status;
  if (!status.ok) {
    return { state: status.problem === "truncated" ? "rolled-back" : "damaged", ...(status.detail ? { reason: status.detail } : {}), writesStopped: true };
  }
  if (status.witnessProblem) return { state: "witness-problem", reason: status.witnessProblem, writesStopped: false };
  return { state: "ok", writesStopped: false };
}

/**
 * "Contain test commands" (opt-in, PP_CONTAIN_TESTS=1): run the gate's test commands inside the OS
 * sandbox of core/exec/sandbox.ts. The gate's own runner still does the work inside the wrapper, and the
 * planted-program checks run first on the command as written. Off, the gate runs tests as before.
 */
export function testRunnerFor(env: NodeJS.ProcessEnv = process.env): TestRunner | undefined {
  if (env.PP_CONTAIN_TESTS !== "1") return undefined;
  return containedRunner({
    base: runTestCommand,
    nodeDir: appNodeDir(),
    precheck: (command, cwd, options) => {
      const protect = options.protect ?? [];
      const resolved = resolveCommand(command, cwd, testEnv(scrubbedEnv(process.env, options.env), { cwd, protect }), protect);
      if (resolved.kind === "missing") return `command not found: ${resolved.program}`;
      if (resolved.kind === "inside") return `refused: ${resolved.program} is ${resolved.file}, inside the project or one of its worktrees, so it could be a planted copy that reports a pass without running the test. Start the test with an installed program (node, npm, npx, python), then a script path.`;
      if (resolved.kind === "unclear") return `refused: Perfect Planner can't tell which program "${resolved.program}" starts. Start the test with a plain program name or path.`;
      return undefined;
    },
  });
}

export function openCoreProject(baseRoot: string, key: string, override: string | undefined, keys: HostKeys, ownerKeyFor?: OwnerKeySource): CoreProject {
  const root = projectRootFor(baseRoot, key, override);
  fs.mkdirSync(root, { recursive: true });
  keys.ensureSystemKey();
  const owner = ownerKeyFor ? ownerFromSource(ownerKeyFor, key, root, keys) : ownerPinFor(baseRoot, root, keys);
  // The head copy outside the project folder (core/host/witness.ts): an older valid ledger put back reads as cut short.
  const ledger = Ledger.openSync(new FileStore(root), { keys, witness: hostWitness(baseRoot, keys), ...(owner.ownerKey ? { ownerKey: owner.ownerKey } : {}) });
  // The same rules every core module assumes: numbering (D-/Q-/T-/R- subjects), clauses, people, planning gates.
  installNumberingRules(ledger);
  installClauseRules(ledger);
  installPeopleRules(ledger);
  installPlanningRules(ledger);
  // Test first, on by default (spec 5.1): no claim until a person approved the test and it failed
  // on the current code, and only the gate writes task.done after the test passes on the merge.
  const policy: GatePolicy = { requireJevTestReview: false };
  ledger.addRule(gateRule(policy));
  const run = testRunnerFor();
  const gate = new TestGate({ ledger, requireJevTestReview: policy.requireJevTestReview, ...(run ? { run } : {}) });
  // TestGate copies its policy; give it the shared object so the host's switch reaches the gate and the rule together.
  Object.assign(gate, { policy });
  const service = new AgentService({ ledger, gate, onJoin: (agent) => listAgent(ledger, agent.person, agent.id) });
  // Shipping safety on for every project the app opens: the release rules hold before the first
  // review, and the whole-branch secret scan runs before every push (a non-git folder is reported).
  // The host excludes .perfect-planner/ before it opens a project for a request (host.ts openProject);
  // this repeats it for direct callers, and every request waits for it.
  const guarded = new Set<string>();
  const releases: (() => void)[] = [];
  const guard = (roots: readonly string[]) => {
    const fresh = roots.filter((r) => typeof r === "string" && path.isAbsolute(r) && !guarded.has(r) && !isHomeOrDrive(r));
    if (!fresh.length) return;
    fresh.forEach((r) => guarded.add(r));
    releases.push(protectRoots(fresh));
  };
  guard([root]);
  const releaseRoots = () => {
    releases.splice(0).forEach((release) => release());
    guarded.clear();
  };
  const ready = excludePrivateFolder(root).then(() => undefined);
  // Every open also rewrites our pre-push shim in the workers' repository, so it names the Node and
  // hook this copy of the app ships (an app update moves both; a stale shim would refuse every push).
  const protection = ready.then(async () => {
    const report = await protectRepository(ledger, root);
    const chosen = chosenRepository(root);
    if (chosen && path.resolve(chosen) !== path.resolve(root)) {
      guard([chosen]);
      await protectRepository(ledger, chosen).catch(() => undefined);
    }
    // Each extra repo of the project gets the same pre-push scan (core/repos).
    for (const extra of extraRepoRoots(root)) {
      if (!fs.existsSync(extra) || isHomeOrDrive(extra)) continue;
      guard([extra]);
      await protectRepository(ledger, extra).catch(() => undefined);
    }
    return report;
  });
  return { key, root, appData: override === undefined, ledger, service, policy, owner, ready, protection, protectRoots: guard, releaseRoots, state: new Map(), entries: () => ledger.entries() };
}
