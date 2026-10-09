// Scripted folder intake for tests and automation (dev server or a build made with PP_TEST_INTAKE=1 only).
//
// The browser's folder picker is a native dialog that automation cannot click. This module lets a test
// queue a folder (as a JSON manifest built by scripts/folder-manifest.mjs) and then press the real
// "Choose app folder" and "Approve read-only analysis" buttons. The queued folder is answered from
// window.showDirectoryPicker, so registration, the census walk, progress, .gitignore handling, size
// budgets, hashing and discovery all run through the same code as a real pick. Nothing is pre-built.
//
// Manifest shape: { kind: "directory", name, children: [ { kind: "file", name, lastModified?, contentBase64 }
//   | { kind: "file", name, size, lastModified?, unreadable: true } | { kind: "directory", name, children } ] }

export const SCRIPTED_INTAKE_GLOBAL = "__ppTestIntake";

function decodeBase64(value) {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new Uint8Array(globalThis.Buffer.from(value, "base64"));
}

function validName(name) {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function permission() {
  return {
    async queryPermission() { return "granted"; },
    async requestPermission() { return "granted"; },
  };
}

function fileHandle(entry) {
  if (!validName(entry.name)) throw new TypeError(`Invalid file name in folder manifest: ${String(entry.name)}`);
  const lastModified = Number.isSafeInteger(entry.lastModified) ? entry.lastModified : 0;
  let bytes = null;
  const content = () => (bytes ??= decodeBase64(String(entry.contentBase64 ?? "")));
  const handle = {
    kind: "file",
    name: entry.name,
    ...permission(),
    async isSameEntry(other) { return other === handle; },
    async getFile() {
      if (entry.unreadable) {
        const size = Number.isSafeInteger(entry.size) ? entry.size : 0;
        return { name: entry.name, size, lastModified, async arrayBuffer() { const error = new Error("File content was not included in the folder manifest."); error.name = "NotReadableError"; throw error; } };
      }
      const data = content();
      return { name: entry.name, size: data.byteLength, lastModified, async arrayBuffer() { return data.slice().buffer; } };
    },
  };
  return handle;
}

export function createFolderHandleFromManifest(manifest) {
  if (!manifest || manifest.kind !== "directory" || !validName(manifest.name) || !Array.isArray(manifest.children))
    throw new TypeError("A folder manifest must be a directory with a name and children.");
  const children = manifest.children.map((child) => [child.name, child.kind === "directory" ? createFolderHandleFromManifest(child) : fileHandle(child)]);
  const names = new Set();
  for (const [name] of children) {
    if (names.has(name)) throw new TypeError(`Duplicate entry in folder manifest: ${name}`);
    names.add(name);
  }
  const handle = {
    kind: "directory",
    name: manifest.name,
    ...permission(),
    async isSameEntry(other) { return other === handle; },
    async *entries() { for (const entry of children) yield entry; },
    async *values() { for (const [, value] of children) yield value; },
    async *keys() { for (const [name] of children) yield name; },
  };
  return handle;
}

// Answers the next showDirectoryPicker call with a queued folder; with nothing queued it falls back to the
// real picker (or reports a cancelled pick when there is none). Returns the control object, or null when
// scripted intake is not enabled.
export function installScriptedIntake(runtime, { enabled = false } = {}) {
  if (enabled !== true || !runtime) return null;
  if (runtime[SCRIPTED_INTAKE_GLOBAL]) return runtime[SCRIPTED_INTAKE_GLOBAL];
  const queue = [];
  const nativePicker = typeof runtime.showDirectoryPicker === "function" ? runtime.showDirectoryPicker.bind(runtime) : null;
  runtime.showDirectoryPicker = async (options) => {
    if (queue.length) return queue.shift();
    if (nativePicker) return nativePicker(options);
    const error = new Error("No folder was queued for scripted intake.");
    error.name = "AbortError";
    throw error;
  };
  const control = Object.freeze({
    queueFolder(manifest) {
      const handle = createFolderHandleFromManifest(manifest);
      queue.push(handle);
      return { name: handle.name, queued: queue.length };
    },
    pending() { return queue.length; },
    clear() { queue.length = 0; },
  });
  Object.defineProperty(runtime, SCRIPTED_INTAKE_GLOBAL, { value: control, configurable: true });
  return control;
}
