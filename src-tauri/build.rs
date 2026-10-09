fn main() {
    println!("cargo:rerun-if-env-changed=PP_NATIVE_HOST_MANIFEST_SHA256");
    let pin=match std::env::var("PP_NATIVE_HOST_MANIFEST_SHA256"){
        Ok(value)=>{assert!(value.len()==64&&value.bytes().all(|byte|byte.is_ascii_digit()||(b'a'..=b'f').contains(&byte)),"PP_NATIVE_HOST_MANIFEST_SHA256 must be exactly 64 lowercase hexadecimal characters");value},
        Err(std::env::VarError::NotPresent)=>String::new(),
        Err(_)=>panic!("PP_NATIVE_HOST_MANIFEST_SHA256 is not valid Unicode"),
    };
    println!("cargo:rustc-env=PP_COMPILED_NATIVE_HOST_MANIFEST_SHA256={pin}");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "runtime_snapshot",
            "inspect_agent_sessions",
            "read_agent_exchange_notes",
            "prepare_agent_pairing",
            "prepare_agent_plan_pairing",
            "prepare_agent_proposal_pairing",
            "stop_project_agent_broker",
            "inspect_native_draft_proposal",
            "read_native_draft_snapshot",
            "submit_native_draft_proposal",
            "choose_native_check_setup",
            "prepare_native_checks",
            "inspect_native_checks",
            "review_native_checks",
            "recover_native_check_review",
            "execute_native_check",
            "recover_native_check_execution",
            "execute_native_task",
            "recover_native_task_execution",
            "inspect_native_task_result",
            "list_native_task_results",
            "read_native_task_result_page",
            "check_bundled_mcp_connection",
            "inspect_registered_git_inventory",
            "select_workspace_folder",
            "register_workspace_read_only",
            "census_registered_workspace",
            "preview_registered_workspace",
            "collision_authority_inspect",
            "collision_authority_approve",
            "collision_authority_commit",
        ]),
    ))
    .expect("failed to build the Perfect Planner Tauri manifest");
}


