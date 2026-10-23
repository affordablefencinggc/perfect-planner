# core/mcp — agent check-in tools (spec §4.1)

Agents talk to Perfect Planner through these MCP tools. Every call carries a
token: a worker token covers one task; a connect token lets an agent say
`hello`, and the first agent a person connects becomes that person's main
chat (helpers get their own, §9.5). Only SHA-256 digests of tokens are kept.

| Tool | Caller | Writes |
|---|---|---|
| `hello(name, model)` | any | nothing; registers the agent and returns its role |
| `list_tasks()` | any | nothing; each task carries `dependsOn` (the tasks that must be done before it starts, from its signed `task.created`) |
| `claim_task(T)` | worker | `task.claimed` |
| `report_progress(T, text, usage?)` | worker | `task.progress` (`usage`: `{inputTokens, outputTokens, cacheReadTokens?, costUsd?}` since your last report; a figure that fails the checks is dropped and named in `usageIgnored`, the line is still written) |
| `attach_proof(T, kind, link)` | worker | `task.proof` |
| `ask_main(T, question, options?, blocking?, wait_seconds?)` | worker | `question.asked` (+ `question.answered` when settled) |
| `check_inbox()` | main: digest (open questions, and `notices` of what the app's git watcher saw, each shown once); worker: its answers and pause state | nothing |
| `answer(Q, text)` | main | `question.answered` (information, not a decision) |
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
service.decide(owner, "Q-3", "ISO dates");   // the person's answer: decision.made D-n + question.answered
```

Identity: issue each token with the agent's `model` (the person sets it at
connect time); that is what the ledger records and what Jev's independence
check trusts. A model an agent only declares in `hello` is recorded as
`unverified:<model>`, and Jev will not approve that agent's work. Agent ids
come from the token, so reconnecting keeps the id and its claims; after a
restart, `releaseOrphanedHolds(owner, reason)` frees tasks whose holder did
not come back.

`AgentService` checks who may call what, then writes through the ledger; gate
rules registered with `ledger.addRule` refuse with their own message, which
the agent receives as a `REFUSED` error. Error codes: `UNAUTHORIZED`,
`FORBIDDEN`, `INVALID`, `NOT_FOUND`, `CONFLICT`, `PAUSED`, `REFUSED`.

`lookup` is `core/lookup`'s; the board fold (`foldBoard`) is the agent-facing
task view.

## Windows setup for agents

The one-line connect (`--agent claude|gemini|codex`) registers Perfect Planner
with the agent by Node's full path, and on Windows the agent should run the line
in PowerShell. PowerShell never runs a program from the project folder just
because it has the same name, so a `node.cmd` someone left in a repo cannot run
in place of Node. cmd.exe does look in the project folder first, which is why
the skill says never to use `cmd /c` for the line
(`core/host/windowsCwdSearch.test.ts` shows both on a real Windows machine).

One gap is in Gemini CLI itself, not in Perfect Planner. When Gemini runs a
shell command it uses PowerShell 7 (`pwsh.exe`) if it is installed. If it is
not, and the `ComSpec` setting does not point at PowerShell, Gemini starts
Windows PowerShell by the bare name `powershell.exe`, and Windows may look for
that name in the current project folder first. A `powershell.exe` planted in a
repo could then run whenever Gemini runs a command there, in any repo, with or
without Perfect Planner.

- **Recommended:** install PowerShell 7 (`winget install Microsoft.PowerShell`).
  Gemini then uses `pwsh.exe` from its install folder and the gap is gone.
- **Your own choice:** Windows has an account-wide setting,
  `NoDefaultCurrentDirectoryInExePath` (an environment variable set to `1`),
  that stops programs started by name from being looked up in the current
  folder. It affects every program you run, so whether to set it is up to you.
  Perfect Planner and its skill never set it for you.
