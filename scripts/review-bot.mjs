#!/usr/bin/env node
// Runs the review bot on one pull request.
//   node scripts/review-bot.mjs --repo owner/name --pr 63 [--sizes] [--post]
// Reads GITHUB_TOKEN from the environment (never from arguments). Without --post it only prints,
// and a public repo can be read with no token.
// --sizes measures dist/client (run `npm run build` first) with the performance-budget scanner.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

const repo = arg("repo") ?? process.env.GITHUB_REPOSITORY;
const number = Number(arg("pr"));
const token = process.env.GITHUB_TOKEN ?? "";
if (!repo || !Number.isInteger(number) || number < 1) {
  console.error("Usage: node scripts/review-bot.mjs --repo owner/name --pr <number> [--sizes] [--post]");
  process.exit(2);
}
if (!token && flag("post")) {
  console.error("GITHUB_TOKEN is not set (needed to post).");
  process.exit(2);
}

// Gzip sizes of the built client, counted the way the performance budget counts them.
function measureClientSizes(dir) {
  const sizes = { jsTotalGzip: 0, jsMaxGzip: 0, cssTotalGzip: 0, cssMaxGzip: 0 };
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(?:js|mjs)$/.test(e.name) || e.name.endsWith(".css")) {
        const gz = gzipSync(readFileSync(full)).length;
        const key = e.name.endsWith(".css") ? "css" : "js";
        sizes[`${key}TotalGzip`] += gz;
        sizes[`${key}MaxGzip`] = Math.max(sizes[`${key}MaxGzip`], gz);
      }
    }
  };
  walk(dir);
  return sizes;
}

const work = mkdtempSync(path.join(tmpdir(), "review-bot-"));
try {
  const out = path.join(work, "bot.mjs");
  await build({ entryPoints: [path.join(root, "core/reviewbot/index.ts")], outfile: out, bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "silent" });
  const bot = await import(pathToFileURL(out).href);
  const github = new bot.Github({ fetch, token, repo, botLogin: arg("bot-login") });

  const extra = { expectedGreen: Number(arg("expected-green") ?? 6) };
  if (flag("sizes")) {
    const perf = await import(pathToFileURL(path.join(root, "scripts/verify-performance-budget.mjs")).href);
    extra.budgets = perf.PERFORMANCE_BUDGETS;
    extra.sizes = measureClientSizes(path.join(root, "dist/client"));
  }
  const review = bot.reviewPullRequest(await github.facts(number, extra));
  process.stdout.write(bot.renderReview(review));
  if (flag("post")) console.error(`Comment ${await github.post(review)}.`);
  process.exitCode = review.verdict === "GO" ? 0 : review.verdict === "NO-GO" ? 1 : 3;
} finally {
  rmSync(work, { recursive: true, force: true });
}
