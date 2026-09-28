//! A fixed, bundled metadata-only MCP service. It cannot execute project code.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PROTOCOL: &str = "2025-11-25";
const SERVICE: &str = "perfect-planner-bundled-metadata";
const TOOL: &str = "planner_registered_workspace_metadata";
const CENSUS_TOOL: &str = "planner_retained_census_observation";
const FRAME_LIMIT: usize = 16_384;
const SESSION_BYTES: usize = 131_072;
const SESSION_MESSAGES: usize = 32;
const EXCHANGE_DEADLINE: Duration = Duration::from_secs(8);
static PROBE_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionRequest {
    schema_version: u32,
    request_id: String,
    project_id: String,
    generation: u32,
    workspace_id: String,
    registry_revision: u32,
    root_identity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReceipt {
    #[serde(flatten)]
    binding: ConnectionRequest,
    state: &'static str,
    code: &'static str,
    observed_at: u64,
    expires_at: u64,
    duration_ms: u64,
    service: &'static str,
    protocol_version: &'static str,
    capabilities: [&'static str; 1],
    metadata_only: bool,
    execution_authorized: bool,
    computer_use: bool,
    cleanup_complete: bool,
}

fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn valid_request(request: &ConnectionRequest) -> bool {
    request.schema_version == 1
        && token(&request.request_id, 96)
        && token(&request.project_id, 128)
        && (3..=64).contains(&request.workspace_id.len())
        && token(&request.workspace_id, 64)
        && request.registry_revision > 0
        && request.root_identity.len() == 64
        && request
            .root_identity
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn receipt(
    request: ConnectionRequest,
    started: Instant,
    code: &'static str,
    cleanup_complete: bool,
) -> ConnectionReceipt {
    let observed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let connected = code == "MCP_CONNECTED" && cleanup_complete;
    ConnectionReceipt {
        binding: request,
        state: if connected { "connected" } else { "failed" },
        code,
        observed_at,
        expires_at: observed_at + if connected { 30_000 } else { 0 },
        duration_ms: started.elapsed().as_millis() as u64,
        service: SERVICE,
        protocol_version: PROTOCOL,
        capabilities: ["workspace-registration:read"],
        metadata_only: true,
        execution_authorized: false,
        computer_use: false,
        cleanup_complete,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MetadataArguments {
    workspace_id: String,
    registry_revision: u32,
    root_identity: String,
}

fn tool_definition() -> Value {
    json!({"name":TOOL,"description":"Read the identity of one already registered workspace. No file content, code execution, network or computer use.","inputSchema":{"type":"object","additionalProperties":false,"required":["workspaceId","registryRevision","rootIdentity"],"properties":{"workspaceId":{"type":"string","minLength":3,"maxLength":64},"registryRevision":{"type":"integer","minimum":1},"rootIdentity":{"type":"string","pattern":"^[a-f0-9]{64}$"}}},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})
}
fn census_tool_definition()->Value{
    let mut definition=tool_definition();
    definition["name"]=json!(CENSUS_TOOL);
    definition["description"]=json!("Read the latest retained native census observation for one currently registered workspace. Includes its historical digest, coverage and scan limits; does not scan or verify the live filesystem. No paths, file content or execution permission.");
    definition
}
fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

struct ServiceSession {
    initialized: bool,
    ready: bool,
    ids: HashSet<String>,
}
impl ServiceSession {
    fn new() -> Self {
        Self {
            initialized: false,
            ready: false,
            ids: HashSet::new(),
        }
    }
    fn handle(&mut self, registry: &Path, message: Value) -> Option<Value> {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let notification = message.get("id").is_none();
        if message.get("jsonrpc") != Some(&json!("2.0"))
            || !message.is_object()
            || message.get("method").and_then(Value::as_str).is_none()
        {
            return Some(rpc_error(id, -32600, "Invalid request"));
        }
        if !notification && !(id.is_string() || id.as_i64().is_some()) {
            return Some(rpc_error(id, -32600, "Invalid request id"));
        }
        if !notification && !self.ids.insert(id.to_string()) {
            return Some(rpc_error(id, -32600, "Duplicate request id"));
        }
        let method = message["method"].as_str().unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(json!({}));
        if notification {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            return None;
        }
        let result = match method {
            "initialize" if !self.initialized => {
                if params["protocolVersion"] != PROTOCOL
                    || !params["capabilities"].is_object()
                    || params["clientInfo"]["name"]
                        .as_str()
                        .filter(|v| !v.is_empty())
                        .is_none()
                    || params["clientInfo"]["version"].as_str().is_none()
                {
                    return Some(rpc_error(id, -32602, "Unsupported initialization"));
                }
                self.initialized = true;
                json!({"protocolVersion":PROTOCOL,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":SERVICE,"version":env!("CARGO_PKG_VERSION")}})
            }
            "ping" if self.initialized => json!({}),
            "tools/list"
                if self.ready && params.as_object().map(|p| p.is_empty()).unwrap_or(false) =>
            {
                json!({"tools":[tool_definition(),census_tool_definition()]})
            }
            "tools/call" if self.ready => {
                if (params["name"] != TOOL&&params["name"]!=CENSUS_TOOL)
                    || params
                        .as_object()
                        .map(|p| p.keys().any(|k| k != "name" && k != "arguments"))
                        .unwrap_or(true)
                {
                    return Some(rpc_error(id, -32602, "Unknown tool or parameters"));
                }
                let arguments: MetadataArguments =
                    match serde_json::from_value(params["arguments"].clone()) {
                        Ok(value) => value,
                        Err(_) => return Some(rpc_error(id, -32602, "Invalid tool arguments")),
                    };
                let result=if params["name"]==CENSUS_TOOL{
                    crate::workspace_census::retained_census_binding(registry,&arguments.workspace_id,arguments.registry_revision,&arguments.root_identity).map_err(|_|())
                }else{crate::workspace_census::registered_metadata(
                    registry,
                    &arguments.workspace_id,
                    arguments.registry_revision,
                    &arguments.root_identity,
                )};
                match result {
                    Ok(metadata) => {
                        json!({"content":[{"type":"text","text":metadata.to_string()}],"structuredContent":metadata,"isError":false})
                    }
                    Err(()) => {
                        json!({"content":[{"type":"text","text":if params["name"]==CENSUS_TOOL{"Retained census observation is unavailable, corrupt, or stale."}else{"Workspace registration is unavailable or stale."}}],"isError":true})
                    }
                }
            }
            _ => {
                return Some(rpc_error(
                    id,
                    if self.ready { -32601 } else { -32000 },
                    "Method unavailable in this session",
                ))
            }
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }
}

fn frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, &'static str> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|_| "MCP_INTERRUPTED")?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("MCP_PROTOCOL_ERROR")
            };
        }
        let length = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(available.len());
        if bytes.len() + length > FRAME_LIMIT {
            return Err("MCP_OUTPUT_LIMIT");
        }
        let complete = available[length - 1] == b'\n';
        bytes.extend_from_slice(&available[..length]);
        reader.consume(length);
        if complete {
            return Ok(Some(bytes));
        }
    }
}
fn serve(
    registry: &Path,
    reader: &mut impl BufRead,
    writer: &mut impl Write,
) -> Result<(), &'static str> {
    let mut session = ServiceSession::new();
    let mut bytes = 0;
    let mut count = 0;
    while let Some(input) = frame(reader)? {
        bytes += input.len();
        count += 1;
        if bytes > SESSION_BYTES || count > SESSION_MESSAGES {
            return Err("MCP_OUTPUT_LIMIT");
        }
        let message = serde_json::from_slice(&input).map_err(|_| "MCP_PROTOCOL_ERROR")?;
        if let Some(response) = session.handle(registry, message) {
            let encoded = serde_json::to_vec(&response).map_err(|_| "MCP_PROTOCOL_ERROR")?;
            if encoded.len() >= FRAME_LIMIT {
                return Err("MCP_OUTPUT_LIMIT");
            }
            writer
                .write_all(&encoded)
                .and_then(|_| writer.write_all(b"\n"))
                .and_then(|_| writer.flush())
                .map_err(|_| "MCP_INTERRUPTED")?;
        }
    }
    Ok(())
}

/// Invoked before any GUI startup. A helper can only read registered metadata.
pub fn run_stdio_if_requested() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    let mode = args.get(1).and_then(|v| v.to_str());
    if !matches!(mode, Some("--planner-mcp-stdio" | "--planner-git-stdio" | "--planner-git-probe")) {
        return None;
    }
    if args.len() != 4 || args[2] != "--registry-root" {
        return Some(2);
    }
    let root = PathBuf::from(&args[3]);
    if !root.is_absolute() {
        return Some(2);
    }
    if mode == Some("--planner-git-stdio") {
        return Some(crate::native_git::serve_stdio(&root));
    }
    if mode == Some("--planner-git-probe") {
        return Some(crate::native_git::probe_stdio(&root));
    }
    let input = std::io::stdin();
    let output = std::io::stdout();
    Some(
        if serve(&root, &mut input.lock(), &mut output.lock()).is_ok() {
            0
        } else {
            2
        },
    )
}

fn send(writer: &mut impl Write, value: Value) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "MCP_PROTOCOL_ERROR")?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|_| "MCP_INTERRUPTED")
}
fn receive(reader: &mut impl BufRead, id: u32) -> Result<Value, &'static str> {
    let input = frame(reader)?.ok_or("MCP_INTERRUPTED")?;
    let response: Value = serde_json::from_slice(&input).map_err(|_| "MCP_PROTOCOL_ERROR")?;
    if response["jsonrpc"] != "2.0" || response["id"] != id || response.get("error").is_some() {
        return Err("MCP_PROTOCOL_ERROR");
    }
    response.get("result").cloned().ok_or("MCP_PROTOCOL_ERROR")
}
fn exchange(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    request: &ConnectionRequest,
) -> Result<(), &'static str> {
    send(
        writer,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"perfect-planner-native-probe","version":"1"}}}),
    )?;
    let initialized = receive(reader, 1)?;
    if initialized["protocolVersion"] != PROTOCOL
        || initialized["serverInfo"]["name"] != SERVICE
        || initialized["capabilities"] != json!({"tools":{"listChanged":false}})
    {
        return Err("MCP_PROTOCOL_ERROR");
    }
    send(
        writer,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )?;
    send(
        writer,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )?;
    if receive(reader, 2)? != json!({"tools":[tool_definition(),census_tool_definition()]}) {
        return Err("MCP_PROTOCOL_ERROR");
    }
    send(
        writer,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":TOOL,"arguments":{"workspaceId":request.workspace_id,"registryRevision":request.registry_revision,"rootIdentity":request.root_identity}}}),
    )?;
    let result = receive(reader, 3)?;
    if result["isError"] == true {
        return Err("MCP_REGISTRATION_INVALID");
    }
    let expected = json!({"schemaVersion":1,"workspaceId":request.workspace_id,"registryRevision":request.registry_revision,"rootIdentity":request.root_identity,"access":"metadata-read-only","contentReturned":false,"executionAuthorized":false});
    if result["isError"] != false
        || result["structuredContent"] != expected
        || result["content"] != json!([{"type":"text","text":expected.to_string()}])
    {
        return Err("MCP_PROTOCOL_ERROR");
    }
    Ok(())
}

fn stop_child(
    mut child: std::process::Child,
    result: Result<(), &'static str>,
    worker: Option<std::thread::JoinHandle<()>>,
) -> (&'static str, bool) {
    let stop = Instant::now();
    let mut killed = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // The fixed helper has no descendants. Reaping it closes all pipe
                // writers, so the bounded reader can finish before we return.
                if let Some(worker) = worker {
                    if worker.join().is_err() {
                        return ("MCP_INTERRUPTED", true);
                    }
                }
                return (
                    if !status.success() && result.is_ok() {
                        "MCP_INTERRUPTED"
                    } else {
                        result.err().unwrap_or("MCP_CONNECTED")
                    },
                    true,
                );
            }
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
            }
        }
        if stop.elapsed() >= Duration::from_millis(100) && !killed {
            let _ = child.kill();
            killed = true;
        }
        if stop.elapsed() >= Duration::from_millis(900) {
            std::thread::spawn(move || {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(worker) = worker {
                    let _ = worker.join();
                }
            });
            return ("MCP_CLEANUP_FAILED", false);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn probe(executable: &Path, registry: &Path, request: &ConnectionRequest) -> (&'static str, bool) {
    let started = Instant::now();
    let mut command = Command::new(executable);
    command
        .arg("--planner-mcp-stdio")
        .arg("--registry-root")
        .arg(registry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return ("MCP_SERVICE_UNAVAILABLE", true),
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let mut stdin = match child.stdin.take() {
        Some(value) => value,
        None => return stop_child(child, Err("MCP_INTERRUPTED"), None),
    };
    let stdout = match child.stdout.take() {
        Some(value) => value,
        None => {
            drop(stdin);
            return stop_child(child, Err("MCP_INTERRUPTED"), None);
        }
    };
    let binding = request.clone();
    let worker = match std::thread::Builder::new()
        .name("bundled-mcp-exchange".into())
        .spawn(move || {
            let result = exchange(&mut BufReader::new(stdout), &mut stdin, &binding);
            drop(stdin);
            let _ = sender.send(result);
        }) {
        Ok(worker) => worker,
        Err(_) => return stop_child(child, Err("MCP_SERVICE_UNAVAILABLE"), None),
    };
    let result = receiver
        .recv_timeout(EXCHANGE_DEADLINE.saturating_sub(started.elapsed()))
        .unwrap_or(Err("MCP_TIMEOUT"));
    stop_child(child, result, Some(worker))
}

fn check_at(registry: &Path, request: ConnectionRequest) -> ConnectionReceipt {
    let started = Instant::now();
    if !valid_request(&request) {
        return receipt(request, started, "MCP_REQUEST_INVALID", true);
    }
    if PROBE_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return receipt(request, started, "MCP_BUSY", true);
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            PROBE_ACTIVE.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release;
    let executable = match std::env::current_exe().and_then(std::fs::canonicalize) {
        Ok(value) => value,
        Err(_) => return receipt(request, started, "MCP_SERVICE_UNAVAILABLE", true),
    };
    let (code, cleanup_complete) = probe(&executable, registry, &request);
    if !cleanup_complete {
        std::mem::forget(_release);
    } // No accumulating probes if cleanup is unconfirmed.
      // All potentially blocking registered-root I/O happens in the killable child.
      // This is a short-lived observation, not authority to run tools or promote work.
    receipt(request, started, code, cleanup_complete)
}

#[tauri::command]
pub async fn check_bundled_mcp_connection(
    app: tauri::AppHandle,
    request: ConnectionRequest,
) -> ConnectionReceipt {
    let started = Instant::now();
    let registry = match crate::workspace_census::app_registry_root(&app) {
        Ok(value) => value,
        Err(_) => return receipt(request, started, "MCP_REGISTRATION_INVALID", true),
    };
    let fallback = request.clone();
    tauri::async_runtime::spawn_blocking(move || check_at(&registry, request))
        .await
        .unwrap_or_else(|_| receipt(fallback, started, "MCP_INTERRUPTED", false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io::Cursor;
    use std::sync::atomic::AtomicUsize;
    static FIXTURE: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        base: PathBuf,
        registry: PathBuf,
        request: ConnectionRequest,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    fn fixture() -> Fixture {
        let base = std::env::temp_dir().join(format!(
            "pp-native-mcp-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = base.join("workspace");
        let registry = base.join("registry");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&registry).unwrap();
        fs::write(
            workspace.join("secret.txt"),
            "Never return or execute project content",
        )
        .unwrap();
        let canonical = fs::canonicalize(&workspace)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let root_identity = format!("{:x}", Sha256::digest(canonical.as_bytes()));
        fs::write(registry.join("workspace-one.json"), serde_json::to_vec(&json!({"schemaVersion":1,"registryRevision":1,"workspaceId":"workspace-one","canonicalRoot":canonical,"rootIdentity":root_identity,"access":"metadata-read-only"})).unwrap()).unwrap();
        Fixture {
            base,
            registry,
            request: ConnectionRequest {
                schema_version: 1,
                request_id: "request-one".into(),
                project_id: "project-one".into(),
                generation: 0,
                workspace_id: "workspace-one".into(),
                registry_revision: 1,
                root_identity,
            },
        }
    }
    fn initialize(id: u32) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}})
    }
    fn ready(registry: &Path) -> ServiceSession {
        let mut session = ServiceSession::new();
        assert!(session
            .handle(registry, initialize(1))
            .unwrap()
            .get("result")
            .is_some());
        assert!(session
            .handle(
                registry,
                json!({"jsonrpc":"2.0","method":"notifications/initialized"})
            )
            .is_none());
        session
    }
    fn call(request: &ConnectionRequest, id: u32) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":TOOL,"arguments":{"workspaceId":request.workspace_id,"registryRevision":request.registry_revision,"rootIdentity":request.root_identity}}})
    }

    fn retained_call(request:&ConnectionRequest,id:u32)->Value{let mut value=call(request,id);value["params"]["name"]=json!(CENSUS_TOOL);value}
    fn retain_actual(fixture:&Fixture)->Value{
        let request=serde_json::from_value(json!({"schemaVersion":1,"workspaceId":fixture.request.workspace_id,"registryRevision":fixture.request.registry_revision,"maxFiles":20,"maxFileBytes":1000})).unwrap();
        serde_json::to_value(crate::workspace_census::census_and_retain(&fixture.registry,request).unwrap()).unwrap()
    }
    #[test]
    fn retained_census_tool_reads_actual_scan_without_claiming_current_filesystem(){
        let fixture=fixture();let receipt=retain_actual(&fixture);let mut session=ready(&fixture.registry);
        let result=session.handle(&fixture.registry,retained_call(&fixture.request,2)).unwrap();
        assert_eq!(result["result"]["isError"],false);let observed=&result["result"]["structuredContent"];
        assert_eq!(observed["censusDigest"],receipt["digest"]);assert_eq!(observed["fileCount"],receipt["fileCount"]);assert_eq!(observed["retainedObservation"],true);assert_eq!(observed["liveFilesystemVerified"],false);assert_eq!(observed["executionAuthorized"],false);
        assert!(!result.to_string().contains("Never return"));assert!(!result.to_string().contains("canonicalRoot"));assert!(!result.to_string().contains(&fixture.base.to_string_lossy().to_string()));
        fs::write(fixture.base.join("workspace/secret.txt"),"changed after scan").unwrap();
        let retained=session.handle(&fixture.registry,retained_call(&fixture.request,3)).unwrap();assert_eq!(retained["result"]["structuredContent"]["censusDigest"],receipt["digest"]);
    }
    #[test]
    fn retained_census_tool_refuses_missing_stale_corrupt_and_caller_digest(){
        let fixture=fixture();let mut session=ready(&fixture.registry);
        assert_eq!(session.handle(&fixture.registry,retained_call(&fixture.request,2)).unwrap()["result"]["isError"],true);
        retain_actual(&fixture);
        let mut stale=retained_call(&fixture.request,3);stale["params"]["arguments"]["registryRevision"]=json!(2);assert_eq!(session.handle(&fixture.registry,stale).unwrap()["result"]["isError"],true);
        let mut forged=retained_call(&fixture.request,4);forged["params"]["arguments"]["censusDigest"]=json!("f".repeat(64));assert!(session.handle(&fixture.registry,forged).unwrap().get("error").is_some());
        let journal=fixture.registry.join("workspace-one.census-observations.jsonl");let mut file=fs::OpenOptions::new().append(true).open(journal).unwrap();file.write_all(b"{partial").unwrap();file.sync_all().unwrap();drop(file);
        assert_eq!(session.handle(&fixture.registry,retained_call(&fixture.request,5)).unwrap()["result"]["isError"],true);
    }

    #[test]
    fn lifecycle_requires_initialize_then_notification_and_pins_capabilities() {
        let fixture = fixture();
        let mut session = ServiceSession::new();
        assert!(session
            .handle(
                &fixture.registry,
                json!({"jsonrpc":"2.0","id":9,"method":"tools/list"})
            )
            .unwrap()
            .get("error")
            .is_some());
        let result = session.handle(&fixture.registry, initialize(1)).unwrap();
        assert_eq!(result["result"]["protocolVersion"], PROTOCOL);
        assert_eq!(
            result["result"]["capabilities"],
            json!({"tools":{"listChanged":false}})
        );
        assert!(session
            .handle(
                &fixture.registry,
                json!({"jsonrpc":"2.0","id":10,"method":"tools/list"})
            )
            .unwrap()
            .get("error")
            .is_some());
        session.handle(
            &fixture.registry,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        );
        let tools = session
            .handle(
                &fixture.registry,
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            )
            .unwrap();
        assert_eq!(tools["result"]["tools"], json!([tool_definition(),census_tool_definition()]));
        assert!(session
            .handle(&fixture.registry, initialize(1))
            .unwrap()
            .get("error")
            .is_some());
        assert!(session
            .handle(
                &fixture.registry,
                json!({"jsonrpc":"2.0","id":3,"method":"computer/click"})
            )
            .unwrap()
            .get("error")
            .is_some());
    }
    #[test]
    fn metadata_tool_returns_identity_without_paths_content_or_execution() {
        let fixture = fixture();
        let mut session = ready(&fixture.registry);
        let result = session
            .handle(&fixture.registry, call(&fixture.request, 2))
            .unwrap();
        assert_eq!(result["result"]["isError"], false);
        assert_eq!(
            result["result"]["structuredContent"]["rootIdentity"],
            fixture.request.root_identity
        );
        assert_eq!(
            result["result"]["structuredContent"]["executionAuthorized"],
            false
        );
        assert!(!result.to_string().contains("canonicalRoot"));
        assert!(!result.to_string().contains("Never return"));
        assert!(!result
            .to_string()
            .contains(&fixture.base.to_string_lossy().to_string()));
    }
    #[test]
    fn wrong_workspace_revision_identity_and_revoked_registration_fail_closed() {
        let fixture = fixture();
        let mut session = ready(&fixture.registry);
        for (index, field) in ["workspaceId", "registryRevision", "rootIdentity"]
            .iter()
            .enumerate()
        {
            let mut input = call(&fixture.request, index as u32 + 2);
            input["params"]["arguments"][*field] = if *field == "registryRevision" {
                json!(2)
            } else {
                json!("wrong")
            };
            assert_eq!(
                session.handle(&fixture.registry, input).unwrap()["result"]["isError"],
                true
            );
        }
        let entry = fixture.registry.join("workspace-one.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&entry).unwrap()).unwrap();
        value["access"] = json!("revoked");
        fs::write(&entry, value.to_string()).unwrap();
        assert_eq!(
            session
                .handle(&fixture.registry, call(&fixture.request, 9))
                .unwrap()["result"]["isError"],
            true
        );
    }
    #[test]
    fn request_contract_rejects_paths_unknown_fields_and_invalid_binding() {
        let fixture = fixture();
        assert!(valid_request(&fixture.request));
        for field in [
            "executable",
            "rootPath",
            "registryRoot",
            "args",
            "env",
            "tool",
        ] {
            let mut value = serde_json::to_value(&fixture.request).unwrap();
            value[field] = json!("not accepted");
            assert!(serde_json::from_value::<ConnectionRequest>(value).is_err());
        }
        let mut invalid = fixture.request.clone();
        invalid.schema_version = 2;
        assert!(!valid_request(&invalid));
        invalid = fixture.request.clone();
        invalid.workspace_id = "../escape".into();
        assert!(!valid_request(&invalid));
        invalid = fixture.request.clone();
        invalid.request_id = "x".repeat(97);
        assert!(!valid_request(&invalid));
        invalid = fixture.request.clone();
        invalid.root_identity = "g".repeat(64);
        assert!(!valid_request(&invalid));
        let result = check_at(&fixture.registry, invalid);
        assert_eq!(result.code, "MCP_REQUEST_INVALID");
        assert_eq!(result.state, "failed");
        assert_eq!(result.observed_at, result.expires_at);
    }
    #[test]
    fn protocol_wrong_version_and_unknown_tool_arguments_are_refused() {
        let fixture = fixture();
        let mut session = ServiceSession::new();
        let mut init = initialize(1);
        init["params"]["protocolVersion"] = json!("2024-11-05");
        assert!(session
            .handle(&fixture.registry, init)
            .unwrap()
            .get("error")
            .is_some());
        let mut session = ready(&fixture.registry);
        let mut input = call(&fixture.request, 2);
        input["params"]["arguments"]["rootPath"] = json!("C:/");
        assert!(session
            .handle(&fixture.registry, input)
            .unwrap()
            .get("error")
            .is_some());
    }
    #[test]
    fn stdio_frames_and_sessions_are_bounded_and_partial_frames_fail() {
        assert_eq!(
            frame(&mut Cursor::new(vec![b'x'; FRAME_LIMIT + 1])).unwrap_err(),
            "MCP_OUTPUT_LIMIT"
        );
        assert_eq!(
            frame(&mut Cursor::new(b"{}".to_vec())).unwrap_err(),
            "MCP_PROTOCOL_ERROR"
        );
        let fixture = fixture();
        let mut input = format!("{}\n", initialize(1));
        for id in 2..=34 {
            input.push_str(&format!(
                "{}\n",
                json!({"jsonrpc":"2.0","id":id,"method":"ping"})
            ));
        }
        assert_eq!(
            serve(&fixture.registry, &mut Cursor::new(input), &mut Vec::new()).unwrap_err(),
            "MCP_OUTPUT_LIMIT"
        );
        fs::write(
            fixture.registry.join("workspace-one.json"),
            vec![b' '; 16_385],
        )
        .unwrap();
        assert!(crate::workspace_census::registered_metadata(
            &fixture.registry,
            &fixture.request.workspace_id,
            1,
            &fixture.request.root_identity
        )
        .is_err());
    }
    #[test]
    fn client_exchange_verifies_full_lifecycle_tool_and_metadata_payload() {
        let fixture = fixture();
        let mut session = ready(&fixture.registry);
        let metadata = session
            .handle(&fixture.registry, call(&fixture.request, 3))
            .unwrap();
        let transcript = format!(
            "{}\n{}\n{}\n",
            json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":PROTOCOL,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":SERVICE}}}),
            json!({"jsonrpc":"2.0","id":2,"result":{"tools":[tool_definition(),census_tool_definition()]}}),
            metadata
        );
        let mut sent = Vec::new();
        assert!(exchange(&mut Cursor::new(&transcript), &mut sent, &fixture.request).is_ok());
        assert_eq!(String::from_utf8(sent).unwrap().lines().count(), 4);
        let mut other = fixture.request.clone();
        other.registry_revision = 2;
        assert_eq!(
            exchange(&mut Cursor::new(&transcript), &mut Vec::new(), &other).unwrap_err(),
            "MCP_PROTOCOL_ERROR"
        );
    }
    #[test]
    fn failed_child_spawn_and_receipt_truth_are_explicit() {
        let fixture = fixture();
        let (code, cleanup) = probe(
            &fixture.base.join("does-not-exist"),
            &fixture.registry,
            &fixture.request,
        );
        assert_eq!(code, "MCP_SERVICE_UNAVAILABLE");
        assert!(cleanup);
        let result = receipt(fixture.request.clone(), Instant::now(), code, cleanup);
        assert_eq!(result.state, "failed");
        assert_eq!(result.observed_at, result.expires_at);
        assert!(!result.execution_authorized);
        assert!(!result.computer_use);
        let connected = receipt(
            fixture.request.clone(),
            Instant::now(),
            "MCP_CONNECTED",
            true,
        );
        assert_eq!(connected.expires_at - connected.observed_at, 30_000);
        assert_eq!(connected.state, "connected");
        assert_eq!(
            receipt(
                fixture.request.clone(),
                Instant::now(),
                "MCP_CONNECTED",
                false
            )
            .state,
            "failed"
        );
    }
}
