// One open core project: its ledger (single writer, spec §2.6) and the agent
// service that agents check in through. The host keeps one per project key.
import fs from "node:fs";
import path from "node:path";
import { FileStore, Ledger, type LedgerEntry } from "../ledger/index";
import { installClauseRules } from "../lookup/index";
import { TestGate, gateRule } from "../gate/index";
import { AgentService } from "../mcp/index";
import type { HostKeys } from "./keys";
import { installNumberingRules } from "../numbering/index";
import { installPeopleRules } from "../people/index";
import { installPlanningRules } from "../planning/index";

export interface CoreProject {
  /** Safe key from the client ("default" when none was given). */
  key: string;
  /** Folder whose .perfect-planner/ledger holds this project's ledger. */
  root: string;
  ledger: Ledger;
  service: AgentService;
  /** Per-screen scratch state that is not ledger truth (e.g. a planning session in progress). */
  state: Map<string, unknown>;
  entries(): readonly LedgerEntry[];
}

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function projectKey(raw: string | null | undefined): string {
  const key = (raw ?? "").trim();
  return KEY.test(key) ? key : "default";
}

// The project's owner key id lives in the app's own folder, never in the ledger: anyone who can
// write the ledger file could otherwise write its first person line and name themselves owner.
function ownerFile(baseRoot: string, key: string): string {
  return path.join(baseRoot, "owners", `${key}.json`);
}

export function readOwnerKey(baseRoot: string, key: string): string | undefined {
  try {
    const value = (JSON.parse(fs.readFileSync(ownerFile(baseRoot, key), "utf8")) as { ownerKey?: unknown }).ownerKey;
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeOwnerKey(baseRoot: string, key: string, ownerKey: string): void {
  const file = ownerFile(baseRoot, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ownerKey, at: new Date().toISOString() }, null, 2));
}

/**
 * The owner key to open with, when one is pinned. Pinning happens once, from this app's own write:
 * the key that signs a project's first person entry here is recorded as its owner key. A ledger that
 * already has person entries but no pin (made before pinning existed) stays unpinned: guessing the
 * owner from the ledger file itself is exactly what pinning is there to stop.
 */
function pinOwnerOnFirstPersonEntry(baseRoot: string, key: string, root: string, ledger: Ledger): void {
  if (new FileStore(root).load().entries.some((e) => e.actor?.kind === "person")) return;
  const stop = ledger.subscribe((entry) => {
    if (entry.actor?.kind !== "person") return;
    stop();
    if (entry.sig?.key && !readOwnerKey(baseRoot, key)) writeOwnerKey(baseRoot, key, entry.sig.key);
  });
}

export function openCoreProject(baseRoot: string, key: string, override: string | undefined, keys: HostKeys): CoreProject {
  const root = override ?? path.join(baseRoot, "projects", key);
  fs.mkdirSync(root, { recursive: true });
  keys.ensureSystemKey();
  const ownerKey = readOwnerKey(baseRoot, key);
  const ledger = Ledger.openSync(new FileStore(root), { keys, ...(ownerKey ? { ownerKey } : {}) });
  if (!ownerKey) pinOwnerOnFirstPersonEntry(baseRoot, key, root, ledger);
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
  return { key, root, ledger, service, state: new Map(), entries: () => ledger.entries() };
}
