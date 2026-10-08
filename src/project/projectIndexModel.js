// Search index for one imported project, built from what the app actually stores:
// saved task drafts, discovery areas, saved plans/contracts, proof labels, build
// notes and the file paths named in tasks. The folder scan stores counts and a
// digest only, so individual file names outside task drafts are not searchable.
import { workspaceDiscoveryCategories } from "../engine/workspaceDiscoveryEngine.js";
import { BUILD_STATE_LABELS } from "./projectBuildModel.js";
import { proofItems } from "./workRecordReaders.js";

export const INDEX_KINDS = Object.freeze({
  task: "Task",
  area: "Discovery area",
  saved: "Saved plan",
  proof: "Proof",
  file: "File",
  build: "Build note",
});

const SAVED = Object.freeze([
  ["architecture", "Architecture (Blueprint)", "blueprint"],
  ["folder", "Folder contract", "structure"],
  ["component", "Component catalog", "components"],
  ["plan", "Approved plan", "plan"],
]);
const SAVED_STATE = Object.freeze({ authoritative: "published", generated: "drafted, not yet published", stale: "out of date", unavailable: "unavailable" });
const AREA_STATE = Object.freeze({ observed: "found in the folder scan", signal: "needs your review", unanswered: "not answered yet" });

const entry = (kind, id, title, detail, workspace, extra = {}, searchText = "") => ({
  key: `${kind}:${id}`, kind, id, title, detail, workspace, ...extra,
  text: `${id} ${title} ${detail} ${searchText}`.toLowerCase(),
});

export function buildProjectIndex({ project, ledger = null, sections = {} }) {
  const entries = [];
  const tasks = ledger?.tasks ?? [];
  for (const task of tasks) {
    const detail = task.archived ? "Archived task draft" : [task.owner ? `Owner: ${task.owner}` : "No owner yet", `${task.claims.length} file${task.claims.length === 1 ? "" : "s"} named`].join(" · ");
    entries.push(entry("task", task.id, task.title, detail, "ledger", { taskId: task.id, archived: task.archived }, `${task.description} ${task.acceptance} ${task.recovery} ${task.owner}`));
  }

  const byId = new Map((project?.discovery?.categories ?? []).map((category) => [category.id, category]));
  const reviews = sections.discoveryReview?.data ?? {};
  for (const definition of workspaceDiscoveryCategories) {
    const category = byId.get(definition.id);
    const review = reviews?.[definition.id] ?? reviews?.categories?.[definition.id] ?? null;
    const reviewText = review && typeof review === "object" ? [review.answer, review.note, review.decision, review.state].filter((value) => typeof value === "string").join(" ") : "";
    const detail = `${AREA_STATE[category?.state ?? "unanswered"]}${category?.findingCount ? ` · ${category.findingCount} finding${category.findingCount === 1 ? "" : "s"}` : ""}${reviewText ? ` · ${reviewText}` : ""}`;
    entries.push(entry("area", definition.id, definition.title, detail, "structure", {}, `${definition.questions.join(" ")} ${(category?.findingIds ?? []).join(" ")}`));
  }

  for (const [kind, title, workspace] of SAVED) {
    const authority = project?.authorities?.[kind];
    if (!authority) continue;
    entries.push(entry("saved", kind, title, `Revision ${authority.revision} · ${SAVED_STATE[authority.state] ?? authority.state}`, workspace));
  }

  proofItems(sections).forEach((item, index) => {
    entries.push(entry("proof", `${item.taskId}-${index + 1}`, item.label, `Proof for ${item.taskId}${item.kind && item.kind !== item.label ? ` · ${item.kind}` : ""}`, "evidence", { taskId: item.taskId }));
  });

  const files = new Map();
  for (const task of tasks) for (const claim of task.claims) {
    const key = claim.path.toLowerCase();
    if (!files.has(key)) files.set(key, { path: claim.path, tasks: [] });
    files.get(key).tasks.push(`${task.id} (${claim.access === "write" ? "changes" : "reads"})`);
  }
  for (const file of files.values()) entries.push(entry("file", file.path, file.path, `Named in ${file.tasks.join(", ")}`, "ledger", { taskId: file.tasks[0].slice(0, file.tasks[0].indexOf(" ")) }));

  for (const [taskId, status] of Object.entries(sections.build?.data?.status ?? {})) {
    if (!status || !BUILD_STATE_LABELS[status.state]) continue;
    entries.push(entry("build", taskId, `${taskId} — ${BUILD_STATE_LABELS[status.state]}`, status.note || "No note", "build", { taskId }));
  }

  return {
    projectId: project?.projectId ?? null,
    censusDigest: project?.census?.digest ?? null,
    fileCount: project?.census?.fileCount ?? null,
    entries,
    counts: Object.fromEntries(Object.keys(INDEX_KINDS).map((kind) => [kind, entries.filter((item) => item.kind === kind).length])),
  };
}

/** Every word must match; title matches rank first. */
export function searchProjectIndex(index, query, { limit = 60 } = {}) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!words.length) return [];
  return index.entries
    .filter((item) => words.every((word) => item.text.includes(word)))
    .map((item) => ({ item, score: words.reduce((sum, word) => sum + (item.title.toLowerCase().includes(word) ? 2 : 0) + (item.id.toLowerCase() === word ? 3 : 0), 0) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ item }) => item);
}
