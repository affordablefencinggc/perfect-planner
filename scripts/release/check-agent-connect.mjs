#!/usr/bin/env node
// Proves a Connect agent line works the way a person uses it: run the exact line the app
// showed, with a stand-in `claude` command that records what it was asked to register,
// then start that registered MCP server and check in with hello, as Claude Code would.
//   node scripts/release/check-agent-connect.mjs --line '<the Claude Code command from Connect agent>'
// Prints one JSON summary; exits non-zero when any step fails. The token in the line is
// never printed. Used by the release workflow against the installed desktop app.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Splits the pasted line into words: "quoted paths", bare words, and PowerShell's leading `&`. */
export function parseConnectLine(line) {
  const words = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of String(line).trim().matchAll(pattern)) words.push(match[1] !== undefined ? match[1].replace(/\\"/g, '"') : match[2]);
  if (words[0] === "&") words.shift();
  const [node, connect, bridgeUrl, token] = words;
  if (words.length !== 4 || !/connect\.mjs$/.test(connect ?? "") || !/^http:\/\/127\.0\.0\.1:\d+$/.test(bridgeUrl ?? "") || !/^pp_[cw]_[\w-]{16,}$/.test(token ?? "")) {
    throw new Error("That is not a Connect agent line (node, connect.mjs, bridge address, key).");
  }
  return { node, connect, bridgeUrl, token };
}

/** A `claude` stand-in that writes its arguments, one JSON array per call, to record. */
function fakeClaude(dir, record) {
  const script = path.join(dir, "fake-claude.mjs");
  writeFileSync(script, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  if (process.platform === "win32") writeFileSync(path.join(dir, "claude.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
  else writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
}

function helloOverStdio(command, args, env, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map();
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`The agent program did not answer in time. ${stderr.trim()}`)); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        replies.set(message.id, message);
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hello", arguments: { name: "Release check agent", model: "release-check" } } })}\n`);
        }
        if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ server: replies.get(1)?.result?.serverInfo?.name, hello: message.result?.structuredContent ?? null, error: message.error ?? null });
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-check", version: "1" } } })}\n`);
  });
}

export async function checkAgentConnect(line) {
  const parsed = parseConnectLine(line);
  const dir = mkdtempSync(path.join(tmpdir(), "pp-connect-check-"));
  const record = path.join(dir, "claude-calls.jsonl");
  fakeClaude(dir, record);
  const home = path.join(dir, "home");
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
  delete env.NODE_OPTIONS;
  try {
    const steps = {};
    if (!existsSync(parsed.node) && parsed.node !== "node") throw new Error(`The line's Node runtime is missing: ${parsed.node}`);
    const run = spawnSync(parsed.node, [parsed.connect, parsed.bridgeUrl, parsed.token], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
    steps.connectExit = run.status;
    steps.connectSaid = String(run.stdout).replaceAll(parsed.token, "<key>").trim();
    if (run.status !== 0) throw new Error(`The connect line failed (${run.status}): ${String(run.stderr).replaceAll(parsed.token, "<key>")}`);
    steps.skillInstalled = existsSync(path.join(home, ".claude", "skills", "perfect-planner-connect", "SKILL.md"));
    const calls = readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const add = calls.find((args) => args[0] === "mcp" && args[1] === "add");
    if (!add) throw new Error("The connect line did not register an MCP server with Claude Code.");
    const separator = add.indexOf("--");
    const [command, ...args] = add.slice(separator + 1);
    const serverEnv = {};
    for (let i = 0; i < separator; i++) if (add[i] === "--env") { const [k, ...v] = add[i + 1].split("="); serverEnv[k] = v.join("="); }
    steps.registered = { name: add[2], command, args, usesLineNode: path.resolve(command) === path.resolve(parsed.node) || command === parsed.node };
    const hello = await helloOverStdio(command, args, { ...env, ...serverEnv });
    steps.server = hello.server;
    steps.checkedInAs = hello.hello?.role ?? null;
    if (hello.error || hello.server !== "perfect-planner-core" || !hello.hello) throw new Error(`hello failed: ${JSON.stringify(hello.error)}`);
    return { ok: true, node: parsed.node, ...steps };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--line");
  const line = at > 0 ? process.argv[at + 1] : process.env.PP_CONNECT_LINE;
  checkAgentConnect(line ?? "").then(
    (summary) => { console.log(JSON.stringify(summary, null, 2)); },
    (error) => { console.log(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exit(1); },
  );
}
