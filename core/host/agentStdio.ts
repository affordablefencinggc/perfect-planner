// The process an agent (Claude Code, Codex, ...) starts to talk to Perfect Planner.
// It speaks MCP over stdio and forwards every call to the running app's loopback
// bridge with this agent's token. PP_BRIDGE_URL and PP_AGENT_TOKEN come from the
// Connect agent drawer.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridgeCall, createAgentMcpServer } from "../mcp/index";

const url = process.env.PP_BRIDGE_URL ?? "";
const token = process.env.PP_AGENT_TOKEN ?? "";
if (!url || !token) {
  process.stderr.write("Perfect Planner: PP_BRIDGE_URL and PP_AGENT_TOKEN must be set. Copy the command from Connect agent in the app.\n");
  process.exit(2);
}
const server = createAgentMcpServer(bridgeCall(url, token));
await server.connect(new StdioServerTransport());
