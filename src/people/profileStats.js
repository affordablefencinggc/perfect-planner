// Pure helpers for the person profile: stats from real task rows, and the next free calendar slot.

const OPEN = new Set(["claimed", "blocked", "ready", "open"]);

/** Task rows (the /tasks payload) that belong to one member, by person id or any agent listed under them. */
export function tasksOf(member, tasks = []) {
  const ids = new Set([member.person, ...(member.agents ?? [])]);
  return tasks.filter((t) => t.owner && ids.has(t.owner));
}

export function statsFromTasks(member, tasks = []) {
  const mine = tasksOf(member, tasks);
  const done = mine.filter((t) => t.status === "done" || t.stage === "done");
  const open = mine.filter((t) => !done.includes(t) && OPEN.has(t.status));
  const errors = mine.filter((t) => t.check && t.check.passed === false);
  return {
    finished: done.length,
    open: open.length,
    errors: errors.length,
    total: mine.length,
    openTasks: open.map((t) => ({ id: t.id, label: t.label ?? t.id, status: t.status })),
  };
}

const iso = (d) => d.toISOString().slice(0, 10);
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** First weekday on or after `from` (ISO date) that is not in `busy` (ISO dates). */
export function nextFreeSlot(busy = [], from) {
  const taken = new Set(busy);
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < 400; i += 1) {
    if (!isWeekend(d) && !taken.has(iso(d))) return iso(d);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return iso(d);
}

export const MD_MAX_BYTES = 64 * 1024;
export const isMarkdownName = (name) => /\.(md|markdown|txt)$/i.test(String(name ?? ""));
export const isHttpsLink = (text) => /^https:\/\/[^\s]+$/i.test(String(text ?? "").trim());
