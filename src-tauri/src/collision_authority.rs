use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

const SCHEMA_VERSION: u32 = 1;
const COMMAND_REVISION: u32 = 1;
const AUTHORITY_ACTOR: &str = "local-desktop-user";
const MAX_LEDGER_ENTRIES: usize = 10_000;
const MAX_ENTRY_BYTES: u64 = 128_000;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_RETRY: Duration = Duration::from_millis(10);
const CAPABILITIES: [&str; 3] = [
    "collision-authority:inspect",
    "collision-authority:approve",
    "collision-authority:commit",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollisionAuthorityError {
    code: &'static str,
    message: String,
}

impl CollisionAuthorityError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectRequest {
    schema_version: u32,
    plan_id: String,
    census_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrderedParty {
    plan_id: String,
    task_id: String,
    access: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollisionDecision {
    id: String,
    surface: String,
    severity: String,
    first: OrderedParty,
    then: OrderedParty,
    contingency: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproveRequest {
    schema_version: u32,
    plan_id: String,
    census_digest: String,
    expected_revision: u32,
    expected_head_hash: String,
    explicit_user_approval: bool,
    collision: CollisionDecision,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollisionAssessment {
    manifest_ids: Vec<String>,
    claims: usize,
    collision_ids: Vec<String>,
    surfaces: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    schema_version: u32,
    plan_id: String,
    census_digest: String,
    expected_revision: u32,
    expected_head_hash: String,
    explicit_user_approval: bool,
    assessment: CollisionAssessment,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LedgerEntry {
    sequence: u32,
    timestamp: String,
    actor: String,
    #[serde(rename = "type")]
    event_type: String,
    payload: Value,
    previous_hash: String,
    hash: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollisionAuthorityReceipt {
    schema_version: u32,
    command_revision: u32,
    plan_id: String,
    census_digest: String,
    authority: &'static str,
    authority_transport: &'static str,
    authoritative: bool,
    revision: usize,
    head_hash: String,
    approved_ids: Vec<String>,
    ledger: Vec<LedgerEntry>,
    capabilities: [&'static str; 3],
}

struct AuthorityLock {
    file: File,
}

impl Drop for AuthorityLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "null".into()),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "null".into()),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn entry_body(entry: &LedgerEntry) -> Value {
    json!({
        "sequence": entry.sequence,
        "timestamp": entry.timestamp,
        "actor": entry.actor,
        "type": entry.event_type,
        "payload": entry.payload,
        "previousHash": entry.previous_hash,
    })
}

fn calculate_entry_hash(entry: &LedgerEntry) -> String {
    sha256_hex(canonical_json(&entry_body(entry)).as_bytes())
}

fn valid_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_plan_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_named_id(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .chars()
            .all(|character| !character.is_control() && character != '\0')
}

fn valid_collision_id(value: &str) -> bool {
    value.strip_prefix("COL-").is_some_and(|tail| {
        tail.len() >= 3 && tail.len() <= 12 && tail.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn validate_identity(
    schema_version: u32,
    plan_id: &str,
    census_digest: &str,
) -> Result<(), CollisionAuthorityError> {
    if schema_version != SCHEMA_VERSION {
        return Err(CollisionAuthorityError::new(
            "COLLISION_SCHEMA_VERSION_UNSUPPORTED",
            format!(
                "collision authority requires schema version {SCHEMA_VERSION}; received {schema_version}"
            ),
        ));
    }
    if !valid_plan_id(plan_id) {
        return Err(CollisionAuthorityError::new(
            "COLLISION_PLAN_ID_INVALID",
            "planId must be 1-128 ASCII letters, numbers, hyphens, underscores, periods, or colons",
        ));
    }
    if !valid_hex_64(census_digest) {
        return Err(CollisionAuthorityError::new(
            "COLLISION_CENSUS_DIGEST_INVALID",
            "censusDigest must be a lowercase SHA-256 identity",
        ));
    }
    Ok(())
}

fn validate_expected_head(value: &str) -> Result<(), CollisionAuthorityError> {
    if value == "GENESIS" || valid_hex_64(value) {
        Ok(())
    } else {
        Err(CollisionAuthorityError::new(
            "COLLISION_EXPECTED_HEAD_INVALID",
            "expectedHeadHash must be GENESIS or a lowercase SHA-256 identity",
        ))
    }
}

fn authority_locations(root: &Path, plan_id: &str, census_digest: &str) -> (PathBuf, PathBuf) {
    let plan_key = sha256_hex(format!("plan:{plan_id}").as_bytes());
    let directory = root.join(plan_key).join(census_digest);
    let lock = directory.join(".authority.lock");
    (directory, lock)
}

fn safe_directory(path: &Path, create: bool) -> Result<bool, CollisionAuthorityError> {
    if create {
        fs::create_dir_all(path).map_err(|error| {
            CollisionAuthorityError::new("COLLISION_STORE_CREATE_FAILED", error.to_string())
        })?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(CollisionAuthorityError::new(
                "COLLISION_STORE_REFUSED",
                "collision authority storage contains an unsafe directory",
            ))
        }
        Ok(_) => Ok(true),
        Err(error) if !create && error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(CollisionAuthorityError::new(
            "COLLISION_STORE_UNAVAILABLE",
            error.to_string(),
        )),
    }
}

fn ensure_store_path(
    root: &Path,
    directory: &Path,
    create: bool,
) -> Result<bool, CollisionAuthorityError> {
    if !safe_directory(root, create)? {
        return Ok(false);
    }
    let Some(plan_directory) = directory.parent() else {
        return Err(CollisionAuthorityError::new(
            "COLLISION_STORE_REFUSED",
            "collision authority storage path is invalid",
        ));
    };
    if !safe_directory(plan_directory, create)? {
        return Ok(false);
    }
    safe_directory(directory, create)
}

fn acquire_lock(path: &Path) -> Result<AuthorityLock, CollisionAuthorityError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| {
            CollisionAuthorityError::new("COLLISION_LOCK_UNAVAILABLE", error.to_string())
        })?;
    let started = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(AuthorityLock { file }),
            Err(error) if started.elapsed() < LOCK_TIMEOUT => {
                if error.kind() != ErrorKind::WouldBlock {
                    return Err(CollisionAuthorityError::new(
                        "COLLISION_LOCK_FAILED",
                        error.to_string(),
                    ));
                }
                thread::sleep(LOCK_RETRY);
            }
            Err(_) => {
                return Err(CollisionAuthorityError::new(
                    "COLLISION_LOCK_TIMEOUT",
                    "collision authority remained locked for 5000 ms",
                ))
            }
        }
    }
}

fn empty_receipt(plan_id: &str, census_digest: &str) -> CollisionAuthorityReceipt {
    CollisionAuthorityReceipt {
        schema_version: SCHEMA_VERSION,
        command_revision: COMMAND_REVISION,
        plan_id: plan_id.to_owned(),
        census_digest: census_digest.to_owned(),
        authority: "native-journal",
        authority_transport: "tauri-ipc-v1",
        authoritative: true,
        revision: 0,
        head_hash: "GENESIS".into(),
        approved_ids: Vec::new(),
        ledger: Vec::new(),
        capabilities: CAPABILITIES,
    }
}

fn approval_payload(
    value: &Value,
    expected_census_digest: &str,
) -> Result<String, CollisionAuthorityError> {
    let payload: ApprovalPayload = serde_json::from_value(value.clone()).map_err(|_| {
        CollisionAuthorityError::new(
            "COLLISION_JOURNAL_INVALID",
            "collision approval payload is malformed",
        )
    })?;
    if !valid_collision_id(&payload.collision_id)
        || payload.census_digest != expected_census_digest
        || !valid_named_id(&payload.surface, 4096)
        || !matches!(payload.severity.as_str(), "hard-stop" | "ordered")
        || !valid_named_id(&payload.first, 260)
        || !payload.first.contains('/')
        || !valid_named_id(&payload.then, 260)
        || !payload.then.contains('/')
        || !valid_named_id(&payload.contingency, 8192)
    {
        return Err(CollisionAuthorityError::new(
            "COLLISION_JOURNAL_INVALID",
            "collision approval payload identity is invalid",
        ));
    }
    Ok(payload.collision_id)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalPayload {
    collision_id: String,
    census_digest: String,
    surface: String,
    severity: String,
    first: String,
    then: String,
    contingency: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitPayload {
    census_digest: String,
    collision_ids: Vec<String>,
    manifest_ids: Vec<String>,
    claims: usize,
    surfaces: Vec<String>,
}

fn inspect_at(
    root: &Path,
    request: &InspectRequest,
) -> Result<CollisionAuthorityReceipt, CollisionAuthorityError> {
    validate_identity(
        request.schema_version,
        &request.plan_id,
        &request.census_digest,
    )?;
    let (directory, _) = authority_locations(root, &request.plan_id, &request.census_digest);
    if !ensure_store_path(root, &directory, false)? {
        return Ok(empty_receipt(&request.plan_id, &request.census_digest));
    }
    let mut names = Vec::new();
    for candidate in fs::read_dir(&directory).map_err(|error| {
        CollisionAuthorityError::new("COLLISION_STORE_READ_FAILED", error.to_string())
    })? {
        let candidate = candidate.map_err(|error| {
            CollisionAuthorityError::new("COLLISION_STORE_READ_FAILED", error.to_string())
        })?;
        let name = candidate.file_name().to_string_lossy().into_owned();
        if name == ".authority.lock" {
            let metadata = fs::symlink_metadata(candidate.path()).map_err(|error| {
                CollisionAuthorityError::new("COLLISION_STORE_READ_FAILED", error.to_string())
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(CollisionAuthorityError::new(
                    "COLLISION_STORE_REFUSED",
                    "collision authority lock is not a regular file",
                ));
            }
            continue;
        }
        if name.len() != 13
            || !name.ends_with(".json")
            || !name[..8].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(CollisionAuthorityError::new(
                "COLLISION_STORE_UNRECOGNIZED_ENTRY",
                "collision authority storage contains an unrecognized entry",
            ));
        }
        names.push(name);
    }
    names.sort();
    if names.len() > MAX_LEDGER_ENTRIES {
        return Err(CollisionAuthorityError::new(
            "COLLISION_LEDGER_LIMIT",
            format!("collision authority exceeds its {MAX_LEDGER_ENTRIES} entry limit"),
        ));
    }
    let mut receipt = empty_receipt(&request.plan_id, &request.census_digest);
    let mut committed = false;
    let mut approved = BTreeSet::new();
    for (index, name) in names.iter().enumerate() {
        let expected_sequence = index + 1;
        let expected_name = format!("{expected_sequence:08}.json");
        if name != &expected_name {
            return Err(CollisionAuthorityError::new(
                "COLLISION_LEDGER_SEQUENCE_BROKEN",
                format!("collision authority sequence is broken at {expected_sequence}"),
            ));
        }
        let path = directory.join(name);
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            CollisionAuthorityError::new("COLLISION_STORE_READ_FAILED", error.to_string())
        })?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_ENTRY_BYTES
        {
            return Err(CollisionAuthorityError::new(
                "COLLISION_JOURNAL_ENTRY_REFUSED",
                "collision journal entry is not a bounded regular file",
            ));
        }
        let bytes = fs::read(&path).map_err(|error| {
            CollisionAuthorityError::new("COLLISION_STORE_READ_FAILED", error.to_string())
        })?;
        let entry: LedgerEntry = serde_json::from_slice(&bytes).map_err(|_| {
            CollisionAuthorityError::new(
                "COLLISION_JOURNAL_INVALID",
                format!("collision journal entry {expected_sequence} is malformed"),
            )
        })?;
        if entry.sequence as usize != expected_sequence
            || entry.previous_hash != receipt.head_hash
            || entry.actor != AUTHORITY_ACTOR
            || !valid_hex_64(&entry.hash)
            || calculate_entry_hash(&entry) != entry.hash
        {
            return Err(CollisionAuthorityError::new(
                "COLLISION_JOURNAL_INVALID",
                format!("collision journal entry {expected_sequence} failed chain verification"),
            ));
        }
        match entry.event_type.as_str() {
            "collision.order-approved" => {
                if committed {
                    return Err(CollisionAuthorityError::new(
                        "COLLISION_JOURNAL_INVALID",
                        "collision order appears after the assessment commit",
                    ));
                }
                let id = approval_payload(&entry.payload, &request.census_digest)?;
                if !approved.insert(id) {
                    return Err(CollisionAuthorityError::new(
                        "COLLISION_JOURNAL_INVALID",
                        "collision approval is duplicated",
                    ));
                }
            }
            "collision.assessment-committed" => {
                if committed {
                    return Err(CollisionAuthorityError::new(
                        "COLLISION_JOURNAL_INVALID",
                        "collision assessment is committed more than once",
                    ));
                }
                let payload: CommitPayload = serde_json::from_value(entry.payload.clone())
                    .map_err(|_| {
                        CollisionAuthorityError::new(
                            "COLLISION_JOURNAL_INVALID",
                            "collision commit payload is malformed",
                        )
                    })?;
                let payload_ids = payload
                    .collision_ids
                    .iter()
                    .cloned()
                    .collect::<BTreeSet<_>>();
                if payload.census_digest != request.census_digest
                    || payload_ids != approved
                    || payload_ids.len() != payload.collision_ids.len()
                    || payload.manifest_ids.is_empty()
                    || payload.claims == 0
                    || payload.surfaces.len() != payload.claims
                {
                    return Err(CollisionAuthorityError::new(
                        "COLLISION_JOURNAL_INVALID",
                        "collision commit does not reconcile with its exact census approvals",
                    ));
                }
                committed = true;
            }
            _ => {
                return Err(CollisionAuthorityError::new(
                    "COLLISION_JOURNAL_EVENT_UNSUPPORTED",
                    "collision journal contains an unsupported event type",
                ))
            }
        }
        receipt.head_hash = entry.hash.clone();
        receipt.ledger.push(entry);
    }
    receipt.revision = receipt.ledger.len();
    receipt.approved_ids = approved.into_iter().collect();
    Ok(receipt)
}

fn verify_compare_and_swap(
    state: &CollisionAuthorityReceipt,
    expected_revision: u32,
    expected_head_hash: &str,
) -> Result<(), CollisionAuthorityError> {
    validate_expected_head(expected_head_hash)?;
    if state.revision != expected_revision as usize || state.head_hash != expected_head_hash {
        return Err(CollisionAuthorityError::new(
            "COLLISION_COMPARE_AND_SWAP_FAILED",
            "collision authority changed; refresh the exact census before retrying",
        ));
    }
    Ok(())
}

fn validate_party(value: &OrderedParty) -> bool {
    valid_plan_id(&value.plan_id)
        && valid_named_id(&value.task_id, 128)
        && matches!(value.access.as_str(), "read" | "write")
}

fn validate_collision(value: &CollisionDecision) -> Result<(), CollisionAuthorityError> {
    if !valid_collision_id(&value.id)
        || !valid_named_id(&value.surface, 4096)
        || !matches!(value.severity.as_str(), "hard-stop" | "ordered")
        || !validate_party(&value.first)
        || !validate_party(&value.then)
        || !valid_named_id(&value.contingency, 8192)
        || (value.first.plan_id == value.then.plan_id && value.first.task_id == value.then.task_id)
    {
        return Err(CollisionAuthorityError::new(
            "COLLISION_DECISION_INVALID",
            "collision approval requires an exact bounded order between two distinct task claims",
        ));
    }
    Ok(())
}

fn append_entry(
    directory: &Path,
    state: &CollisionAuthorityReceipt,
    event_type: &str,
    payload: Value,
) -> Result<(), CollisionAuthorityError> {
    if state.revision >= MAX_LEDGER_ENTRIES {
        return Err(CollisionAuthorityError::new(
            "COLLISION_LEDGER_LIMIT",
            format!("collision authority reached its {MAX_LEDGER_ENTRIES} entry limit"),
        ));
    }
    let mut entry = LedgerEntry {
        sequence: (state.revision + 1) as u32,
        timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        actor: AUTHORITY_ACTOR.into(),
        event_type: event_type.into(),
        payload,
        previous_hash: state.head_hash.clone(),
        hash: String::new(),
    };
    entry.hash = calculate_entry_hash(&entry);
    let bytes = serde_json::to_vec_pretty(&entry).map_err(|error| {
        CollisionAuthorityError::new("COLLISION_JOURNAL_WRITE_FAILED", error.to_string())
    })?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES {
        return Err(CollisionAuthorityError::new(
            "COLLISION_JOURNAL_ENTRY_LIMIT",
            format!("collision journal entry exceeds its {MAX_ENTRY_BYTES} byte limit"),
        ));
    }
    let path = directory.join(format!("{:08}.json", entry.sequence));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            CollisionAuthorityError::new("COLLISION_JOURNAL_WRITE_FAILED", error.to_string())
        })?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            CollisionAuthorityError::new("COLLISION_JOURNAL_WRITE_FAILED", error.to_string())
        })
}

fn approve_at(
    root: &Path,
    request: &ApproveRequest,
) -> Result<CollisionAuthorityReceipt, CollisionAuthorityError> {
    validate_identity(
        request.schema_version,
        &request.plan_id,
        &request.census_digest,
    )?;
    if !request.explicit_user_approval {
        return Err(CollisionAuthorityError::new(
            "COLLISION_EXPLICIT_APPROVAL_REQUIRED",
            "an explicit user action is required to append a collision order",
        ));
    }
    validate_collision(&request.collision)?;
    let (directory, lock_path) =
        authority_locations(root, &request.plan_id, &request.census_digest);
    ensure_store_path(root, &directory, true)?;
    let _lock = acquire_lock(&lock_path)?;
    let inspect = InspectRequest {
        schema_version: request.schema_version,
        plan_id: request.plan_id.clone(),
        census_digest: request.census_digest.clone(),
    };
    let state = inspect_at(root, &inspect)?;
    verify_compare_and_swap(
        &state,
        request.expected_revision,
        &request.expected_head_hash,
    )?;
    if state
        .ledger
        .iter()
        .any(|entry| entry.event_type == "collision.assessment-committed")
    {
        return Err(CollisionAuthorityError::new(
            "COLLISION_ASSESSMENT_ALREADY_COMMITTED",
            "the collision assessment is already committed",
        ));
    }
    if state.approved_ids.contains(&request.collision.id) {
        return Err(CollisionAuthorityError::new(
            "COLLISION_ORDER_ALREADY_APPROVED",
            "the collision order is already approved",
        ));
    }
    let payload = json!({
        "collisionId": request.collision.id,
        "censusDigest": request.census_digest,
        "surface": request.collision.surface,
        "severity": request.collision.severity,
        "first": format!("{}/{}", request.collision.first.plan_id, request.collision.first.task_id),
        "then": format!("{}/{}", request.collision.then.plan_id, request.collision.then.task_id),
        "contingency": request.collision.contingency,
    });
    append_entry(&directory, &state, "collision.order-approved", payload)?;
    inspect_at(root, &inspect)
}

fn validate_assessment(value: &CollisionAssessment) -> Result<(), CollisionAuthorityError> {
    let manifests = value.manifest_ids.iter().collect::<BTreeSet<_>>();
    let collision_ids = value.collision_ids.iter().collect::<BTreeSet<_>>();
    let surfaces = value.surfaces.iter().collect::<BTreeSet<_>>();
    if value.manifest_ids.is_empty()
        || manifests.len() != value.manifest_ids.len()
        || value.manifest_ids.iter().any(|id| !valid_plan_id(id))
        || collision_ids.len() != value.collision_ids.len()
        || value.collision_ids.iter().any(|id| !valid_collision_id(id))
        || value.claims == 0
        || value.claims > 50_000
        || value.surfaces.len() != value.claims
        || surfaces.len() != value.surfaces.len()
        || value.surfaces.iter().any(|surface| {
            !valid_named_id(surface, 4096)
                || !(surface.starts_with("read:") || surface.starts_with("write:"))
        })
    {
        return Err(CollisionAuthorityError::new(
            "COLLISION_ASSESSMENT_INVALID",
            "assessment requires unique bounded manifest IDs, collision IDs, and every exact typed claim surface",
        ));
    }
    Ok(())
}

fn commit_at(
    root: &Path,
    request: &CommitRequest,
) -> Result<CollisionAuthorityReceipt, CollisionAuthorityError> {
    validate_identity(
        request.schema_version,
        &request.plan_id,
        &request.census_digest,
    )?;
    if !request.explicit_user_approval {
        return Err(CollisionAuthorityError::new(
            "COLLISION_EXPLICIT_APPROVAL_REQUIRED",
            "an explicit user action is required to commit a collision assessment",
        ));
    }
    validate_assessment(&request.assessment)?;
    let (directory, lock_path) =
        authority_locations(root, &request.plan_id, &request.census_digest);
    ensure_store_path(root, &directory, true)?;
    let _lock = acquire_lock(&lock_path)?;
    let inspect = InspectRequest {
        schema_version: request.schema_version,
        plan_id: request.plan_id.clone(),
        census_digest: request.census_digest.clone(),
    };
    let state = inspect_at(root, &inspect)?;
    verify_compare_and_swap(
        &state,
        request.expected_revision,
        &request.expected_head_hash,
    )?;
    if state
        .ledger
        .iter()
        .any(|entry| entry.event_type == "collision.assessment-committed")
    {
        return Err(CollisionAuthorityError::new(
            "COLLISION_ASSESSMENT_ALREADY_COMMITTED",
            "the collision assessment is already committed",
        ));
    }
    let approved = state.approved_ids.iter().cloned().collect::<BTreeSet<_>>();
    let requested = request
        .assessment
        .collision_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if approved != requested {
        return Err(CollisionAuthorityError::new(
            "COLLISION_APPROVAL_SET_MISMATCH",
            "assessment cannot commit until every exact census collision is approved",
        ));
    }
    let payload = serde_json::to_value(&request.assessment).map_err(|error| {
        CollisionAuthorityError::new("COLLISION_ASSESSMENT_INVALID", error.to_string())
    })?;
    let payload = match payload {
        Value::Object(mut object) => {
            object.insert(
                "censusDigest".into(),
                Value::String(request.census_digest.clone()),
            );
            Value::Object(object)
        }
        _ => unreachable!("serialized assessment is always an object"),
    };
    append_entry(
        &directory,
        &state,
        "collision.assessment-committed",
        payload,
    )?;
    inspect_at(root, &inspect)
}

fn app_authority_root(app: &tauri::AppHandle) -> Result<PathBuf, CollisionAuthorityError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("collision-authority-v1"))
        .map_err(|error| {
            CollisionAuthorityError::new("COLLISION_APP_DATA_UNAVAILABLE", error.to_string())
        })
}

#[tauri::command]
pub async fn collision_authority_inspect(
    app: tauri::AppHandle,
    request: InspectRequest,
) -> Result<CollisionAuthorityReceipt, CollisionAuthorityError> {
    let root = app_authority_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || inspect_at(&root, &request))
        .await
        .map_err(|error| {
            CollisionAuthorityError::new(
                "COLLISION_AUTHORITY_WORKER_FAILED",
                format!("native collision authority worker failed: {error}"),
            )
        })?
}

#[tauri::command]
pub async fn collision_authority_approve(
    app: tauri::AppHandle,
    request: ApproveRequest,
) -> Result<CollisionAuthorityReceipt, CollisionAuthorityError> {
    let root = app_authority_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || approve_at(&root, &request))
        .await
        .map_err(|error| {
            CollisionAuthorityError::new(
                "COLLISION_AUTHORITY_WORKER_FAILED",
                format!("native collision authority worker failed: {error}"),
            )
        })?
}

#[tauri::command]
pub async fn collision_authority_commit(
    app: tauri::AppHandle,
    request: CommitRequest,
) -> Result<CollisionAuthorityReceipt, CollisionAuthorityError> {
    let root = app_authority_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || commit_at(&root, &request))
        .await
        .map_err(|error| {
            CollisionAuthorityError::new(
                "COLLISION_AUTHORITY_WORKER_FAILED",
                format!("native collision authority worker failed: {error}"),
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "pp-native-collision-{name}-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn digest(letter: char) -> String {
        std::iter::repeat_n(letter, 64).collect()
    }

    fn collision(id: &str) -> CollisionDecision {
        CollisionDecision {
            id: id.into(),
            surface: "src/contracts/plan.ts".into(),
            severity: "hard-stop".into(),
            first: OrderedParty {
                plan_id: "PLAN-A".into(),
                task_id: "B01".into(),
                access: "write".into(),
            },
            then: OrderedParty {
                plan_id: "PLAN-B".into(),
                task_id: "B02".into(),
                access: "write".into(),
            },
            contingency: "PLAN-A/B01 proceeds first; PLAN-B/B02 rescans".into(),
        }
    }

    fn inspect(plan_id: &str, census_digest: &str) -> InspectRequest {
        InspectRequest {
            schema_version: 1,
            plan_id: plan_id.into(),
            census_digest: census_digest.into(),
        }
    }

    #[test]
    fn empty_inspection_is_versioned_and_does_not_create_storage() {
        let root = fixture("empty");
        let state = inspect_at(&root, &inspect("PP-TEST", &digest('a'))).unwrap();
        assert!(state.authoritative);
        assert_eq!(state.authority_transport, "tauri-ipc-v1");
        assert_eq!(state.revision, 0);
        assert_eq!(state.head_hash, "GENESIS");
        assert!(!root.exists());
    }

    #[test]
    fn approval_and_commit_form_a_verified_append_only_chain() {
        let root = fixture("happy");
        let census = digest('b');
        let first = approve_at(
            &root,
            &ApproveRequest {
                schema_version: 1,
                plan_id: "PP-TEST".into(),
                census_digest: census.clone(),
                expected_revision: 0,
                expected_head_hash: "GENESIS".into(),
                explicit_user_approval: true,
                collision: collision("COL-001"),
            },
        )
        .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(first.approved_ids, ["COL-001"]);
        let committed = commit_at(
            &root,
            &CommitRequest {
                schema_version: 1,
                plan_id: "PP-TEST".into(),
                census_digest: census.clone(),
                expected_revision: 1,
                expected_head_hash: first.head_hash,
                explicit_user_approval: true,
                assessment: CollisionAssessment {
                    manifest_ids: vec!["PLAN-A".into(), "PLAN-B".into()],
                    claims: 2,
                    collision_ids: vec!["COL-001".into()],
                    surfaces: vec![
                        "write:src/contracts/plan.ts".into(),
                        "read:src/contracts/plan.ts".into(),
                    ],
                },
            },
        )
        .unwrap();
        assert_eq!(committed.revision, 2);
        assert_eq!(
            inspect_at(&root, &inspect("PP-TEST", &census))
                .unwrap()
                .head_hash,
            committed.head_hash
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mutation_requires_explicit_gesture_and_exact_compare_and_swap() {
        let root = fixture("cas");
        let census = digest('c');
        let request = ApproveRequest {
            schema_version: 1,
            plan_id: "PP-TEST".into(),
            census_digest: census.clone(),
            expected_revision: 0,
            expected_head_hash: "GENESIS".into(),
            explicit_user_approval: false,
            collision: collision("COL-001"),
        };
        assert_eq!(
            approve_at(&root, &request).unwrap_err().code,
            "COLLISION_EXPLICIT_APPROVAL_REQUIRED"
        );
        let state = approve_at(
            &root,
            &ApproveRequest {
                explicit_user_approval: true,
                ..request
            },
        )
        .unwrap();
        let stale = approve_at(
            &root,
            &ApproveRequest {
                schema_version: 1,
                plan_id: "PP-TEST".into(),
                census_digest: census,
                expected_revision: 0,
                expected_head_hash: "GENESIS".into(),
                explicit_user_approval: true,
                collision: collision("COL-002"),
            },
        )
        .unwrap_err();
        assert_eq!(stale.code, "COLLISION_COMPARE_AND_SWAP_FAILED");
        assert_eq!(state.revision, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tampering_unknown_entries_and_schema_drift_fail_closed() {
        let root = fixture("tamper");
        let census = digest('d');
        let state = approve_at(
            &root,
            &ApproveRequest {
                schema_version: 1,
                plan_id: "PP-TEST".into(),
                census_digest: census.clone(),
                expected_revision: 0,
                expected_head_hash: "GENESIS".into(),
                explicit_user_approval: true,
                collision: collision("COL-001"),
            },
        )
        .unwrap();
        let (directory, _) = authority_locations(&root, "PP-TEST", &census);
        let file = directory.join("00000001.json");
        let mut entry: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        entry["payload"]["surface"] = Value::String("src/tampered.ts".into());
        fs::write(&file, serde_json::to_vec_pretty(&entry).unwrap()).unwrap();
        assert_eq!(
            inspect_at(&root, &inspect("PP-TEST", &census))
                .unwrap_err()
                .code,
            "COLLISION_JOURNAL_INVALID"
        );
        assert_eq!(state.revision, 1);
        fs::write(directory.join("surprise.txt"), b"unexpected").unwrap();
        assert_eq!(
            inspect_at(&root, &inspect("PP-TEST", &census))
                .unwrap_err()
                .code,
            "COLLISION_STORE_UNRECOGNIZED_ENTRY"
        );
        assert_eq!(
            inspect_at(
                &root,
                &InspectRequest {
                    schema_version: 2,
                    plan_id: "PP-TEST".into(),
                    census_digest: digest('e'),
                }
            )
            .unwrap_err()
            .code,
            "COLLISION_SCHEMA_VERSION_UNSUPPORTED"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rust_hash_matches_the_browser_canonical_ledger_contract() {
        let entry = LedgerEntry {
            sequence: 1,
            timestamp: "2026-09-04T00:00:00.000Z".into(),
            actor: AUTHORITY_ACTOR.into(),
            event_type: "collision.order-approved".into(),
            payload: json!({
                "collisionId": "COL-001",
                "censusDigest": digest('a'),
                "surface": "src/contracts/plan.ts",
                "severity": "hard-stop",
                "first": "PLAN-A/B01",
                "then": "PLAN-B/B02",
                "contingency": "PLAN-A/B01 proceeds first; PLAN-B/B02 rescans",
            }),
            previous_hash: "GENESIS".into(),
            hash: String::new(),
        };
        assert_eq!(
            calculate_entry_hash(&entry),
            "4fd198e6265e4cfd1d3c343f58c81d1dbe0ca8ee41aea011bd1a73fb3342bc60"
        );
    }
}
