// Stand-ins for the `claude`, `gemini` and `codex` commands (ledger 02, L2). Each one keeps its
// server list where the real CLI does (in JSON instead of TOML for Codex), takes the arguments
// connect.mjs really passes, and can be told to misbehave the way the real ones do. They let the
// whole connect line run offline for every agent, with no key and no model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentKind } from "../host/agentKinds";

export type FakeMode = "ok" | "hang" | "fail" | "readonly-home";

const SOURCE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const agent = path.basename(process.argv[1]);
const [, , group, verb, ...rest] = process.argv;
const home = process.env.HOME;
const mode = process.env.FAKE_CLI_MODE || "ok";
const cwd = process.cwd();
const die = (text, code = 1) => { process.stderr.write(text + "\n"); process.exit(code); };
if (group !== "mcp") die("unknown command");

const file = { claude: path.join(home, ".claude.json"), gemini: path.join(cwd, ".gemini", "settings.json"), codex: path.join(home, ".codex", "config.json") }[agent];
const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const servers = (doc) => agent === "claude" ? ((doc.projects ||= {})[cwd] ||= {}).mcpServers ||= {} : (doc.mcpServers ||= {});
const write = (doc) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc, null, 2)); };

if (verb === "remove") {
  const doc = read();
  const list = servers(doc);
  if (!(rest[0] in list)) die("No MCP server found with name: " + rest[0]);
  delete list[rest[0]];
  write(doc);
  process.exit(0);
}
if (verb !== "add") die("unknown mcp command");

if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") die("Error: add failed for " + process.env.FAKE_CLI_LEAK, 1);
else {
  if (mode === "readonly-home") die("EROFS: read-only file system, open '" + file + "'");
  let name, command = [], env = {}, scope = "local";
  const a = [...rest];
  while (a.length) {
    const x = a.shift();
    if (x === "-s") scope = a.shift();
    else if (x === "--env" || x === "-e") { const [k, ...v] = a.shift().split("="); env[k] = v.join("="); }
    else if (x === "--") { command = a.splice(0); }
    else if (name === undefined) name = x;
    else command.push(x);
  }
  if (agent === "gemini") {
    // Gemini CLI 0.65 will not change a folder's settings until the folder is trusted.
    let trusted = {};
    try { trusted = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "trustedFolders.json"), "utf8")); } catch {}
    if (trusted[cwd] !== "TRUST_FOLDER") die("Error: Cannot modify settings in an untrusted workspace. To enable this, verify the source of the repository and set GEMINI_CLI_TRUST_WORKSPACE=true or move your configuration to the global settings file.");
  }
  const doc = read();
  servers(doc)[name] = { command: command[0], args: command.slice(1), env, scope };
  write(doc);
  process.stdout.write("Added " + name + "\n");
}
`;

export interface FakeAgents {
  /** Folder to put first on PATH. */
  bin: string;
  /** Private home the fake CLIs and connect.mjs write into. */
  home: string;
  /** The server a fake CLI recorded for a folder, or undefined. */
  registered(agent: AgentKind, cwd: string): { command: string; args: string[]; env: Record<string, string> } | undefined;
  trustFolder(folder: string): void;
  cleanup(): void;
}

export function fakeAgents(): FakeAgents {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-fake-agents-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  for (const agent of ["claude", "gemini", "codex"] as const) fs.writeFileSync(path.join(bin, agent), SOURCE, { mode: 0o755 });
  const read = (file: string): any => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  return {
    bin,
    home,
    registered(agent, cwd) {
      const doc = agent === "claude" ? read(path.join(home, ".claude.json")).projects?.[cwd] : agent === "gemini" ? read(path.join(cwd, ".gemini", "settings.json")) : read(path.join(home, ".codex", "config.json"));
      return doc?.mcpServers?.["perfect-planner-core"];
    },
    trustFolder(folder) {
      const file = path.join(home, ".gemini", "trustedFolders.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...read(file), [folder]: "TRUST_FOLDER" }));
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
