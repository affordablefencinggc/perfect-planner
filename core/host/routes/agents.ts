// Connect agent (spec §4.1, §9.5): one click issues a connect token, starts the
// loopback bridge and hands back a ready-to-paste command. The agent's stdio
// entry (core/host/agentStdio.ts, bundled to dist/core-host/agent.mjs) forwards
// its MCP calls to the bridge; the first agent a person connects becomes their
// main chat the moment it calls hello.
//
// Tokens are secrets: the raw token appears only in the POST agents/connect
// response. It is never logged, never written to the ledger and never returned
// by GET agents. The host keeps it in memory only so the connection can be
// revoked (TokenStore.revoke needs the raw token).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentRecord, AgentService } from "../../mcp/index";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";
import { writeOwnerOnlyFile } from "../tokenFile";
import { localPersonId } from "./people";

export const AGENT_SERVER_NAME = "perfect-planner-core";
const PERSON = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const CONNECTIONS = "agents.connections";
const SEEN = "agents.seen";
const BRIDGE_URL = "agents.bridgeUrl";

interface Connection {
  id: string;
  person: string;
  issuedAt: string;
  /** In memory only, for revoke. Never sent to the app window; the agent reads it from tokenFile. */
  token: string;
  tokenFile: string;
  revoked: boolean;
}

export interface AgentView {
  id: string;
  name: string;
  model?: string;
  role: AgentRecord["role"];
  person: string;
  task?: string;
  connectedAt?: string;
  connection?: string;
  revoked?: boolean;
}

export interface ConnectionView {
  id: string;
  person: string;
  issuedAt: string;
  revoked: boolean;
  /** The agent that checked in with this connection's token, once it has. */
  agent?: string;
}

function connections(project: CoreProject): Map<string, Connection> {
  let map = project.state.get(CONNECTIONS) as Map<string, Connection> | undefined;
  if (!map) {
    map = new Map();
    project.state.set(CONNECTIONS, map);
  }
  return map;
}

function seen(project: CoreProject): Map<string, string> {
  let map = project.state.get(SEEN) as Map<string, string> | undefined;
  if (!map) {
    map = new Map();
    project.state.set(SEEN, map);
  }
  return map;
}

/**
 * agent id -> the token it checked in with. AgentService keeps this pairing
 * privately and has no public lookup, so read it defensively; without it the
 * screen still lists agents, just without tying them to a connection.
 */
function agentTokens(service: AgentService): Map<string, string> {
  const out = new Map<string, string>();
  const agents = (service as unknown as { agents?: unknown }).agents;
  if (!(agents instanceof Map)) return out;
  for (const [id, record] of agents as Map<string, { token?: unknown }>) {
    if (typeof record?.token === "string") out.set(id, record.token);
  }
  return out;
}

/** Where the agent's stdio entry lives: next to the bundled host, or dist/core-host in a checkout. */
export function agentEntryPath(from: string = fileURLToPath(import.meta.url)): { path: string; built: boolean } {
  const dir = path.dirname(from);
  if (path.basename(dir) === "core-host" && fs.existsSync(path.join(dir, "agent.mjs"))) return { path: path.join(dir, "agent.mjs"), built: true };
  let root = dir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(root, "package.json"))) break;
    const up = path.dirname(root);
    if (up === root) break;
    root = up;
  }
  const entry = path.join(root, "dist", "core-host", "agent.mjs");
  return { path: entry, built: fs.existsSync(entry) };
}

/** Single quotes in both shells, so nothing in a path ($(...), backticks, %VAR% in PowerShell) runs. */
export const quoteFor = (windows: boolean) => (value: string) =>
  windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'\\''`)}'`;

const connectProgram = (entry: string) => entry.replace(/agent\.mjs$/, "connect.mjs");

/**
 * The Node that runs connect.mjs and agent.mjs. The desktop app ships its own Node and sets
 * PP_NODE_BINARY to it (src/node/desktopHost.mjs), so the person needs no Node install;
 * otherwise (npm start, the dev server) it is the node on PATH.
 */
export function nodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.PP_NODE_BINARY || "node";
}

/** nodeBinary as the first word of a pasted line. A quoted path needs PowerShell's call operator on Windows. */
export function nodeCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const binary = env.PP_NODE_BINARY;
  if (!binary) return "node";
  const quoted = quoteFor(platform === "win32")(binary);
  return platform === "win32" ? `& ${quoted}` : quoted;
}

/**
 * The one line for Claude Code: connect.mjs (next to the agent entry) registers the server for the
 * folder it runs in, replacing an older registration, and installs the perfect-planner-connect skill.
 * It names the token file, never the token, so nothing secret lands in shell history, a chat
 * transcript or ~/.claude.json.
 */
export function connectLine(bridgeUrl: string, tokenFile: string, entry: string, platform: NodeJS.Platform = process.platform): string {
  const quote = quoteFor(platform === "win32");
  return `${nodeCommand(platform)} ${quote(connectProgram(entry))} ${bridgeUrl} ${quote(tokenFile)}`;
}

/** Installs only the skill, user-wide; no token, so it is safe to show at any time. */
export function skillLine(entry: string, platform: NodeJS.Platform = process.platform): string {
  return `${nodeCommand(platform)} ${quoteFor(platform === "win32")(connectProgram(entry))} --skill-only`;
}

export function setupFor(bridgeUrl: string, tokenFile: string, entry: string, platform: NodeJS.Platform = process.platform) {
  const claudeCode = connectLine(bridgeUrl, tokenFile, entry, platform);
  const json = JSON.stringify({ mcpServers: { [AGENT_SERVER_NAME]: { command: nodeBinary(), args: [entry], env: { PP_BRIDGE_URL: bridgeUrl, PP_AGENT_TOKEN_FILE: tokenFile } } } }, null, 2);
  return { claudeCode, json };
}

/** The token waits in a file only this OS user can read (0600, or an owner-only ACL on Windows); the agent program reads it at start. */
export function writeTokenFile(project: CoreProject, name: string, token: string): string {
  const file = path.join(project.root, ".perfect-planner", "tokens", `${name}.token`);
  writeOwnerOnlyFile(file, token);
  return file;
}

function viewAgents(project: CoreProject): { agents: AgentView[]; connections: ConnectionView[] } {
  const conns = connections(project);
  const firstSeen = seen(project);
  const tokens = agentTokens(project.service);
  const byToken = new Map<string, Connection>();
  for (const conn of conns.values()) byToken.set(conn.token, conn);
  const now = new Date().toISOString();
  const linked = new Map<string, string>();

  const agents = project.service.listAgents().map((record): AgentView => {
    if (!firstSeen.has(record.id)) firstSeen.set(record.id, now);
    const token = tokens.get(record.id);
    const conn = token ? byToken.get(token) : undefined;
    const revoked = token ? project.service.tokens.resolve(token) === null : false;
    if (conn && !linked.has(conn.id)) linked.set(conn.id, record.id);
    return {
      id: record.id,
      name: record.name,
      role: record.role,
      person: record.person,
      connectedAt: firstSeen.get(record.id)!,
      ...(record.model ? { model: record.model } : {}),
      ...(record.task ? { task: record.task } : {}),
      ...(conn ? { connection: conn.id } : {}),
      ...(revoked ? { revoked: true } : {}),
    };
  });
  const views = [...conns.values()].map((conn): ConnectionView => ({
    id: conn.id,
    person: conn.person,
    issuedAt: conn.issuedAt,
    revoked: conn.revoked,
    ...(linked.has(conn.id) ? { agent: linked.get(conn.id)! } : {}),
  }));
  return { agents, connections: views };
}

export function registerAgentRoutes(router: Router): void {
  router.get("/agents", ({ project, host }) => {
    const url = project.state.get(BRIDGE_URL) as string | undefined;
    const entry = agentEntryPath();
    return { bridge: { enabled: host.bridgeEnabled, ...(url ? { url } : {}) }, skillLine: skillLine(entry.path), agentBuilt: entry.built, ...viewAgents(project) };
  });

  router.post("/agents/connect", async ({ project, host, body }) => {
    if (!host.bridgeEnabled) throw new HttpError(503, "BRIDGE_OFF", "Agent connections are turned off for this app, so there is nothing for an agent to connect to.");
    const raw = (body as { person?: unknown } | null)?.person;
    const person = raw === undefined || raw === null || raw === "" ? localPersonId(project) : String(raw).trim();
    if (!PERSON.test(person)) throw new HttpError(400, "INVALID", "Pick a person by their short name, such as owner.");
    const bridge = await host.bridge(project);
    project.state.set(BRIDGE_URL, bridge.url);
    const token = project.service.tokens.issue({ role: "connect", person });
    const id = `C-${randomBytes(4).toString("hex")}`;
    const tokenFile = writeTokenFile(project, `connect-${id}`, token);
    const conn: Connection = { id, person, issuedAt: new Date().toISOString(), token, tokenFile, revoked: false };
    connections(project).set(conn.id, conn);
    const entry = agentEntryPath();
    const setup = setupFor(bridge.url, tokenFile, entry.path);
    return {
      connection: conn.id,
      person,
      bridgeUrl: bridge.url,
      tokenFile,
      serverName: AGENT_SERVER_NAME,
      agentPath: entry.path,
      agentBuilt: entry.built,
      claudeCode: setup.claudeCode,
      json: setup.json,
      ...(entry.built ? {} : { warning: "The agent program is not built yet. Run npm run build:core-host in the Perfect Planner folder before pasting this." }),
    };
  });

  router.post("/agents/revoke", ({ project, body }) => {
    const { connection, agent } = (body ?? {}) as { connection?: unknown; agent?: unknown };
    const conns = connections(project);
    let conn: Connection | undefined;
    if (typeof connection === "string") conn = conns.get(connection);
    else if (typeof agent === "string") {
      const token = agentTokens(project.service).get(agent);
      conn = token ? [...conns.values()].find((c) => c.token === token) : undefined;
    } else throw new HttpError(400, "INVALID", "Say which connection or agent to disconnect.");
    if (!conn) throw new HttpError(404, "NOT_FOUND", "That connection is not known to this app. It may have ended when the app restarted.");
    if (!conn.revoked) {
      project.service.tokens.revoke(conn.token);
      conn.revoked = true;
    }
    fs.rmSync(conn.tokenFile, { force: true });
    return { connection: conn.id, revoked: true };
  });
}
