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

export function openCoreProject(baseRoot: string, key: string, override: string | undefined, keys: HostKeys): CoreProject {
  const root = override ?? path.join(baseRoot, "projects", key);
  fs.mkdirSync(root, { recursive: true });
  keys.ensureSystemKey();
  const ledger = Ledger.openSync(new FileStore(root), { keys });
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
