// MVP board routes: stage a project (scan existing code or plan a new one),
// move features across the MVP line with a reason, rename stages, confirm.
// Everything the board shows is rebuilt from the ledger (core/mvp); the only
// scratch state is a cached code scan, which is re-read on demand.
import fs from "node:fs";
import path from "node:path";
import type { Actor, LedgerEntry } from "../../ledger/index";
import { appendNumbered } from "../../numbering/index";
import {
  MockJev, MvpError, STAGE_IDS, boardFromLedger, confirmMvp, isOneLineReason, missingDependencies,
  moveFeature, mvpDoneWhen, proposeWith, recordProposal, renameStage, scanFeatures,
  type Feature, type FeatureStatus, type MvpAdvisor, type ScanResult, type ScannedFeature, type StageBoard, type StageId,
} from "../../mvp/index";
import { replayRoster } from "../../people/index";
import type { CoreProject } from "../project";
import { HttpError, type Handler, type Router } from "../router";
import { localPerson, localPersonId } from "./people";

const SCAN_KEY = "mvp.scan";
const MAX_FEATURES = 200;
const MAX_GOAL = 200;
const DEFAULT_GOAL = "Get the core user journey working end to end";
/** Internal-sounding names: these are not something a person touches directly. */
const INTERNAL = /\b(store|storage|database|db|api|backend|server|infra|infrastructure|performance|budget|logging|logs?|sync|migration|schema|cache|queue|monitoring|hardening|ci)\b/i;

/** Who set the board up, persisted in the ledger next to the proposal. */
interface Staging {
  mode: "existing" | "new";
  goal: string;
  root?: string;
  source: string;
  features: (Feature & { status: FeatureStatus })[];
}

interface CachedScan {
  staging: string; // ledger n of the staging entry
  scan: ScanResult;
  at: string;
}

// The offline advisor. Swapping in the real Jev (core/jev) is this one line.
function advisor(): MvpAdvisor {
  return new MockJev();
}

function isOffline(actor: Actor | undefined): boolean {
  return !!actor && (actor.id === "jev-mock" || actor.model === "mock-1");
}

/** The person using this screen (shared with the People screen so roster rules agree). */
function personActor(project: CoreProject): Actor {
  return localPerson(project);
}

function personName(project: CoreProject, id: string | undefined): string | undefined {
  if (!id) return undefined;
  const member = replayRoster(project.entries()).members.get(id);
  if (member) return member.name;
  return id === localPersonId(project) ? "You" : id;
}

const FRIENDLY: Record<string, string> = {
  REASON_REQUIRED: "Moving a feature out of the MVP needs a one-line reason (not empty, not \"TBD\", at most 200 characters).",
  NO_PROPOSAL: "There is no proposed MVP line yet. Scan this project's code or plan a new project first.",
  NOT_A_PERSON: "Only a person can confirm the MVP line.",
};

/** Turns module refusals into readable 422 answers. */
function guarded(handler: Handler): Handler {
  return async (req) => {
    try {
      return await handler(req);
    } catch (error) {
      if (error instanceof MvpError) {
        const message = error.code === "REASON_REQUIRED" && /journey/.test(error.message) ? error.message : (FRIENDLY[error.code] ?? error.message);
        throw new HttpError(422, error.code, message);
      }
      if (error instanceof Error && /proposed an invalid MVP/.test(error.message)) {
        const problems = error.message.split("\n").slice(1).map((l) => l.replace(/^- /, "")).join("; ");
        throw new HttpError(422, "ADVISOR_REFUSED", `The advisor's proposal broke the board's rules, so nothing was saved: ${problems}.`);
      }
      throw error;
    }
  };
}

function mvpEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.filter((e) => e.type === "decision.made" && (e.data?.mvp || e.data?.mvpStaging));
}

function latestStaging(entries: readonly LedgerEntry[]): { entry: LedgerEntry; staging: Staging } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "decision.made" && e.data?.mvpStaging) return { entry: e, staging: e.data.mvpStaging as Staging };
  }
  return undefined;
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Current features with status and evidence: a fresh (cached) scan for existing code, the plan for a new project. */
function currentFeatures(project: CoreProject, staged: { entry: LedgerEntry; staging: Staging }, refresh = false): { features: ScannedFeature[]; scannedAt?: string; stale: boolean } {
  const { staging, entry } = staged;
  const fromStaging = (): ScannedFeature[] => staging.features.map((f) => ({
    ...f,
    evidence: [],
    findings: staging.mode === "new" ? ["Planned, not built yet"] : ["The folder could not be read again; showing the status from when it was scanned"],
  }));
  if (staging.mode !== "existing" || !staging.root) return { features: fromStaging(), stale: false };
  let cached = project.state.get(SCAN_KEY) as CachedScan | undefined;
  if (refresh || !cached || cached.staging !== entry.n) {
    if (!isDir(staging.root)) return { features: fromStaging(), stale: true };
    cached = { staging: entry.n, scan: scanFeatures(staging.root), at: new Date().toISOString() };
    project.state.set(SCAN_KEY, cached);
  }
  // Keep the staged feature set: features that vanished from the code show as missing.
  const byId = new Map(cached.scan.features.map((f) => [f.id, f]));
  const features = staging.features.map((f): ScannedFeature => byId.get(f.id) ?? { ...f, status: "missing", evidence: [], findings: ["No longer found in the code"] });
  return { features, scannedAt: cached.at, stale: false };
}

function stageName(board: StageBoard, id: string): string {
  return board.stages.find((s) => s.id === id)?.name ?? id;
}

function buildBoard(project: CoreProject, refresh = false) {
  const entries = project.entries();
  const staged = latestStaging(entries);
  const board = boardFromLedger(entries);
  if (!staged || !board.proposalEntry) {
    return { staged: false, stages: board.stages, features: [], confirmed: false };
  }
  const { features, scannedAt, stale } = currentFeatures(project, staged, refresh);
  const byId = new Map(features.map((f) => [f.id, f]));
  const proposalEntry = entries.find((e) => e.n === board.proposalEntry);
  const proposalData = (proposalEntry?.data?.mvp ?? {}) as { summary?: string; proposedBy?: Actor };
  // Jev's proposal is recorded by the system stager; who proposed it is kept in data.mvp.proposedBy.
  const proposedBy = proposalData.proposedBy ?? proposalEntry?.actor;
  const placementOf = new Map(board.placements.map((p) => [p.feature, p]));
  const deps = missingDependencies(board, features);
  const depsOf = new Map(deps.map((d) => [d.feature, d.missing]));

  const cards = board.placements.map((p) => {
    const f = byId.get(p.feature);
    return {
      id: p.feature,
      name: f?.name ?? p.feature,
      description: f?.description,
      status: f?.status ?? "missing",
      evidence: f?.evidence ?? [],
      findings: f?.findings ?? [],
      dependsOn: (f?.dependsOn ?? []).map((d) => ({ id: d, name: byId.get(d)?.name ?? d, stage: placementOf.get(d)?.stage })),
      userFacing: f?.userFacing ?? true,
      stage: p.stage,
      reason: p.reason,
      onJourney: board.journey?.features.includes(p.feature) ?? false,
      missingDependencies: depsOf.get(p.feature) ?? [],
    };
  });

  const warnings = deps.map((d) => {
    const name = byId.get(d.feature)?.name ?? d.feature;
    const needs = d.missing.map((m) => `${byId.get(m)?.name ?? m} (${stageName(board, placementOf.get(m)?.stage ?? "")})`).join(", ");
    return { feature: d.feature, missing: d.missing, message: `${name} is in the ${stageName(board, "mvp")} but needs ${needs}, which sits in a later stage.` };
  });

  let confirmation: { by: string; name?: string; at: string; entry: string; subject: string; note?: string } | undefined;
  if (board.confirmed) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const mvp = e.data?.mvp as { kind?: string; note?: string } | undefined;
      if (e.type === "decision.made" && mvp?.kind === "confirm") {
        confirmation = { by: e.actor.id, name: personName(project, e.actor.id), at: e.at, entry: e.n, subject: e.subject, ...(mvp.note ? { note: mvp.note } : {}) };
        break;
      }
    }
  }

  const done = mvpDoneWhen(board, entries, features);
  // The same blocking list in plain words for Simple view.
  const todo: string[] = [];
  if (!board.confirmed) todo.push("Confirm the MVP line.");
  if (!board.journey) todo.push("Name the journey that proves the MVP works.");
  else if (!done.journeyPassed) todo.push("Run the journey test and see it pass.");
  for (const p of board.placements.filter((x) => x.stage === "mvp")) {
    const f = byId.get(p.feature);
    if (!f) todo.push(`Find ${p.feature} again; it is not in the code any more.`);
    else if (f.status !== "done") todo.push(`Finish ${f.name} (${f.status === "partial" ? "partly built" : "not built yet"}).`);
  }
  const counts: Record<FeatureStatus, number> = { done: 0, partial: 0, missing: 0 };
  for (const f of features) counts[f.status]++;
  const history = mvpEntries(entries).filter((e) => e.n >= staged.entry.n).map((e) => {
    const mvp = e.data?.mvp as { kind?: string } | undefined;
    return { n: e.n, subject: e.subject, kind: mvp?.kind ?? "staging", summary: e.summary, reason: e.reason, actor: e.actor, at: e.at };
  });

  return {
    staged: true,
    mode: staged.staging.mode,
    goal: staged.staging.goal,
    stages: board.stages,
    features: cards,
    counts,
    journey: board.journey,
    confirmed: board.confirmed,
    confirmation,
    doneWhen: { ...done, todo },
    warnings,
    proposal: {
      by: proposedBy,
      offline: isOffline(proposedBy),
      summary: proposalData.summary ?? proposalEntry?.summary ?? "",
      at: proposalEntry?.at,
      entry: board.proposalEntry,
      subject: proposalEntry?.subject,
    },
    source: {
      kind: staged.staging.source,
      root: staged.staging.root,
      scannedAt,
      stale,
      staging: staged.entry.n,
    },
    history,
  };
}

function parseFeatureLines(raw: unknown): Feature[] {
  const lines = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/\r?\n/) : [];
  const parsed = lines
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      // "Plan editor (needs: Local store, Sign in)"
      const m = /^(.*?)\s*\((?:needs|depends on)\s*:?\s*([^)]*)\)\s*$/i.exec(line);
      const name = (m ? m[1]! : line).trim();
      const needs = m ? m[2]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
      return { name, needs };
    })
    .filter((f) => f.name.length > 0);
  if (parsed.length === 0) throw new HttpError(422, "NO_FEATURES", "List at least one feature, one per line.");
  if (parsed.length > MAX_FEATURES) throw new HttpError(422, "TOO_MANY", `List at most ${MAX_FEATURES} features.`);
  const ids = new Map<string, string>(); // lower-case name -> id
  const used = new Set<string>();
  for (const f of parsed) {
    const base = f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "feature";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    if (!ids.has(f.name.toLowerCase())) ids.set(f.name.toLowerCase(), id);
  }
  const out: Feature[] = [];
  const order = [...used];
  parsed.forEach((f, i) => {
    const id = order[i]!;
    const unknown = f.needs.filter((n) => !ids.has(n.toLowerCase()));
    if (unknown.length) throw new HttpError(422, "UNKNOWN_DEPENDENCY", `"${f.name}" needs ${unknown.map((u) => `"${u}"`).join(", ")}, which is not in the list. Add it as its own line or remove it from "needs".`);
    out.push({ id, name: f.name, dependsOn: f.needs.map((n) => ids.get(n.toLowerCase())!).filter((d) => d !== id), userFacing: !INTERNAL.test(f.name) });
  });
  return out;
}

function readGoal(raw: unknown, required: boolean): string {
  const goal = typeof raw === "string" ? raw.trim() : "";
  if (!goal) {
    if (required) throw new HttpError(422, "GOAL_REQUIRED", "Say in one line what the project is for.");
    return DEFAULT_GOAL;
  }
  if (/[\r\n]/.test(goal) || goal.length > MAX_GOAL) throw new HttpError(422, "BAD_GOAL", `Keep the goal to one line of at most ${MAX_GOAL} characters.`);
  return goal;
}

async function stage(project: CoreProject, body: Record<string, unknown>) {
  const mode = body.mode;
  const jev = advisor();
  const actor = personActor(project);
  if (mode === "existing") {
    const goal = readGoal(body.goal, false);
    let root = project.root;
    if (typeof body.path === "string" && body.path.trim()) {
      const candidate = path.resolve(project.root, body.path.trim());
      if (!isDir(candidate)) throw new HttpError(422, "NOT_A_FOLDER", `${body.path.trim()} is not a folder on this computer, so nothing was scanned.`);
      root = candidate;
    } else if (body.path !== undefined && typeof body.path !== "string") {
      throw new HttpError(422, "NOT_A_FOLDER", "The folder to scan must be a path.");
    }
    if (!isDir(root)) throw new HttpError(422, "NOT_A_FOLDER", "This project's folder could not be found, so nothing was scanned.");
    const scan = scanFeatures(root);
    if (scan.features.length === 0) {
      throw new HttpError(422, "NO_FEATURES", `No features were found in ${root}. Perfect Planner looks for a feature registry or files under src/components, src/pages, src/features or app/routes. Choose another folder, or plan a new project instead.`);
    }
    const proposal = await proposeWith(jev, { mode: "existing", goal, features: scan.features });
    const staging: Staging = {
      mode: "existing", goal, root: scan.root, source: scan.source,
      features: scan.features.map(({ id, name, description, dependsOn, userFacing, status }) => ({ id, name, ...(description ? { description } : {}), dependsOn, userFacing, status })),
    };
    const entry = appendNumbered(project.ledger, {
      actor, type: "decision.made",
      summary: `Scanned the code for MVP planning: ${scan.features.length} features (${scan.counts.done} done, ${scan.counts.partial} partial, ${scan.counts.missing} missing)`,
      reason: `Stage the existing project: ${goal}`, evidence: [], refs: [], data: { mvpStaging: staging },
    });
    project.state.set(SCAN_KEY, { staging: entry.n, scan, at: new Date().toISOString() } satisfies CachedScan);
    recordProposal(project.ledger, proposal);
    return buildBoard(project);
  }
  if (mode === "new") {
    const goal = readGoal(body.goal, true);
    const features = parseFeatureLines(body.features);
    const proposal = await proposeWith(jev, { mode: "new", goal, features });
    appendNumbered(project.ledger, {
      actor, type: "decision.made",
      summary: `Planned a new project for MVP planning: ${features.length} features`,
      reason: `Stage the new project: ${goal}`, evidence: [], refs: [],
      data: { mvpStaging: { mode: "new", goal, source: "planned", features: features.map((f) => ({ ...f, status: "missing" as const })) } satisfies Staging },
    });
    recordProposal(project.ledger, proposal);
    return buildBoard(project);
  }
  throw new HttpError(422, "BAD_MODE", "Choose either to scan this project's code or to plan a new project.");
}

function body(req: { body: unknown }): Record<string, unknown> {
  return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

export function registerMvpRoutes(router: Router): void {
  router.get("/mvp", guarded(({ project }) => buildBoard(project)));

  router.post("/mvp/stage", guarded(({ project, ...req }) => stage(project, body(req))));

  router.post("/mvp/rescan", guarded(({ project }) => {
    if (!latestStaging(project.entries())) throw new HttpError(422, "NO_PROPOSAL", FRIENDLY.NO_PROPOSAL!);
    return buildBoard(project, true);
  }));

  router.post("/mvp/move", guarded(({ project, ...req }) => {
    const b = body(req);
    const feature = typeof b.feature === "string" ? b.feature : "";
    const to = b.to as StageId;
    if (!(STAGE_IDS as readonly string[]).includes(String(to))) throw new HttpError(422, "UNKNOWN_STAGE", "Choose a stage to move the feature to.");
    const reason = typeof b.reason === "string" ? b.reason : "";
    if (to !== "mvp" && !isOneLineReason(reason)) throw new HttpError(422, "REASON_REQUIRED", FRIENDLY.REASON_REQUIRED!);
    const board = boardFromLedger(project.entries());
    const from = board.placements.find((p) => p.feature === feature)?.stage;
    if (from === to) return buildBoard(project);
    const entry = moveFeature(project.ledger, personActor(project), feature, to, reason);
    return { ...buildBoard(project), moved: { feature, from, to, entry: entry.n, subject: entry.subject } };
  }));

  router.post("/mvp/rename", guarded(({ project, ...req }) => {
    const b = body(req);
    renameStage(project.ledger, personActor(project), b.stage as StageId, typeof b.name === "string" ? b.name : "");
    return buildBoard(project);
  }));

  router.post("/mvp/confirm", guarded(({ project, ...req }) => {
    const b = body(req);
    const current = buildBoard(project);
    if (current.staged && "warnings" in current && current.warnings && current.warnings.length > 0) {
      throw new HttpError(422, "MISSING_DEPENDENCIES", `The MVP line cannot be confirmed yet: ${current.warnings.map((w) => w.message).join(" ")} Move those features into the MVP or move their dependents out.`);
    }
    confirmMvp(project.ledger, personActor(project), typeof b.note === "string" ? b.note : undefined);
    return buildBoard(project);
  }));
}
