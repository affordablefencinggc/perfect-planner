// One open core project: its ledger (single writer, spec §2.6) and the agent
// service that agents check in through. The host keeps one per project key.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FileStore, Ledger, type LedgerEntry } from "../ledger/index";
import { installClauseRules } from "../lookup/index";
import { TestGate, gateRule, type GatePolicy } from "../gate/index";
import { AgentService } from "../mcp/index";
import type { HostKeys } from "./keys";
import { hostWitness } from "./witness";
import { readOwnerPin, rememberedGenesis, rememberFolder, writeOwnerPin, type OwnerPin } from "./owner";
import { DEFAULT_LOCAL_PERSON } from "./routes/people";
import { installNumberingRules } from "../numbering/index";
import { installPeopleRules } from "../people/index";
import { installPlanningRules } from "../planning/index";
import { installReleaseRules, protectProject, type CommandRunner, type ProtectionReport } from "../release/index";
import { ensureRequiredIgnores, PRIVATE_DIR } from "../worktrees/index";
import { gitExecutable, NO_CWD_SEARCH_ENV, protectRoots } from "../exec/index";

export interface CoreProject {
  /** Safe key from the client ("default" when none was given). */
  key: string;
  /** Folder whose .perfect-planner/ledger holds this project's ledger. */
  root: string;
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
  /** Per-screen scratch state that is not ledger truth (e.g. a planning session in progress). */
  state: Map<string, unknown>;
  entries(): readonly LedgerEntry[];
}

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function projectKey(raw: string | null | undefined): string {
  const key = (raw ?? "").trim();
  return KEY.test(key) ? key : "default";
}

/**
 * Runs git (and only what protectProject asks for) without a shell. git is started by absolute path
 * with the current folder left out of the program search, never a git found in the user's repo (core/exec).
 */
export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    let program = command;
    try {
      if (command === "git") program = gitExecutable(options?.cwd ?? process.cwd());
    } catch (error) {
      return resolve({ code: 127, stdout: "", stderr: (error as Error).message });
    }
    execFile(program, [...args], { cwd: options?.cwd, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...NO_CWD_SEARCH_ENV } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (error ? error.message : "")) });
    });
  });

/**
 * protectProject for a folder, but only when the folder is itself the top of a git repository: a
 * project folder that merely sits inside some other checkout must never get that checkout's hook.
 */
export async function protectRepository(ledger: Ledger, dir: string): Promise<ProtectionReport> {
  await excludePrivateFolder(dir);
  try {
    const top = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    const real = (p: string) => fs.realpathSync.native(p);
    if (top.code === 0 && top.stdout.trim() && real(top.stdout.trim()) === real(dir)) return await protectProject(ledger, { run: runCommand, cwd: dir });
  } catch (error) {
    installReleaseRules(ledger);
    return { rules: "on", prePush: { state: "not-a-repo", reason: (error as Error).message } };
  }
  installReleaseRules(ledger);
  return { rules: "on", prePush: { state: "not-a-repo", reason: `${dir} is not the top of a git repository, so there is nothing to scan before a push.` } };
}

/** Folder whose .perfect-planner/ holds a project's ledger. */
export function projectRootFor(baseRoot: string, key: string, override?: string): string {
  return override ?? path.join(baseRoot, "projects", key);
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
  if (!ownerKey) return { state: "unavailable", reason: "This device has no key store, so the project has no owner." };
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
  const gate = new TestGate({ ledger, requireJevTestReview: policy.requireJevTestReview });
  // TestGate copies its policy; give it the shared object so the host's switch reaches the gate and the rule together.
  Object.assign(gate, { policy });
  const service = new AgentService({ ledger, gate });
  // Shipping safety on for every project the app opens: the release rules hold before the first
  // review, and the whole-branch secret scan runs before every push (a non-git folder is reported).
  // The host excludes .perfect-planner/ before it opens a project for a request (host.ts openProject);
  // this repeats it for direct callers, and every request waits for it.
  const guarded = new Set<string>();
  const releases: (() => void)[] = [];
  const guard = (roots: readonly string[]) => {
    const fresh = roots.filter((r) => typeof r === "string" && path.isAbsolute(r) && !guarded.has(r));
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
  const protection = ready.then(() => protectRepository(ledger, root));
  return { key, root, ledger, service, policy, owner, ready, protection, protectRoots: guard, releaseRoots, state: new Map(), entries: () => ledger.entries() };
}
