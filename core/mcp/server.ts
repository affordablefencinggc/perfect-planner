// The MCP face of the agent tools. One MCP server per connected agent: it
// remembers the agent id hello returned and forwards every call, with the
// agent's token, to the single Perfect Planner process (in-process for tests
// and the desktop app, or over the local bridge for agents in other processes).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_INFO, TOOL_INPUTS, TOOL_NAMES, type ToolName } from "./tools";

/** Forwards one call to the Perfect Planner process. Throws { code, message } on refusal. */
export type RemoteCall = (call: { tool: ToolName; args: unknown; agent?: string }) => Promise<unknown>;

const INSTRUCTIONS = [
  "Perfect Planner coordinates agents through one strict ledger.",
  "Call hello once when you connect. The first agent to connect becomes the main chat; workers launched on a task get a token for that task only.",
  "Workers: claim_task, report_progress, attach_proof, ask_main, release_task. Main chat: check_inbox between steps (open questions, plus notices of what Perfect Planner saw the workers do), answer questions by Q number.",
  "Every write is a ledger entry. Nothing you report marks a task done; Perfect Planner runs the approved test itself.",
].join(" ");

type LooseRegister = (name: string, config: Record<string, unknown>, cb: (args: Record<string, unknown>) => Promise<unknown>) => unknown;

export function createAgentMcpServer(remote: RemoteCall): McpServer {
  const server = new McpServer({ name: "perfect-planner-core", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  let agent: string | undefined;
  const register = server.registerTool.bind(server) as unknown as LooseRegister;

  for (const name of TOOL_NAMES) {
    const info = TOOL_INFO[name];
    register(
      name,
      {
        title: info.title,
        description: info.description,
        inputSchema: TOOL_INPUTS[name].shape,
        annotations: { title: info.title, readOnlyHint: info.readOnly, destructiveHint: false, idempotentHint: info.readOnly, openWorldHint: false },
      },
      async (args) => {
        try {
          const result = await remote({ tool: name, args, ...(agent ? { agent } : {}) });
          if (name === "hello" && result && typeof result === "object" && "agent" in result) agent = String((result as { agent: unknown }).agent);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> };
        } catch (error) {
          const code = (error as { code?: string }).code ?? "ERROR";
          return { isError: true, content: [{ type: "text", text: `${code}: ${(error as Error).message}` }] };
        }
      },
    );
  }
  return server;
}
