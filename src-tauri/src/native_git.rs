//! Fixed registered-repository metadata helper. No user-supplied commands.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LIMIT: usize = 2 * 1024 * 1024;
static ACTIVE: AtomicBool = AtomicBool::new(false);
fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryRequest {
    schema_version: u32,
    request_id: String,
    project_id: String,
    generation: u32,
    workspace_id: String,
    registry_revision: u32,
    root_identity: String,
}
fn token(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn valid(r: &InventoryRequest) -> bool {
    r.schema_version == 1
        && token(&r.request_id, 96)
        && token(&r.project_id, 128)
        && token(&r.workspace_id, 64)
        && r.workspace_id.len() >= 3
        && r.registry_revision > 0
        && r.root_identity.len() == 64
        && r.root_identity
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn envelope(
    r: &InventoryRequest,
    start: Instant,
    code: &str,
    observation: Option<Value>,
    cleanup: bool,
) -> Value {
    let now = timestamp();
    let mut value = serde_json::to_value(r).unwrap();
    let fields = value.as_object_mut().unwrap();
    fields.extend(json!({"code":code,"observedAt":now,"expiresAt":now + if observation.is_some() && cleanup { 30000 } else { 0 },
        "durationMs":start.elapsed().as_millis() as u64,"observation":observation,"cleanupComplete":cleanup,
        "metadataOnly":true,"executionAuthorized":false,"computerUse":false}).as_object().unwrap().clone());
    value
}
fn oid(s: &str) -> bool {
    [40, 64].contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn branch(s: &str) -> bool {
    s.starts_with("refs/heads/")
        && s.len() <= 1024
        && !s
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\u{fffd}')
}
fn parse_worktrees(text: &str) -> Result<Vec<Value>, &'static str> {
    let body = text.strip_suffix("\0\0").ok_or("GIT_OUTPUT_INVALID")?;
    let mut paths = HashSet::new();
    let mut rows = Vec::new();
    for block in body.split("\0\0") {
        if rows.len() >= 128 {
            return Err("GIT_INVENTORY_LIMIT");
        }
        let mut tokens = block.split('\0');
        let location = tokens
            .next()
            .and_then(|v| v.strip_prefix("worktree "))
            .ok_or("GIT_OUTPUT_INVALID")?;
        if !Path::new(location).is_absolute()
            || location.len() > 4096
            || location.chars().any(|c| c.is_control() || c == '\u{fffd}')
            || !paths.insert(if cfg!(windows) {
                location.replace('\\', "/").to_lowercase()
            } else {
                location.to_owned()
            })
        {
            return Err("GIT_OUTPUT_INVALID");
        }
        let mut fields = std::collections::HashMap::new();
        for token in tokens {
            let (key, value) = token
                .split_once(' ')
                .map(|(k, v)| (k, Some(v)))
                .unwrap_or((token, None));
            if !["HEAD", "branch", "bare", "detached", "locked", "prunable"].contains(&key)
                || fields.insert(key, value).is_some()
            {
                return Err("GIT_OUTPUT_INVALID");
            }
        }
        let bare = fields.contains_key("bare");
        let detached = fields.contains_key("detached");
        let head = fields.get("HEAD").copied().flatten();
        let reference = fields.get("branch").copied().flatten();
        if (bare && (fields.len() != 1 || fields["bare"].is_some()))
            || (!bare
                && (!head.map(oid).unwrap_or(false)
                    || if detached {
                        fields["detached"].is_some() || fields.contains_key("branch")
                    } else {
                        !reference.map(branch).unwrap_or(false)
                    }))
        {
            return Err("GIT_OUTPUT_INVALID");
        }
        rows.push(json!({"path":location,"headSha":head,"branchRef":reference,"mode":if bare {"bare"} else if detached {"detached"} else {"branch"},
            "locked":fields.contains_key("locked"),"prunable":fields.contains_key("prunable"),"cleanState":"not-inspected","canAutomaticallyDelete":false}));
    }
    Ok(rows)
}
fn parse_branches(text: &str) -> Result<Vec<Value>, &'static str> {
    if text.is_empty() {
        return Ok(vec![]);
    }
    let body = text.strip_suffix('\n').ok_or("GIT_OUTPUT_INVALID")?;
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for line in body.split('\n') {
        if rows.len() >= 500 {
            return Err("GIT_INVENTORY_LIMIT");
        }
        let (reference, head) = line.split_once('\0').ok_or("GIT_OUTPUT_INVALID")?;
        if !branch(reference) || !oid(head) || !seen.insert(reference) {
            return Err("GIT_OUTPUT_INVALID");
        }
        rows.push(json!({"ref":reference,"headSha":head}));
    }
    Ok(rows)
}
fn canonical(p: &Path) -> Result<PathBuf, &'static str> {
    fs::canonicalize(p).map_err(|_| "GIT_ROOT_UNAVAILABLE")
}
fn fixed_executable(p: &Path, root: &Path) -> Result<PathBuf, &'static str> {
    for ancestor in p.ancestors() {
        if fs::symlink_metadata(ancestor)
            .map_err(|_| "GIT_EXECUTABLE_UNAVAILABLE")?
            .file_type()
            .is_symlink()
        {
            return Err("GIT_EXECUTABLE_REFUSED");
        }
    }
    let resolved = canonical(p).map_err(|_| "GIT_EXECUTABLE_UNAVAILABLE")?;
    let normalized = |path: &Path| {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .to_lowercase()
    };
    if !fs::metadata(p)
        .map_err(|_| "GIT_EXECUTABLE_UNAVAILABLE")?
        .is_file()
        || resolved.starts_with(root)
        || normalized(p) != normalized(&resolved)
    {
        return Err("GIT_EXECUTABLE_REFUSED");
    }
    Ok(resolved)
}
fn fingerprint(p: &Path) -> Result<String, &'static str> {
    let m = fs::symlink_metadata(p).map_err(|_| "GIT_ROOT_UNAVAILABLE")?;
    if m.file_type().is_symlink() {
        return Err("GIT_ROOT_REFUSED");
    }
    Ok(format!(
        "{:?}:{}:{:?}:{:?}",
        canonical(p)?,
        m.len(),
        m.modified(),
        m.created()
    ))
}
fn marker(root: &Path) -> Result<Option<String>, &'static str> {
    let p = root.join(".git");
    match fs::symlink_metadata(&p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(m) if m.is_dir() || m.is_file() => fingerprint(&p).map(Some),
        _ => Err("GIT_MARKER_REFUSED"),
    }
}
fn inspect(registry: &Path, request: &InventoryRequest) -> Result<Value, &'static str> {
    let root = crate::workspace_census::registered_git_root(
        registry,
        &request.workspace_id,
        request.registry_revision,
        &request.root_identity,
    )
    .map_err(|_| "GIT_REGISTRATION_INVALID")?;
    let before = fingerprint(&root)?;
    let git_before = marker(&root)?;
    let mut worktrees = vec![];
    let mut branches = vec![];
    if git_before.is_some() {
        let executable = Path::new("C:\\Program Files\\Git\\cmd\\git.exe");
        let executable_path = fixed_executable(executable, &root)?;
        let executable_stamp = fingerprint(executable)?;
        let mut used = 0;
        let mut run = |args: &[&str]| -> Result<String, &'static str> {
            if fixed_executable(executable, &root)? != executable_path
                || fingerprint(executable)? != executable_stamp
            {
                return Err("GIT_EXECUTABLE_CHANGED");
            }
            if used >= LIMIT {
                return Err("GIT_INVENTORY_LIMIT");
            }
            let mut command = Command::new(&executable_path);
            command
                .args([
                    "--no-pager",
                    "--no-optional-locks",
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "protocol.allow=never",
                ])
                .args(args)
                .current_dir(&root)
                .env_clear()
                .env("SystemRoot", "C:\\Windows")
                .env("WINDIR", "C:\\Windows")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_NO_LAZY_FETCH", "1")
                .env("GIT_NO_REPLACE_OBJECTS", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn().map_err(|_| "GIT_EXECUTABLE_UNAVAILABLE")?;
            let mut bytes = Vec::new();
            child
                .stdout
                .take()
                .ok_or("GIT_INTERRUPTED")?
                .take((LIMIT - used + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "GIT_INTERRUPTED")?;
            used += bytes.len();
            if used > LIMIT {
                return Err("GIT_INVENTORY_LIMIT");
            }
            if !child.wait().map_err(|_| "GIT_INTERRUPTED")?.success() {
                return Err("GIT_COMMAND_FAILED");
            }
            String::from_utf8(bytes).map_err(|_| "GIT_OUTPUT_INVALID")
        };
        let mut read = || -> Result<(String, String), &'static str> {
            let top = run(&["rev-parse", "--show-toplevel"])?;
            let top = top.strip_suffix('\n').ok_or("GIT_OUTPUT_INVALID")?;
            if top.chars().any(char::is_control) || canonical(Path::new(top))? != root {
                return Err("GIT_ROOT_MISMATCH");
            }
            Ok((
                run(&["worktree", "list", "--porcelain", "-z"])?,
                run(&[
                    "for-each-ref",
                    "--sort=refname",
                    "--count=501",
                    "--format=%(refname)%00%(objectname)",
                    "refs/heads/",
                ])?,
            ))
        };
        let first = read()?;
        worktrees = parse_worktrees(&first.0)?;
        branches = parse_branches(&first.1)?;
        if !worktrees.iter().any(|w| {
            w["path"]
                .as_str()
                .map(|s| canonical(Path::new(s)).ok() == Some(root.clone()))
                .unwrap_or(false)
        }) {
            return Err("GIT_ROOT_MISMATCH");
        }
        if first != read()? {
            return Err("GIT_INVENTORY_CHANGED");
        }
    }
    if before != fingerprint(&root)?
        || git_before != marker(&root)?
        || root
            != crate::workspace_census::registered_git_root(
                registry,
                &request.workspace_id,
                request.registry_revision,
                &request.root_identity,
            )
            .map_err(|_| "GIT_REGISTRATION_INVALID")?
    {
        return Err("GIT_INVENTORY_CHANGED");
    }
    Ok(
        json!({"schemaVersion":1,"kind":"git-inventory","state":if git_before.is_some(){"observed"}else{"no-git-marker"},
        "localOnly":true,"worktrees":worktrees,"branches":branches,"cleanState":"not-inspected","ciState":"not-inspected","productionState":"not-inspected",
        "promotionAuthority":false,"canAutomaticallyDelete":false,"consistency":if git_before.is_some(){"two-matching-reads-not-atomic"}else{"root-marker-observation"}}),
    )
}

pub(crate) fn serve_stdio(registry: &Path) -> i32 {
    // The parent assigns the fixed helper to a kill-on-close Job before sending
    // this frame. No project read or child creation occurs before it arrives.
    let mut bytes = Vec::new();
    let input = std::io::stdin();
    if input
        .lock()
        .take(4097)
        .read_until(b'\n', &mut bytes)
        .is_err()
        || bytes.len() > 4096
        || bytes.last() != Some(&b'\n')
    {
        return 2;
    }
    let request: InventoryRequest = match serde_json::from_slice(&bytes) {
        Ok(r) if valid(&r) => r,
        _ => return 2,
    };
    let value = match inspect(registry, &request) {
        Ok(observation) => json!({"code":"GIT_OBSERVED","observation":observation}),
        Err(code) => json!({"code":code,"observation":null}),
    };
    let output = std::io::stdout();
    let mut writer = output.lock();
    if serde_json::to_writer(&mut writer, &value).is_err()
        || writer.write_all(b"\n").is_err()
        || writer.flush().is_err()
    {
        return 2;
    }
    0
}

#[cfg(windows)]
mod containment {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Basic {
        process_time: i64,
        job_time: i64,
        flags: u32,
        minimum: usize,
        maximum: usize,
        active: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Extended {
        basic: Basic,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        user: i64,
        kernel: i64,
        period_user: i64,
        period_kernel: i64,
        faults: u32,
        total: u32,
        active: u32,
        terminated: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(security: Handle, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: i32,
            info: *mut c_void,
            len: u32,
            returned: *mut u32,
        ) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    pub struct Job(Handle);
    impl Job {
        pub fn new(child: &std::process::Child) -> Result<Self, ()> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if handle.is_null() {
                    return Err(());
                }
                let job = Self(handle);
                let mut limits = Extended::default();
                limits.basic.flags = 0x2000;
                if SetInformationJobObject(
                    handle,
                    9,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<Extended>() as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
                {
                    return Err(());
                }
                Ok(job)
            }
        }
        pub fn empty(&self) -> bool {
            unsafe {
                let mut info = Accounting::default();
                QueryInformationJobObject(
                    self.0,
                    1,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<Accounting>() as u32,
                    std::ptr::null_mut(),
                ) != 0
                    && info.active == 0
            }
        }
        pub fn stop(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
fn probe(registry: &Path, request: &InventoryRequest) -> (Result<Value, &'static str>, bool) {
    use std::os::windows::process::CommandExt;
    let mut child = match std::env::current_exe()
        .and_then(fs::canonicalize)
        .and_then(|exe| {
            Command::new(exe)
                .args(["--planner-git-stdio", "--registry-root"])
                .arg(registry)
                .env_clear()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
        }) {
        Ok(c) => c,
        Err(_) => return (Err("GIT_HELPER_UNAVAILABLE"), true),
    };
    let job = match containment::Job::new(&child) {
        Ok(j) => j,
        Err(_) => {
            let _ = child.kill();
            let deadline = Instant::now();
            while deadline.elapsed() < Duration::from_millis(900) {
                if child.try_wait().ok().flatten().is_some() {
                    return (Err("GIT_CONTAINMENT_UNAVAILABLE"), true);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            std::thread::spawn(move || {
                let _ = child.kill();
                let _ = child.wait();
            });
            return (Err("GIT_CLEANUP_UNCERTAIN"), false);
        }
    };
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let (sender, receiver) = mpsc::sync_channel(1);
    let binding = request.clone();
    let worker = std::thread::Builder::new()
        .name("git-inventory-exchange".into())
        .spawn(move || {
            let read = || -> Result<Value, &'static str> {
                let mut input = stdin.ok_or("GIT_INTERRUPTED")?;
                serde_json::to_writer(&mut input, &binding).map_err(|_| "GIT_INTERRUPTED")?;
                input.write_all(b"\n").map_err(|_| "GIT_INTERRUPTED")?;
                drop(input);
                let mut bytes = Vec::new();
                BufReader::new(stdout.ok_or("GIT_INTERRUPTED")?)
                    .take((LIMIT + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "GIT_INTERRUPTED")?;
                if bytes.len() > LIMIT {
                    return Err("GIT_INVENTORY_LIMIT");
                }
                serde_json::from_slice(&bytes).map_err(|_| "GIT_OUTPUT_INVALID")
            };
            let _ = sender.send(read());
        });
    let result = if worker.is_ok() {
        receiver
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or(Err("GIT_TIMEOUT"))
    } else {
        Err("GIT_HELPER_UNAVAILABLE")
    };
    let stop = Instant::now();
    // Stop leftover descendants even after the helper returned its result.
    job.stop();
    let mut status = None;
    while stop.elapsed() < Duration::from_millis(900) {
        status = child.try_wait().ok().flatten().or(status);
        if let Some(exit) = status {
            if job.empty() {
                if let Ok(worker) = worker {
                    let _ = worker.join();
                }
                return (
                    if !exit.success() && result.is_ok() {
                        Err("GIT_INTERRUPTED")
                    } else {
                        result
                    },
                    true,
                );
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    (Err("GIT_CLEANUP_UNCERTAIN"), false)
}
#[cfg(not(windows))]
fn probe(_: &Path, _: &InventoryRequest) -> (Result<Value, &'static str>, bool) {
    (Err("GIT_PLATFORM_UNSUPPORTED"), true)
}

/// Headless verification of the same job-contained parent path; never starts a GUI.
pub(crate) fn probe_stdio(registry: &Path) -> i32 {
    let start = Instant::now();
    let mut bytes = Vec::new();
    let input = std::io::stdin();
    if input
        .lock()
        .take(4097)
        .read_until(b'\n', &mut bytes)
        .is_err()
        || bytes.len() > 4096
        || bytes.last() != Some(&b'\n')
    {
        return 2;
    }
    let request: InventoryRequest = match serde_json::from_slice(&bytes) {
        Ok(r) if valid(&r) => r,
        _ => return 2,
    };
    let (result, cleanup) = probe(registry, &request);
    let value = match result {
        Ok(value)
            if cleanup && value["code"] == "GIT_OBSERVED" && value["observation"].is_object() =>
        {
            envelope(
                &request,
                start,
                "GIT_OBSERVED",
                Some(value["observation"].clone()),
                true,
            )
        }
        Ok(value) => envelope(
            &request,
            start,
            value["code"].as_str().unwrap_or("GIT_OUTPUT_INVALID"),
            None,
            cleanup,
        ),
        Err(code) => envelope(&request, start, code, None, cleanup),
    };
    let output = std::io::stdout();
    let mut writer = output.lock();
    if serde_json::to_writer(&mut writer, &value).is_err()
        || writer.write_all(b"\n").is_err()
        || writer.flush().is_err()
    {
        return 2;
    }
    0
}

#[tauri::command]
pub async fn inspect_registered_git_inventory(
    app: tauri::AppHandle,
    request: InventoryRequest,
) -> Value {
    let started = Instant::now();
    if !valid(&request) {
        return envelope(&request, started, "GIT_REQUEST_INVALID", None, true);
    }
    if ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return envelope(&request, started, "GIT_BUSY", None, true);
    }
    let registry = match crate::workspace_census::app_registry_root(&app) {
        Ok(p) => p,
        Err(_) => {
            ACTIVE.store(false, Ordering::SeqCst);
            return envelope(&request, started, "GIT_REGISTRATION_INVALID", None, true);
        }
    };
    let binding = request.clone();
    let (result, cleanup) =
        tauri::async_runtime::spawn_blocking(move || probe(&registry, &binding))
            .await
            .unwrap_or((Err("GIT_CLEANUP_UNCERTAIN"), false));
    if cleanup {
        ACTIVE.store(false, Ordering::SeqCst);
    }
    match result {
        Ok(value)
            if cleanup && value["code"] == "GIT_OBSERVED" && value["observation"].is_object() =>
        {
            envelope(
                &request,
                started,
                "GIT_OBSERVED",
                Some(value["observation"].clone()),
                true,
            )
        }
        Ok(value) => envelope(
            &request,
            started,
            value["code"].as_str().unwrap_or("GIT_OUTPUT_INVALID"),
            None,
            cleanup,
        ),
        Err(code) => envelope(&request, started, code, None, cleanup),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn containment_fixture_helper() {
        use std::os::windows::process::CommandExt;
        let Ok(role) = std::env::var("PLANNER_JOB_TEST_ROLE") else {
            return;
        };
        let mut input = std::io::stdin();
        let mut byte = [0];
        if role == "parent" {
            // Wait for the test owner to establish containment first.
            input.read_exact(&mut byte).unwrap();
            let mut descendant = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "native_git::tests::containment_fixture_helper",
                    "--nocapture",
                ])
                .env_clear()
                .env("PLANNER_JOB_TEST_ROLE", "leaf")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .unwrap();
            let mut reader = std::io::BufReader::new(descendant.stdout.take().unwrap());
            let mut line = String::new();
            loop {
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line.contains("PLANNER_LEAF_READY") {
                    break;
                }
                line.clear();
            }
            println!("PLANNER_TREE_READY");
            std::io::stdout().flush().unwrap();
            // Both fixture processes deliberately remain alive until Job termination.
            let _ = input.read_exact(&mut byte);
            let _ = descendant.kill();
            let _ = descendant.wait();
        } else {
            assert_eq!(role, "leaf");
            println!("PLANNER_LEAF_READY");
            std::io::stdout().flush().unwrap();
            let _ = input.read_exact(&mut byte);
        }
    }
    #[cfg(windows)]
    #[test]
    fn job_termination_stops_a_live_helper_and_its_descendant() {
        use std::os::windows::process::CommandExt;
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_git::tests::containment_fixture_helper",
                "--nocapture",
            ])
            .env_clear()
            .env("PLANNER_JOB_TEST_ROLE", "parent")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let job = match containment::Job::new(&child) {
            Ok(job) => job,
            Err(()) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("fixture containment failed");
            }
        };
        let output = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in std::io::BufReader::new(output).lines() {
                if line.unwrap_or_default().contains("PLANNER_TREE_READY") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        child.stdin.as_mut().unwrap().write_all(b"1").unwrap();
        let ready = rx.recv_timeout(Duration::from_secs(5)).is_ok();
        let was_live = !job.empty();
        job.stop();
        let started = Instant::now();
        let mut reaped = false;
        while started.elapsed() < Duration::from_secs(3) {
            reaped = child.try_wait().unwrap().is_some();
            if reaped && job.empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready, "descendant never confirmed startup");
        assert!(was_live);
        assert!(
            reaped && job.empty(),
            "fixture process tree cleanup unconfirmed"
        );
        reader.join().unwrap();
    }
    #[test]
    fn metadata_parsers_keep_unverified_states_and_refuse_lossy_names() {
        let location = if cfg!(windows) {
            "C:/fixture"
        } else {
            "/fixture"
        };
        let sha = "a".repeat(40);
        let text = format!(
            "worktree {location}\0HEAD {sha}\0branch refs/heads/main\0locked private reason\0\0"
        );
        let rows = parse_worktrees(&text).unwrap();
        assert_eq!(rows[0]["locked"], true);
        assert_eq!(rows[0]["canAutomaticallyDelete"], false);
        assert!(!rows[0].to_string().contains("private reason"));
        assert!(parse_worktrees(&text.replace("main", "bad\u{fffd}")).is_err());
        assert!(parse_worktrees(text.trim_end_matches('\0')).is_err());
        assert!(parse_branches(&format!("refs/heads/bad\u{fffd}\0{sha}\n")).is_err());
        assert!(parse_branches(&format!("refs/heads/main\0{sha}\n")).is_ok());
    }
    #[test]
    fn request_schema_accepts_no_paths_or_commands() {
        let mut request = json!({"schemaVersion":1,"requestId":"request-1","projectId":"project-1","generation":0,"workspaceId":"repo-1","registryRevision":1,"rootIdentity":"a".repeat(64)});
        assert!(valid(&serde_json::from_value(request.clone()).unwrap()));
        request["command"] = json!("git");
        assert!(serde_json::from_value::<InventoryRequest>(request).is_err());
    }
}
