import { isTauriRuntime } from "../native/runtimeSnapshot.js";

// Thin client for the native keychain commands. The key goes in once and is
// never read back: the only answer the renderer ever receives is a status.
export const JEV_UNAVAILABLE = Object.freeze({ available: false, stored: false, store: "unavailable" });

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
    return normalizeStatus(await call("jev_key_status"));
  } catch {
    return JEV_UNAVAILABLE;
  }
}

export async function saveJevKey(key, { invoke } = {}) {
  const call = await resolveInvoke(invoke);
  if (!call) return { ok: false, status: JEV_UNAVAILABLE, message: "The keychain is only available in the desktop app." };
  try {
    return { ok: true, status: normalizeStatus(await call("jev_key_save", { key })) };
  } catch (error) {
    return { ok: false, status: await readJevKeyStatus({ invoke: call }), message: errorMessage(error) };
  }
}

export async function clearJevKey({ invoke } = {}) {
  const call = await resolveInvoke(invoke);
  if (!call) return { ok: false, status: JEV_UNAVAILABLE, message: "The keychain is only available in the desktop app." };
  try {
    return { ok: true, status: normalizeStatus(await call("jev_key_clear")) };
  } catch (error) {
    return { ok: false, status: await readJevKeyStatus({ invoke: call }), message: errorMessage(error) };
  }
}
