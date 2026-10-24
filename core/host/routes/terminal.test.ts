import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";

// A stand-in `aws`: "configure" asks for two values on its input, prints the first, and never the second.
const SCRIPT = String.raw`#!/usr/bin/env node
process.stdout.write("Access key: ");
let seen = "";
process.stdin.on("data", (d) => {
  seen += d;
  const lines = seen.split("\n");
  if (lines.length === 2) process.stdout.write("got " + lines[0] + "\nSecret: ");
  if (lines.length === 3) { process.stdout.write("got " + lines[1] + "\ndone\n"); process.exit(0); }
});
`;

let base: string;
let stop: () => Promise<void>;
let home: string;
let oldPath: string | undefined;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pp-term-"));
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(path.join(home, "bin", "aws"), SCRIPT, { mode: 0o755 });
  oldPath = process.env.PATH;
  process.env.PATH = `${path.join(home, "bin")}${path.delimiter}${oldPath}`;
  ({ base, stop } = await startTestHost());
});
afterEach(async () => {
  process.env.PATH = oldPath;
  await stop();
});

const call = (method: "GET" | "POST", route: string, body?: unknown) => hostCall(base, method, `${route}${route.includes("?") ? "&" : "?"}project=demo`, body);
const until = async (ok: (r: Record<string, any>) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const r = (await call("GET", "/terminal/run")).body.result;
    if (ok(r)) return r;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
};

describe("script pane", () => {
  it("lists a fixed set of scripts with the exact command shown", async () => {
    const { scripts } = (await call("GET", "/terminal/scripts")).body.result;
    expect(scripts.find((s: any) => s.id === "aws-configure")).toMatchObject({ shown: "aws configure", asks: true });
    expect(scripts.some((s: any) => s.id === "connect-claude")).toBe(true);
  });

  it("refuses anything not on the list", async () => {
    expect((await call("POST", "/terminal/run", { script: "rm -rf /" })).status).toBe(400);
    expect((await call("POST", "/terminal/input", { text: "x" })).status).toBe(409);
  });

  it.skipIf(process.platform === "win32")("passes typed lines on and never shows or keeps a secret", async () => {
    expect((await call("POST", "/terminal/run", { script: "aws-configure" })).status).toBe(200);
    expect((await call("POST", "/terminal/run", { script: "aws-configure" })).status).toBe(409);
    await until((r) => r.output.includes("Access key:"));
    await call("POST", "/terminal/input", { text: "AKIAEXAMPLE" });
    await call("POST", "/terminal/input", { text: "s3cr3t-value", secret: true });
    const done = await until((r) => r.state === "done");
    expect(done.output).toContain("$ aws configure");
    expect(done.output).toContain("got AKIAEXAMPLE");
    expect(done.output).not.toContain("s3cr3t-value");
    expect(done.output).toContain("got ••••");
  });

  it.skipIf(process.platform === "win32")("stops a running script and says when a program is missing", async () => {
    await call("POST", "/terminal/run", { script: "aws-configure" });
    expect((await call("POST", "/terminal/stop")).body.result.state).toBe("stopped");
    const missing = await call("POST", "/terminal/run", { script: "azure-login" });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toMatch(/not installed/);
  });
});
