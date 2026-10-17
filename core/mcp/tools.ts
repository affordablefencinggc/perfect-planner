// The agent tools of spec §4.1, as data: names, who may call them, what they
// write and the input each accepts. Shared by the MCP server and the local
// bridge so both validate exactly the same way.
import * as z from "zod";

const taskId = z.string().regex(/^T-\d+$/, "Use a task number such as T-14.");
const words = (max: number) => z.string().trim().min(1, "Say something here.").max(max);

export const PROOF_KINDS = ["commit", "test-run", "file", "page", "screenshot", "link"] as const;

export const TOOL_INPUTS = {
  hello: z.object({ name: words(80), model: z.string().trim().max(80).optional() }),
  list_tasks: z.object({}),
  claim_task: z.object({ task: taskId }),
  report_progress: z.object({ task: taskId, text: words(500) }),
  attach_proof: z.object({ task: taskId, kind: z.enum(PROOF_KINDS), link: words(500) }),
  ask_main: z.object({
    task: taskId,
    question: words(2000),
    options: z.array(words(200)).max(8).optional(),
    blocking: z.boolean().optional(),
    /** Blocking only: how long to wait in place for the answer, 0 to return at once. */
    wait_seconds: z.number().int().min(0).max(600).optional(),
  }),
  check_inbox: z.object({}),
  answer: z.object({ question: z.string().regex(/^Q-\d+$/, "Use a question number such as Q-3."), text: words(2000) }),
  lookup: z.object({ ref: words(80) }),
  release_task: z.object({ task: taskId, reason: words(500), blocked: z.boolean().optional() }),
  propose_test: z.object({
    task: taskId,
    /** One line that runs the test from the worktree root, e.g. "node --test tests/invoice.test.mjs". */
    command: words(500),
    /** The test file(s) the command runs, relative to the worktree root. Their content is pinned when the person approves. */
    files: z.array(words(300)).min(1, "Name the test file(s) so they can be pinned.").max(20),
  }),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;
export type ToolInput<T extends ToolName> = z.infer<(typeof TOOL_INPUTS)[T]>;

export interface ToolInfo {
  title: string;
  description: string;
  caller: "any" | "worker" | "main";
  readOnly: boolean;
}

export const TOOL_INFO: Record<ToolName, ToolInfo> = {
  hello: { title: "Check in", caller: "any", readOnly: false, description: "Register this agent with Perfect Planner. Call once on connect. The first agent to check in for a person becomes their main chat; a worker token checks in as the worker for its one task." },
  list_tasks: { title: "List tasks", caller: "any", readOnly: true, description: "Read the task board: each task's number, title, status, owner, attempt, cited clauses and whether its test is approved." },
  claim_task: { title: "Claim a task", caller: "worker", readOnly: false, description: "Claim the task your token covers. Refused until its acceptance test is approved, or while another agent holds it." },
  report_progress: { title: "Report progress", caller: "worker", readOnly: false, description: "Write one plain line about what you just did on your task." },
  attach_proof: { title: "Attach proof", caller: "worker", readOnly: false, description: "Attach evidence to your task: a commit, test run, file, page, screenshot or link. Perfect Planner still runs the approved test itself; proof is not done." },
  ask_main: { title: "Ask the main chat", caller: "worker", readOnly: false, description: "Ask a question. It gets a Q number and goes to the one main chat. If an earlier decision or the plan already answers it, the answer comes back at once. A blocking question pauses only you until it is answered; set wait_seconds to wait for the answer in this call." },
  check_inbox: { title: "Check inbox", caller: "any", readOnly: true, description: "Main chat: the digest of open questions from every worker, blocking first, plus notices of what Perfect Planner itself saw the workers do since you last checked (two tasks changing one file, a task with no activity, new commits); each notice is shown once. Worker: answers to your questions, and whether you are paused." },
  answer: { title: "Answer a question", caller: "main", readOnly: false, description: "Main chat only: answer a question by its Q number and send the answer to the worker that asked. Your answer is recorded as information; only the person's own answer in Perfect Planner becomes a decision (D number) that answers the same question later." },
  lookup: { title: "Look up a reference", caller: "any", readOnly: true, description: "Resolve any reference (§3.1, P-2 §3.1, T-14, Q-3, D-3, R-1, L-000231) to its text, its history and everything that cites it." },
  propose_test: { title: "Propose the done-when test", caller: "worker", readOnly: false, description: "Test first: write a test in your worktree that fails today and passes once the task is done, then propose its command and files here. The person approves it in Perfect Planner, the app runs it to confirm it fails, and only then can you claim_task. Proposing again replaces the earlier test and any approval." },
  release_task: { title: "Release a task", caller: "worker", readOnly: false, description: "Give your task back, with a reason. Set blocked when you cannot continue; otherwise it returns to the board as open. Your token stops working for it." },
};

export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as ToolName[];
