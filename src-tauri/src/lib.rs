use serde::{Deserialize, Serialize};

// A plain cargo release build otherwise loads devUrl instead of embedded assets.
// That address may belong to an unrelated app on the user's machine.
#[cfg(all(not(debug_assertions), dev))]
compile_error!("Release builds require embedded assets. Use npm run tauri:build -- --no-bundle, not plain cargo build --release.");

mod collision_authority;
mod native_mcp;
#[cfg(windows)] mod native_agent_mcp;
#[cfg(windows)] mod native_agent_setup;
#[cfg(windows)] pub use native_agent_mcp::run_agent_stdio;
mod native_agent_broker;
mod native_agent_commands;
mod native_agent_registry;
#[cfg(windows)] mod native_agent_session;
#[cfg(windows)] mod native_agent_worker;
#[cfg(windows)]
mod native_agent_pipe;
#[cfg(windows)]
mod native_agent_channel;
mod native_host_resources;
mod native_host_supervisor;
#[cfg(windows)]
mod native_task_containment;
#[cfg(windows)]
mod native_task_execution;
#[cfg(all(test, windows))]
mod candidate_custody_probe;
#[cfg(windows)]
pub use native_task_execution::run_stdio_if_requested as run_task_stdio_if_requested;
mod native_draft_commands;
mod native_git;
mod workspace_census;
mod workspace_picker;

const RUNTIME_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeSnapshotRequest {
    schema_version: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeSnapshot {
    schema_version: u32,
    command_revision: u32,
    product_name: &'static str,
    app_version: &'static str,
    runtime_mode: &'static str,
    authority: &'static str,
    platform: &'static str,
    capabilities: [&'static str; 1],
    static_release_authoritative: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeSnapshotError {
    code: &'static str,
    message: String,
    expected_schema_version: u32,
    received_schema_version: u32,
}

fn create_runtime_snapshot(
    request: RuntimeSnapshotRequest,
) -> Result<RuntimeSnapshot, RuntimeSnapshotError> {
    if request.schema_version != RUNTIME_SCHEMA_VERSION {
        return Err(RuntimeSnapshotError {
            code: "RUNTIME_SCHEMA_VERSION_UNSUPPORTED",
            message: format!(
                "runtime_snapshot requires schema version {RUNTIME_SCHEMA_VERSION}; received {}",
                request.schema_version
            ),
            expected_schema_version: RUNTIME_SCHEMA_VERSION,
            received_schema_version: request.schema_version,
        });
    }

    Ok(RuntimeSnapshot {
        schema_version: RUNTIME_SCHEMA_VERSION,
        command_revision: 1,
        product_name: "Perfect Planner",
        app_version: env!("CARGO_PKG_VERSION"),
        runtime_mode: "native-desktop",
        authority: "tauri-read-only",
        platform: std::env::consts::OS,
        capabilities: ["runtime-snapshot:read"],
        static_release_authoritative: false,
    })
}

#[tauri::command]
fn runtime_snapshot(
    request: RuntimeSnapshotRequest,
) -> Result<RuntimeSnapshot, RuntimeSnapshotError> {
    create_runtime_snapshot(request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(native_agent_commands::AgentBrokers::default())
        .invoke_handler(tauri::generate_handler![
            runtime_snapshot,
            native_agent_commands::inspect_agent_sessions,
            native_agent_commands::read_agent_exchange_notes,
            native_agent_commands::prepare_agent_pairing,
            native_agent_commands::prepare_agent_plan_pairing,
            native_agent_commands::prepare_agent_proposal_pairing,
            native_agent_commands::stop_project_agent_broker,
            native_draft_commands::inspect_native_draft_proposal,
            native_draft_commands::read_native_draft_snapshot,
            native_draft_commands::submit_native_draft_proposal,
            native_draft_commands::choose_native_check_setup,
            native_draft_commands::prepare_native_checks,
            native_draft_commands::inspect_native_checks,
            native_draft_commands::review_native_checks,
            native_draft_commands::recover_native_check_review,
            native_draft_commands::execute_native_check,
            native_draft_commands::recover_native_check_execution,
            native_draft_commands::inspect_native_task_result,
            native_draft_commands::list_native_task_results,
            native_draft_commands::read_native_task_result_page,
            native_mcp::check_bundled_mcp_connection,
            native_git::inspect_registered_git_inventory,
            workspace_picker::select_workspace_folder,
            workspace_census::register_workspace_read_only,
            workspace_census::census_registered_workspace,
            workspace_census::preview_registered_workspace,
            collision_authority::collision_authority_inspect,
            collision_authority::collision_authority_approve,
            collision_authority::collision_authority_commit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Perfect Planner native shell");
}

pub use native_mcp::run_stdio_if_requested;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_snapshot_accepts_only_the_current_schema() {
        let snapshot = create_runtime_snapshot(RuntimeSnapshotRequest { schema_version: 1 })
            .expect("schema version 1 should be accepted");

        assert_eq!(snapshot.schema_version, 1);
        assert_eq!(snapshot.command_revision, 1);
        assert_eq!(snapshot.authority, "tauri-read-only");
        assert_eq!(snapshot.capabilities, ["runtime-snapshot:read"]);
        assert!(!snapshot.static_release_authoritative);
    }

    #[test]
    fn runtime_snapshot_rejects_stale_and_future_schemas() {
        for schema_version in [0, 2, u32::MAX] {
            let error = create_runtime_snapshot(RuntimeSnapshotRequest { schema_version })
                .expect_err("unsupported schema versions must fail closed");

            assert_eq!(error.code, "RUNTIME_SCHEMA_VERSION_UNSUPPORTED");
            assert_eq!(error.expected_schema_version, 1);
            assert_eq!(error.received_schema_version, schema_version);
        }
    }
}


