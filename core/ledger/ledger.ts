import { hashEntry, ledgerNumber, parseLedgerNumber, verifyWithAcknowledgements } from "./chain";
import type { LedgerStore } from "./store";
import {
  ACTOR_KINDS,
  ENTRY_TYPES,
  GENESIS_PREV,
  LedgerError,
  REASON_REQUIRED_TYPES,
  type Actor,
  type ChainResult,
  type EntryDraft,
  type LedgerEntry,
  type LedgerStatus,
} from "./types";

export type LedgerRule = (draft: EntryDraft, ledger: Ledger) => string | null;

export interface OpenOptions {
  readOnly?: boolean;
  /** Clock for `at`; tests pass a fixed one. */
  now?: () => Date;
}

const TYPES: ReadonlySet<string> = new Set(ENTRY_TYPES);
const KINDS: ReadonlySet<string> = new Set(ACTOR_KINDS);

export class Ledger {
  private readonly store: LedgerStore;
  private readonly list: LedgerEntry[];
  private readonly index = new Map<string, number>();
  private readonly listeners = new Set<(entry: LedgerEntry) => void>();
  private readonly rules: LedgerRule[] = [];
  private readonly now: () => Date;
  private writable: boolean;
  private chain: ChainResult;
  private acknowledged: string[];

  private constructor(store: LedgerStore, entries: LedgerEntry[], chain: ChainResult, acknowledged: string[], writable: boolean, now: () => Date) {
    this.store = store;
    this.list = entries;
    entries.forEach((entry, i) => this.index.set(entry.n, i));
    this.chain = chain;
    this.acknowledged = acknowledged;
    this.writable = writable;
    this.now = now;
  }

  /** Loads and re-checks the whole chain (spec §2.5), then takes the writer lock unless read-only. */
  static async open(store: LedgerStore, options: OpenOptions = {}): Promise<Ledger> {
    return Ledger.openSync(store, options);
  }

  static openSync(store: LedgerStore, options: OpenOptions = {}): Ledger {
    const loaded = store.load();
    const { result, acknowledged } = verifyWithAcknowledgements(loaded.entries);
    let chain: ChainResult = result;
    if (chain.ok && loaded.parseError) {
      chain = { ok: false, firstBad: loaded.parseError.n, problem: "parse", detail: loaded.parseError.detail };
    }
    if (chain.ok && loaded.head) {
      const last = loaded.entries[loaded.entries.length - 1];
      const head = loaded.head;
      if (!last || (parseLedgerNumber(last.n) ?? 0) < (parseLedgerNumber(head.n) ?? 0)) {
        chain = { ok: false, firstBad: head.n, problem: "truncated", detail: `the ledger ends at ${last?.n ?? "nothing"} but ${head.n} was written` };
      } else if (last.n === head.n && last.hash !== head.hash) {
        chain = { ok: false, firstBad: head.n, problem: "hash", detail: `${head.n} was rewritten after it was recorded` };
      }
    }
    const writable = !options.readOnly && store.acquireWriter();
    return new Ledger(store, loaded.entries, chain, acknowledged, writable, options.now ?? (() => new Date()));
  }

  get status(): LedgerStatus {
    const head = this.last()?.n;
    const base = { writable: this.writable, entries: this.list.length, head, acknowledged: [...this.acknowledged] };
    if (this.chain.ok) return { ok: true, ...base };
    return { ok: false, ...base, brokenAt: this.chain.firstBad, problem: this.chain.problem, detail: this.chain.detail };
  }

  close(): void {
    if (this.writable) this.store.releaseWriter();
    this.writable = false;
  }

  addRule(rule: LedgerRule): () => void {
    this.rules.push(rule);
    return () => {
      const i = this.rules.indexOf(rule);
      if (i >= 0) this.rules.splice(i, 1);
    };
  }

  subscribe(listener: (entry: LedgerEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  entries(): readonly LedgerEntry[] {
    return this.list;
  }

  get(n: string): LedgerEntry | undefined {
    const i = this.index.get(n);
    return i === undefined ? undefined : this.list[i];
  }

  last(): LedgerEntry | undefined {
    return this.list[this.list.length - 1];
  }

  bySubject(subject: string): LedgerEntry[] {
    return this.list.filter((entry) => entry.subject === subject);
  }

  since(n: string): LedgerEntry[] {
    const i = this.index.get(n);
    return i === undefined ? [] : this.list.slice(i + 1);
  }

  range(from: string, to: string): LedgerEntry[] {
    const a = this.index.get(from);
    const b = this.index.get(to);
    if (a === undefined || b === undefined || b < a) return [];
    return this.list.slice(a, b + 1);
  }

  /** Validates, numbers, stamps, chains and persists one entry. */
  append(draft: EntryDraft): LedgerEntry {
    if (!this.writable) throw new LedgerError("READ_ONLY", `this ledger is read-only (${this.store.description})`);
    if (!this.chain.ok) {
      throw new LedgerError("CHAIN_BROKEN", `writes are stopped: ${this.chain.firstBad} failed the fingerprint check (${this.chain.problem}); acknowledge it first`);
    }
    return this.write(draft);
  }

  /**
   * Records that a person has seen the break and reopens writes. The break
   * stays visible as acknowledged on every later open.
   */
  acknowledgeBreak(person: Actor, reason: string): LedgerEntry {
    if (!this.writable) throw new LedgerError("READ_ONLY", `this ledger is read-only (${this.store.description})`);
    if (this.chain.ok) throw new LedgerError("RULE", "the fingerprint chain is intact; there is nothing to acknowledge");
    if (person.kind !== "person") throw new LedgerError("BAD_ACTOR", "only a person can acknowledge a broken chain");
    if (this.chain.problem === "parse") {
      throw new LedgerError("RULE", `${this.chain.firstBad} cannot be read; restore the ledger file from git before writing`);
    }
    if (this.chain.problem === "truncated") {
      throw new LedgerError("RULE", `entries up to ${this.chain.firstBad} are missing; restore them from git before writing`);
    }
    const broken = this.chain;
    const entry = this.write({
      actor: person,
      type: "chain.acknowledged",
      subject: broken.firstBad,
      summary: `Fingerprint break at ${broken.firstBad} acknowledged`,
      reason,
      data: { firstBad: broken.firstBad, problem: broken.problem, detail: broken.detail },
    });
    this.acknowledged.push(broken.firstBad);
    this.chain = { ok: true };
    return entry;
  }

  private write(draft: EntryDraft): LedgerEntry {
    this.validate(draft);
    const previous = this.last();
    let at = this.now();
    if (previous && at.getTime() < Date.parse(previous.at)) at = new Date(previous.at);
    const unsigned: Omit<LedgerEntry, "hash"> = {
      n: ledgerNumber(this.list.length + 1),
      at: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
      actor: { ...draft.actor },
      type: draft.type,
      subject: draft.subject.trim(),
      summary: draft.summary.trim(),
      reason: draft.reason?.trim() || undefined,
      evidence: [...(draft.evidence ?? [])],
      refs: [...(draft.refs ?? [])],
      corrects: draft.corrects,
      data: draft.data === undefined ? undefined : structuredClone(draft.data),
      prev: previous?.hash ?? GENESIS_PREV,
    };
    // Drop undefined so the stored line and the hashed form are the same object.
    for (const key of Object.keys(unsigned) as (keyof typeof unsigned)[]) {
      if (unsigned[key] === undefined) delete unsigned[key];
    }
    if (unsigned.actor.model === undefined) delete unsigned.actor.model;
    const entry = Object.freeze({ ...unsigned, hash: hashEntry(unsigned) }) as LedgerEntry;
    this.store.append(entry);
    this.index.set(entry.n, this.list.length);
    this.list.push(entry);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  private validate(draft: EntryDraft): void {
    if (!draft || typeof draft !== "object") throw new LedgerError("EMPTY_FIELD", "an entry is required");
    if (!TYPES.has(draft.type)) throw new LedgerError("UNKNOWN_TYPE", `unknown entry type "${draft.type}"`);
    const actor = draft.actor;
    if (!actor || !KINDS.has(actor.kind) || !isFilled(actor.id)) {
      throw new LedgerError("BAD_ACTOR", "actor needs a kind (person, agent, jev or system) and an id");
    }
    if ((actor.kind === "agent" || actor.kind === "jev") && !isFilled(actor.model)) {
      throw new LedgerError("BAD_ACTOR", `an ${actor.kind} actor must name its model`);
    }
    if (!isFilled(draft.subject)) throw new LedgerError("EMPTY_FIELD", "subject may not be empty");
    if (!isFilled(draft.summary)) throw new LedgerError("EMPTY_FIELD", "summary may not be empty or TBD");
    if (draft.reason !== undefined && !isFilled(draft.reason)) {
      throw new LedgerError("EMPTY_FIELD", "reason may not be empty or TBD");
    }
    if (REASON_REQUIRED_TYPES.has(draft.type) && !isFilled(draft.reason)) {
      throw new LedgerError("REASON_REQUIRED", `${draft.type} needs a reason`);
    }
    for (const list of [draft.evidence, draft.refs]) {
      if (list !== undefined && (!Array.isArray(list) || list.some((item) => !isFilled(item)))) {
        throw new LedgerError("EMPTY_FIELD", "evidence and refs must be lists of non-empty strings");
      }
    }
    if (draft.type === "correction" && draft.corrects === undefined) {
      throw new LedgerError("BAD_CORRECTS", "a correction must name the entry it corrects");
    }
    if (draft.corrects !== undefined && !this.get(draft.corrects)) {
      throw new LedgerError("BAD_CORRECTS", `${draft.corrects} is not an existing entry`);
    }
    if (draft.type === "task.done") this.checkDone(draft.subject.trim());
    for (const rule of this.rules) {
      const refusal = rule(draft, this);
      if (refusal) throw new LedgerError("RULE", refusal);
    }
  }

  /**
   * Spec §2.4: task.done needs a test.passed for the task's approved test,
   * later than its last commit (and its last approval or reopen).
   */
  private checkDone(task: string): void {
    const base = taskBase(task);
    let approvedTest: string | undefined;
    let anchor = -1;
    let passedAfterAnchor = false;
    this.list.forEach((entry, i) => {
      if (taskBase(entry.subject) !== base) return;
      switch (entry.type) {
        case "test.approved":
          approvedTest = String(entry.data?.test ?? "");
          anchor = i;
          passedAfterAnchor = false;
          break;
        case "commit.observed":
        case "task.reopened":
          anchor = i;
          passedAfterAnchor = false;
          break;
        case "test.passed":
          if (approvedTest !== undefined && i > anchor && String(entry.data?.test ?? "") === approvedTest) passedAfterAnchor = true;
          break;
        default:
          break;
      }
    });
    if (approvedTest === undefined) {
      throw new LedgerError("DONE_WITHOUT_PASS", `${task} has no approved test`);
    }
    if (!passedAfterAnchor) {
      throw new LedgerError("DONE_WITHOUT_PASS", `${task} has no passing run of its approved test after its last commit`);
    }
  }
}

/** "T-14.a2" and "T-14" are the same task. */
function taskBase(subject: string): string {
  return subject.trim().replace(/\.a\d+$/, "");
}

function isFilled(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text !== "" && text.toUpperCase() !== "TBD";
}
