use serde::{Deserialize, Serialize};

const PICKER_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePickerRequest {
    schema_version: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePickerReceipt {
    schema_version: u32,
    command_revision: u32,
    selection_state: &'static str,
    selected_path: Option<String>,
    capabilities: [&'static str; 1],
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePickerError {
    code: &'static str,
    message: String,
    expected_schema_version: u32,
    received_schema_version: u32,
}

fn validate_request(request: &WorkspacePickerRequest) -> Result<(), WorkspacePickerError> {
    if request.schema_version != PICKER_SCHEMA_VERSION {
        return Err(WorkspacePickerError {
            code: "WORKSPACE_PICKER_SCHEMA_VERSION_UNSUPPORTED",
            message: format!("select_workspace_folder requires schema version {PICKER_SCHEMA_VERSION}; received {}", request.schema_version),
            expected_schema_version: PICKER_SCHEMA_VERSION,
            received_schema_version: request.schema_version,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn select_workspace_folder(
    request: WorkspacePickerRequest,
) -> Result<WorkspacePickerReceipt, WorkspacePickerError> {
    validate_request(&request)?;
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Choose an app folder for read-only analysis")
        .pick_folder()
        .await;
    let selected_path = selected.map(|folder| folder.path().to_string_lossy().into_owned());
    Ok(WorkspacePickerReceipt {
        schema_version: PICKER_SCHEMA_VERSION,
        command_revision: 1,
        selection_state: if selected_path.is_some() {
            "selected"
        } else {
            "cancelled"
        },
        selected_path,
        capabilities: ["workspace-folder-picker:select"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_request_refuses_unknown_versions_before_opening_a_dialog() {
        for schema_version in [0, 2, u32::MAX] {
            let error = validate_request(&WorkspacePickerRequest { schema_version })
                .expect_err("unsupported picker schemas must fail before UI");
            assert_eq!(error.code, "WORKSPACE_PICKER_SCHEMA_VERSION_UNSUPPORTED");
            assert_eq!(error.expected_schema_version, 1);
            assert_eq!(error.received_schema_version, schema_version);
        }
    }
}
