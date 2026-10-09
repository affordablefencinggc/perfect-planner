// The Jev reviewer key lives only in the operating-system keychain (Windows
// Credential Manager). The renderer may store, clear, or ask whether a key is
// stored; no command ever returns the key itself.
use serde::Serialize;

const TARGET: &str = "PerfectPlanner/JevReviewerKey";
const MAX_KEY_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JevKeyStatus {
    pub available: bool,
    pub stored: bool,
    pub store: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JevKeyError {
    pub code: &'static str,
    pub message: String,
}

fn invalid(message: &str) -> JevKeyError {
    JevKeyError { code: "JEV_KEY_INVALID", message: message.to_string() }
}

pub fn validate_key(key: &str) -> Result<&str, JevKeyError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(invalid("Enter a key before saving."));
    }
    if trimmed.len() > MAX_KEY_BYTES {
        return Err(invalid("That key is longer than 512 characters."));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(invalid("The key contains control characters."));
    }
    Ok(trimmed)
}

#[cfg(windows)]
mod store {
    use super::{JevKeyError, JevKeyStatus, TARGET};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn failure(message: &str) -> JevKeyError {
        JevKeyError { code: "JEV_KEYCHAIN_FAILED", message: format!("{message} (Windows error {})", std::io::Error::last_os_error().raw_os_error().unwrap_or(0)) }
    }

    pub fn status() -> JevKeyStatus {
        let target = wide(TARGET);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: target is NUL-terminated; on success the buffer is released with CredFree and its blob is never read.
        let found = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } != 0;
        if found && !credential.is_null() {
            unsafe { CredFree(credential as *const core::ffi::c_void) };
        }
        JevKeyStatus { available: true, stored: found, store: "windows-credential-manager" }
    }

    pub fn save(key: &str) -> Result<JevKeyStatus, JevKeyError> {
        let mut target = wide(TARGET);
        let mut user = wide("jev");
        let mut blob = key.as_bytes().to_vec();
        // SAFETY: an all-zero CREDENTIALW is a valid empty value; every pointer set below outlives the call.
        let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = target.as_mut_ptr();
        credential.UserName = user.as_mut_ptr();
        credential.CredentialBlobSize = blob.len() as u32;
        credential.CredentialBlob = blob.as_mut_ptr();
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        let ok = unsafe { CredWriteW(&credential, 0) } != 0;
        blob.iter_mut().for_each(|byte| *byte = 0);
        if !ok {
            return Err(failure("Windows Credential Manager did not accept the key"));
        }
        Ok(status())
    }

    pub fn clear() -> Result<JevKeyStatus, JevKeyError> {
        let target = wide(TARGET);
        // SAFETY: target is NUL-terminated.
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0;
        let current = status();
        if !ok && current.stored {
            return Err(failure("Windows Credential Manager did not remove the key"));
        }
        Ok(current)
    }
}

#[cfg(not(windows))]
mod store {
    use super::{JevKeyError, JevKeyStatus};

    fn unavailable() -> JevKeyError {
        JevKeyError { code: "JEV_KEYCHAIN_UNAVAILABLE", message: "The keychain is only connected in the Windows desktop app.".to_string() }
    }

    pub fn status() -> JevKeyStatus {
        JevKeyStatus { available: false, stored: false, store: "unavailable" }
    }

    pub fn save(_key: &str) -> Result<JevKeyStatus, JevKeyError> {
        Err(unavailable())
    }

    pub fn clear() -> Result<JevKeyStatus, JevKeyError> {
        Err(unavailable())
    }
}

#[tauri::command]
pub fn jev_key_status() -> JevKeyStatus {
    store::status()
}

#[tauri::command]
pub fn jev_key_save(key: String) -> Result<JevKeyStatus, JevKeyError> {
    let key = validate_key(&key)?;
    store::save(key)
}

#[tauri::command]
pub fn jev_key_clear() -> Result<JevKeyStatus, JevKeyError> {
    store::clear()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_oversized_and_control_keys() {
        assert_eq!(validate_key("   ").unwrap_err().code, "JEV_KEY_INVALID");
        assert_eq!(validate_key(&"k".repeat(513)).unwrap_err().code, "JEV_KEY_INVALID");
        assert_eq!(validate_key("abc\ndef").unwrap_err().code, "JEV_KEY_INVALID");
        assert_eq!(validate_key("  sk-abc  ").unwrap(), "sk-abc");
    }

    #[test]
    fn status_never_carries_the_key() {
        let json = serde_json::to_string(&jev_key_status()).unwrap();
        assert!(json.contains("\"available\"") && json.contains("\"stored\""));
        assert!(!json.contains("key\""));
    }
}
