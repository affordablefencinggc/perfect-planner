// One open core project: its ledger (single writer, spec §2.6) and the agent
// service that agents check in through. The host keeps one per project key.
import fs from "node:fs";
import path from "node:path";
import { FileStore, Ledger, type KeyProvider, type LedgerEntry } from "../ledger/index";
import { installClauseRules } from "../lookup/index";
import { AgentService } from "../mcp/index";
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

/**
 * Supplies the project's owner key id. The ledger names an owner only when it is opened with this
 * key (core/ledger "The owner"), and the people rules let only that owner start the roster. The pin
 * must live outside the project folder (agents can write there), so nothing in the folder is read
 * for it: without an ownerKey source the project opens unowned. The app's signed pin (#25) plugs in
 * here; tests pass their own.
 */
export type OwnerKeySource = (project: { key: string; root: string }) => string | undefined;

export function openCoreProject(baseRoot: string, key: string, override?: string, keys?: KeyProvider, ownerKeyFor?: OwnerKeySource): CoreProject {
  const root = override ?? path.join(baseRoot, "projects", key);
  fs.mkdirSync(root, { recursive: true });
  const ownerKey = ownerKeyFor?.({ key, root });
  const ledger = Ledger.openSync(new FileStore(root), { ...(keys ? { keys } : {}), ...(ownerKey ? { ownerKey } : {}) });
  // The same rules every core module assumes: numbering (D-/Q-/T-/R- subjects), clauses, people, planning gates.
  installNumberingRules(ledger);
  installClauseRules(ledger);
  installPeopleRules(ledger);
  installPlanningRules(ledger);
  const service = new AgentService({ ledger });
  return { key, root, ledger, service, state: new Map(), entries: () => ledger.entries() };
}
