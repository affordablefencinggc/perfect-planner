import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildEvidenceBundle } from "../src/node/evidenceBundle.mjs";

const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from("0000IHDR0000IEND")]);
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "pp-bundle-")); await mkdir(path.join(root, "public", "proof"), { recursive: true }); await writeFile(path.join(root, "public", "proof", "shot.png"), png); return root; }
const verified = { id: "T01", title: "Shell", status: "verified", proof: { screenshot: "/proof/shot.png", hash: "DECLARED", diff: "+ safe <change>", reviewer: "human viewed" } };

test("bundle embeds screenshot, scoped diff, reports, and manifest without external assets", async () => {
  const root = await fixture(); const outputPath = path.join(root, "bundle.html");
  const result = await buildEvidenceBundle({ projectRoot: root, outputPath, tasks: [verified], truthReport: { journal: { valid: true } }, completionReport: { verdict: "NO-GO", digest: "abc" }, generatedAt: "2026-09-02T00:00:00.000Z" });
  const html = await readFile(outputPath, "utf8");
  assert.match(html, /data:image\/png;base64/); assert.match(html, /Scoped code difference/); assert.match(html, /&lt;change&gt;/); assert.equal(result.manifest.verifiedTasks, 1);
});

test("open tasks stay visibly unproven without fabricated capsules", async () => {
  const root = await fixture(); const outputPath = path.join(root, "bundle.html");
  await buildEvidenceBundle({ projectRoot: root, outputPath, tasks: [verified, { id: "T02", title: "Open", status: "queued" }] });
  const html = await readFile(outputPath, "utf8"); assert.match(html, /T02 · Open/); assert.match(html, /NOT PROVEN/);
});

test("a verified task without paired proof is refused", async () => {
  const root = await fixture(); await assert.rejects(() => buildEvidenceBundle({ projectRoot: root, outputPath: path.join(root, "bundle.html"), tasks: [{ id: "T", status: "verified" }] }), /missing screenshot/);
});

test("non-PNG evidence is refused", async () => {
  const root = await fixture(); await writeFile(path.join(root, "public", "proof", "shot.png"), "not an image");
  await assert.rejects(() => buildEvidenceBundle({ projectRoot: root, outputPath: path.join(root, "bundle.html"), tasks: [verified] }), /not a supported PNG or JPEG/);
});

test("a misnamed JPEG is embedded by its real media type and disclosed", async () => {
  const root = await fixture(); const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]); await writeFile(path.join(root, "public", "proof", "shot.png"), jpeg);
  const result = await buildEvidenceBundle({ projectRoot: root, outputPath: path.join(root, "bundle.html"), tasks: [verified] });
  const html = await readFile(path.join(root, "bundle.html"), "utf8");
  assert.match(html, /data:image\/jpeg;base64/); assert.equal(result.manifest.screenshots[0].extensionMismatch, true);
});

test("screenshot paths cannot escape the public root", async () => {
  const root = await fixture(); const unsafe = { ...verified, proof: { ...verified.proof, screenshot: "../../outside.png" } };
  await assert.rejects(() => buildEvidenceBundle({ projectRoot: root, outputPath: path.join(root, "bundle.html"), tasks: [unsafe] }), /escapes the public root/);
});
