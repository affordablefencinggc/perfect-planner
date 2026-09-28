use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
#[path = "workspace_census_observation.rs"]
mod observation;

const SCHEMA_VERSION: u32 = 1;
const MAX_FILES_LIMIT: u32 = 50_000;
const MAX_FILE_BYTES_LIMIT: u64 = 2_000_000;
const MAX_TOTAL_BYTES: u64 = 500_000_000;
const MAX_DIRECTORIES_LIMIT: usize = 50_000;
const MAX_ENTRIES_LIMIT: usize = 250_000;
const MAX_DIRECTORY_DEPTH: usize = 64;
const MAX_CENSUS_DURATION: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy)]
struct CensusPolicy {
    metadata_only: bool,
    max_total_bytes: u64,
    max_directories: usize,
    max_entries: usize,
    max_depth: usize,
    max_duration: Duration,
}

impl Default for CensusPolicy {
    fn default() -> Self {
        Self {
            metadata_only: false,
            max_total_bytes: MAX_TOTAL_BYTES,
            max_directories: MAX_DIRECTORIES_LIMIT,
            max_entries: MAX_ENTRIES_LIMIT,
            max_depth: MAX_DIRECTORY_DEPTH,
            max_duration: MAX_CENSUS_DURATION,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EntryStamp {
    name: OsString,
    kind: u8,
    size: u64,
    modified_epoch_ns: Option<u128>,
}

struct ObservedEntry {
    path: PathBuf,
    name: OsString,
    metadata: fs::Metadata,
    stamp: EntryStamp,
}

struct DirectorySnapshot {
    path: PathBuf,
    relative: String,
    entries: Vec<EntryStamp>,
}

struct FileSnapshot {
    path: PathBuf,
    relative: String,
    size: u64,
    modified_epoch_ns: Option<u128>,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCensusError {
    code: &'static str,
    message: String,
}

impl WorkspaceCensusError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterWorkspaceRequest {
    schema_version: u32,
    workspace_id: String,
    root_path: String,
    explicit_user_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceRegistration {
    schema_version: u32,
    registry_revision: u32,
    workspace_id: String,
    canonical_root: String,
    root_identity: String,
    access: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRegistrationReceipt {
    schema_version: u32,
    registry_revision: u32,
    workspace_id: String,
    canonical_root: String,
    root_identity: String,
    access: &'static str,
    idempotent: bool,
    capabilities: [&'static str; 1],
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CensusWorkspaceRequest {
    schema_version: u32,
    workspace_id: String,
    registry_revision: u32,
    max_files: u32,
    max_file_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CensusFileRecord {
    path: String,
    extension: String,
    category: &'static str,
    size: u64,
    sha256: String,
    modified_epoch_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CensusSkipRecord {
    path: String,
    reason: &'static str,
    size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCensusReceipt {
    schema_version: u32,
    registry_revision: u32,
    workspace_id: String,
    root_identity: String,
    generated_epoch_ms: u128,
    file_count: usize,
    total_bytes_hashed: u64,
    summary: BTreeMap<&'static str, usize>,
    files: Vec<CensusFileRecord>,
    skipped: Vec<CensusSkipRecord>,
    digest: String,
    content_returned: bool,
    capabilities: [&'static str; 1],
}

fn validate_schema(received: u32) -> Result<(), WorkspaceCensusError> {
    if received == SCHEMA_VERSION {
        Ok(())
    } else {
        Err(WorkspaceCensusError::new(
            "WORKSPACE_SCHEMA_VERSION_UNSUPPORTED",
            format!(
                "workspace commands require schema version {SCHEMA_VERSION}; received {received}"
            ),
        ))
    }
}

fn validate_workspace_id(value: &str) -> Result<(), WorkspaceCensusError> {
    let valid = (3..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(WorkspaceCensusError::new(
            "WORKSPACE_ID_INVALID",
            "workspaceId must be 3-64 ASCII letters, numbers, hyphens, or underscores",
        ))
    }
}

fn slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn registry_file(registry_root: &Path, workspace_id: &str) -> PathBuf {
    registry_root.join(format!("{workspace_id}.json"))
}

fn canonical_directory(root_path: &str) -> Result<PathBuf, WorkspaceCensusError> {
    let supplied = PathBuf::from(root_path);
    if !supplied.is_absolute() {
        return Err(WorkspaceCensusError::new(
            "WORKSPACE_ROOT_NOT_ABSOLUTE",
            "workspace root must be an absolute path",
        ));
    }
    let supplied_meta = fs::symlink_metadata(&supplied).map_err(|error| {
        WorkspaceCensusError::new("WORKSPACE_ROOT_UNAVAILABLE", error.to_string())
    })?;
    if supplied_meta.file_type().is_symlink() || !supplied_meta.is_dir() {
        return Err(WorkspaceCensusError::new(
            "WORKSPACE_ROOT_REFUSED",
            "workspace root must be a regular directory and not a link",
        ));
    }
    fs::canonicalize(&supplied)
        .map_err(|error| WorkspaceCensusError::new("WORKSPACE_ROOT_UNAVAILABLE", error.to_string()))
}

fn read_registration(
    registry_root: &Path,
    workspace_id: &str,
) -> Result<WorkspaceRegistration, WorkspaceCensusError> {
    let path = registry_file(registry_root, workspace_id);
    let meta = fs::symlink_metadata(&path).map_err(|_| {
        WorkspaceCensusError::new(
            "WORKSPACE_NOT_REGISTERED",
            "workspace identity is not registered",
        )
    })?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(WorkspaceCensusError::new(
            "WORKSPACE_REGISTRY_REFUSED",
            "workspace registry entry is not a regular file",
        ));
    }
    let bytes = fs::read(path).map_err(|error| {
        WorkspaceCensusError::new("WORKSPACE_REGISTRY_READ_FAILED", error.to_string())
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        WorkspaceCensusError::new(
            "WORKSPACE_REGISTRY_INVALID",
            "workspace registry entry is malformed",
        )
    })
}

#[cfg(test)]
pub(crate) fn register_qualification_workspace(registry_root:&Path,request:RegisterWorkspaceRequest)->Result<WorkspaceRegistrationReceipt,WorkspaceCensusError>{register_at(registry_root,request)}

fn register_at(
    registry_root: &Path,
    request: RegisterWorkspaceRequest,
) -> Result<WorkspaceRegistrationReceipt, WorkspaceCensusError> {
    validate_schema(request.schema_version)?;
    validate_workspace_id(&request.workspace_id)?;
    if !request.explicit_user_approval {
        return Err(WorkspaceCensusError::new(
            "WORKSPACE_APPROVAL_REQUIRED",
            "explicit user approval is required to register a workspace",
        ));
    }
    let canonical = canonical_directory(&request.root_path)?;
    let canonical_root = slash(&canonical);
    let root_identity = sha256_hex(canonical_root.as_bytes());
    fs::create_dir_all(registry_root).map_err(|error| {
        WorkspaceCensusError::new("WORKSPACE_REGISTRY_CREATE_FAILED", error.to_string())
    })?;
    let root_meta = fs::symlink_metadata(registry_root).map_err(|error| {
        WorkspaceCensusError::new("WORKSPACE_REGISTRY_CREATE_FAILED", error.to_string())
    })?;
    if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
        return Err(WorkspaceCensusError::new(
            "WORKSPACE_REGISTRY_REFUSED",
            "workspace registry root is not a regular directory",
        ));
    }
    let destination = registry_file(registry_root, &request.workspace_id);
    if destination.exists() {
        let existing = read_registration(registry_root, &request.workspace_id)?;
        if existing.canonical_root != canonical_root || existing.root_identity != root_identity {
            return Err(WorkspaceCensusError::new(
                "WORKSPACE_ID_REBIND_REFUSED",
                "workspace identity is already bound to a different canonical root",
            ));
        }
        return Ok(WorkspaceRegistrationReceipt {
            schema_version: 1,
            registry_revision: existing.registry_revision,
            workspace_id: existing.workspace_id,
            canonical_root: existing.canonical_root,
            root_identity: existing.root_identity,
            access: "metadata-read-only",
            idempotent: true,
            capabilities: ["workspace-census:read"],
        });
    }
    let registration = WorkspaceRegistration {
        schema_version: 1,
        registry_revision: 1,
        workspace_id: request.workspace_id.clone(),
        canonical_root: canonical_root.clone(),
        root_identity: root_identity.clone(),
        access: "metadata-read-only".into(),
    };
    let bytes = serde_json::to_vec_pretty(&registration).map_err(|error| {
        WorkspaceCensusError::new("WORKSPACE_REGISTRY_WRITE_FAILED", error.to_string())
    })?;
    let temporary = registry_root.join(format!(
        ".{}.{}.tmp",
        request.workspace_id,
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| {
            WorkspaceCensusError::new("WORKSPACE_REGISTRY_WRITE_FAILED", error.to_string())
        })?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            WorkspaceCensusError::new("WORKSPACE_REGISTRY_WRITE_FAILED", error.to_string())
        })?;
    fs::rename(&temporary, &destination).map_err(|error| {
        WorkspaceCensusError::new("WORKSPACE_REGISTRY_WRITE_FAILED", error.to_string())
    })?;
    Ok(WorkspaceRegistrationReceipt {
        schema_version: 1,
        registry_revision: 1,
        workspace_id: request.workspace_id,
        canonical_root,
        root_identity,
        access: "metadata-read-only",
        idempotent: false,
        capabilities: ["workspace-census:read"],
    })
}

fn category(extension: &str, relative: &str) -> &'static str {
    if relative.contains("/test") || relative.starts_with("test") || relative.contains(".test.") {
        "test"
    } else if matches!(extension, ".md" | ".txt") {
        "document"
    } else if matches!(extension, ".json" | ".yaml" | ".yml" | ".toml" | ".lock") {
        "configuration"
    } else if matches!(extension, ".css" | ".html" | ".jsx" | ".tsx") {
        "interface"
    } else {
        "source"
    }
}

fn modified_epoch_ns(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
}

fn entry_kind(metadata: &fs::Metadata) -> u8 {
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        1
    } else if metadata.is_dir() {
        2
    } else if metadata.is_file() {
        3
    } else {
        4
    }
}

fn entry_stamp(name: OsString, metadata: &fs::Metadata) -> EntryStamp {
    EntryStamp {
        name,
        kind: entry_kind(metadata),
        size: metadata.len(),
        modified_epoch_ns: modified_epoch_ns(metadata),
    }
}

fn enforce_time_limit(started: Instant, policy: CensusPolicy) -> Result<(), WorkspaceCensusError> {
    if started.elapsed() >= policy.max_duration {
        Err(WorkspaceCensusError::new(
            "WORKSPACE_CENSUS_TIME_LIMIT",
            format!(
                "workspace census exceeded the fixed {} ms execution limit",
                policy.max_duration.as_millis()
            ),
        ))
    } else {
        Ok(())
    }
}

fn changed_during_scan(relative: &str) -> WorkspaceCensusError {
    WorkspaceCensusError::new(
        "WORKSPACE_CENSUS_CHANGED_DURING_SCAN",
        format!(
            "workspace changed while the census was running at {relative}; discard this result and run the census again"
        ),
    )
}

fn read_file_bounded(
    path: &Path,
    maximum: u64,
    read_error_code: &'static str,
) -> Result<Vec<u8>, WorkspaceCensusError> {
    let source = File::open(path)
        .map_err(|error| WorkspaceCensusError::new(read_error_code, error.to_string()))?;
    let mut bytes = Vec::new();
    source
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| WorkspaceCensusError::new(read_error_code, error.to_string()))?;
    Ok(bytes)
}

fn verify_consistent_snapshot(
    root: &Path,
    registration: &WorkspaceRegistration,
    directories: &[DirectorySnapshot],
    file_snapshots: &[FileSnapshot],
    started: Instant,
    policy: CensusPolicy,
    max_file_bytes: u64,
) -> Result<(), WorkspaceCensusError> {
    enforce_time_limit(started, policy)?;
    let final_root = canonical_directory(&registration.canonical_root)
        .map_err(|_| changed_during_scan("workspace root"))?;
    if final_root != root
        || slash(&final_root) != registration.canonical_root
        || sha256_hex(registration.canonical_root.as_bytes()) != registration.root_identity
    {
        return Err(changed_during_scan("workspace root"));
    }

    for snapshot in file_snapshots {
        enforce_time_limit(started, policy)?;
        let before = fs::symlink_metadata(&snapshot.path)
            .map_err(|_| changed_during_scan(&snapshot.relative))?;
        if !before.is_file()
            || before.file_type().is_symlink()
            || before.len() != snapshot.size
            || modified_epoch_ns(&before) != snapshot.modified_epoch_ns
        {
            return Err(changed_during_scan(&snapshot.relative));
        }
        let bytes = read_file_bounded(
            &snapshot.path,
            max_file_bytes,
            "WORKSPACE_CENSUS_CONSISTENCY_READ_FAILED",
        )
        .map_err(|_| changed_during_scan(&snapshot.relative))?;
        let after = fs::symlink_metadata(&snapshot.path)
            .map_err(|_| changed_during_scan(&snapshot.relative))?;
        if after.len() != snapshot.size
            || modified_epoch_ns(&after) != snapshot.modified_epoch_ns
            || bytes.len() as u64 != snapshot.size
            || sha256_hex(&bytes) != snapshot.sha256
        {
            return Err(changed_during_scan(&snapshot.relative));
        }
    }

    let mut verified_entries = 0_usize;
    for directory in directories {
        enforce_time_limit(started, policy)?;
        let iterator =
            fs::read_dir(&directory.path).map_err(|_| changed_during_scan(&directory.relative))?;
        let mut current = Vec::new();
        for candidate in iterator {
            enforce_time_limit(started, policy)?;
            verified_entries = verified_entries.saturating_add(1);
            if verified_entries > policy.max_entries {
                return Err(WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_ENTRY_LIMIT",
                    format!(
                        "workspace census exceeded the fixed {} directory-entry limit during consistency verification",
                        policy.max_entries
                    ),
                ));
            }
            let entry = candidate.map_err(|_| changed_during_scan(&directory.relative))?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| changed_during_scan(&directory.relative))?;
            current.push(entry_stamp(entry.file_name(), &metadata));
        }
        current.sort_by(|left, right| left.name.cmp(&right.name));
        if current != directory.entries {
            return Err(changed_during_scan(&directory.relative));
        }
    }

    enforce_time_limit(started, policy)
}

fn census_at(
    registry_root: &Path,
    request: CensusWorkspaceRequest,
) -> Result<WorkspaceCensusReceipt, WorkspaceCensusError> {
    census_at_with_policy(registry_root, request, CensusPolicy::default(), None)
}

fn census_at_with_policy(
    registry_root: &Path,
    request: CensusWorkspaceRequest,
    policy: CensusPolicy,
    after_initial_scan: Option<&dyn Fn()>,
) -> Result<WorkspaceCensusReceipt, WorkspaceCensusError> {
    let started = Instant::now();
    validate_schema(request.schema_version)?;
    validate_workspace_id(&request.workspace_id)?;
    if request.max_files == 0
        || request.max_files > MAX_FILES_LIMIT
        || request.max_file_bytes == 0
        || request.max_file_bytes > MAX_FILE_BYTES_LIMIT
    {
        return Err(WorkspaceCensusError::new(
            "WORKSPACE_CENSUS_LIMIT_INVALID",
            "census limits exceed the fixed native policy",
        ));
    }
    let registration = read_registration(registry_root, &request.workspace_id)?;
    if registration.registry_revision != request.registry_revision {
        return Err(WorkspaceCensusError::new(
            "WORKSPACE_REGISTRY_REVISION_STALE",
            "registry revision does not match the current workspace identity",
        ));
    }
    let root = canonical_directory(&registration.canonical_root)?;
    if slash(&root) != registration.canonical_root
        || sha256_hex(registration.canonical_root.as_bytes()) != registration.root_identity
    {
        return Err(WorkspaceCensusError::new(
            "WORKSPACE_ROOT_IDENTITY_CHANGED",
            "registered workspace root identity no longer matches",
        ));
    }
    let allowed_extensions = [
        ".md", ".txt", ".json", ".yaml", ".yml", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
        ".css", ".html", ".rs", ".toml", ".lock",
    ];
    let ignored = [
        ".git",
        "node_modules",
        "dist",
        "web-dist",
        "target",
        "target-codex",
        "gen",
        "autogenerated",
        ".cache",
        "coverage",
        "generated",
    ];
    let mut queue = VecDeque::from([(root.clone(), 0_usize, Vec::<ignore::gitignore::Gitignore>::new())]);
    let mut ignore_bytes = 0_u64;
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total = 0_u64;
    let mut directory_count = 1_usize;
    let mut entry_count = 0_usize;
    let mut directory_snapshots = Vec::new();
    let mut file_snapshots = Vec::new();
    while let Some((directory, depth, mut matchers)) = queue.pop_front() {
        enforce_time_limit(started, policy)?;
        let directory_relative = if directory == root {
            ".".to_string()
        } else {
            slash(directory.strip_prefix(&root).map_err(|_| {
                WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_ESCAPE",
                    "census directory escaped the registered root",
                )
            })?)
        };
        let iterator = fs::read_dir(&directory).map_err(|error| {
            WorkspaceCensusError::new(
                "WORKSPACE_CENSUS_READ_FAILED",
                format!("could not read directory {directory_relative}: {error}"),
            )
        })?;
        let mut entries = Vec::new();
        for candidate in iterator {
            enforce_time_limit(started, policy)?;
            entry_count = entry_count.saturating_add(1);
            if entry_count > policy.max_entries {
                return Err(WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_ENTRY_LIMIT",
                    format!(
                        "workspace census exceeded the fixed {} directory-entry limit",
                        policy.max_entries
                    ),
                ));
            }
            let entry = candidate.map_err(|error| {
                WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_READ_FAILED",
                    format!("could not enumerate directory {directory_relative}: {error}"),
                )
            })?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_READ_FAILED",
                    format!("could not inspect an entry in {directory_relative}: {error}"),
                )
            })?;
            let name = entry.file_name();
            let stamp = entry_stamp(name.clone(), &metadata);
            entries.push(ObservedEntry {
                path,
                name,
                metadata,
                stamp,
            });
        }
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        if let Some(config) = entries.iter().find(|entry| entry.name == ".gitignore") {
            if !config.metadata.is_file() || config.metadata.file_type().is_symlink() {
                return Err(WorkspaceCensusError::new("WORKSPACE_IGNORE_REFUSED", ".gitignore must be a regular non-link file"));
            }
            let bytes = read_file_bounded(&config.path, 65_536, "WORKSPACE_IGNORE_REFUSED")?;
            ignore_bytes += bytes.len() as u64;
            if ignore_bytes > 2_000_000 {
                return Err(WorkspaceCensusError::new("WORKSPACE_IGNORE_LIMIT", "Ignore configuration exceeded its separate 2MB bound"));
            }
            let source = std::str::from_utf8(&bytes).map_err(|_| WorkspaceCensusError::new("WORKSPACE_IGNORE_REFUSED", ".gitignore is not UTF-8"))?;
            let mut builder = ignore::gitignore::GitignoreBuilder::new(&directory);
            for line in source.lines() {
                builder.add_line(Some(config.path.clone()), line).map_err(|error| WorkspaceCensusError::new("WORKSPACE_IGNORE_REFUSED", error.to_string()))?;
            }
            matchers.push(builder.build().map_err(|error| WorkspaceCensusError::new("WORKSPACE_IGNORE_REFUSED", error.to_string()))?);
            file_snapshots.push(FileSnapshot {path:config.path.clone(),relative:slash(config.path.strip_prefix(&root).unwrap()),size:config.metadata.len(),modified_epoch_ns:modified_epoch_ns(&config.metadata),sha256:sha256_hex(&bytes)});
        }
        directory_snapshots.push(DirectorySnapshot {
            path: directory.clone(),
            relative: directory_relative,
            entries: entries.iter().map(|entry| entry.stamp.clone()).collect(),
        });

        for entry in entries {
            enforce_time_limit(started, policy)?;
            let name = entry.name.to_string_lossy().to_string();
            let path = entry.path;
            let relative = slash(path.strip_prefix(&root).map_err(|_| {
                WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_ESCAPE",
                    "census path escaped the registered root",
                )
            })?);
            let meta = entry.metadata;
            if meta.file_type().is_symlink() {
                skipped.push(CensusSkipRecord {
                    path: relative,
                    reason: "symbolic-link-refused",
                    size: None,
                });
                continue;
            }
            let ignored_by_repo = matchers.iter().rev().map(|matcher| matcher.matched(&path, meta.is_dir())).find(|matched| !matched.is_none()).map(|matched| matched.is_ignore()).unwrap_or(false);
            if ignored_by_repo {
                skipped.push(CensusSkipRecord {path:relative,reason:"gitignore-excluded",size:None});
                continue;
            }
            if meta.is_dir() {
                if ignored.contains(&name.as_str()) {
                    skipped.push(CensusSkipRecord {
                        path: relative,
                        reason: "ignored-directory",
                        size: None,
                    });
                    continue;
                }
                let child_depth = depth.saturating_add(1);
                if child_depth > policy.max_depth {
                    return Err(WorkspaceCensusError::new(
                        "WORKSPACE_CENSUS_DEPTH_LIMIT",
                        format!(
                            "workspace census exceeded the fixed {} directory-depth limit at {relative}",
                            policy.max_depth
                        ),
                    ));
                }
                directory_count = directory_count.saturating_add(1);
                if directory_count > policy.max_directories {
                    return Err(WorkspaceCensusError::new(
                        "WORKSPACE_CENSUS_DIRECTORY_LIMIT",
                        format!(
                            "workspace census exceeded the fixed {} directory limit",
                            policy.max_directories
                        ),
                    ));
                }
                queue.push_back((path, child_depth, matchers.clone()));
                continue;
            }
            if !meta.is_file() {
                skipped.push(CensusSkipRecord {
                    path: relative,
                    reason: "non-regular-file-refused",
                    size: None,
                });
                continue;
            }
            let extension = Path::new(&name)
                .extension()
                .map(|value| format!(".{}", value.to_string_lossy().to_lowercase()))
                .unwrap_or_default();
            if !allowed_extensions.contains(&extension.as_str()) {
                continue;
            }
            if files.len() >= request.max_files as usize {
                return Err(WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_FILE_LIMIT",
                    format!("Read {} eligible files; the approved limit is {}. No complete inventory was accepted. Select a smaller app root or exclude generated content before retrying.", files.len(), request.max_files),
                ));
            }
            if policy.metadata_only {
                files.push(CensusFileRecord {
                    path:relative.clone(),extension:extension.clone(),category:category(&extension,&relative),
                    size:meta.len(),sha256:String::new(),modified_epoch_ms:modified_epoch_ns(&meta).map(|value|value/1_000_000),
                });
                continue;
            }
            if meta.len() > request.max_file_bytes {
                skipped.push(CensusSkipRecord {
                    path: relative,
                    reason: "file-too-large",
                    size: Some(meta.len()),
                });
                continue;
            }
            if total.saturating_add(meta.len()) > policy.max_total_bytes {
                return Err(WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_BYTE_LIMIT",
                    format!("Scan stopped before reading {relative}: {} bytes already read; next file {} bytes; scan limit {} bytes. No complete inventory was accepted. Choose a smaller source folder or exclude generated output from the selected workspace.", total, meta.len(), policy.max_total_bytes),
                ));
            }
            let modified_ns = modified_epoch_ns(&meta);
            let bytes = read_file_bounded(
                &path,
                request.max_file_bytes,
                "WORKSPACE_CENSUS_READ_FAILED",
            )?;
            let after_read =
                fs::symlink_metadata(&path).map_err(|_| changed_during_scan(&relative))?;
            if !after_read.is_file()
                || after_read.file_type().is_symlink()
                || bytes.len() as u64 != meta.len()
                || after_read.len() != meta.len()
                || modified_epoch_ns(&after_read) != modified_ns
            {
                return Err(changed_during_scan(&relative));
            }
            if total.saturating_add(bytes.len() as u64) > policy.max_total_bytes {
                return Err(WorkspaceCensusError::new(
                    "WORKSPACE_CENSUS_BYTE_LIMIT",
                    format!("Scan exceeded its {} byte content limit. No complete inventory was accepted.", policy.max_total_bytes),
                ));
            }
            total += bytes.len() as u64;
            let file_sha256 = sha256_hex(&bytes);
            let modified_epoch_ms = modified_ns.map(|value| value / 1_000_000);
            file_snapshots.push(FileSnapshot {
                path: path.clone(),
                relative: relative.clone(),
                size: meta.len(),
                modified_epoch_ns: modified_ns,
                sha256: file_sha256.clone(),
            });
            files.push(CensusFileRecord {
                path: relative.clone(),
                extension: extension.clone(),
                category: category(&extension, &relative),
                size: meta.len(),
                sha256: file_sha256,
                modified_epoch_ms,
            });
        }
    }
    if let Some(hook) = after_initial_scan {
        hook();
    }
    verify_consistent_snapshot(
        &root,
        &registration,
        &directory_snapshots,
        &file_snapshots,
        started,
        policy,
        request.max_file_bytes,
    )?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    skipped.sort_by(|left, right| left.path.cmp(&right.path));
    let mut summary = BTreeMap::new();
    for file in &files {
        *summary.entry(file.category).or_insert(0) += 1;
    }
    let digest_source = files
        .iter()
        .map(|file| format!("{}:{}", file.path, file.sha256))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(WorkspaceCensusReceipt {
        schema_version: 1,
        registry_revision: registration.registry_revision,
        workspace_id: registration.workspace_id,
        root_identity: registration.root_identity,
        generated_epoch_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        file_count: files.len(),
        total_bytes_hashed: total,
        summary,
        files,
        skipped,
        digest: sha256_hex(digest_source.as_bytes()),
        content_returned: false,
        capabilities: ["workspace-census:read"],
    })
}

pub(crate) fn app_registry_root(app: &tauri::AppHandle) -> Result<PathBuf, WorkspaceCensusError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("workspace-registry-v1"))
        .map_err(|error| {
            WorkspaceCensusError::new("WORKSPACE_APP_DATA_UNAVAILABLE", error.to_string())
        })
}

pub(crate) fn census_and_retain(registry_root:&Path,request:CensusWorkspaceRequest)->Result<WorkspaceCensusReceipt,WorkspaceCensusError>{
    observation::scan(registry_root,request,None)
}

/// Retained host observation only, not a new scan or a live filesystem lease.
pub(crate) fn retained_census_binding(registry_root:&Path,workspace_id:&str,registry_revision:u32,root_identity:&str)->Result<serde_json::Value,WorkspaceCensusError>{
    observation::latest(registry_root,workspace_id,registry_revision,root_identity)
}

/// Read registration identity only. This never enumerates or reads project files.
pub(crate) fn registered_metadata(
    registry_root: &Path,
    workspace_id: &str,
    registry_revision: u32,
    root_identity: &str,
) -> Result<serde_json::Value, ()> {
    registered_git_root(registry_root, workspace_id, registry_revision, root_identity)?;
    Ok(serde_json::json!({ "schemaVersion":1, "workspaceId":workspace_id, "registryRevision":registry_revision, "rootIdentity":root_identity, "access":"metadata-read-only", "contentReturned":false, "executionAuthorized":false }))
}

/// Native-only resolver; never returns a filesystem root to the webview.
pub(crate) fn registered_git_root(
    registry_root: &Path,
    workspace_id: &str,
    registry_revision: u32,
    root_identity: &str,
) -> Result<PathBuf, ()> {
    validate_workspace_id(workspace_id).map_err(|_| ())?;
    if registry_revision == 0
        || root_identity.len() != 64
        || !root_identity
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(());
    }
    fn no_links(path: &Path) -> Result<(), ()> {
        if !path.is_absolute() {
            return Err(());
        }
        for ancestor in path.ancestors() {
            let metadata = fs::symlink_metadata(ancestor).map_err(|_| ())?;
            if metadata.file_type().is_symlink() {
                return Err(());
            }
        }
        Ok(())
    }
    no_links(registry_root)?;
    if !fs::metadata(registry_root).map_err(|_| ())?.is_dir() {
        return Err(());
    }
    let path = registry_file(registry_root, workspace_id);
    no_links(&path)?;
    let before = fs::symlink_metadata(&path).map_err(|_| ())?;
    if !before.is_file() || before.len() > 16_384 {
        return Err(());
    }
    let bytes =
        read_file_bounded(&path, 16_384, "WORKSPACE_REGISTRY_READ_FAILED").map_err(|_| ())?;
    let after = fs::symlink_metadata(&path).map_err(|_| ())?;
    if after.file_type().is_symlink()
        || bytes.len() > 16_384
        || before.len() != bytes.len() as u64
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(());
    }
    let registration: WorkspaceRegistration = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if registration.schema_version != 1
        || registration.workspace_id != workspace_id
        || registration.registry_revision != registry_revision
        || registration.root_identity != root_identity
        || registration.access != "metadata-read-only"
    {
        return Err(());
    }
    let registered_root = Path::new(&registration.canonical_root);
    no_links(registered_root)?;
    let canonical = canonical_directory(&registration.canonical_root).map_err(|_| ())?;
    if slash(&canonical) != registration.canonical_root
        || sha256_hex(registration.canonical_root.as_bytes()) != root_identity
    {
        return Err(());
    }
    Ok(canonical)
}

#[tauri::command]
pub fn register_workspace_read_only(
    app: tauri::AppHandle,
    request: RegisterWorkspaceRequest,
) -> Result<WorkspaceRegistrationReceipt, WorkspaceCensusError> {
    register_at(&app_registry_root(&app)?, request)
}

#[tauri::command]
pub async fn preview_registered_workspace(
    app: tauri::AppHandle,
    request: CensusWorkspaceRequest,
) -> Result<serde_json::Value, WorkspaceCensusError> {
    let registry_root=app_registry_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || preview_at(&registry_root,request))
        .await.map_err(|error|WorkspaceCensusError::new("WORKSPACE_PREVIEW_FAILED",error.to_string()))?
}

fn preview_at(registry_root:&Path, request:CensusWorkspaceRequest)->Result<serde_json::Value,WorkspaceCensusError>{
    let receipt=census_at_with_policy(registry_root,request,CensusPolicy{metadata_only:true,..CensusPolicy::default()},None)?;
    Ok(serde_json::json!({
        "schemaVersion":1,"kind":"folder-preview","authoritative":false,"contentVerified":false,
        "workspaceId":receipt.workspace_id,"registryRevision":receipt.registry_revision,
        "fileCount":receipt.file_count,"generatedEpochMs":receipt.generated_epoch_ms,
        "files":receipt.files.iter().map(|file|serde_json::json!({"path":file.path,"size":file.size,"category":file.category,"extension":file.extension})).collect::<Vec<_>>(),
        "skipped":receipt.skipped,
    }))
}

#[tauri::command]
pub async fn census_registered_workspace(
    app: tauri::AppHandle,
    request: CensusWorkspaceRequest,
) -> Result<WorkspaceCensusReceipt, WorkspaceCensusError> {
    let registry_root = app_registry_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || census_and_retain(&registry_root, request))
        .await
        .map_err(|error| {
            WorkspaceCensusError::new(
                "WORKSPACE_CENSUS_WORKER_FAILED",
                format!("native workspace census worker failed: {error}"),
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("pp-native-census-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let workspace = base.join("workspace");
        let registry = base.join("registry");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/app.js"), b"export const app = true;\n").unwrap();
        fs::write(workspace.join("README.md"), b"# fixture\n").unwrap();
        (workspace, registry)
    }

    #[test]
    fn registration_is_explicit_idempotent_and_cannot_rebind() {
        let (workspace, registry) = fixture("register");
        let request = || RegisterWorkspaceRequest {
            schema_version: 1,
            workspace_id: "workspace-one".into(),
            root_path: workspace.to_string_lossy().into(),
            explicit_user_approval: true,
        };
        let first = register_at(&registry, request()).unwrap();
        let second = register_at(&registry, request()).unwrap();
        assert!(!first.idempotent);
        assert!(second.idempotent);
        assert_eq!(first.root_identity, second.root_identity);
        let other = workspace.parent().unwrap().join("other");
        fs::create_dir_all(&other).unwrap();
        let error = register_at(
            &registry,
            RegisterWorkspaceRequest {
                root_path: other.to_string_lossy().into(),
                ..request()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_ID_REBIND_REFUSED");
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    #[ignore = "Requires DANS1 task-specific Looplet metadata snapshot"]
    fn looplet_shape_preview_qualification() {
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let input=std::env::var("PP_LOOPLET_SHAPE").unwrap();
        let source=fs::read_to_string(input).unwrap();
        let shape:serde_json::Value=serde_json::from_str(source.trim_start_matches('\u{feff}')).unwrap();
        assert_eq!(shape["truncated"],false);
        let (workspace,registry)=fixture("looplet-shape-266");
        for entry in shape["entries"].as_array().unwrap() {
            let relative=Path::new(entry["path"].as_str().unwrap());
            assert!(relative.components().all(|part|matches!(part,std::path::Component::Normal(_))));
            let target=workspace.join(relative);
            if entry["kind"]=="directory" {fs::create_dir_all(&target).unwrap();}
            else if relative.extension().is_some() {
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(target,[]).unwrap();
            }
        }
        for config in shape["ignoreFiles"].as_array().unwrap() {
            let relative=Path::new(config["path"].as_str().unwrap());
            assert!(relative.components().all(|part|matches!(part,std::path::Component::Normal(_))));
            fs::write(workspace.join(relative),config["text"].as_str().unwrap()).unwrap();
        }
        register_at(&registry,RegisterWorkspaceRequest{schema_version:1,workspace_id:"looplet-shape".into(),root_path:workspace.to_string_lossy().into(),explicit_user_approval:true}).unwrap();
        let receipt=preview_at(&registry,CensusWorkspaceRequest{schema_version:1,workspace_id:"looplet-shape".into(),registry_revision:1,max_files:MAX_FILES_LIMIT,max_file_bytes:MAX_FILE_BYTES_LIMIT}).unwrap();
        assert!(receipt["fileCount"].as_u64().unwrap()>0);
        assert!(receipt["files"].as_array().unwrap().iter().all(|entry|!entry["path"].as_str().unwrap().starts_with("output/")&&!entry["path"].as_str().unwrap().starts_with("artifacts/")));
        assert!(receipt["skipped"].as_array().unwrap().iter().any(|entry|entry["path"]=="output"));
        assert!(receipt["skipped"].as_array().unwrap().iter().any(|entry|entry["path"]=="artifacts"));
        fs::write(std::env::var("PP_LOOPLET_PREVIEW_OUTPUT").unwrap(),serde_json::to_vec(&receipt).unwrap()).unwrap();
        println!("Looplet shape preview: {} source-file paths; original content never copied",receipt["fileCount"]);
        // Retain this isolated test fixture for browser/diagnostic reproducibility.
    }

    #[test]
    fn gitignore_scope_and_preview_do_not_require_content_budget() {
        let (workspace,registry)=fixture("ignore-preview");
        fs::write(workspace.join(".gitignore"),"/output/\n/artifacts/\n*.tmp\n!keep.tmp\n").unwrap();
        for path in ["output/companion-diagnostics-web/xray-app/src/vendor/pdf.worker.min.mjs","artifacts/repair/web-dist/assets/vendor.js"] {
            let path=workspace.join(path);fs::create_dir_all(path.parent().unwrap()).unwrap();fs::write(path,vec![b'x';1_375_838]).unwrap();
        }
        fs::write(workspace.join("src/.gitignore"),"*.js\n!app.js\n").unwrap();
        fs::write(workspace.join("src/excluded.js"),vec![b'x';2000]).unwrap();
        fs::write(workspace.join("src/big.ts"),vec![b'x';2000]).unwrap();
        register_at(&registry,RegisterWorkspaceRequest{schema_version:1,workspace_id:"preview-app".into(),root_path:workspace.to_string_lossy().into(),explicit_user_approval:true}).unwrap();
        let request=||CensusWorkspaceRequest{schema_version:1,workspace_id:"preview-app".into(),registry_revision:1,max_files:100,max_file_bytes:MAX_FILE_BYTES_LIMIT};
        let preview=preview_at(&registry,request()).unwrap();
        assert_eq!(preview["authoritative"],false);assert_eq!(preview["contentVerified"],false);
        assert!(preview["files"].as_array().unwrap().iter().any(|file|file["path"]=="src/big.ts"));
        assert!(!preview["files"].as_array().unwrap().iter().any(|file|file["path"]=="src/excluded.js"));
        assert!(preview["skipped"].as_array().unwrap().iter().any(|file|file["path"]=="output" && file["reason"]=="gitignore-excluded"));
        assert!(!registry.join("preview-app.census-observations.jsonl").exists());
        let small=CensusPolicy{max_total_bytes:1000,..CensusPolicy::default()};
        assert_eq!(census_at_with_policy(&registry,request(),small,None).unwrap_err().code,"WORKSPACE_CENSUS_BYTE_LIMIT");
        let metadata=census_at_with_policy(&registry,request(),CensusPolicy{metadata_only:true,..small},None).unwrap();
        assert_eq!(metadata.total_bytes_hashed,0);
        assert!(census_and_retain(&registry,request()).is_ok());
        let _=fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn generated_web_dist_is_reported_without_spending_source_budget() {
        let (workspace, registry) = fixture("web-dist-exclusion");
        let output = workspace.join("artifacts/owner-repair/web-dist/assets");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("vendor-pdf.js"), vec![b'x'; 1_441_600]).unwrap();
        fs::write(workspace.join("artifacts/repair-notes.md"), b"retain these notes").unwrap();
        fs::create_dir_all(workspace.join("web-dist-source")).unwrap();
        fs::write(workspace.join("web-dist-source/app.js"), b"retain this source").unwrap();
        // A file sharing an ignored directory name is not a generated directory.
        fs::write(workspace.join(".cache"), b"keep original").unwrap();
        register_at(&registry, RegisterWorkspaceRequest {schema_version:1, workspace_id:"output-exclusion".into(), root_path:workspace.to_string_lossy().into(), explicit_user_approval:true}).unwrap();
        let request = || CensusWorkspaceRequest {schema_version:1, workspace_id:"output-exclusion".into(), registry_revision:1, max_files:50, max_file_bytes:MAX_FILE_BYTES_LIMIT};
        let receipt=census_at_with_policy(&registry,request(),CensusPolicy {max_total_bytes:1_000,..CensusPolicy::default()},None).unwrap();
        assert_eq!(receipt.file_count,4);
        assert!(receipt.total_bytes_hashed<1_000);
        assert!(receipt.files.iter().any(|file|file.path=="artifacts/repair-notes.md"));
        assert!(receipt.files.iter().any(|file|file.path=="web-dist-source/app.js"));
        assert!(receipt.skipped.iter().any(|skip|skip.path=="artifacts/owner-repair/web-dist" && skip.reason=="ignored-directory"));
        assert!(!receipt.files.iter().any(|file|file.path.contains("vendor-pdf")));
        assert_eq!(fs::metadata(output.join("vendor-pdf.js")).unwrap().len(),1_441_600);
        // Real source still consumes the budget and fails closed.
        fs::write(workspace.join("src/large.js"),vec![b'x';1_100]).unwrap();
        assert_eq!(census_at_with_policy(&registry,request(),CensusPolicy {max_total_bytes:1_000,..CensusPolicy::default()},None).unwrap_err().code,"WORKSPACE_CENSUS_BYTE_LIMIT");
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn scan_over_ten_thousand_files_retains_complete_receipt_and_enforces_exact_limit() {
        let (workspace, registry) = fixture("large-file-count");
        for index in 0..10_050 {
            fs::write(workspace.join(format!("src/item-{index}.js")), b"export default 1;").unwrap();
        }
        register_at(&registry, RegisterWorkspaceRequest {schema_version: 1, workspace_id: "large-count".into(), root_path: workspace.to_string_lossy().into(), explicit_user_approval: true}).unwrap();
        let request = |max_files| CensusWorkspaceRequest {schema_version: 1, workspace_id: "large-count".into(), registry_revision: 1, max_files, max_file_bytes: MAX_FILE_BYTES_LIMIT};
        let error = census_and_retain(&registry, request(10_000)).unwrap_err();
        assert_eq!(error.code, "WORKSPACE_CENSUS_FILE_LIMIT");
        assert!(error.message.contains("No complete inventory was accepted"));
        assert!(!registry.join("large-count.census-observations.jsonl").exists());
        let receipt = census_and_retain(&registry, request(MAX_FILES_LIMIT)).unwrap();
        assert_eq!(receipt.file_count, 10_052);
        assert_eq!(receipt.files.len(), 10_052);
        assert!(!receipt.content_returned);
        let journal = registry.join("large-count.census-observations.jsonl");
        let before = fs::read(&journal).unwrap();
        let error = census_and_retain(&registry, request(10_051)).unwrap_err();
        assert_eq!(error.code, "WORKSPACE_CENSUS_FILE_LIMIT");
        assert_eq!(fs::read(&journal).unwrap(), before);
        let exact = census_and_retain(&registry, request(10_052)).unwrap();
        assert_eq!(exact.digest, receipt.digest);
        assert!(census_and_retain(&registry, request(MAX_FILES_LIMIT+1)).is_err());
        assert_eq!(fs::read(workspace.join("src/item-0.js")).unwrap(), b"export default 1;");
        // Export the actual native receipt for the downstream JS map test on DANS1.
        if let Ok(path) = std::env::var("PP_CENSUS_PROOF_OUTPUT") {
            fs::write(path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        }
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn content_over_old_fifty_mb_limit_is_hashed_and_budget_still_refuses() {
        let (workspace, registry) = fixture("larger-content");
        let chunk = vec![b'x'; 2_000_000];
        for index in 0..30 {
            fs::write(workspace.join(format!("src/part-{index}.js")), &chunk).unwrap();
        }
        register_at(&registry, RegisterWorkspaceRequest {schema_version: 1, workspace_id: "large-content".into(), root_path: workspace.to_string_lossy().into(), explicit_user_approval: true}).unwrap();
        let request = || CensusWorkspaceRequest {schema_version: 1, workspace_id: "large-content".into(), registry_revision: 1, max_files: 100, max_file_bytes: MAX_FILE_BYTES_LIMIT};
        let receipt = census_at(&registry, request()).unwrap();
        assert_eq!(receipt.file_count, 32);
        assert!(receipt.total_bytes_hashed > 60_000_000);
        assert!(receipt.total_bytes_hashed < MAX_TOTAL_BYTES);
        assert!(!receipt.content_returned);
        let exact = receipt.total_bytes_hashed;
        assert!(census_at_with_policy(&registry, request(), CensusPolicy {max_total_bytes: exact, ..CensusPolicy::default()}, None).is_ok());
        let error = census_at_with_policy(&registry, request(), CensusPolicy {max_total_bytes: exact-1, ..CensusPolicy::default()}, None).unwrap_err();
        assert_eq!(error.code, "WORKSPACE_CENSUS_BYTE_LIMIT");
        assert!(error.message.contains("No complete inventory was accepted"));
        assert_eq!(fs::read(workspace.join("src/part-0.js")).unwrap(), chunk);
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn census_returns_only_bounded_metadata_and_refuses_stale_revision() {
        let (workspace, registry) = fixture("census");
        register_at(
            &registry,
            RegisterWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-two".into(),
                root_path: workspace.to_string_lossy().into(),
                explicit_user_approval: true,
            },
        )
        .unwrap();
        let receipt = census_at(
            &registry,
            CensusWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-two".into(),
                registry_revision: 1,
                max_files: 10,
                max_file_bytes: 1024,
            },
        )
        .unwrap();
        assert_eq!(receipt.file_count, 2);
        assert!(!receipt.content_returned);
        assert!(receipt.files.iter().all(|file| file.sha256.len() == 64));
        let error = census_at(
            &registry,
            CensusWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-two".into(),
                registry_revision: 2,
                max_files: 10,
                max_file_bytes: 1024,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_REGISTRY_REVISION_STALE");
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn unknown_schema_approval_and_limits_fail_closed() {
        let (workspace, registry) = fixture("refusal");
        let root_path: String = workspace.to_string_lossy().into_owned();
        for request in [
            RegisterWorkspaceRequest {
                schema_version: 2,
                workspace_id: "workspace-three".into(),
                root_path: root_path.clone(),
                explicit_user_approval: true,
            },
            RegisterWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-three".into(),
                root_path: root_path.clone(),
                explicit_user_approval: false,
            },
        ] {
            assert!(register_at(&registry, request).is_err());
        }
        register_at(
            &registry,
            RegisterWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-three".into(),
                root_path,
                explicit_user_approval: true,
            },
        )
        .unwrap();
        assert!(census_at(
            &registry,
            CensusWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-three".into(),
                registry_revision: 1,
                max_files: 0,
                max_file_bytes: 1
            }
        )
        .is_err());
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn hostile_tree_directory_entry_depth_and_time_ceilings_fail_closed() {
        let (workspace, registry) = fixture("tree-limits");
        fs::create_dir_all(workspace.join("src/deeper")).unwrap();
        register_at(
            &registry,
            RegisterWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-tree-limits".into(),
                root_path: workspace.to_string_lossy().into(),
                explicit_user_approval: true,
            },
        )
        .unwrap();
        let request = || CensusWorkspaceRequest {
            schema_version: 1,
            workspace_id: "workspace-tree-limits".into(),
            registry_revision: 1,
            max_files: 10,
            max_file_bytes: 1024,
        };

        let directory_error = census_at_with_policy(
            &registry,
            request(),
            CensusPolicy {
                max_directories: 1,
                ..CensusPolicy::default()
            },
            None,
        )
        .unwrap_err();
        assert_eq!(directory_error.code, "WORKSPACE_CENSUS_DIRECTORY_LIMIT");

        let entry_error = census_at_with_policy(
            &registry,
            request(),
            CensusPolicy {
                max_entries: 1,
                ..CensusPolicy::default()
            },
            None,
        )
        .unwrap_err();
        assert_eq!(entry_error.code, "WORKSPACE_CENSUS_ENTRY_LIMIT");

        let depth_error = census_at_with_policy(
            &registry,
            request(),
            CensusPolicy {
                max_depth: 1,
                ..CensusPolicy::default()
            },
            None,
        )
        .unwrap_err();
        assert_eq!(depth_error.code, "WORKSPACE_CENSUS_DEPTH_LIMIT");

        let time_error = census_at_with_policy(
            &registry,
            request(),
            CensusPolicy {
                max_duration: Duration::ZERO,
                ..CensusPolicy::default()
            },
            None,
        )
        .unwrap_err();
        assert_eq!(time_error.code, "WORKSPACE_CENSUS_TIME_LIMIT");
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn file_mutation_between_scan_and_verification_is_refused() {
        let (workspace, registry) = fixture("file-mutation");
        register_at(
            &registry,
            RegisterWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-file-mutation".into(),
                root_path: workspace.to_string_lossy().into(),
                explicit_user_approval: true,
            },
        )
        .unwrap();
        let changed_file = workspace.join("src/app.js");
        let mutate = || {
            fs::write(
                &changed_file,
                b"export const app = 'changed during census';\n",
            )
            .unwrap();
        };
        let error = census_at_with_policy(
            &registry,
            CensusWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-file-mutation".into(),
                registry_revision: 1,
                max_files: 10,
                max_file_bytes: 1024,
            },
            CensusPolicy::default(),
            Some(&mutate),
        )
        .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_CENSUS_CHANGED_DURING_SCAN");
        assert!(error.message.contains("src/app.js"));
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }

    #[test]
    fn directory_mutation_between_scan_and_verification_is_refused() {
        let (workspace, registry) = fixture("directory-mutation");
        register_at(
            &registry,
            RegisterWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-directory-mutation".into(),
                root_path: workspace.to_string_lossy().into(),
                explicit_user_approval: true,
            },
        )
        .unwrap();
        let added_file = workspace.join("appeared-after-scan.ts");
        let mutate = || {
            fs::write(&added_file, b"export {};\n").unwrap();
        };
        let error = census_at_with_policy(
            &registry,
            CensusWorkspaceRequest {
                schema_version: 1,
                workspace_id: "workspace-directory-mutation".into(),
                registry_revision: 1,
                max_files: 10,
                max_file_bytes: 1024,
            },
            CensusPolicy::default(),
            Some(&mutate),
        )
        .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_CENSUS_CHANGED_DURING_SCAN");
        assert!(error.message.contains(" at .;"));
        let _ = fs::remove_dir_all(workspace.parent().unwrap());
    }
}
