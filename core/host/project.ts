// One open core project: its ledger (single writer, spec §2.6) and the agent
// service that agents check in through. The host keeps one per project key.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FileStore, Ledger, type LedgerEntry } from "../ledger/index";
import { installClauseRules } from "../lookup/index";
import { TestGate, gateRule } from "../gate/index";
import { AgentService } from "../mcp/index";
import type { HostKeys } from "./keys";
import { createOwnerPin, readOwnerPin, type OwnerPin } from "./owner";
import { DEFAULT_LOCAL_PERSON } from "./routes/people";
import { installNumberingRules } from "../numbering/index";
import { installPeopleRules } from "../people/index";
import { installPlanningRules } from "../planning/index";
import { installReleaseRules, protectProject, type CommandRunner, type ProtectionReport } from "../release/index";
import { ensureRequiredIgnores, PRIVATE_DIR } from "../worktrees/index";

export interface CoreProject {
  /** Safe key from the client ("default" when none was given). */
  key: string;
  /** Folder whose .perfect-planner/ledger holds this project's ledger. */
  root: string;
  ledger: Ledger;
  service: AgentService;
  /** Whether the owner key this ledger was opened with is pinned and signed (core/host/owner.ts). */
  owner: OwnerPin;
  /** Done once .perfect-planner/ is in the repo's info/exclude (when the project folder is inside a git repo). */
  ready: Promise<void>;
  /** Shipping safety (core/release protectProject): release rules on the ledger, pre-push scan in the repo. */
  protection: Promise<ProtectionReport>;
  /** Per-screen scratch state that is not ledger truth (e.g. a planning session in progress). */
  state: Map<string, unknown>;
  entries(): readonly LedgerEntry[];
}

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function projectKey(raw: string | null | undefined): string {
  const key = (raw ?? "").trim();
  return KEY.test(key) ? key : "default";
}

/** Runs git (and only what protectProject asks for) without a shell. */
export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd: options?.cwd, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
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
 * The owner key to open with. A signed pin is used. A project nobody has written to as a person yet
 * gets one now: the local person's key, made by the app. A ledger that already has person entries but
 * no pin (from before pinning) opens with no owner rather than taking the owner from its own file.
 */
function ownerPinFor(baseRoot: string, key: string, root: string, keys: HostKeys): OwnerPin {
  const pin = readOwnerPin(baseRoot, key, root, keys);
  if (pin.state === "pinned") return pin;
  const written = new FileStore(root).load().entries.some((e) => e.actor?.kind === "person");
  if (!written) {
    // Nobody has written here as a person, so an earlier pin protects nothing: a pin whose key this
    // device lost (a restart with throwaway keys, a new OS profile) or that fails its check is replaced.
    const made = createOwnerPin(baseRoot, key, root, keys, `person:${DEFAULT_LOCAL_PERSON}`, new Date(), pin.state !== "missing");
    return pin.state === "missing" || made.state !== "created" ? made : { ...made, reason: `Pinned a new owner: ${pin.reason ?? "the earlier pin could not be used"}` };
  }
  if (pin.state === "missing") return { state: "missing", reason: "This project was started before owners were pinned, so it has no owner on this device." };
  return pin;
}

export function openCoreProject(baseRoot: string, key: string, override: string | undefined, keys: HostKeys): CoreProject {
  const root = projectRootFor(baseRoot, key, override);
  fs.mkdirSync(root, { recursive: true });
  keys.ensureSystemKey();
  const owner = ownerPinFor(baseRoot, key, root, keys);
  const ledger = Ledger.openSync(new FileStore(root), { keys, ...(owner.ownerKey ? { ownerKey: owner.ownerKey } : {}) });
  // The same rules every core module assumes: numbering (D-/Q-/T-/R- subjects), clauses, people, planning gates.
  installNumberingRules(ledger);
  installClauseRules(ledger);
  installPeopleRules(ledger);
  installPlanningRules(ledger);
  // Test first, on by default (spec 5.1): no claim until a person approved the test and it failed
  // on the current code, and only the gate writes task.done after the test passes on the merge.
  ledger.addRule(gateRule());
  const gate = new TestGate({ ledger });
  const service = new AgentService({ ledger, gate });
  // Shipping safety on for every project the app opens: the release rules hold before the first
  // review, and the whole-branch secret scan runs before every push (a non-git folder is reported).
  // The host excludes .perfect-planner/ before it opens a project for a request (host.ts openProject);
  // this repeats it for direct callers, and every request waits for it.
  const ready = excludePrivateFolder(root).then(() => undefined);
  const protection = ready.then(() => protectRepository(ledger, root));
  return { key, root, ledger, service, owner, ready, protection, state: new Map(), entries: () => ledger.entries() };
}
