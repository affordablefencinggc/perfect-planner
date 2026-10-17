// The MVP board: a view of the ledger. Every change is a decision.made entry
// with data.mvp; the board is rebuilt by replaying them.

import { isAuthoritative, type Actor, type Ledger, type LedgerEntry } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import {
  DEFAULT_STAGE_NAMES,
  MvpError,
  STAGE_IDS,
  type Journey,
  type MvpProposal,
  type Placement,
  type ScannedFeature,
  type StageBoard,
  type StageId,
} from "./types";

const MAX_REASON = 200;
const MAX_NAME = 40;

/** True when text is a usable one-line reason. */
export function isOneLineReason(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t === "" || t === "TBD" || t === "tbd" || t === "-") return false;
  if (/[\r\n]/.test(t)) return false;
  return t.length <= MAX_REASON;
}

function requireReason(text: string, what: string): string {
  if (!isOneLineReason(text)) {
    throw new MvpError("REASON_REQUIRED", `${what} needs a one-line reason (not empty or "TBD", at most ${MAX_REASON} characters)`);
  }
  return text.trim();
}

function isStage(stage: unknown): stage is StageId {
  return typeof stage === "string" && (STAGE_IDS as readonly string[]).includes(stage);
}

function emptyBoard(): StageBoard {
  return {
    stages: STAGE_IDS.map((id, order) => ({ id, name: DEFAULT_STAGE_NAMES[id], order })),
    placements: [],
    confirmed: false,
  };
}

function write(ledger: Ledger, actor: Actor, summary: string, reason: string, mvp: Record<string, unknown>): LedgerEntry {
  return appendNumbered(ledger, {
    actor,
    type: "decision.made",
    summary,
    reason,
    evidence: [],
    refs: [],
    data: { mvp },
  });
}

/**
 * Whether a confirm entry was written by a person, judged by the ledger's own
 * isAuthoritative check on the entry's author, never a field inside data.
 */
export function confirmedByPerson(entry: LedgerEntry): boolean {
  return isAuthoritative(entry, { personOnly: true });
}

/**
 * Ledger rule: refuse a confirm written by anyone but a person, so a forged
 * one never reaches the ledger. Replay ignores one anyway.
 */
export function installMvpRules(ledger: Ledger): void {
  ledger.addRule((draft) => {
    const mvp = draft.data?.mvp as { kind?: unknown } | undefined;
    if (draft.type === "decision.made" && mvp?.kind === "confirm" && draft.actor.kind !== "person") {
      return "Only a person can confirm the MVP line";
    }
    return null;
  });
}

/** Replay the ledger into the current board. */
export function boardFromLedger(entries: readonly LedgerEntry[]): StageBoard {
  const board = emptyBoard();
  for (const entry of entries) {
    if (entry.type !== "decision.made") continue;
    // Only entries the ledger checked as written by a person or the system
    // shape the board; a copied or hand-written line on disk does not.
    if (!isAuthoritative(entry)) continue;
    const mvp = entry.data?.mvp as Record<string, any> | undefined;
    if (!mvp || typeof mvp !== "object") continue;
    switch (mvp.kind) {
      case "proposal":
        board.placements = (mvp.placements as Placement[]).map((p) => ({ ...p }));
        board.journey = mvp.journey as Journey;
        board.confirmed = false;
        board.confirmedBy = undefined;
        board.proposalEntry = entry.n;
        break;
      case "move": {
        const p = board.placements.find((x) => x.feature === mvp.feature);
        if (p && isStage(mvp.to)) {
          p.stage = mvp.to;
          p.reason = String(mvp.reason ?? "");
          board.confirmed = false;
          board.confirmedBy = undefined;
        }
        break;
      }
      case "rename": {
        const s = board.stages.find((x) => x.id === mvp.stage);
        if (s && typeof mvp.name === "string") s.name = mvp.name;
        break;
      }
      case "confirm":
        // Only the entry's own actor counts, and only a person's. Anyone can
        // append a decision.made carrying kind "confirm", so the payload
        // proves nothing.
        if (!confirmedByPerson(entry)) break;
        board.confirmed = true;
        board.confirmedBy = entry.actor.id;
        break;
      case "journey": {
        board.journey = mvp.journey as Journey;
        for (const id of board.journey.features) {
          const p = board.placements.find((x) => x.feature === id);
          if (p) {
            if (p.stage !== "mvp") p.reason = "";
            p.stage = "mvp";
          } else board.placements.push({ feature: id, stage: "mvp", reason: "" });
        }
        board.confirmed = false;
        board.confirmedBy = undefined;
        break;
      }
    }
  }
  if (!board.confirmedBy) delete board.confirmedBy;
  if (!board.proposalEntry) delete board.proposalEntry;
  return board;
}

/**
 * The actor that records a proposal. Jev may not write decisions itself
 * (core/ledger "Who may write what"), so the stager records Jev's proposal as
 * the system and keeps who proposed it in data.mvp.proposedBy.
 */
export const MVP_STAGER: Actor = { kind: "system", id: "mvp-stager" };

export function recordProposal(ledger: Ledger, proposal: MvpProposal): LedgerEntry {
  for (const p of proposal.placements) {
    if (!isStage(p.stage)) throw new MvpError("UNKNOWN_STAGE", `Unknown stage "${String(p.stage)}" for ${p.feature}`);
    if (p.stage !== "mvp") requireReason(p.reason, `Leaving ${p.feature} out of the MVP`);
  }
  if (!proposal.journey.test.trim()) throw new MvpError("REASON_REQUIRED", "The journey needs a test command");
  const summary = proposal.summary.trim() || "Proposed MVP line";
  const by = proposal.by.kind === "jev" ? MVP_STAGER : proposal.by;
  return write(ledger, by, summary, `Proposed MVP line (${proposal.by.id})`, {
    kind: "proposal",
    proposedBy: proposal.by,
    journey: proposal.journey,
    placements: proposal.placements,
    summary: proposal.summary,
  });
}

export function moveFeature(ledger: Ledger, actor: Actor, featureId: string, to: StageId, reason: string): LedgerEntry {
  if (!isStage(to)) throw new MvpError("UNKNOWN_STAGE", `Unknown stage "${String(to)}"`);
  const board = boardFromLedger(ledger.entries());
  if (!board.proposalEntry) throw new MvpError("NO_PROPOSAL", "There is no MVP proposal yet");
  const placement = board.placements.find((p) => p.feature === featureId);
  if (!placement) throw new MvpError("UNKNOWN_FEATURE", `Unknown feature ${featureId}`);
  let stored: string;
  if (to === "mvp") stored = isOneLineReason(reason) ? reason.trim() : "Moved into the MVP";
  else stored = requireReason(reason, `Moving ${featureId} out of the MVP`);
  return write(ledger, actor, `Moved ${featureId} from ${placement.stage} to ${to}`, stored, {
    kind: "move",
    feature: featureId,
    from: placement.stage,
    to,
    reason: to === "mvp" ? "" : stored,
  });
}

export function renameStage(ledger: Ledger, actor: Actor, stage: StageId, name: string): LedgerEntry {
  if (!isStage(stage)) throw new MvpError("UNKNOWN_STAGE", `Unknown stage "${String(stage)}"`);
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length < 1 || trimmed.length > MAX_NAME || /[\r\n]/.test(trimmed)) {
    throw new MvpError("BAD_NAME", `A stage name is one line of 1 to ${MAX_NAME} characters`);
  }
  const board = boardFromLedger(ledger.entries());
  const clash = board.stages.find((s) => s.id !== stage && s.name.toLowerCase() === trimmed.toLowerCase());
  if (clash) throw new MvpError("BAD_NAME", `"${trimmed}" is already the name of another stage`);
  return write(ledger, actor, `Renamed stage ${stage} to ${trimmed}`, `Renamed ${stage} to ${trimmed}`, {
    kind: "rename",
    stage,
    name: trimmed,
  });
}

export function confirmMvp(ledger: Ledger, actor: Actor, note?: string): LedgerEntry {
  if (actor.kind !== "person") throw new MvpError("NOT_A_PERSON", "Only a person can confirm the MVP");
  const board = boardFromLedger(ledger.entries());
  if (!board.proposalEntry) throw new MvpError("NO_PROPOSAL", "There is no MVP proposal to confirm");
  const n = note?.trim();
  return write(ledger, actor, "Confirmed the MVP line", n && !/[\r\n]/.test(n) ? n : "Confirmed the MVP line", {
    kind: "confirm",
    note: n || undefined,
  });
}

export function setJourney(ledger: Ledger, actor: Actor, journey: Journey): LedgerEntry {
  if (!journey.test || !journey.test.trim()) throw new MvpError("REASON_REQUIRED", "The journey needs a test command");
  const board = boardFromLedger(ledger.entries());
  const moved = journey.features.filter((id) => {
    const p = board.placements.find((x) => x.feature === id);
    return p !== undefined && p.stage !== "mvp";
  });
  return write(ledger, actor, `Set the MVP journey: ${journey.name}`, "Journey decides when the MVP is done", {
    kind: "journey",
    journey,
    moved,
  });
}

export function stageOf(board: StageBoard, featureId: string): StageId | undefined {
  return board.placements.find((p) => p.feature === featureId)?.stage;
}

export function featuresIn(board: StageBoard, stage: StageId): string[] {
  return board.placements.filter((p) => p.stage === stage).map((p) => p.feature);
}

/** MVP features whose dependencies sit outside the MVP (for a UI warning). */
export function missingDependencies(
  board: StageBoard,
  features: readonly { id: string; dependsOn: string[] }[],
): { feature: string; missing: string[] }[] {
  const inMvp = new Set(featuresIn(board, "mvp"));
  const out: { feature: string; missing: string[] }[] = [];
  for (const f of features) {
    if (!inMvp.has(f.id)) continue;
    const missing = f.dependsOn.filter((d) => !inMvp.has(d));
    if (missing.length) out.push({ feature: f.id, missing });
  }
  return out;
}

export function mvpDoneWhen(
  board: StageBoard,
  entries: readonly LedgerEntry[],
  features: ScannedFeature[],
): { done: boolean; journeyPassed: boolean; blocking: string[] } {
  const blocking: string[] = [];
  if (!board.confirmed) blocking.push("MVP line not confirmed");
  let journeyPassed = false;
  if (!board.journey) {
    blocking.push("No journey has been set");
  } else {
    const test = board.journey.test;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      // Test results come from the gate; an unverified result is ignored.
      if ((e.type === "test.passed" || e.type === "test.failed") && e.data?.test === test && isAuthoritative(e)) {
        journeyPassed = e.type === "test.passed";
        break;
      }
    }
    if (!journeyPassed) blocking.push(`Journey test has not passed yet: ${test}`);
  }
  for (const id of featuresIn(board, "mvp")) {
    const f = features.find((x) => x.id === id);
    if (!f) blocking.push(`${id} was not found in the scan`);
    else if (f.status !== "done") blocking.push(`${f.id} ${f.name} is ${f.status}`);
  }
  return { done: blocking.length === 0, journeyPassed, blocking };
}
