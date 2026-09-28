import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function isWithin(root, candidate) { const relative = path.relative(root, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function detectImage(bytes) {
  if (bytes.length >= 20 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.includes(Buffer.from("IHDR"))) return { mime: "image/png", extension: ".png" };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return { mime: "image/jpeg", extension: ".jpg" };
  return null;
}

export async function buildEvidenceBundle(options) {
  const root = path.resolve(options.projectRoot);
  const tasks = options.tasks ?? [];
  if (!tasks.length) throw new Error("Evidence bundle requires ledger tasks.");
  const verified = tasks.filter((task) => task.status === "verified");
  for (const task of verified) {
    if (!task.proof?.screenshot || !task.proof?.diff || !task.proof?.hash) throw new Error(`Verified task ${task.id} is missing screenshot, diff, or hash proof.`);
  }
  const images = new Map();
  for (const task of verified) {
    const relative = String(task.proof.screenshot).replace(/^[/\\]+/, "");
    const absolute = path.resolve(root, "public", relative);
    if (!isWithin(path.resolve(root, "public"), absolute)) throw new Error(`Evidence screenshot escapes the public root: ${task.id}`);
    if (!images.has(relative)) {
      const bytes = await readFile(absolute);
      const imageType = detectImage(bytes);
      if (!imageType) throw new Error(`Evidence screenshot is not a supported PNG or JPEG: ${relative}`);
      if (bytes.length > Number(options.maxImageBytes ?? 8_000_000)) throw new Error(`Evidence screenshot exceeds the bundle limit: ${relative}`);
      images.set(relative, { dataUri: `data:${imageType.mime};base64,${bytes.toString("base64")}`, mime: imageType.mime, extensionMismatch: path.extname(relative).toLowerCase() !== imageType.extension, sha256: sha256(bytes), size: bytes.length });
    }
  }
  const manifest = {
    schemaVersion: 1, generatedAt: options.generatedAt ?? new Date().toISOString(), verifiedTasks: verified.length,
    openTasks: tasks.length - verified.length,
    screenshots: [...images.entries()].map(([name, image]) => ({ name, mime: image.mime, extensionMismatch: image.extensionMismatch, sha256: image.sha256, size: image.size })),
    truthReportDigest: sha256(JSON.stringify(options.truthReport ?? {})), completionReportDigest: options.completionReport?.digest ?? null,
  };
  const cards = tasks.map((task) => {
    if (task.status !== "verified") return `<article class="card open"><header><b>${escapeHtml(task.id)} · ${escapeHtml(task.title)}</b><span>NOT PROVEN</span></header><p>This task remains open. No crossed box or substituted evidence is shown.</p></article>`;
    const relative = String(task.proof.screenshot).replace(/^[/\\]+/, "");
    const image = images.get(relative);
    return `<article class="card verified"><header><b>${escapeHtml(task.id)} · ${escapeHtml(task.title)}</b><span>VERIFIED</span></header><img src="${image.dataUri}" alt="${escapeHtml(task.title)} proof screenshot"><div class="meta">declared ${escapeHtml(task.proof.hash)} · actual SHA-256 ${image.sha256}</div><h3>Scoped code difference</h3><pre>${escapeHtml(task.proof.diff)}</pre><h3>Review record</h3><p>${escapeHtml(task.proof.reviewer)}</p></article>`;
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Perfect Planner evidence bundle</title><style>body{margin:0;background:#f1ede4;color:#17201c;font:14px ui-monospace,Consolas,monospace}main{max-width:1180px;margin:auto;padding:32px}h1{margin:0 0 8px}.summary,.card{background:#fff;border:2px solid #9ca5a1;border-radius:18px;box-shadow:0 8px 20px #23352c22}.summary{padding:20px;margin:20px 0;display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.summary div{padding:12px;background:#f7f4ed;border-radius:10px}.summary b{display:block;font-size:22px}.card{padding:18px;margin:18px 0}.card header{display:flex;justify-content:space-between;gap:12px}.verified header span{color:#207848}.open header span{color:#a13b32}.card img{display:block;max-width:100%;max-height:620px;margin:14px auto;border:1px solid #aeb5b1}.meta{font-size:11px;overflow-wrap:anywhere;color:#5c6762}pre{white-space:pre-wrap;background:#17201c;color:#e8eee9;padding:14px;border-radius:10px}details{background:#fff;border:1px solid #aeb5b1;border-radius:12px;padding:14px;margin:14px 0}code{overflow-wrap:anywhere}@media(max-width:700px){.summary{grid-template-columns:1fr 1fr}}</style></head><body><main><h1>Perfect Planner · frozen evidence bundle</h1><p>Read-only, self-contained, and generated from the ledger. Open tasks remain visibly unproven.</p><section class="summary"><div><b>${manifest.verifiedTasks}</b>verified tasks</div><div><b>${manifest.openTasks}</b>open tasks</div><div><b>${manifest.screenshots.length}</b>embedded screenshots</div><div><b>${escapeHtml(options.completionReport?.verdict ?? "UNKNOWN")}</b>completion verdict</div></section><details open><summary>Completion truth</summary><pre>${escapeHtml(JSON.stringify(options.completionReport ?? {}, null, 2))}</pre></details><details><summary>Machine truth core</summary><pre>${escapeHtml(JSON.stringify(options.truthReport ?? {}, null, 2))}</pre></details>${cards}<details><summary>Bundle manifest</summary><pre>${escapeHtml(JSON.stringify(manifest, null, 2))}</pre></details></main></body></html>`;
  const bytes = Buffer.from(html);
  const outputPath = path.resolve(options.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, outputPath);
  return { outputPath, sha256: sha256(bytes), size: bytes.length, manifest };
}
