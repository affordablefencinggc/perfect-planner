//! The desktop app's local service: the core host (Tasks, Connect agent and the
//! agents' MCP bridge) and the built client, served on loopback by the Node runtime
//! the installer ships (resources/desktop-host, built into dist/desktop-host by scripts/build-desktop-host.mjs).
//!
//! The shell starts it when the app opens and stops it when the app quits (it also
//! stops by itself when its stdin closes, so a crashed shell leaves nothing behind).
//! The service answers on its private stdout with one JSON line holding its origin
//! and the window link, which may carry the core host's one-time launch secret in
//! the fragment. The shell navigates the main window there; the secret never
//! reaches a terminal, a log or the clipboard. The window may only ever show the
//! splash page or that one origin.
//!
//! Native commands stay bound to the app's own origin (the capabilities are local
//! only), so on the service's page the client runs in its browser mode, as it does
//! under npm start.
use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{App, AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder};

const READY_TIMEOUT: Duration = Duration::from_secs(90);
const STOP_GRACE: Duration = Duration::from_secs(5);
const LOG_FILE: &str = "desktop-host.log";

/// What the shell keeps about the running service.
#[derive(Default)]
pub(crate) struct CoreHostState {
    child: Mutex<Option<Child>>,
    origin: Arc<Mutex<Option<String>>>,
    quitting: Arc<Mutex<bool>>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum ServiceLine {
    Ready { origin: String, open: Url },
    Failed(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLine {
    event: String,
    origin: Option<String>,
    open: Option<String>,
    message: Option<String>,
}

/// The service's one stdout line. Only a loopback http origin, and a window link on
/// that same origin at the app's root, are accepted.
pub(crate) fn parse_service_line(line: &str) -> Result<ServiceLine, String> {
    let raw: RawLine = serde_json::from_str(line.trim()).map_err(|_| "The local service sent an unreadable start line.".to_string())?;
    match raw.event.as_str() {
        "failed" => Ok(ServiceLine::Failed(raw.message.unwrap_or_else(|| "The local service could not start.".into()))),
        "ready" => {
            let origin = raw.origin.ok_or("The local service did not say where it is.")?;
            let parsed = Url::parse(&origin).map_err(|_| "The local service named an invalid address.".to_string())?;
            if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") || parsed.port().is_none() || parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() || origin.ends_with('/') {
                return Err("The local service is not on this computer's loopback address.".into());
            }
            let open = Url::parse(raw.open.as_deref().ok_or("The local service gave no window link.")?).map_err(|_| "The local service gave an invalid window link.".to_string())?;
            if open.origin() != parsed.origin() || open.path() != "/" || open.query().is_some() {
                return Err("The window link does not point at the local service.".into());
            }
            Ok(ServiceLine::Ready { origin, open })
        }
        _ => Err("The local service sent an unexpected start line.".into()),
    }
}

/// Where the main window may go: the splash page shipped inside the app, the local
/// service once it is up, and (in `tauri dev`) the dev server. Anything else is refused.
pub(crate) fn navigation_allowed(url: &Url, service_origin: Option<&str>, dev_origin: Option<&str>) -> bool {
    let app_page = matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http", Some("tauri.localhost")) | ("https", Some("tauri.localhost")));
    if app_page {
        return true;
    }
    let origin = url.origin().ascii_serialization();
    service_origin.is_some_and(|o| o == origin) || dev_origin.is_some_and(|o| o == origin)
}

/// `#error=...` for the splash page; it reads the message as text.
pub(crate) fn error_fragment(message: &str, node_missing: bool) -> String {
    let mut out = String::from("error=");
    for byte in message.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    if node_missing {
        out.push_str("&node=missing");
    }
    out
}

#[derive(Debug)]
pub(crate) struct Runtime {
    pub node: PathBuf,
    pub entry: PathBuf,
}

const NODE_BINARY: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Tauri's own WebView2 switches (wry's defaults, which any explicit list replaces).
const WEBVIEW2_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// WebView2's documented WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, honoured on top of Tauri's switches:
/// wry always passes its own list, which otherwise silently drops the variable (the release smoke
/// test opens DevTools with it). Only on Windows; whoever sets it for the app already runs as the user.
fn webview2_browser_args(extra: Option<&str>) -> Option<String> {
    let extra = extra.map(str::trim).filter(|e| !e.is_empty())?;
    cfg!(windows).then(|| format!("{WEBVIEW2_DEFAULT_ARGS} {extra}"))
}

/// Windows hands out the resource folder in verbatim form (`\\?\C:\...`). Node then sees a script
/// path that is not the file URL it loaded, so desktop.mjs never starts, and the same prefix would
/// land in the connect line. Plain drive and UNC forms are used everywhere instead.
pub(crate) fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// The service runs only on the Node the installer shipped, from the app's own read-only
/// resources: never a copy in a user-writable folder and never whatever `node` is on PATH.
fn locate_runtime(resources: &Path) -> Result<Runtime, String> {
    let base = plain_path(resources).join("desktop-host");
    let entry = base.join("core-host").join("desktop.mjs");
    let node = base.join(NODE_BINARY);
    if !entry.is_file() || !std::fs::metadata(&node).map(|m| m.is_file() && m.len() > 0).unwrap_or(false) {
        return Err(format!("This copy of Perfect Planner is missing its local service or its Node runtime ({}). Reinstall the app.", base.display()));
    }
    if !is_executable(&node) {
        return Err(format!("This copy of Perfect Planner was installed without permission to run its Node runtime ({}). Reinstall the app.", node.display()));
    }
    Ok(Runtime { node, entry })
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    true
}

fn log_file(app: &AppHandle) -> Option<(PathBuf, std::fs::File)> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(LOG_FILE);
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()?;
    Some((path, file))
}

/**
 * The service's environment: nothing from the person's shell setup may load code into it, and
 * PP_DATA_DIR is Tauri's app_data_dir on every platform, the same folder the native commands use,
 * so the ledgers, owner pins and agent token files never split across two data folders.
 */
pub(crate) fn service_env(runtime_node: &Path, data_dir: &Path) -> Vec<(&'static str, Option<std::ffi::OsString>)> {
    let mut env: Vec<(&'static str, Option<std::ffi::OsString>)> = ["NODE_OPTIONS", "NODE_PATH", "PP_PORT", "PP_CLIENT_DIR", "PP_CORE_PROJECT_ROOT", "PP_CORE_KEYS"].into_iter().map(|k| (k, None)).collect();
    env.push(("PP_NODE_BINARY", Some(runtime_node.as_os_str().to_owned())));
    env.push(("PP_DATA_DIR", Some(data_dir.as_os_str().to_owned())));
    env
}

fn spawn_service(runtime: &Runtime, data_dir: &Path, log: Option<std::fs::File>) -> std::io::Result<Child> {
    let mut command = Command::new(&runtime.node);
    command
        .arg(&runtime.entry)
        .current_dir(runtime.entry.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log.map(Stdio::from).unwrap_or_else(Stdio::null));
    for (key, value) in service_env(&runtime.node, data_dir) {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

fn show_error(window: &WebviewWindow, splash: &Url, message: &str, node_missing: bool, log: Option<&Path>) {
    let full = match log {
        Some(path) => format!("{message} (Log: {})", path.display()),
        None => message.to_string(),
    };
    let mut url = splash.clone();
    url.set_fragment(Some(&error_fragment(&full, node_missing)));
    let _ = window.navigate(url);
}

/// Builds the main window (with its navigation guard) and starts the service.
pub(crate) fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let state = CoreHostState::default();
    let service_origin = state.origin.clone();
    let dev_origin = if cfg!(dev) { app.config().build.dev_url.as_ref().map(|u| u.origin().ascii_serialization()) } else { None };
    let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("The main window is not configured.")?;
    let guard_origin = service_origin.clone();
    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?.on_navigation(move |url| {
        let current = guard_origin.lock().ok().and_then(|o| o.clone());
        navigation_allowed(url, current.as_deref(), dev_origin.as_deref())
    });
    if let Some(args) = webview2_browser_args(std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok().as_deref()) {
        builder = builder.additional_browser_args(&args);
    }
    let window = builder.build()?;
    app.manage(state);
    // `tauri dev` serves the core host from the Vite dev server (src/node/coreHostVitePlugin.mjs).
    if cfg!(dev) {
        return Ok(());
    }
    let splash = window.url()?;
    let handle = app.handle().clone();
    std::thread::spawn(move || start(handle, window, splash));
    Ok(())
}

fn start(app: AppHandle, window: WebviewWindow, splash: Url) {
    let logged = log_file(&app);
    let log_path = logged.as_ref().map(|(p, _)| p.clone());
    let fail = {
        let (window, log_path) = (window.clone(), log_path.clone());
        move |message: &str, node_missing: bool| {
            // The log says why too, so a window nobody is looking at (or a bug report) still has the reason.
            if let Some(mut file) = log_path.as_ref().and_then(|p| std::fs::OpenOptions::new().append(true).open(p).ok()) {
                let _ = writeln!(file, "--- {message}");
            }
            show_error(&window, &splash, message, node_missing, log_path.as_deref())
        }
    };
    let (Ok(resources), Ok(data_dir)) = (app.path().resource_dir(), app.path().app_data_dir().map(|d| plain_path(&d))) else {
        return fail("Perfect Planner could not find its own folders.", false);
    };
    let runtime = match locate_runtime(&resources) {
        Ok(runtime) => runtime,
        Err(message) => return fail(&message, false),
    };
    let log = logged.and_then(|(_, file)| file.try_clone().ok().map(|mut f| {
        let _ = writeln!(f, "--- Perfect Planner {} starting {} with {}", env!("CARGO_PKG_VERSION"), runtime.entry.display(), runtime.node.display());
        f
    }));
    let mut child = match spawn_service(&runtime, &data_dir, log) {
        Ok(child) => child,
        Err(error) => return fail(&format!("Perfect Planner could not start its local service: {error}."), false),
    };
    let Some(stdout) = child.stdout.take() else { return fail("The local service has no output channel.", false) };
    let state = app.state::<CoreHostState>();
    if let Ok(mut slot) = state.child.lock() {
        *slot = Some(child);
    }
    let quitting = state.quitting.clone();
    let origin_slot = state.origin.clone();

    // First line within READY_TIMEOUT; the rest is drained so the service never blocks on a full pipe.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first = String::new();
        let read = reader.read_line(&mut first);
        let _ = tx.send(read.map(|_| first));
        let mut sink = [0u8; 4096];
        while matches!(reader.read(&mut sink), Ok(n) if n > 0) {}
    });
    let line = match rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(line)) if !line.is_empty() => line,
        Ok(_) => return fail("The local service stopped before it was ready.", false),
        Err(_) => return fail("The local service did not start in time.", false),
    };
    match parse_service_line(&line) {
        Ok(ServiceLine::Ready { origin, open }) => {
            if let Ok(mut slot) = origin_slot.lock() {
                *slot = Some(origin);
            }
            if window.navigate(open).is_err() {
                fail("Perfect Planner could not open its window on the local service.", false);
            }
        }
        Ok(ServiceLine::Failed(message)) => return fail(&message, false),
        Err(message) => return fail(&message, false),
    }
    // If the service dies while the app is open, say so instead of showing a dead page.
    let watcher = app.clone();
    let fail = fail.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        if quitting.lock().map(|q| *q).unwrap_or(true) {
            return;
        }
        let state = watcher.state::<CoreHostState>();
        let exited = state.child.lock().ok().and_then(|mut c| c.as_mut().map(|c| c.try_wait().ok().flatten().is_some())).unwrap_or(true);
        if exited {
            if let Ok(mut slot) = origin_slot.lock() {
                *slot = None;
            }
            fail("The local service stopped. Close and reopen Perfect Planner to start it again.", false);
            return;
        }
    });
}

/// Stops the service when the app quits: closing stdin asks it to stop, then it is killed.
pub(crate) fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<CoreHostState>() else { return };
    if let Ok(mut quitting) = state.quitting.lock() {
        *quitting = true;
    }
    let Some(mut child) = state.child.lock().ok().and_then(|mut c| c.take()) else { return };
    drop(child.stdin.take());
    let deadline = std::time::Instant::now() + STOP_GRACE;
    while std::time::Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    #[test]
    fn webview2_args_keep_tauris_switches_and_add_the_documented_variable() {
        assert_eq!(super::webview2_browser_args(None), None);
        assert_eq!(super::webview2_browser_args(Some("  ")), None);
        let args = super::webview2_browser_args(Some("--remote-debugging-port=9333"));
        if cfg!(windows) {
            assert_eq!(args.as_deref(), Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9333"));
        } else {
            assert_eq!(args, None);
        }
    }

    #[test]
    fn plain_paths_drop_the_windows_verbatim_prefix() {
        use std::path::Path;
        assert_eq!(super::plain_path(Path::new(r"\\?\C:\PP Smoke\Perfect Planner")), Path::new(r"C:\PP Smoke\Perfect Planner"));
        assert_eq!(super::plain_path(Path::new(r"\\?\UNC\server\share\pp")), Path::new(r"\\server\share\pp"));
        assert_eq!(super::plain_path(Path::new(r"\\?\Volume{x}\pp")), Path::new(r"\\?\Volume{x}\pp"));
        assert_eq!(super::plain_path(Path::new("/opt/Perfect Planner")), Path::new("/opt/Perfect Planner"));
    }

    use super::*;

    #[test]
    fn accepts_only_a_loopback_ready_line_whose_link_is_on_the_same_origin() {
        let ok = parse_service_line(r#"{"event":"ready","origin":"http://127.0.0.1:41730","open":"http://127.0.0.1:41730/#pp-launch=abcdefghijklmnopqrstuvwxyz"}"#).unwrap();
        assert_eq!(ok, ServiceLine::Ready { origin: "http://127.0.0.1:41730".into(), open: Url::parse("http://127.0.0.1:41730/#pp-launch=abcdefghijklmnopqrstuvwxyz").unwrap() });
        for bad in [
            r#"{"event":"ready","origin":"http://192.168.1.5:41730","open":"http://192.168.1.5:41730/"}"#,
            r#"{"event":"ready","origin":"https://127.0.0.1:41730","open":"https://127.0.0.1:41730/"}"#,
            r#"{"event":"ready","origin":"http://localhost:41730","open":"http://localhost:41730/"}"#,
            r#"{"event":"ready","origin":"http://127.0.0.1","open":"http://127.0.0.1/"}"#,
            r#"{"event":"ready","origin":"http://127.0.0.1:41730/x","open":"http://127.0.0.1:41730/"}"#,
            r#"{"event":"ready","origin":"http://127.0.0.1:41730","open":"http://127.0.0.1:41731/"}"#,
            r#"{"event":"ready","origin":"http://127.0.0.1:41730","open":"https://example.com/"}"#,
            r#"{"event":"ready","origin":"http://127.0.0.1:41730","open":"http://127.0.0.1:41730/other"}"#,
            r#"{"event":"ready","origin":"http://127.0.0.1:41730"}"#,
            r#"{"event":"ready","origin":"http://127.0.0.1:41730","open":"http://127.0.0.1:41730/","extra":1}"#,
            r#"{"event":"open"}"#,
            "not json",
        ] {
            assert!(parse_service_line(bad).is_err(), "{bad}");
        }
        assert_eq!(parse_service_line(r#"{"event":"failed","message":"port in use"}"#).unwrap(), ServiceLine::Failed("port in use".into()));
    }

    #[test]
    fn the_window_may_show_only_the_splash_and_the_local_service() {
        let service = Some("http://127.0.0.1:41730");
        for ok in ["tauri://localhost/index.html", "http://tauri.localhost/index.html#error=x", "http://127.0.0.1:41730/tasks", "http://127.0.0.1:41730/#pp-launch=abc"] {
            assert!(navigation_allowed(&Url::parse(ok).unwrap(), service, None), "{ok}");
        }
        for bad in ["http://127.0.0.1:41731/", "http://localhost:41730/", "https://example.com/", "file:///etc/passwd", "http://evil.localhost/"] {
            assert!(!navigation_allowed(&Url::parse(bad).unwrap(), service, None), "{bad}");
        }
        assert!(!navigation_allowed(&Url::parse("http://127.0.0.1:41730/").unwrap(), None, None), "nothing but the splash before the service is up");
        assert!(navigation_allowed(&Url::parse("http://127.0.0.1:4173/").unwrap(), None, Some("http://127.0.0.1:4173")));
    }

    #[test]
    fn error_fragment_is_url_safe_and_flags_a_missing_node() {
        assert_eq!(error_fragment("No Node 20+ (here: v18)", true), "error=No%20Node%2020%2B%20%28here%3A%20v18%29&node=missing");
        assert_eq!(error_fragment("a&b#c", false), "error=a%26b%23c");
    }

    #[test]
    fn the_service_gets_the_app_data_folder_and_a_clean_node_environment() {
        let data = Path::new("/home/u/.local/share/com.perfectplanner.desktop");
        let env = service_env(Path::new("/opt/pp/desktop-host/node"), data);
        let get = |k: &str| env.iter().find(|(key, _)| *key == k).map(|(_, v)| v.clone());
        assert_eq!(get("PP_DATA_DIR"), Some(Some(data.as_os_str().to_owned())));
        assert_eq!(get("PP_NODE_BINARY"), Some(Some("/opt/pp/desktop-host/node".into())));
        for removed in ["NODE_OPTIONS", "NODE_PATH", "PP_CORE_KEYS", "PP_CORE_PROJECT_ROOT"] {
            assert_eq!(get(removed), Some(None), "{removed}");
        }
    }

    #[test]
    fn a_bundle_without_its_service_is_reported_as_broken() {
        let dir = std::env::temp_dir().join(format!("pp-core-host-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        assert!(locate_runtime(&dir).unwrap_err().contains("Reinstall"));
        // A runtime without its execute permission is refused, never copied somewhere writable.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let host = dir.join("desktop-host");
            std::fs::create_dir_all(host.join("core-host")).unwrap();
            std::fs::write(host.join("core-host").join("desktop.mjs"), "").unwrap();
            std::fs::write(host.join("node"), "binary").unwrap();
            std::fs::set_permissions(host.join("node"), std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(locate_runtime(&dir).unwrap_err().contains("without permission"));
            std::fs::set_permissions(host.join("node"), std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(locate_runtime(&dir).unwrap().node, host.join("node"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
