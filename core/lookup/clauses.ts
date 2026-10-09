import type { Actor, EntryDraft, Ledger, LedgerEntry } from "../ledger/index";

export type ClauseKind = "heading" | "paragraph" | "item";

export interface Clause {
  clause: string;           // "3.1.1"
  kind: ClauseKind;
  text: string;
  status: "active" | "withdrawn";
  addedBy: string;          // ledger number of clause.added
  changedBy: string[];      // ledger numbers of clause.changed
  withdrawnBy?: string;     // ledger number of clause.withdrawn
}

const CLAUSE = /^\d+(?:\.\d+)*$/;

export function isClauseNumber(text: string): boolean {
  return CLAUSE.test(text);
}

/** "§3.1" → "3.1"; also accepts "3.1". */
export function clauseNumber(text: string): string | undefined {
  const trimmed = String(text).trim().replace(/^§\s*/, "");
  return CLAUSE.test(trimmed) ? trimmed : undefined;
}

/** Sorts 3.2 before 3.10 and 3.1 before 3.1.1. */
export function compareClauses(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function clauseOf(entry: LedgerEntry): string | undefined {
  const fromData = entry.data?.clause;
  return typeof fromData === "string" ? clauseNumber(fromData) : clauseNumber(entry.subject);
}

/** Clause state after replaying entries[0..end). */
export function clausesAt(entries: readonly LedgerEntry[], end = entries.length): Map<string, Clause> {
  const map = new Map<string, Clause>();
  for (let i = 0; i < end && i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry.type.startsWith("clause.")) continue;
    const number = clauseOf(entry);
    if (!number) continue;
    const data = entry.data ?? {};
    if (entry.type === "clause.added") {
      map.set(number, {
        clause: number,
        kind: (data.kind as ClauseKind) ?? "paragraph",
        text: String(data.text ?? ""),
        status: "active",
        addedBy: entry.n,
        changedBy: [],
      });
    } else if (entry.type === "clause.changed") {
      const clause = map.get(number);
      if (clause) {
        clause.text = String(data.new ?? clause.text);
        clause.changedBy.push(entry.n);
      }
    } else if (entry.type === "clause.withdrawn") {
      const clause = map.get(number);
      if (clause) {
        clause.status = "withdrawn";
        clause.withdrawnBy = entry.n;
      }
    }
  }
  return map;
}

/** Index of the plan.approved entry for a plan version, or -1. */
export function planIndex(entries: readonly LedgerEntry[], plan: string): number {
  return entries.findIndex((entry) => entry.type === "plan.approved" && entry.subject === plan);
}

/** Clauses as approved in a plan version (P-2), or the current draft when no plan is named. */
export function planClauses(entries: readonly LedgerEntry[], plan?: string): Map<string, Clause> | undefined {
  if (!plan) return clausesAt(entries);
  const index = planIndex(entries, plan);
  return index < 0 ? undefined : clausesAt(entries, index + 1);
}

export function sortedClauses(map: Map<string, Clause>): Clause[] {
  return [...map.values()].sort((a, b) => compareClauses(a.clause, b.clause));
}

/**
 * Number for a clause inserted after `after` (spec §3.4): published numbers
 * never move, so it becomes a child, after any children already there
 * (3.1 → 3.1.1, then 3.1.2). With no `after`, the next top-level number.
 */
export function numberForInsert(clauses: Map<string, Clause>, after?: string): string {
  const parent = after ? clauseNumber(after) : undefined;
  if (after && !parent) throw new RangeError(`not a clause number: ${after}`);
  if (parent && !clauses.has(parent)) throw new RangeError(`§${parent} does not exist`);
  const depth = parent ? parent.split(".").length + 1 : 1;
  let highest = 0;
  for (const number of clauses.keys()) {
    const parts = number.split(".");
    if (parts.length !== depth) continue;
    if (parent && !number.startsWith(`${parent}.`)) continue;
    highest = Math.max(highest, Number(parts[depth - 1]));
  }
  return parent ? `${parent}.${highest + 1}` : String(highest + 1);
}

export interface NumberedBlock {
  clause: string;
  kind: ClauseKind;
  text: string;
}

/**
 * Gives every heading, paragraph and list item of a markdown plan a clause
 * number (spec §3.3). A top-level "## 3. Title" heading keeps its typed
 * number when it is higher than the one before; everything else is numbered
 * in order, and blocks under a heading are numbered as its children.
 */
export function numberMarkdown(markdown: string): NumberedBlock[] {
  const blocks: NumberedBlock[] = [];
  const stack: { level: number; number: string; children: number }[] = [];
  let topLevel = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text) push("paragraph", text);
  };
  const push = (kind: ClauseKind, text: string) => {
    const parent = stack[stack.length - 1];
    if (!parent) {
      topLevel += 1;
      blocks.push({ clause: String(topLevel), kind, text });
      return;
    }
    parent.children += 1;
    blocks.push({ clause: `${parent.number}.${parent.children}`, kind, text });
  };

  let fence: string | undefined;
  let code: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    // A fenced code block is one clause, whatever its lines look like.
    const fenceMark = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fence) {
      code.push(raw);
      if (fenceMark === fence) {
        push("paragraph", code.join("\n"));
        fence = undefined;
        code = [];
      }
      continue;
    }
    if (fenceMark) {
      flushParagraph();
      fence = fenceMark;
      code = [raw];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      if (level === 1 && stack.length === 0 && blocks.length === 0) continue; // document title
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const typed = /^(\d+(?:\.\d+)*)\.?\s+/.exec(heading[2]);
      const text = heading[2].slice(typed ? typed[0].length : 0).trim();
      const parent = stack[stack.length - 1];
      let number: string;
      if (parent) {
        parent.children += 1;
        number = `${parent.number}.${parent.children}`;
      } else {
        // A typed top-level number is kept when it moves forward; otherwise number in order.
        const wanted = typed && !typed[1].includes(".") ? Number(typed[1]) : 0;
        topLevel = wanted > topLevel ? wanted : topLevel + 1;
        number = String(topLevel);
      }
      blocks.push({ clause: number, kind: "heading", text });
      stack.push({ level, number, children: 0 });
    } else if (item) {
      flushParagraph();
      push("item", item[1].trim());
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  if (fence) push("paragraph", code.join("\n"));
  return blocks;
}

/** Ledger rules for spec §3.4: clause numbers are never reused, changed clauses must exist. */
export function installClauseRules(ledger: Ledger): () => void {
  return ledger.addRule((draft, current) => clauseRefusal(draft, current.entries()));
}

export function clauseRefusal(draft: EntryDraft, entries: readonly LedgerEntry[]): string | null {
  if (!draft.type.startsWith("clause.")) return null;
  const data = draft.data ?? {};
  const number = typeof data.clause === "string" ? clauseNumber(data.clause) : clauseNumber(draft.subject);
  if (!number) return `${draft.type} needs a clause number like §3.1`;
  const clauses = clausesAt(entries);
  const existing = clauses.get(number);
  if (draft.type === "clause.added") {
    if (existing) return `§${number} was already used (${existing.addedBy}); clause numbers are never reused`;
    if (typeof data.text !== "string" || data.text.trim() === "") return "clause.added needs the clause text";
    const parts = number.split(".");
    if (parts.length > 1 && !clauses.has(parts.slice(0, -1).join("."))) return `§${number} has no parent §${parts.slice(0, -1).join(".")}`;
    return null;
  }
  if (!existing) return `§${number} does not exist`;
  if (existing.status === "withdrawn") return `§${number} was withdrawn in ${existing.withdrawnBy}`;
  if (draft.type === "clause.changed") {
    if (typeof data.old !== "string" || typeof data.new !== "string") return "clause.changed must name the old and new text";
    if (data.old !== existing.text) return `the old text does not match §${number} as it stands`;
    if (data.new.trim() === "" || data.new === data.old) return "clause.changed needs different, non-empty new text";
  }
  return null;
}

/** Writes clause.added for every block of a markdown plan; returns the entries. */
export function addPlanText(ledger: Ledger, actor: Actor, markdown: string, refs: string[] = []): LedgerEntry[] {
  return numberMarkdown(markdown).map((block) =>
    ledger.append({
      actor,
      type: "clause.added",
      subject: `§${block.clause}`,
      summary: `Added §${block.clause}: ${oneLine(block.text)}`,
      refs,
      data: { clause: block.clause, kind: block.kind, text: block.text },
    }),
  );
}

export function addClause(ledger: Ledger, actor: Actor, options: { after?: string; text: string; kind?: ClauseKind; reason?: string }): LedgerEntry {
  const clause = numberForInsert(clausesAt(ledger.entries()), options.after);
  return ledger.append({
    actor,
    type: "clause.added",
    subject: `§${clause}`,
    summary: `Added §${clause}: ${oneLine(options.text)}`,
    reason: options.reason,
    data: { clause, kind: options.kind ?? "paragraph", text: options.text },
  });
}

export function changeClause(ledger: Ledger, actor: Actor, clause: string, text: string, reason: string): LedgerEntry {
  const number = clauseNumber(clause);
  const existing = number ? clausesAt(ledger.entries()).get(number) : undefined;
  if (!number || !existing) throw new RangeError(`§${clause} does not exist`);
  return ledger.append({
    actor,
    type: "clause.changed",
    subject: `§${number}`,
    summary: `Changed §${number}: ${oneLine(text)}`,
    reason,
    data: { clause: number, old: existing.text, new: text },
  });
}

export function withdrawClause(ledger: Ledger, actor: Actor, clause: string, reason: string): LedgerEntry {
  const number = clauseNumber(clause);
  if (!number) throw new RangeError(`not a clause number: ${clause}`);
  return ledger.append({
    actor,
    type: "clause.withdrawn",
    subject: `§${number}`,
    summary: `Withdrew §${number}`,
    reason,
    data: { clause: number },
  });
}

export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
