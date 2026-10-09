import { isTauriRuntime } from "../native/runtimeSnapshot.js";

// Thin client for the native keychain commands. The key goes in once and is
// never read back: the only answer the renderer ever receives is a status.
export const JEV_UNAVAILABLE = Object.freeze({ available: false, stored: false, store: "unavailable" });
// The desktop app is running, but this operating system's keychain is not wired yet (Windows only today).
export const JEV_UNSUPPORTED_OS = Object.freeze({ available: false, stored: false, store: "unsupported-os" });
const UNSUPPORTED_MESSAGE = "Saving the Jev key is not available yet on this operating system. It works on Windows today.";

function isWindowsHost(runtime = globalThis) {
  const nav = runtime.navigator ?? {};
  return /win/i.test(nav.userAgentData?.platform ?? nav.platform ?? "") || /Windows/.test(nav.userAgent ?? "");
}

async function resolveInvoke(invoke) {
  if (invoke) return invoke;
  if (!isTauriRuntime(globalThis)) return null;
  return (await import("@tauri-apps/api/core")).invoke;
}

function normalizeStatus(value) {
  return value && typeof value === "object"
    ? { available: value.available === true, stored: value.stored === true, store: String(value.store ?? "unknown") }
    : JEV_UNAVAILABLE;
}

function errorMessage(error) {
  return typeof error?.message === "string" ? error.message : typeof error === "string" ? error : "The keychain did not respond.";
}

export async function readJevKeyStatus({ invoke } = {}) {
  const call = await resolveInvoke(invoke);
  if (!call) return JEV_UNAVAILABLE;
  try {
    const status = normalizeStatus(await call("jev_key_status"));
    return status.available || isWindowsHost() ? status : { ...JEV_UNSUPPORTED_OS };
  } catch {
    // The command is only granted on Windows, so other systems land here.
    return isWindowsHost() ? { available: false, stored: false, store: "error" } : { ...JEV_UNSUPPORTED_OS };
  }
}

export async function saveJevKey(key, { invoke } = {}) {
  const call = await resolveInvoke(invoke);
  if (!call) return { ok: false, status: JEV_UNAVAILABLE, message: "The keychain is only available in the desktop app." };
  try {
    return { ok: true, status: normalizeStatus(await call("jev_key_save", { key })) };
  } catch (error) {
    const status = await readJevKeyStatus({ invoke: call });
    return { ok: false, status, message: status.store === "unsupported-os" ? UNSUPPORTED_MESSAGE : errorMessage(error) };
  }
}

export async function clearJevKey({ invoke } = {}) {
  const call = await resolveInvoke(invoke);
  if (!call) return { ok: false, status: JEV_UNAVAILABLE, message: "The keychain is only available in the desktop app." };
  try {
    return { ok: true, status: normalizeStatus(await call("jev_key_clear")) };
  } catch (error) {
    const status = await readJevKeyStatus({ invoke: call });
    return { ok: false, status, message: status.store === "unsupported-os" ? UNSUPPORTED_MESSAGE : errorMessage(error) };
  }
}
