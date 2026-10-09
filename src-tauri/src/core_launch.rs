// The one-time launch secret for the core host (core/host/session.ts). The process that
// starts this shell generates it, gives the same value to the core host, and passes it here
// in PP_CORE_DESKTOP_LAUNCH. It is read once at startup and removed from this process's
// environment, then handed to the main window exactly once over IPC, never over HTTP.
use std::sync::Mutex;

pub const LAUNCH_ENV: &str = "PP_CORE_DESKTOP_LAUNCH";

#[derive(Default)]
pub struct CoreLaunch(Mutex<Option<String>>);

impl CoreLaunch {
    pub fn from_env() -> Self {
        let secret = std::env::var(LAUNCH_ENV).ok().filter(|value| valid(value));
        std::env::remove_var(LAUNCH_ENV);
        Self(Mutex::new(secret))
    }

    /// The secret, the first time only; None afterwards or when none was given.
    pub fn take(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut slot| slot.take())
    }
}

/// Base64url, as PersonSessions.issueLaunch makes it (at least 20 characters, at most 128).
fn valid(value: &str) -> bool {
    (20..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[tauri::command]
pub fn take_core_launch(launch: tauri::State<'_, CoreLaunch>) -> Option<String> {
    launch.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_the_secret_out_once() {
        let launch = CoreLaunch(Mutex::new(Some("a".repeat(43))));
        assert_eq!(launch.take().as_deref(), Some("a".repeat(43).as_str()));
        assert_eq!(launch.take(), None);
    }

    #[test]
    fn refuses_malformed_secrets() {
        assert!(valid(&"A-z_9".repeat(5)));
        assert!(!valid("short"));
        assert!(!valid(&"a".repeat(129)));
        assert!(!valid(&format!("{}#x", "a".repeat(30))));
    }
}
