#!/usr/bin/env node
// Records a named person's viewing of the exact screenshot the release truth validates.
// This is the human half of the screenshot gate: it never captures, and it never accepts a
// capture or a release approval as proof of viewing. The attestation is bound to the artifact
// hash, so a changed image cannot inherit an earlier viewing.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  completeDurableScreenshotViewing,
  inspectDurableScreenshotViewing,
  issueDurableScreenshotViewingChallenge,
  validatePngScreenshot,
} from "../src/node/screenshotEvidence.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.resolve(projectRoot, process.env.PP_SCREENSHOT_ARTIFACT ?? "public/assets/evidence/whole-plan-map.png");
const storePath = path.resolve(process.env.PP_SCREENSHOT_VIEWING_STORE ?? path.join(projectRoot, ".cache", "screenshot-viewing.json"));
const allowedRoot = path.dirname(storePath);
const viewer = String(process.argv[2] ?? process.env.PP_SCREENSHOT_VIEWER ?? "").trim();

if (!process.stdin.isTTY) throw new Error("Screenshot viewing must be attested by a person in an interactive terminal.");
if (!viewer) throw new Error('Pass the viewer name: node scripts/attest-screenshot-viewing.mjs "Daniel Sivyer"');

const bytes = await readFile(artifactPath);
const validation = validatePngScreenshot(bytes);
const artifactStat = await stat(artifactPath);
const record = {
  schemaVersion: 1,
  planId: "PP-CLEANROOM",
  itemId: "SCREENSHOT",
  targetUrl: "local-artifact",
  artifactPath,
  artifactHash: validation.sha256,
  width: validation.width,
  height: validation.height,
  capturedAt: artifactStat.mtime.toISOString(),
  adapter: "existing-artifact",
  isolatedProfile: false,
  capturePerformedThisRun: false,
  viewingStatus: "UNVIEWED",
};

const before = await inspectDurableScreenshotViewing(storePath, { allowedRoot });
const already = before.attestations.find((item) => item.planId === record.planId && item.itemId === record.itemId && item.artifactHash === record.artifactHash);
if (already) {
  process.stdout.write(`This exact screenshot is already attested by ${already.viewedBy} at ${already.viewedAt}.\n`);
  process.stdout.write(`Artifact: ${artifactPath}\nsha256: ${record.artifactHash}\n`);
  process.exit(0);
}

const challenge = await issueDurableScreenshotViewingChallenge(storePath, record, { allowedRoot, requestedViewer: viewer, actor: viewer });
process.stdout.write(`\nOpen and inspect this exact file:\n  ${artifactPath}\n`);
process.stdout.write(`Dimensions: ${validation.width} x ${validation.height}\nsha256: ${record.artifactHash}\n\n`);
process.stdout.write(`One-time challenge token: ${challenge.token}\n`);
process.stdout.write(`This token expires at ${challenge.expiresAt}.\n\n`);

const prompt = createInterface({ input: process.stdin, output: process.stdout });
try {
  const token = (await prompt.question("Type the challenge token: ")).trim();
  const observation = (await prompt.question("Describe something concrete you saw (at least 12 characters): ")).trim();
  const confirmed = (await prompt.question('Type VIEWED to confirm you viewed this exact screenshot: ')).trim();
  if (confirmed !== "VIEWED") throw new Error("Not confirmed; no attestation was recorded.");
  const attestation = await completeDurableScreenshotViewing(storePath, record, {
    challengeId: challenge.challengeId,
    token,
    actor: viewer,
    explicitGesture: true,
    observation,
  }, { allowedRoot });
  process.stdout.write(`\nViewing attested by ${attestation.viewedBy} at ${attestation.viewedAt}.\n`);
  process.stdout.write(`Bound to sha256 ${attestation.artifactHash}.\n`);
} finally {
  prompt.close();
}
