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
 * The project owner key, pinned next to the ledger it belongs to (so a pin can never apply to
 * another ledger under the same project key). The ledger names an owner only when it is opened
 * with this key (core/ledger "The owner"), and the people rules let only that owner start the
 * roster. The host pins the local person's key on the person's first write to a new project
 * (CoreHost.pinOwnerIfNew).
 */
export function ownerPinPath(root: string): string {
  return path.join(root, ".perfect-planner", "owner-key.json");
}

export function readOwnerPin(root: string): string | undefined {
  try {
    const pin = JSON.parse(fs.readFileSync(ownerPinPath(root), "utf8")) as { keyId?: unknown };
    return typeof pin.keyId === "string" && /^k-[0-9a-f]{16,}$/.test(pin.keyId) ? pin.keyId : undefined;
  } catch {
    return undefined;
  }
}

export function writeOwnerPin(root: string, keyId: string, principal: string): void {
  fs.mkdirSync(path.dirname(ownerPinPath(root)), { recursive: true });
  fs.writeFileSync(ownerPinPath(root), `${JSON.stringify({ keyId, principal, pinnedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
}

export function openCoreProject(baseRoot: string, key: string, override?: string, keys?: KeyProvider): CoreProject {
  const root = override ?? path.join(baseRoot, "projects", key);
  fs.mkdirSync(root, { recursive: true });
  const ownerKey = readOwnerPin(root);
  const ledger = Ledger.openSync(new FileStore(root), { ...(keys ? { keys } : {}), ...(ownerKey ? { ownerKey } : {}) });
  // The same rules every core module assumes: numbering (D-/Q-/T-/R- subjects), clauses, people, planning gates.
  installNumberingRules(ledger);
  installClauseRules(ledger);
  installPeopleRules(ledger);
  installPlanningRules(ledger);
  const service = new AgentService({ ledger });
  return { key, root, ledger, service, state: new Map(), entries: () => ledger.entries() };
}
