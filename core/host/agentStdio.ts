// The process an agent (Claude Code, Codex, ...) starts to talk to Perfect Planner.
// It speaks MCP over stdio and forwards every call to the running app's loopback
// bridge with this agent's token. PP_BRIDGE_URL and PP_AGENT_TOKEN come from the
// Connect agent drawer; a worker started from Tasks gets PP_AGENT_TOKEN_FILE instead,
// so its token is never on a command line.
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridgeCall, createAgentMcpServer } from "../mcp/index";
import { isNetworkPath } from "./tokenFile";

const url = process.env.PP_BRIDGE_URL ?? "";
const tokenFile = process.env.PP_AGENT_TOKEN_FILE ?? "";
let token = process.env.PP_AGENT_TOKEN ?? "";
if (!token && tokenFile && isNetworkPath(tokenFile)) {
  process.stderr.write("Perfect Planner: the token file must be on this computer, not a network share.\n");
  process.exit(2);
}
if (!token && tokenFile) {
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    process.stderr.write(`Perfect Planner: cannot read the worker token at ${tokenFile}. Start the worker again from Tasks.\n`);
    process.exit(2);
  }
}
if (!url || !token) {
  process.stderr.write("Perfect Planner: PP_BRIDGE_URL and PP_AGENT_TOKEN (or PP_AGENT_TOKEN_FILE) must be set. Copy the command from Connect agent in the app.\n");
  process.exit(2);
}
const server = createAgentMcpServer(bridgeCall(url, token));
await server.connect(new StdioServerTransport());
