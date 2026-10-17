// Roadmap: turns a mind map into phased tasks, and writes them to the ledger
// as numbered task.created entries.

import { isAuthoritative, type Actor, type Ledger, type LedgerEntry } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import { nodeArea } from "./mindmap";
import type { MindMap, MindNode, PhaseId, Roadmap, RoadmapPhase, RoadmapTask } from "./types";

export const PHASES: readonly { id: PhaseId; title: string }[] = [
  { id: "foundation", title: "Foundation" },
  { id: "core", title: "Core" },
  { id: "integrations", title: "Integrations" },
  { id: "hardening", title: "Hardening" },
  { id: "release", title: "Release" },
];

/** Key of the task that always closes the roadmap. */
export const FINAL_TASK_KEY = "K-first-release";

/**
 * Which phase a node's task lands in:
 * risk -> hardening; testing area -> release; stack, data or auth area -> foundation;
 * integration -> integrations; everything else (components, screens, data) -> core.
 */
export function phaseOf(node: MindNode): PhaseId {
  if (node.kind === "risk") return "hardening";
  const area = nodeArea(node);
  if (area === "testing") return "release";
  if (area === "stack" || area === "data" || area === "auth") return "foundation";
  if (node.kind === "integration") return "integrations";
  return "core";
}

export function taskKey(nodeId: string): string {
  return `K-${nodeId}`;
}

function titleOf(node: MindNode): string {
  switch (node.kind) {
    case "component":
      return `Build ${node.label}`;
    case "screen":
      return `Build the ${node.label}`;
    case "data":
      return `Set up ${node.label}`;
    case "integration":
      return `Integrate ${node.label}`;
    case "risk":
      return `Mitigate: ${node.label}`;
  }
}

function doneWhenOf(node: MindNode, map: MindMap): string {
  const parts = node.children.map((c) => map.nodes[c]?.label).filter((l): l is string => !!l);
  switch (node.kind) {
    case "component":
      return parts.length
        ? `a test proves ${node.label} starts with its parts (${parts.join(", ")}) wired in, and \`npm test\` passes for ${node.label}.`
        : `a test proves ${node.label} starts and does its one job, and \`npm test\` passes for ${node.label}.`;
    case "screen":
      return `a test renders the ${node.label} and proves its main action works; \`npm test\` passes for it.`;
    case "data":
      return `a test writes a record through ${node.label}, reads it back unchanged, and \`npm test\` passes for ${node.label}.`;
    case "integration":
      return `a test against a stub of ${node.label} proves both the success and the failure path are handled; \`npm test\` passes for ${node.label}.`;
    case "risk":
      return `a test reproduces "${node.label}"${node.note ? ` (${node.note})` : ""} and proves the mitigation holds; \`npm test\` passes for it.`;
  }
}

/** Nodes in map order: depth-first from the root, following children order. */
function walk(map: MindMap): MindNode[] {
  const out: MindNode[] = [];
  const seen = new Set<string>([map.root]);
  const visit = (id: string): void => {
    for (const child of map.nodes[id]?.children ?? []) {
      if (seen.has(child) || !map.nodes[child]) continue;
      seen.add(child);
      out.push(map.nodes[child]!);
      visit(child);
    }
  };
  visit(map.root);
  // Nodes not reachable from the root (left over from edits) still get tasks, in id order.
  for (const id of Object.keys(map.nodes).sort()) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(map.nodes[id]!);
    }
  }
  return out;
}

/**
 * Builds the phased roadmap. Dependencies only ever point at tasks that come
 * earlier (by phase, then map order), so the graph is acyclic:
 * - a task depends on its parent node's task, when that comes earlier;
 * - a task outside foundation depends on the foundation tasks it is linked to
 *   (cross-links in either direction), and a top-level one on the stack's top-level tasks;
 * - the final "Cut the first release" task depends on every other task.
 */
export function buildRoadmap(map: MindMap, opts: { owner?: string } = {}): Roadmap {
  const owner = opts.owner ?? "unassigned";
  const all = walk(map);
  // What the repo already has gets no build task; the roadmap names it instead.
  const nodes = all.filter((n) => !n.existing);
  const existing = all.filter((n) => n.existing).map((n) => ({ node: n.id, label: n.label }));
  const order = (n: MindNode) => PHASES.findIndex((p) => p.id === phaseOf(n));
  const ordered = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => order(a.n) - order(b.n) || a.i - b.i)
    .map((x) => x.n);
  const position = new Map(ordered.map((n, i) => [n.id, i]));
  const parentOf = new Map<string, string>();
  for (const n of Object.values(map.nodes)) for (const c of n.children) if (!parentOf.has(c)) parentOf.set(c, n.id);
  const stackRoots = ordered.filter((n) => parentOf.get(n.id) === map.root && nodeArea(n) === "stack" && phaseOf(n) === "foundation");

  const tasks: RoadmapTask[] = ordered.map((node, i) => {
    const deps = new Set<string>();
    const earlier = (id: string) => (position.get(id) ?? Infinity) < i;
    const parent = parentOf.get(node.id);
    if (parent && parent !== map.root && earlier(parent)) deps.add(parent);
    if (phaseOf(node) !== "foundation") {
      for (const link of map.links) {
        const other = link.from === node.id ? link.to : link.to === node.id ? link.from : undefined;
        if (other && other !== map.root && map.nodes[other] && phaseOf(map.nodes[other]!) === "foundation" && earlier(other)) deps.add(other);
      }
      if (parent === map.root) for (const s of stackRoots) if (earlier(s.id)) deps.add(s.id);
    }
    return {
      key: taskKey(node.id),
      title: titleOf(node),
      phase: phaseOf(node),
      owner,
      doneWhen: doneWhenOf(node, map),
      node: node.id,
      change: node.kind === "risk" ? "fix" : "feature",
      dependsOn: ordered.filter((n) => deps.has(n.id)).map((n) => taskKey(n.id)),
    };
  });

  tasks.push({
    key: FINAL_TASK_KEY,
    title: "Cut the first release",
    phase: "release",
    owner,
    doneWhen: "`npm test` passes on a clean checkout and a test proves the release entry (R-1, v1.0.0) is in the ledger with its stamp.",
    node: map.root,
    change: "feature",
    dependsOn: tasks.map((t) => t.key),
  });

  const phases: RoadmapPhase[] = PHASES.map((p) => ({ id: p.id, title: p.title, tasks: tasks.filter((t) => t.phase === p.id) }));
  return existing.length > 0 ? { phases, existing } : { phases };
}

/** All tasks of a roadmap in phase order. */
export function roadmapTasks(roadmap: Roadmap): RoadmapTask[] {
  return roadmap.phases.flatMap((p) => p.tasks);
}

/** Tasks ordered so every dependency comes first; keeps phase order otherwise. Throws on unknown keys or cycles. */
function writeOrder(tasks: RoadmapTask[]): RoadmapTask[] {
  const byKey = new Map<string, RoadmapTask>();
  for (const t of tasks) {
    if (byKey.has(t.key)) throw new Error(`duplicate roadmap key "${t.key}"`);
    byKey.set(t.key, t);
  }
  for (const t of tasks) for (const d of t.dependsOn) if (!byKey.has(d)) throw new Error(`${t.key} depends on unknown task "${d}"`);
  const done = new Set<string>();
  const out: RoadmapTask[] = [];
  while (out.length < tasks.length) {
    const next = tasks.find((t) => !done.has(t.key) && t.dependsOn.every((d) => done.has(d)));
    if (!next) throw new Error("roadmap dependencies form a cycle");
    done.add(next.key);
    out.push(next);
  }
  return out;
}

/**
 * Writes one task.created per task, each taking the next T- number. Returns
 * key -> T- number. Writes nothing for an empty roadmap. Everything is checked
 * before the first write, so a bad roadmap writes nothing.
 */
export function writeRoadmap(ledger: Ledger, actor: Actor, roadmap: Roadmap): Record<string, string> {
  const ordered = writeOrder(roadmapTasks(roadmap));
  const numbers: Record<string, string> = {};
  for (const task of ordered) {
    const entry = appendNumbered(ledger, {
      actor,
      type: "task.created",
      summary: task.title,
      refs: [],
      data: {
        change: task.change,
        phase: task.phase,
        owner: task.owner,
        doneWhen: task.doneWhen,
        node: task.node,
        dependsOn: task.dependsOn.map((d) => numbers[d]!),
        key: task.key,
        source: "planning",
        ...(task.template ? { template: task.template } : {}),
      },
    });
    numbers[task.key] = entry.subject;
  }
  return numbers;
}

// ---------- The person's own changes to the roadmap ----------

/** `data.source` on a task.created the person added by hand. */
export const OWN_TASK_SOURCE = "person";

/** A task the person added themselves, as replayed from the ledger. */
export interface OwnTask {
  task: string;
  entry: string;
  title: string;
  phase: PhaseId;
  owner: string;
  doneWhen?: string;
  refs: string[];
  at: string;
}

const PHASE_IDS: ReadonlySet<string> = new Set(PHASES.map((p) => p.id));

export function isPhase(value: unknown): value is PhaseId {
  return typeof value === "string" && PHASE_IDS.has(value);
}

/** Tasks the person added by hand (task.created with source "person"), in ledger order. */
export function ownTasks(entries: readonly LedgerEntry[]): OwnTask[] {
  return entries
    .filter((e) => e.type === "task.created" && e.data?.source === OWN_TASK_SOURCE && isAuthoritative(e, { personOnly: true }))
    .map((e) => ({
      task: e.subject,
      entry: e.n,
      title: typeof e.data?.title === "string" ? e.data.title : e.summary,
      phase: isPhase(e.data?.phase) ? e.data.phase : "core",
      owner: typeof e.data?.owner === "string" ? e.data.owner : e.actor.id,
      ...(typeof e.data?.doneWhen === "string" && e.data.doneWhen ? { doneWhen: e.data.doneWhen } : {}),
      refs: [...e.refs],
      at: e.at,
    }));
}

/**
 * Draft roadmap tasks the person left out, by task key, replayed from their
 * decision.made entries (data.roadmap.drop / data.roadmap.restore). Only a
 * person's decision counts.
 */
export function droppedRoadmapTasks(entries: readonly LedgerEntry[]): Map<string, { key: string; title: string; decision: string }> {
  const dropped = new Map<string, { key: string; title: string; decision: string }>();
  for (const e of entries) {
    if (e.type !== "decision.made" || !isAuthoritative(e, { personOnly: true })) continue;
    const change = e.data?.roadmap as { drop?: unknown; restore?: unknown; title?: unknown } | undefined;
    if (!change || typeof change !== "object") continue;
    if (typeof change.drop === "string") dropped.set(change.drop, { key: change.drop, title: typeof change.title === "string" ? change.title : change.drop, decision: e.subject });
    if (typeof change.restore === "string") dropped.delete(change.restore);
  }
  return dropped;
}

/** The roadmap without the given task keys; dependencies on them go too. */
export function withoutTasks(roadmap: Roadmap, keys: Iterable<string>): Roadmap {
  const gone = new Set(keys);
  if (gone.size === 0) return roadmap;
  return {
    ...roadmap,
    phases: roadmap.phases.map((p) => ({
      ...p,
      tasks: p.tasks.filter((t) => !gone.has(t.key)).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => !gone.has(d)) })),
    })),
  };
}
