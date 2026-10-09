// Mind map: turns the idea and the settled planning answers into a map of
// components, data, screens, integrations and risks. Pure and deterministic:
// the same idea and answers always give the same map, whatever order the
// answers arrive in.

import { AREAS } from "./types";
import type { Area, MindLink, MindMap, MindNode, MindNodeKind, PlanningAnswer } from "./types";

// ---------- Reading answers ----------

/** Lower-cased choice, text and decision of an answer, for the rule tables. */
export function answerText(answer: PlanningAnswer): string {
  return `${answer.choice} ${answer.text} ${answer.decision ?? ""}`.toLowerCase();
}

/** Phrases that mean "we are not doing this (yet)". */
export const DECLINE_PATTERN =
  /^\s*(no|none|skip|later)\b|\bnot in v1\b|\bnot now\b|\bnot used\b|\bnot needed\b|\bno (ai|payments?|sign[- ]?in|login|accounts?|offline)\b|\bwithout (ai|payments?|sign[- ]?in|login|accounts?)\b|\bonline[- ]only\b/;

/** True when the answer declines its area ("none", "not in v1", "no AI", ...). */
export function isDeclined(answer: PlanningAnswer): boolean {
  const choice = answer.choice.toLowerCase();
  if (["no", "none", "skip", "later", "not-v1", "not-in-v1", "online-only"].includes(choice)) return true;
  return DECLINE_PATTERN.test(answer.text.toLowerCase()) || DECLINE_PATTERN.test(choice);
}

/** True when an offline-area answer chooses offline working. */
export function choosesOffline(answer: PlanningAnswer): boolean {
  return /offline|local[- ]first/.test(answerText(answer)) && !isDeclined(answer);
}

/** Platforms the answer mentions, in the fixed order web, desktop, mobile. */
export const PLATFORMS = [
  { id: "web", label: "Web", pattern: /\bweb\b|browser/ },
  { id: "desktop", label: "Desktop", pattern: /desktop|windows|mac ?os|\bmac\b|linux/ },
  { id: "mobile", label: "Mobile", pattern: /mobile|ios|android|phone/ },
] as const;

// ---------- Node specs and the area table ----------

/** A node to create, with its sub-parts. Ids are derived from kind and label. */
export interface NodeSpec {
  kind: MindNodeKind;
  label: string;
  note?: string;
  children?: NodeSpec[];
}

const short = (text: string, max = 40): string => {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/**
 * One rule per area: which nodes an answer in that area adds to the map.
 * Leaves are never components, so a fresh map passes the depth check.
 *
 * | area      | nodes |
 * |-----------|-------|
 * | stack     | component "App shell" (note: the answer) > screen "Main layout", integration "Framework: <answer>" |
 * | data      | data "Data store" (note: the answer) > data "Schema", data "Backups" |
 * | auth      | component "Sign-in" > screen "Sign-in screen", data "Users and roles"; nothing when declined |
 * | money     | integration "Payments"; nothing when declined ("none", "not in v1") |
 * | ai        | integration "AI provider" > risk "AI API outage"; nothing when declined |
 * | offline   | component "Sync engine" > data "Local copy", risk "Edit conflicts"; only when offline is chosen |
 * | security  | risk "Data exposure", data "Secrets store" |
 * | scale     | risk "Cost at scale" |
 * | testing   | component "Test suite" > data "Test fixtures"; component "Release pipeline" > data "Build artifacts" |
 * | platforms | per platform mentioned: component "<Platform> screens" > screen "<Platform> home screen" |
 *
 * Any answer with a spike also adds risk "Open: <question id>" (see buildMindMap).
 */
export const AREA_RULES: Readonly<Record<Area, (answer: PlanningAnswer) => NodeSpec[]>> = {
  stack: (a) => [
    {
      kind: "component",
      label: "App shell",
      note: a.text,
      children: [
        { kind: "screen", label: "Main layout" },
        { kind: "integration", label: `Framework: ${short(a.text || a.choice)}`, note: a.text },
      ],
    },
  ],
  data: (a) => [
    {
      kind: "data",
      label: "Data store",
      note: a.text,
      children: [
        { kind: "data", label: "Schema" },
        { kind: "data", label: "Backups" },
      ],
    },
  ],
  auth: (a) =>
    isDeclined(a)
      ? []
      : [
          {
            kind: "component",
            label: "Sign-in",
            note: a.text,
            children: [
              { kind: "screen", label: "Sign-in screen" },
              { kind: "data", label: "Users and roles" },
            ],
          },
        ],
  money: (a) => (isDeclined(a) ? [] : [{ kind: "integration", label: "Payments", note: a.text }]),
  ai: (a) =>
    isDeclined(a)
      ? []
      : [
          {
            kind: "integration",
            label: "AI provider",
            note: a.text,
            children: [{ kind: "risk", label: "AI API outage", note: "the app must keep working when the AI provider is down" }],
          },
        ],
  offline: (a) =>
    choosesOffline(a)
      ? [
          {
            kind: "component",
            label: "Sync engine",
            note: a.text,
            children: [
              { kind: "data", label: "Local copy" },
              { kind: "risk", label: "Edit conflicts", note: "two devices change the same record while apart" },
            ],
          },
        ]
      : [],
  security: (a) => [
    { kind: "risk", label: "Data exposure", note: a.text },
    { kind: "data", label: "Secrets store" },
  ],
  scale: (a) => [{ kind: "risk", label: "Cost at scale", note: a.text }],
  testing: (a) => [
    { kind: "component", label: "Test suite", note: a.text, children: [{ kind: "data", label: "Test fixtures" }] },
    { kind: "component", label: "Release pipeline", children: [{ kind: "data", label: "Build artifacts" }] },
  ],
  platforms: (a) => {
    const text = answerText(a);
    return PLATFORMS.filter((p) => p.pattern.test(text)).map((p) => ({
      kind: "component" as const,
      label: `${p.label} screens`,
      children: [{ kind: "screen" as const, label: `${p.label} home screen` }],
    }));
  },
};

// ---------- Building ----------

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "node"
  );
}

/** Stable node id: kind plus slug of the label, e.g. "component-sign-in". */
export function nodeId(kind: MindNodeKind, label: string): string {
  return `${kind}-${slug(label)}`;
}

/** The area a node came from, read from its first question id ("data.store" -> "data"). */
export function nodeArea(node: MindNode): Area | undefined {
  const head = node.from[0]?.split(".")[0];
  return (AREAS as readonly string[]).includes(head ?? "") ? (head as Area) : undefined;
}

function sortAnswers(answers: PlanningAnswer[]): PlanningAnswer[] {
  const order = (a: PlanningAnswer) => AREAS.indexOf(a.area);
  return [...answers].sort((x, y) => order(x) - order(y) || (x.questionId < y.questionId ? -1 : x.questionId > y.questionId ? 1 : 0));
}

export function buildMindMap(idea: string, answers: PlanningAnswer[]): MindMap {
  const nodes: Record<string, MindNode> = {};
  const links: MindLink[] = [];
  const rootLabel = short(idea, 60) || "Untitled idea";
  nodes.root = { id: "root", kind: "component", label: rootLabel, from: [], children: [] };

  const place = (spec: NodeSpec, parent: string, from: string, fromRepo = false): void => {
    const id = nodeId(spec.kind, spec.label);
    const existing = nodes[id];
    if (existing) {
      if (!existing.from.includes(from)) existing.from.push(from);
    } else {
      nodes[id] = { id, kind: spec.kind, label: spec.label, from: [from], children: [], ...(spec.note ? { note: spec.note } : {}) };
      nodes[parent]!.children.push(id);
      links.push({ from: parent, to: id });
    }
    if (fromRepo && spec.kind !== "risk") nodes[id]!.existing = true;
    for (const child of spec.children ?? []) place(child, id, from, fromRepo);
  };

  for (const answer of sortAnswers(answers)) {
    for (const spec of AREA_RULES[answer.area](answer)) place(spec, "root", answer.questionId, answer.fromRepo === true);
    if (answer.spike) {
      place(
        {
          kind: "risk",
          label: `Open: ${answer.questionId}`,
          note: `Spike ${answer.spike.task} due ${answer.spike.due}: ${answer.spike.risk}`,
        },
        "root",
        answer.questionId,
      );
    }
  }
  return { root: "root", nodes, links };
}

// ---------- Editing (pure: each returns a new map) ----------

function clone(map: MindMap): MindMap {
  const nodes: Record<string, MindNode> = {};
  for (const [id, n] of Object.entries(map.nodes)) nodes[id] = { ...n, from: [...n.from], children: [...n.children] };
  return { root: map.root, nodes, links: map.links.map((l) => ({ ...l })) };
}

function need(map: MindMap, id: string): MindNode {
  const node = map.nodes[id];
  if (!node) throw new Error(`unknown mind map node "${id}"`);
  return node;
}

/** Adds a node under parentId (default: the root). Throws on a duplicate id or unknown parent/children. */
export function addNode(map: MindMap, node: MindNode, parentId: string = map.root): MindMap {
  if (map.nodes[node.id]) throw new Error(`duplicate mind map node "${node.id}"`);
  need(map, parentId);
  for (const child of node.children) need(map, child);
  const next = clone(map);
  next.nodes[node.id] = { ...node, from: [...node.from], children: [...node.children] };
  next.nodes[parentId]!.children.push(node.id);
  next.links.push({ from: parentId, to: node.id });
  return next;
}

/**
 * Removes a node and the sub-parts only it holds, with every link touching
 * them and every child reference to them. The root cannot be removed.
 */
export function removeNode(map: MindMap, id: string): MindMap {
  need(map, id);
  if (id === map.root) throw new Error("the root node cannot be removed");
  const gone = new Set<string>([id]);
  const queue = [...map.nodes[id]!.children];
  while (queue.length) {
    const child = queue.shift()!;
    if (gone.has(child)) continue;
    const otherParents = Object.values(map.nodes).some((n) => !gone.has(n.id) && n.id !== id && n.children.includes(child));
    if (otherParents) continue;
    gone.add(child);
    queue.push(...(map.nodes[child]?.children ?? []));
  }
  const next = clone(map);
  for (const g of gone) delete next.nodes[g];
  for (const n of Object.values(next.nodes)) n.children = n.children.filter((c) => !gone.has(c));
  next.links = next.links.filter((l) => !gone.has(l.from) && !gone.has(l.to));
  return next;
}

/** Changes a node's label; its id stays the same so links and tasks keep pointing at it. */
export function renameNode(map: MindMap, id: string, label: string): MindMap {
  need(map, id);
  if (!label.trim()) throw new Error("a node label cannot be empty");
  const next = clone(map);
  next.nodes[id]!.label = label.trim();
  return next;
}

/** Adds a labelled cross-link between two existing nodes (not a parent/child relation). */
export function linkNodes(map: MindMap, from: string, to: string, label?: string): MindMap {
  need(map, from);
  need(map, to);
  if (from === to) throw new Error("a node cannot link to itself");
  const next = clone(map);
  next.links.push(label ? { from, to, label } : { from, to });
  return next;
}

// ---------- Rendering ----------

const SHAPES: Readonly<Record<MindNodeKind, [string, string]>> = {
  component: ["[", "]"],
  data: ["[(", ")]"],
  screen: ["[/", "/]"],
  integration: ["{{", "}}"],
  risk: ["{", "}"],
};

const mermaidId = (id: string): string => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
const mermaidText = (text: string): string => text.replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ");

/** A `graph TD` Mermaid diagram; node shape shows its kind. */
export function toMermaid(map: MindMap): string {
  const lines = ["graph TD"];
  for (const node of Object.values(map.nodes)) {
    const [open, close] = SHAPES[node.kind];
    lines.push(`  ${mermaidId(node.id)}${open}"${mermaidText(node.label)}"${close}`);
  }
  for (const link of map.links) {
    const arrow = link.label ? `-->|"${mermaidText(link.label)}"|` : "-->";
    lines.push(`  ${mermaidId(link.from)} ${arrow} ${mermaidId(link.to)}`);
  }
  return lines.join("\n");
}
