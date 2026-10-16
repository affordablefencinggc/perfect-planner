// Pure text helpers for the People panel.

export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const IDLE_MS = 24 * 60 * 60 * 1000;

export function relativeTime(atIso, nowDate) {
  const at = new Date(atIso).getTime();
  const now = (nowDate instanceof Date ? nowDate : new Date(nowDate ?? Date.now())).getTime();
  if (Number.isNaN(at) || Number.isNaN(now)) return "";
  const diff = now - at;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0];
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : "";
  return (first + last).toUpperCase();
}

export function stageLabel(stage) {
  const s = String(stage ?? "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

export function isIdle(presence, nowDate) {
  if (!presence) return false;
  const at = new Date(presence.at).getTime();
  const now = (nowDate instanceof Date ? nowDate : new Date(nowDate ?? Date.now())).getTime();
  return !Number.isNaN(at) && now - at > IDLE_MS;
}

export function presenceLine(member, nowDate) {
  const p = member?.presence;
  if (!p) return "No activity yet";
  const parts = [`On ${p.subject}`, `${stageLabel(p.stage)} stage`, relativeTime(p.at, nowDate)].filter(Boolean);
  let line = parts.join(" · ");
  if (p.via && p.via !== member.person) line += ` · via ${p.via}`;
  if (p.summary) line += ` — ${p.summary}`;
  return line;
}

export function slugify(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
