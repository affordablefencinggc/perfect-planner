// Proof items and plan sign-off for imported projects (Evidence + Integrity).
// Pure functions only: the panels read task drafts and work records, and this
// module decides coverage. Absence is never treated as proof.

export const PROOF_KINDS = Object.freeze([
  { id: "screenshot", label: "Screenshot", formats: ["image", "link"] },
  { id: "diff", label: "Code change", formats: ["link", "text"] },
  { id: "test", label: "Test result", formats: ["text", "link"] },
  { id: "note", label: "Note", formats: ["text", "link"] },
  { id: "skip", label: "Not needed for this task", formats: ["text"] },
]);
export const REQUIRED_PROOF_KINDS = Object.freeze(["screenshot", "diff", "test"]);
export const REQUIRED_KIND_LABELS = Object.freeze({ screenshot: "a screenshot", diff: "a code change", test: "a passing test" });
export const MAX_IMAGE_CHARS = 550_000; // ~400 KB of image bytes once base64-encoded
export const MAX_TEXT_CHARS = 20_000;
const KIND_IDS = new Set(PROOF_KINDS.map((kind) => kind.id));
const TASK_ID = /^T\d{4,6}$/;
const fail = (message) => { throw new Error(message); };

export const kindLabel = (kind) => PROOF_KINDS.find((item) => item.id === kind)?.label ?? kind;

/** Small, stable, non-cryptographic fingerprint (two FNV-1a passes) used to notice plan changes. */
export function fingerprint(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x5bd1e995) >>> 0;
  }
  return `fp-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

const taskIdOf = (value) => typeof value === "string" ? value : typeof value?.id === "string" ? value.id : typeof value?.taskId === "string" ? value.taskId : null;

/** Task ids in the approved plan, or null when no plan approval is recorded or it lists no tasks. */
export function planTaskIds(planAuthority) {
  const data = planAuthority?.data;
  if (!data || typeof data !== "object") return null;
  const list = [data.taskIds, data.tasks, data.ledger?.tasks, data.plan?.tasks].find(Array.isArray);
  if (!list) return null;
  const ids = list.filter((task) => !task?.archived).map(taskIdOf).filter((id) => id && TASK_ID.test(id));
  return ids.length ? [...new Set(ids)] : null;
}

function planDigest(planAuthority) {
  const data = planAuthority.data ?? {};
  const named = [data.planDigest, data.digest, data.ledgerDigest].find((value) => typeof value === "string" && value);
  return named ?? `plan-revision-${planAuthority.revision}`;
}

export const activeDrafts = (ledger) => (ledger?.tasks ?? []).filter((task) => !task.archived);

/**
 * Which tasks need proof. The approved plan wins; otherwise the live task drafts;
 * otherwise (inside receipt derivers, which cannot read drafts) the most recent
 * task list a person saw when they added proof or signed off.
 */
export function proofScope(sections = {}, ledger = null) {
  const planIds = planTaskIds(sections.planAuthority);
  if (planIds) return { source: "plan", taskIds: planIds, digest: planDigest(sections.planAuthority), seenAt: sections.planAuthority.recordedAt ?? null };
  if (ledger) {
    const tasks = activeDrafts(ledger);
    return { source: "drafts", taskIds: tasks.map((task) => task.id), digest: fingerprint(tasks.map((task) => [task.id, task.title, task.acceptance, task.claims])), seenAt: null };
  }
  const snapshots = [
    sections.proof?.data?.scope && { ...sections.proof.data.scope, seenAt: sections.proof.recordedAt },
    sections.review?.data?.planDigest && { source: sections.review.data.planSource, taskIds: sections.review.data.taskIds, digest: sections.review.data.planDigest, seenAt: sections.review.recordedAt },
  ].filter((item) => item && Array.isArray(item.taskIds) && typeof item.digest === "string");
  snapshots.sort((left, right) => String(right.seenAt ?? "").localeCompare(String(left.seenAt ?? "")));
  const latest = snapshots[0];
  if (!latest) return { source: "none", taskIds: [], digest: null, seenAt: null };
  return { source: "snapshot", taskIds: latest.taskIds.filter((id) => TASK_ID.test(id)), digest: latest.digest, seenAt: latest.seenAt };
}

export const proofItems = (sections = {}) => {
  const items = sections.proof?.data?.items;
  return items && typeof items === "object" && !Array.isArray(items) ? items : {};
};

/** A task is covered for a kind when it has that proof (a test must have passed) or it is marked not needed. */
function kindStatus(list, kind) {
  if (list.some((item) => item.kind === kind && (kind !== "test" || item.outcome === "passed"))) return "proof";
  if (list.some((item) => item.kind === "skip" && item.covers === kind)) return "skipped";
  if (kind === "test" && list.some((item) => item.kind === "test")) return "failed";
  return null;
}

export function proofCoverage(scope, items) {
  const tasks = scope.taskIds.map((taskId) => {
    const list = Array.isArray(items[taskId]) ? items[taskId] : [];
    const kinds = Object.fromEntries(REQUIRED_PROOF_KINDS.map((kind) => [kind, kindStatus(list, kind)]));
    const covered = REQUIRED_PROOF_KINDS.filter((kind) => kinds[kind] === "proof" || kinds[kind] === "skipped").length;
    return { taskId, count: list.length, kinds, covered, status: covered === REQUIRED_PROOF_KINDS.length ? "complete" : covered || list.length ? "partial" : "none" };
  });
  const byKind = Object.fromEntries(REQUIRED_PROOF_KINDS.map((kind) => {
    const covered = tasks.filter((task) => task.kinds[kind] === "proof" || task.kinds[kind] === "skipped");
    return [kind, { covered: covered.length, skipped: tasks.filter((task) => task.kinds[kind] === "skipped").length, missing: tasks.filter((task) => !covered.includes(task)).map((task) => task.taskId) }];
  }));
  return {
    tasks,
    total: tasks.length,
    complete: tasks.filter((task) => task.status === "complete").length,
    partial: tasks.filter((task) => task.status === "partial").length,
    none: tasks.filter((task) => task.status === "none").length,
    byKind,
  };
}

/** Latest test proof recorded as run against the merged code, across all tasks. */
export function latestMergedTest(items) {
  return Object.entries(items)
    .flatMap(([taskId, list]) => (Array.isArray(list) ? list : []).filter((item) => item.kind === "test" && item.merged === true).map((item) => ({ ...item, taskId })))
    .sort((left, right) => String(right.addedAt).localeCompare(String(left.addedAt)))[0] ?? null;
}

const isLink = (value) => { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } };

/** Validates one proof item before it is stored. Returns a clean copy. */
export function validateProofItem(input) {
  const item = input ?? {};
  if (!KIND_IDS.has(item.kind)) fail("Choose what kind of proof this is.");
  const kind = PROOF_KINDS.find((entry) => entry.id === item.kind);
  if (!kind.formats.includes(item.format)) fail(`${kind.label} proof cannot be stored in that form.`);
  const addedBy = typeof item.addedBy === "string" ? item.addedBy.trim() : "";
  if (!addedBy || addedBy.length > 120) fail("Say who is adding this proof (up to 120 characters).");
  const label = typeof item.label === "string" ? item.label.trim().slice(0, 160) : "";
  const value = typeof item.value === "string" ? (item.format === "image" ? item.value : item.value.trim()) : "";
  if (!value) fail(item.kind === "skip" ? "Explain why this proof is not needed." : "Add the proof itself: an image, a link, or pasted text.");
  if (item.format === "link" && !isLink(value)) fail("Links must start with https:// or http://.");
  if (item.format === "image" && (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) || value.length > MAX_IMAGE_CHARS)) fail("The screenshot could not be stored. Choose a PNG, JPEG, WebP or GIF image.");
  if (item.format === "text" && value.length > MAX_TEXT_CHARS) fail(`Pasted text is limited to ${MAX_TEXT_CHARS.toLocaleString()} characters. Link to the full output instead.`);
  if (typeof item.id !== "string" || !item.id) fail("Proof item is missing its id.");
  if (typeof item.addedAt !== "string" || !Number.isFinite(Date.parse(item.addedAt))) fail("Proof item is missing its time.");
  const clean = { id: item.id, kind: item.kind, format: item.format, label, value, addedAt: item.addedAt, addedBy };
  if (item.kind === "test") {
    if (!["passed", "failed"].includes(item.outcome)) fail("Say whether the tests passed or failed.");
    clean.outcome = item.outcome;
    clean.merged = item.merged === true;
  }
  if (item.kind === "skip") {
    if (!REQUIRED_PROOF_KINDS.includes(item.covers)) fail("Choose which proof is not needed.");
    clean.covers = item.covers;
  }
  return clean;
}

export const newProofId = () => `P-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Next proof section data after adding one item to one task. */
export function addProofItem(sections, taskId, input, scope) {
  if (!TASK_ID.test(taskId ?? "")) fail("Choose the task this proof belongs to.");
  const item = validateProofItem(input);
  const items = proofItems(sections);
  return { items: { ...items, [taskId]: [...(Array.isArray(items[taskId]) ? items[taskId] : []), item] }, scope: scopeSnapshot(scope) };
}

export function removeProofItem(sections, taskId, itemId, scope) {
  const items = proofItems(sections);
  const remaining = (items[taskId] ?? []).filter((item) => item.id !== itemId);
  const next = { ...items };
  if (remaining.length) next[taskId] = remaining; else delete next[taskId];
  return { items: next, scope: scopeSnapshot(scope) };
}

const scopeSnapshot = (scope) => scope && scope.source !== "none" ? { source: scope.source === "snapshot" ? "drafts" : scope.source, taskIds: [...scope.taskIds], digest: scope.digest } : null;

/** Review section data for a named sign-off on the current plan version. */
export function signOffRecord({ scope, reviewer, notes, now = new Date().toISOString() }) {
  const name = typeof reviewer === "string" ? reviewer.trim() : "";
  if (!name || name.length > 120) fail("Enter the reviewer's name (up to 120 characters).");
  if (!scope?.digest || !scope.taskIds.length) fail("There are no tasks to sign off yet.");
  const text = typeof notes === "string" ? notes.trim() : "";
  if (text.length > 4000) fail("Notes are limited to 4,000 characters.");
  return { planDigest: scope.digest, planSource: scope.source === "snapshot" ? "drafts" : scope.source, taskIds: [...scope.taskIds], reviewer: name, signedAt: now, notes: text };
}

/** True for the browser's "storage full" errors across engines. */
export function isQuotaError(error) {
  return Boolean(error) && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014);
}

export function saveErrorMessage(error) {
  if (isQuotaError(error)) return "Browser storage for this project is full, so nothing was saved. Remove a large screenshot or add a link to the image instead, then try again.";
  if (error?.message === "WORK_RECORDS_UNREADABLE") return "Saved records for this project could not be read, so nothing was changed. The unreadable copy was kept for recovery.";
  if (error?.message === "WORK_RECORDS_STORAGE_UNAVAILABLE") return "Browser storage is unavailable here (for example in a private window), so nothing was saved.";
  return error?.message || "Nothing was saved.";
}
