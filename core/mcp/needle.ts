// The needle: a tiny local router that picks which agent tool to call next.
// It is a pure function (no network, no weights, no shared state), so any number of
// projects and agents can use it at once, and it answers in well under a millisecond.
// Two signals are added: what the agent says it wants (words and references in its
// intent) and where its task stands on the board (what the next legal step is).
import { TOOL_INFO, TOOL_NAMES, type ToolName } from "./tools";
import { isTaskId, type TaskView } from "./board";

export type NeedleRole = "worker" | "main" | "observer" | "unknown";

export interface NeedleInput {
  /** "unknown" = the agent has not checked in yet. */
  role: NeedleRole;
  /** What the agent wants to do, in its own words. May be empty: the board then decides. */
  intent?: string;
  /** The board, as list_tasks returns it. */
  tasks?: readonly TaskView[];
  /** A worker's one task. */
  task?: string;
  /** Main chat: how many questions wait for an answer. */
  openQuestions?: number;
}

export interface NeedleChoice {
  tool: ToolName;
  /** 0..1, higher is better. Scores of the returned choices sum to 1. */
  score: number;
  /** One plain line. */
  why: string;
  /** Arguments that can be filled in from the intent and the board. The agent supplies the rest. */
  args: Record<string, string>;
}

/** Words that point at each tool. A word counts once however often it appears. */
const WORDS: Record<ToolName, string[]> = {
  hello: ["hello", "check in", "checkin", "connect", "register", "join", "start session", "begin"],
  list_tasks: ["list", "tasks", "board", "what is open", "whats open", "what s open", "what to do", "next task", "overview", "status of all", "everything"],
  claim_task: ["claim", "take", "start working", "begin work", "pick up", "start the task", "work on"],
  report_progress: ["progress", "update", "report", "i did", "i wrote", "i finished step", "done with", "wrote", "implemented", "fixed", "working on"],
  attach_proof: ["proof", "evidence", "attach", "screenshot", "commit", "test run", "link", "show it works", "finished", "complete", "ready for review"],
  ask_main: ["ask", "question", "a question", "question for", "unsure", "not sure", "which", "should i", "can i", "clarify", "need to know", "decision", "stuck on a choice"],
  check_inbox: ["inbox", "questions waiting", "any answer", "answers", "messages", "notices", "anything new", "unanswered", "paused"],
  answer: ["answer", "reply", "respond", "tell the worker", "resolve the question"],
  lookup: ["lookup", "look up", "what does", "what is", "meaning", "history", "who cites", "explain", "clause", "decision", "reference", "read"],
  release_task: ["release", "give back", "give up", "drop", "cannot continue", "can t continue", "blocked", "abandon", "hand back"],
  propose_test: ["test", "tests", "propose", "failing test", "acceptance", "done when", "test first", "write a test"],
};

const REF = /\b(?:T-\d+(?:\.a\d+)?|Q-\d+|D-\d+|R-\d+|L-\d+|P-\d+|§\s?\d+(?:\.\d+)*)\b/g;

function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/['’]/g, " ").replace(/[^a-z0-9§.\s-]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function hits(text: string, words: readonly string[]): number {
  let n = 0;
  for (const word of words) if (text.includes(` ${word} `) || (word.length > 4 && text.includes(` ${word}`))) n += word.includes(" ") ? 1.5 : 1;
  return n;
}

function allowed(role: NeedleRole, tool: ToolName): boolean {
  if (role === "unknown") return tool === "hello";
  if (tool === "hello") return false;
  const need = TOOL_INFO[tool].caller;
  return need === "any" || need === role || (role === "observer" && TOOL_INFO[tool].readOnly);
}

/** The step the board says comes next for a worker's task, with the tools that fit it. */
function boardPrior(input: NeedleInput): Partial<Record<ToolName, [number, string]>> {
  const out: Partial<Record<ToolName, [number, string]>> = {};
  if (input.role === "main") {
    if ((input.openQuestions ?? 0) > 0) out.check_inbox = [3, `${input.openQuestions} question${input.openQuestions === 1 ? "" : "s"} wait for an answer`];
    else out.list_tasks = [1, "see the board"];
    return out;
  }
  if (input.role !== "worker") {
    out.list_tasks = [1, "see the board"];
    return out;
  }
  const task = input.task ? input.tasks?.find((t) => t.id === input.task) : undefined;
  if (!task) {
    out.list_tasks = [2, "no task is known yet"];
    return out;
  }
  if (task.status === "done") out.lookup = [2, `${task.id} is done`];
  else if (task.status === "blocked") out.check_inbox = [3, `${task.id} is blocked: look for an answer`];
  else if (task.status === "open" && !task.testApproved) out.propose_test = [3, `${task.id} has no approved test yet`];
  else if (task.status === "open") out.claim_task = [3, `${task.id}'s test is approved, so it can be claimed`];
  else if (!task.proofs.length) {
    out.report_progress = [2, `${task.id} is claimed and has no proof yet`];
    out.attach_proof = [1.5, "proof is still missing"];
  } else out.attach_proof = [2, `${task.id} has proof: check it, or add more`];
  return out;
}

function fillArgs(tool: ToolName, input: NeedleInput, refs: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  const taskRef = refs.find((r) => isTaskId(r.toUpperCase()));
  const task = input.role === "worker" ? input.task : taskRef?.toUpperCase();
  if (["claim_task", "report_progress", "attach_proof", "ask_main", "release_task", "propose_test"].includes(tool) && (task ?? taskRef)) args.task = (task ?? taskRef)!.toUpperCase();
  const q = refs.find((r) => /^Q-\d+$/i.test(r));
  if (tool === "answer" && q) args.question = q.toUpperCase();
  if (tool === "lookup" && refs[0]) args.ref = refs[0].replace(/\s/g, "");
  return args;
}

/** Rank every tool this caller may use. The first choice is the one to call. */
export function route(input: NeedleInput, limit = 3): NeedleChoice[] {
  const text = normalise(input.intent ?? "");
  const refs = (input.intent ?? "").match(REF) ?? [];
  const prior = boardPrior(input);
  const raw: { tool: ToolName; value: number; why: string }[] = [];
  for (const tool of TOOL_NAMES) {
    if (!allowed(input.role, tool)) continue;
    let value = 0.05; // every legal tool keeps a small floor
    const reasons: string[] = [];
    const matched = hits(text, WORDS[tool]);
    if (matched) {
      value += matched * 2;
      reasons.push("matches what you asked");
    }
    const p = prior[tool];
    if (p) {
      // With no intent the board decides alone; with an intent it only nudges.
      value += text.trim() ? p[0] * 0.6 : p[0] * 2;
      reasons.push(p[1]);
    }
    if (tool === "answer" && refs.some((r) => /^Q-\d+$/i.test(r))) {
      value += 2;
      reasons.push("a question number is named");
    }
    if (tool === "lookup" && refs.length && !refs.some((r) => /^Q-\d+$/i.test(r) && /answer/.test(text))) {
      value += 1.5;
      reasons.push("a reference is named");
    }
    raw.push({ tool, value, why: reasons.join("; ") || "allowed for you" });
  }
  raw.sort((a, b) => b.value - a.value || TOOL_NAMES.indexOf(a.tool) - TOOL_NAMES.indexOf(b.tool));
  const top = raw.slice(0, Math.max(1, limit));
  const total = top.reduce((s, c) => s + c.value, 0) || 1;
  return top.map((c) => ({ tool: c.tool, score: Math.round((c.value / total) * 1000) / 1000, why: c.why, args: fillArgs(c.tool, input, refs) }));
}
