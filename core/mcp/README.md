# core/mcp — agent check-in tools (spec §4.1)

Agents talk to Perfect Planner through these MCP tools. Every call carries a
token: a worker token covers one task; a connect token lets an agent say
`hello`, and the first agent a person connects becomes that person's main
chat (helpers get their own, §9.5). Only SHA-256 digests of tokens are kept.

| Tool | Caller | Writes |
|---|---|---|
| `hello(name, model)` | any | nothing; registers the agent and returns its role |
| `list_tasks()` | any | nothing |
| `claim_task(T)` | worker | `task.claimed` |
| `report_progress(T, text)` | worker | `task.progress` |
| `attach_proof(T, kind, link)` | worker | `task.proof` |
| `ask_main(T, question, options?, blocking?, wait_seconds?)` | worker | `question.asked` (+ `question.answered` when settled) |
| `check_inbox()` | main: digest; worker: its answers and pause state | nothing |
| `answer(Q, text)` | main | `decision.made`, `question.answered` |
| `lookup(ref)` | any | nothing |
| `release_task(T, reason, blocked?)` | worker | `task.blocked` or `task.progress`; revokes the token |

```ts
import { Ledger, FileStore } from "../ledger/index";
import { AgentService, createAgentMcpServer, directCall, startBridge, bridgeCall } from "../mcp/index";

const ledger = await Ledger.open(new FileStore(root));
const service = new AgentService({ ledger });            // builds a Relay and TokenStore unless given
const token = service.tokens.issue({ role: "worker", person: "owner", task: "T-14" });
const bridge = await startBridge(service);               // 127.0.0.1 only, Bearer token per call
// In the agent's process:
const mcp = createAgentMcpServer(bridgeCall(bridge.url, token));   // connect to a stdio transport
// In-process (desktop app, tests): createAgentMcpServer(directCall(service, token))
service.pauseAll(owner, "reason"); service.resumeAll(owner);
```

`AgentService` checks who may call what, then writes through the ledger; gate
rules registered with `ledger.addRule` refuse with their own message, which
the agent receives as a `REFUSED` error. Error codes: `UNAUTHORIZED`,
`FORBIDDEN`, `INVALID`, `NOT_FOUND`, `CONFLICT`, `PAUSED`, `REFUSED`.

`lookup` and the board fold live here until `core/lookup` lands; swap them
for its implementation then.
