// The one-chat relay (spec §4.2, §4.3, §4.5).
//
// Every worker question gets a Q number and lands in the inbox of ONE main
// chat: the first agent that connected for that person. If an earlier
// decision already answers the identical question, the answer comes straight
// back and is logged. Otherwise a settled-answer source (Jev reading the plan)
// may answer it when it is confident; everything else waits in the main
// chat's digest. The main chat's answer becomes a D number and routes back to
// the worker that asked, by Q number. A blocking question pauses only that
// worker.
import type { Actor, EntryDraft, Ledger, LedgerEntry } from "../ledger/index";
import { isAuthoritative } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import { redactSecrets } from "../jev/redact";

export interface QuestionInput {
  task: string;
  question: string;
  options?: string[];
  blocking?: boolean;
}

export interface Question {
  q: string;
  task: string;
  askedBy: string;
  /** The person whose main chat receives it. */
  person: string;
  question: string;
  options: string[];
  blocking: boolean;
  askedAt: string;
  status: "open" | "answered";
  answer?: string;
  decision?: string;
  answeredBy?: string;
  /** "decision" = matched an earlier D; "settled" = the plan settles it; "main" = the main chat. */
  answeredVia?: "decision" | "settled" | "main";
  /** Set once the asking worker has read the answer. */
  delivered?: boolean;
}

export interface SettledAnswer {
  answer: string;
  reason: string;
  refs: string[];
  actor: Actor;
}

/** Something that can answer a question the plan already settles (Jev, see core/jev/planAnswerer.ts). */
export interface SettledAnswerer {
  tryAnswer(question: Question): Promise<SettledAnswer | null>;
}

export interface Digest {
  person: string;
  open: number;
  blocking: number;
  /** One short line per question: open ones (blocking first), then new auto-answered ones. */
  lines: string[];
  /** Open questions, then auto-answered ones the main chat has not seen, each marked. */
  questions: (Question & { autoAnswered: boolean })[];
  /** Questions answered without the main chat (earlier decision or the plan) since its last check. */
  autoAnswered: string[];
}

export interface AskResult {
  q: string;
  status: "open" | "answered";
  answer?: string;
  decision?: string;
  via?: Question["answeredVia"];
  paused: boolean;
}

/** Normalise a question so trivially different spellings match (spec §4.2 "identical question"). */
export function questionKey(question: string, options: readonly string[] = []): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const opts = [...options].map(norm).filter(Boolean).sort();
  return opts.length ? `${norm(question)} :: ${opts.join(" | ")}` : norm(question);
}

const decisionKey = (person: string, key: string) => `${person}\u0000${key}`;

const SYSTEM: Actor = { kind: "system", id: "perfect-planner" };

export interface RelayOptions {
  ledger: Ledger;
  settled?: SettledAnswerer | null;
}

/**
 * Whether a reader may take an entry as written: an agent's or Jev's own entry
 * (they hold no keys), or a person or system entry whose signature the ledger
 * verified. A forged person or system entry on disk is ignored.
 */
export function trustedEntry(entry: LedgerEntry): boolean {
  const kind = entry.actor?.kind;
  return kind === "agent" || kind === "jev" || isAuthoritative(entry);
}

export class Relay {
  private readonly ledger: Ledger;
  private readonly settled: SettledAnswerer | null;
  private readonly questions = new Map<string, Question>();
  /** person + question key -> { D number, answer }: one person's decisions never answer another's workers */
  private readonly decisions = new Map<string, { d: string; answer: string }>();
  /** person -> auto-answered Q numbers their main chat has already been shown */
  private readonly shownAuto = new Map<string, Set<string>>();
  private readonly waiters = new Map<string, ((q: Question) => void)[]>();
  private pausedAll: { reason: string } | null = null;
  /** Tasks Pause all blocked; Resume all unblocks exactly these, owned or not. */
  private pausedTasks = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(options: RelayOptions) {
    this.ledger = options.ledger;
    this.settled = options.settled ?? null;
    this.load();
    // Entries written by anyone (the app, another tool) keep the relay current.
    this.unsubscribe = this.ledger.subscribe((entry) => this.apply(entry));
  }

  /** Rebuild open questions and known decisions by replaying the ledger. */
  private load(): void {
    this.questions.clear();
    this.decisions.clear();
    for (const e of this.ledger.entries()) this.apply(e);
  }

  private apply(e: LedgerEntry): void {
    const d = e.data ?? {};
    // Agents (and Jev) hold no keys, so their entries are taken as written; a
    // person or system entry counts only when the ledger verified its signature.
    if (!trustedEntry(e)) return;
    if (e.type === "question.asked") {
      this.questions.set(e.subject, {
        q: e.subject,
        task: String(d.task ?? ""),
        askedBy: e.actor.id,
        person: String(d.person ?? ""),
        question: String(d.question ?? e.summary),
        options: Array.isArray(d.options) ? d.options.map(String) : [],
        blocking: d.blocking === true,
        askedAt: e.at,
        status: "open",
      });
    } else if (e.type === "question.answered") {
      const q = this.questions.get(e.subject);
      if (!q) return;
      q.status = "answered";
      q.answer = String(d.answer ?? e.summary);
      const settledBy = (d.settledBy ?? d.source) as { id?: unknown } | undefined;
      q.answeredBy = typeof settledBy?.id === "string" ? settledBy.id : e.actor.id;
      q.answeredVia = (d.via as Question["answeredVia"]) ?? "main";
      if (typeof d.decision === "string") q.decision = d.decision;
      this.notify(q);
    } else if (e.type === "decision.made" && typeof d.key === "string" && isAuthoritative(e)) {
      // Only a person's (or the system's) decision may answer later questions.
      const person = typeof d.person === "string" ? d.person : typeof d.question === "string" ? this.questions.get(d.question)?.person : undefined;
      if (person !== undefined) this.decisions.set(decisionKey(person, d.key), { d: e.subject, answer: String(d.answer ?? e.summary) });
    } else if (e.type === "task.blocked" && d.pauseAll === true && isAuthoritative(e)) {
      this.pausedAll = { reason: e.reason ?? "Paused" };
      this.pausedTasks.add(e.subject);
    } else if (e.type === "task.progress" && d.resumeAll === true && isAuthoritative(e)) {
      this.pausedAll = null;
      this.pausedTasks.delete(e.subject);
    }
  }

  /** Appends; the subscription applies the entry to the relay's state. */
  private write(draft: EntryDraft): LedgerEntry {
    return this.ledger.append(draft);
  }

  /**
   * A worker asks the main chat. Writes question.asked; when an earlier
   * decision or the settled-answer source answers it, also question.answered.
   */
  async ask(worker: Actor, person: string, input: QuestionInput): Promise<AskResult> {
    // Agents paste logs and configs; nothing secret goes into the ledger or the digest.
    const question = redactSecrets(input.question.trim());
    if (!question) throw new Error("A question needs some words.");
    const options = (input.options ?? []).map((o) => redactSecrets(o.trim())).filter(Boolean);
    const blocking = input.blocking === true;
    const q = appendNumbered(this.ledger, {
      actor: worker,
      type: "question.asked",
      summary: question.length > 140 ? `${question.slice(0, 137)}...` : question,
      refs: [input.task],
      data: { task: input.task, person, question, options, blocking },
    }).subject;

    const prior = this.decisions.get(decisionKey(person, questionKey(question, options)));
    if (prior) {
      this.write({
        actor: SYSTEM,
        type: "question.answered",
        subject: q,
        summary: prior.answer,
        reason: `The same question was decided in ${prior.d}`,
        refs: [prior.d, input.task],
        data: { answer: prior.answer, decision: prior.d, via: "decision" },
      });
      return { q, status: "answered", answer: prior.answer, decision: prior.d, via: "decision", paused: false };
    }

    if (this.settled) {
      const asked = this.questions.get(q)!;
      const settled = await this.settled.tryAnswer({ ...asked }).catch(() => null);
      // The main chat may have answered while the settled source was thinking.
      if (asked.status === "answered") return { q, status: "answered", answer: asked.answer!, via: asked.answeredVia!, ...(asked.decision ? { decision: asked.decision } : {}), paused: false };
      if (settled) {
        this.write({
          // The ledger lets Jev write only review.verdict, so Perfect Planner records the
          // answer itself and names the source; Jev's own review.verdict is already logged.
          actor: SYSTEM,
          type: "question.answered",
          subject: q,
          summary: settled.answer,
          reason: settled.reason,
          refs: [...settled.refs, input.task],
          data: { answer: settled.answer, via: "settled", source: settled.actor, settledBy: { ...settled.actor } },
        });
        return { q, status: "answered", answer: settled.answer, via: "settled", paused: false };
      }
    }
    return { q, status: "open", paused: blocking };
  }

  /**
   * The main chat's digest (spec §4.3): every open question, blocking first,
   * plus each question answered without it (from an earlier decision or the
   * plan) until the main chat has seen it once, marked as auto-answered.
   */
  digest(person: string): Digest {
    const shown = this.shownAuto.get(person) ?? new Set<string>();
    this.shownAuto.set(person, shown);
    const byNumber = (a: Question, b: Question) => a.q.localeCompare(b.q, undefined, { numeric: true });
    const mine = [...this.questions.values()].filter((q) => q.person === person);
    const open = mine.filter((q) => q.status === "open").sort((a, b) => Number(b.blocking) - Number(a.blocking) || byNumber(a, b));
    const auto = mine.filter((q) => q.status === "answered" && q.answeredVia !== "main" && !shown.has(q.q)).sort(byNumber);
    for (const q of auto) shown.add(q.q);
    const autoLines = auto.map((q) => `${q.q} (${q.task}) auto-answered ${q.answeredVia === "decision" ? `from ${q.decision}` : "from the plan"}: ${q.answer}`);
    return {
      person,
      open: open.length,
      blocking: open.filter((q) => q.blocking).length,
      lines: [...open.map((q) => `${q.q} (${q.task}${q.blocking ? ", blocking" : ""}) ${q.question}${q.options.length ? ` Options: ${q.options.join(" | ")}` : ""}`), ...autoLines],
      questions: [...open.map((q) => ({ ...q, autoAnswered: false })), ...auto.map((q) => ({ ...q, autoAnswered: true }))],
      autoAnswered: autoLines,
    };
  }

  /**
   * Answer Q and route the answer to the worker that asked.
   *
   * A person (or the system on their behalf) makes a decision: decision.made
   * gets a D number, and identical questions later are answered from it. The
   * main chat is an agent, so its answer is a question.answered entry only:
   * information for the worker, never a decision (only a person decides).
   */
  answer(by: Actor, person: string, q: string, text: string): { q: string; decision: string | null; worker: string } {
    const answer = redactSecrets(text.trim());
    if (!answer) throw new Error("An answer needs some words.");
    const asked = this.questions.get(q);
    if (!asked) throw new Error(`${q} is not a question in this project.`);
    if (asked.person !== person) throw new Error(`${q} belongs to another person's main chat.`);
    if (asked.status === "answered") throw new Error(`${q} was already answered: ${asked.answer}`);
    const deciding = by.kind === "person" || by.kind === "system";
    const d = deciding
      ? appendNumbered(this.ledger, {
          actor: by,
          type: "decision.made",
          summary: answer,
          reason: `Answer to ${q} from ${asked.task}`,
          refs: [q, asked.task],
          data: { key: questionKey(asked.question, asked.options), person: asked.person, question: q, questionText: asked.question, answer },
        }).subject
      : null;
    this.write({
      actor: by,
      type: "question.answered",
      subject: q,
      summary: answer,
      refs: d ? [d, asked.task] : [asked.task],
      data: { answer, ...(d ? { decision: d } : {}), via: "main" },
    });
    return { q, decision: d, worker: asked.askedBy };
  }


  /** Answers waiting for one worker; marks them delivered. */
  answersFor(worker: string): Question[] {
    const ready = [...this.questions.values()].filter((q) => q.askedBy === worker && q.status === "answered" && !q.delivered);
    for (const q of ready) q.delivered = true;
    return ready.map((q) => ({ ...q }));
  }

  /** Resolves when Q is answered: lets a blocking ask_main wait in place. */
  waitFor(q: string, signal?: AbortSignal): Promise<Question> {
    const asked = this.questions.get(q);
    if (!asked) return Promise.reject(new Error(`${q} is not a question in this project.`));
    if (asked.status === "answered") return Promise.resolve({ ...asked });
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(q) ?? [];
      const done = (value: Question) => resolve(value);
      list.push(done);
      this.waiters.set(q, list);
      signal?.addEventListener("abort", () => {
        this.waiters.set(q, (this.waiters.get(q) ?? []).filter((w) => w !== done));
        reject(new Error(`Stopped waiting for ${q}.`));
      }, { once: true });
    });
  }

  private notify(q: Question): void {
    const list = this.waiters.get(q.q) ?? [];
    this.waiters.delete(q.q);
    for (const resolve of list) resolve({ ...q });
  }

  /** The open blocking question that pauses this worker, if any. */
  blockingFor(worker: string): string | null {
    for (const q of this.questions.values()) if (q.askedBy === worker && q.blocking && q.status === "open") return q.q;
    return null;
  }

  isPausedAll(): { reason: string } | null {
    return this.pausedAll;
  }

  /**
   * Pause every worker (spec §4.5): one task.blocked entry per given task,
   * marked pauseAll. Every entry needs a real task number, so the caller passes
   * the open tasks too when nothing is being worked on.
   */
  pauseAll(by: Actor, reason: string, tasks: string[]): void {
    if (!tasks.length) throw new Error("There are no tasks to pause.");
    for (const task of tasks) {
      this.write({ actor: by, type: "task.blocked", subject: task, summary: "Paused by Pause all", reason, data: { pauseAll: true } });
    }
  }

  resumeAll(by: Actor): void {
    for (const task of [...this.pausedTasks]) {
      this.write({ actor: by, type: "task.progress", subject: task, summary: "Resumed after Pause all", data: { resumeAll: true } });
    }
  }

  dispose(): void {
    this.unsubscribe();
  }

  get(q: string): Question | null {
    const found = this.questions.get(q);
    return found ? { ...found } : null;
  }
}
