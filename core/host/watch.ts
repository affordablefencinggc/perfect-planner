// The git watcher inside the host: one per open project (spec 4.4). It reads every task worktree on a timer,
// writes the git facts into the ledger itself (commit.observed, collision.detected / collision.resolved), and
// tells the main chat's inbox what it saw in plain words, so the orchestrator hears about collisions, stalled
// tasks and new commits without any model remembering to report them.
//
// Fails quiet and safe: a worktree it cannot read, a ledger it cannot read or write, or a project whose git
// folder went away makes it write nothing and tell the inbox once; it never throws into the host.
import { deriveState } from "../gate/index";
import { attemptLabel } from "../mcp/index";
import { GitWatcher, WatchNotifier, type TickResult } from "../watcher/index";
import { ledgerIntegrity, type CoreProject } from "./project";
import { stageOf, worktreesForWatcher } from "./routes/tasks";

export const DEFAULT_WATCH_MS = 5000;

export interface ProjectWatchOptions {
  /** Time between passes. Default 5 seconds. */
  intervalMs?: number;
  /** A task with no commit, file change or file save for this long is reported as stalled. Default 15 minutes. */
  stallMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Run no timer; the caller ticks. Tests only. */
  manual?: boolean;
}

export interface ProjectWatch {
  /** One pass now (shares a pass already running). Never throws; a failure comes back as an error entry and an inbox notice. */
  tick(): Promise<TickResult>;
  /** Stops the timer and waits for a pass in flight, so the ledger can close safely. */
  stop(): Promise<void>;
}

const blank = (message: string): TickResult => ({ observed: [], collisions: [], resolved: [], stalled: [], active: [], errors: [{ taskId: "*", path: "", message }] });

/** Stages where a quiet task waits for the person, not for its worker. */
const WAITING_ON_PERSON = new Set(["test-proposed", "review-diff", "ready-to-merge", "done"]);

export function startProjectWatch(project: CoreProject, options: ProjectWatchOptions = {}): ProjectWatch {
  const notifier = new WatchNotifier();
  let listed: ReadonlySet<string> = new Set();
  /** Set once the project had a usable git folder: losing it afterwards is a problem, not "no tasks". */
  let hadRepo = false;

  const waitingOnPerson = (label: string): boolean => {
    const task = project.service.board().get(label.replace(/\.a\d+$/, ""));
    if (!task || attemptLabel(task) !== label) return false;
    return WAITING_ON_PERSON.has(stageOf(task, deriveState(project.entries(), label)));
  };

  const publish = (result: TickResult): void => {
    try {
      for (const notice of notifier.consume(result, { listed, waitingOnPerson })) project.service.relay.addNotice(notice);
    } catch {
      // Telling the inbox is best effort: the ledger already holds the facts, and the watcher must never throw into the host.
    }
  };

  const watcher = new GitWatcher({
    ledger: project.ledger,
    // Nothing is read or written until the project has the person's history: a new folder, a swapped or
    // damaged ledger, or one whose writes are stopped is never added to.
    shouldRun: () => project.owner.state === "pinned" && !ledgerIntegrity(project.ledger).writesStopped,
    worktrees: async () => {
      await project.ready;
      const { repo, list } = await worktreesForWatcher(project);
      if (!repo.ok && hadRepo) throw new Error(`the project's git folder cannot be read any more${repo.reason ? ` (${repo.reason})` : ""}`);
      if (repo.ok) hadRepo = true;
      listed = new Set(list.map((info) => info.taskId));
      return list;
    },
    ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    onTick: publish,
    onError: (error) => publish(blank((error as Error)?.message ?? String(error))),
  });
  if (!options.manual) watcher.start(options.intervalMs ?? DEFAULT_WATCH_MS);

  return {
    async tick() {
      try {
        return await watcher.tick();
      } catch (error) {
        const result = blank((error as Error)?.message ?? String(error));
        publish(result);
        return result;
      }
    },
    stop: () => watcher.stop(),
  };
}
