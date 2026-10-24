import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";

// A stand-in `codex`: "login" prints a sign-in address and signs in once the marker file says so;
// "login status" exits 0 only when a login file exists. No browser, no network, no real account.
const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.env.HOME, "codex-auth");
const [, , a, b] = process.argv;
if (a === "login" && b === "status") {
  if (!fs.existsSync(file)) { process.stderr.write("Not logged in\n"); process.exit(1); }
  process.stdout.write("Logged in using ChatGPT\n"); process.exit(0);
}
if (a === "login") {
  process.stdout.write("Open https://auth.openai.com/oauth/authorize?state=abc and also http://evil.example/x\n");
  const wait = setInterval(() => { if (fs.existsSync(path.join(process.env.HOME, "approve"))) { fs.writeFileSync(file, "x"); clearInterval(wait); process.exit(0); } if (fs.existsSync(path.join(process.env.HOME, "deny"))) process.exit(1); }, 50);
}
`;

let base: string;
let stop: () => Promise<void>;
let home: string;
let oldPath: string | undefined;
let oldHome: string | undefined;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pp-codex-"));
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(path.join(home, "bin", "codex"), SCRIPT, { mode: 0o755 });
  oldPath = process.env.PATH;
  oldHome = process.env.HOME;
  process.env.PATH = `${path.join(home, "bin")}${path.delimiter}${oldPath}`;
  process.env.HOME = home;
  ({ base, stop } = await startTestHost());
});
afterEach(async () => {
  process.env.PATH = oldPath;
  process.env.HOME = oldHome;
  await stop();
});

const get = () => hostCall(base, "GET", "/agents/codex-login?project=demo");
const until = async (ok: (r: Record<string, unknown>) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const r = (await get()).body.result as Record<string, unknown>;
    if (ok(r)) return r;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
};

describe.skipIf(process.platform === "win32")("Log in to Codex", () => {
  it("starts the sign-in, passes on only an OpenAI address, and reports done", async () => {
    expect((await get()).body.result).toMatchObject({ installed: true, loggedIn: false, state: "idle" });
    const start = await hostCall(base, "POST", "/agents/codex-login?project=demo", {});
    expect(start.status).toBe(200);
    expect(start.body.result.state).toBe("waiting");
    const waiting = await until((r) => typeof r.url === "string");
    expect(waiting.url).toMatch(/^https:\/\/auth\.openai\.com\//);
    expect(JSON.stringify(waiting)).not.toContain("evil.example");
    fs.writeFileSync(path.join(home, "approve"), "");
    const done = await until((r) => r.state === "done");
    expect(done).toMatchObject({ loggedIn: true, method: "chatgpt" });
    expect(done.url).toBeUndefined();
  });

  it("reports a sign-in that did not finish and changes nothing", async () => {
    await hostCall(base, "POST", "/agents/codex-login?project=demo", {});
    fs.writeFileSync(path.join(home, "deny"), "");
    const failed = await until((r) => r.state === "failed");
    expect(failed).toMatchObject({ loggedIn: false });
    expect(fs.existsSync(path.join(home, "codex-auth"))).toBe(false);
  });

  it("says plainly when Codex is not installed", async () => {
    fs.rmSync(path.join(home, "bin", "codex"));
    expect((await get()).body.result.installed).toBe(false);
    const start = await hostCall(base, "POST", "/agents/codex-login?project=demo", {});
    expect(start.status).toBe(404);
  });
});
