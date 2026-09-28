# Native agent MCP helper — integration in progress

The `planner-agent-helper` binary provides a stdio MCP connection-observation
tool. It does not replace the existing metadata/read-only MCP server, write tasks,
approve work, or grant browser/desktop control.

Launch contract: `planner-agent-helper.exe --connection-config <absolute-path>`.
The configuration must be produced/selected by the trusted native owner and IDE
setup workflow, not obtained from model tool arguments or the pipe peer. It has
exactly these fields:

- `schemaVersion`: 1
- `endpointId`: opaque 64-character lowercase hexadecimal local pipe identifier
- `ownerExecutable`: trusted absolute owner executable path
- `ownerSha256`: trusted lowercase SHA-256 of that executable
- `binding`: exact `projectId`, `workspaceId`, positive `registryRevision`, and
  64-character lowercase hexadecimal `rootIdentity`

No pairing secret belongs in this file. The helper checks the OS-observed server
process against the configured executable and hash; the owner must independently
approve and authenticate the helper executable before issuing private pairing.
The file itself is launch configuration, not an authorization receipt. Protecting
its installation/publication and explicit user pairing are unfinished; do not
generate configuration from arbitrary MCP input or expose a wildcard listener.

MCP lifecycle and tools follow the 2025-11-25 specification:
https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
https://modelcontextprotocol.io/specification/2025-11-25/server/tools

After initialization, `planner_agent_connection` with empty arguments returns
sanitized observed connection state. The background thread maintains heartbeat;
the model does not need to call the tool periodically. MCP stdin EOF requests a
channel disconnect and waits for revocation acknowledgment. Unexpected pipe loss
remains a failure; it is not disguised as normal completion.

This is not yet an Antigravity installation guide. Trusted configuration UI,
actual IDE qualification, shared ledger tools, live header integration and the
new packaged app build remain required.

## Build ordering

The native review package builder accepts optional `agentHelperExecutable` with
explicit sourcePath and sha256, copying it to `native/planner-agent-helper.exe`.
Existing packages without it remain valid for their existing functions; agent
pairing must refuse with NATIVE_AGENT_HELPER_NOT_PACKAGED. Native helper lookup
uses the compiled package manifest pin, never a renderer-supplied executable pin.

Build the helper first, independently copy its pinned bytes into a fresh package,
then build the owner app with that package's manifest hash. Do not replace the
packaged helper with a subsequently rebuilt binary without producing a new
manifest and owner build. Matching bytes are not publisher authentication.
