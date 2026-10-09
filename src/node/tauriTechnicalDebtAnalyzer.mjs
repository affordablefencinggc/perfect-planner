import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { nativeCapabilities, nativeCommands, nativeInvokeHandlers, declaredNativeCommands, declaredNativeHandlers } from './tauriCommandContract.mjs';

const normalize = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
const requiredFiles = Object.freeze([
  "src/native/runtimeSnapshot.js",
  "src/native/workspaceCensus.js",
  "src/native/collisionAuthority.js",
  "src-tauri/build.rs",
  "src-tauri/Cargo.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/capabilities/main-read-only.json",
  "src-tauri/capabilities/main-collision-authority.json",
  "src-tauri/capabilities/main-bundled-mcp.json",
  "src-tauri/capabilities/main-git-inventory.json",
  "src-tauri/capabilities/main-native-drafts.json",
  "src-tauri/capabilities/main-agent-observation.json",
  "src-tauri/capabilities/main-check-setup.json",
  "src-tauri/capabilities/main-task-results.json",
  "src-tauri/capabilities/main-jev-keychain.json",
  "src-tauri/permissions/runtime-snapshot.json",
  "src-tauri/permissions/workspace-picker.json",
  "src-tauri/permissions/bundled-mcp.json",
  "src-tauri/permissions/git-inventory.json",
  "src-tauri/src/lib.rs",
  "src-tauri/src/collision_authority.rs",
  "src-tauri/src/main.rs",
  "src-tauri/src/native_mcp.rs",
  "src-tauri/src/native_git.rs",
  "src-tauri/src/jev_keychain.rs",
  "src-tauri/src/workspace_census.rs",
  "src-tauri/src/workspace_picker.rs",
  "src-tauri/tauri.conf.json",
]);

const within = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function exactArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function flattenCsp(csp) {
  return Object.values(csp ?? {}).flatMap((value) => Array.isArray(value) ? value : [value]).map(String);
}

export async function inspectTauriTechnicalDebtSurface(workspaceRoot, files) {
  const root = path.resolve(workspaceRoot);
  const selected = [...new Set((files ?? []).map(normalize))].sort();
  if (!selected.length) throw new Error("Tauri analyzer requires an exact non-empty file set.");
  if (selected.some((file) => path.isAbsolute(file) || file.startsWith("../") || !(file.startsWith("src-tauri/") || file.startsWith("src/native/")))) throw new Error("Tauri analyzer accepts only contained native-surface files.");
  const missing = requiredFiles.filter((file) => !selected.includes(file));
  if (missing.length) throw new Error(`Tauri analyzer is missing required security inputs: ${missing.join(", ")}.`);

  const contents = new Map();
  for (const file of selected) {
    const absolute = path.join(root, file);
    if (!within(root, absolute)) throw new Error(`Tauri analyzer path escapes the workspace: ${file}.`);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Tauri analyzer refuses non-regular input: ${file}.`);
    contents.set(file, await readFile(absolute, "utf8"));
  }

  const blockers = [];
  const parse = (file) => {
    try { return JSON.parse(contents.get(file)); }
    catch { blockers.push(`${file} is not valid JSON.`); return {}; }
  };
  const config = parse("src-tauri/tauri.conf.json");
  const capability = parse("src-tauri/capabilities/main-read-only.json");
  const collisionCapability = parse("src-tauri/capabilities/main-collision-authority.json");
  const mcpCapability = parse("src-tauri/capabilities/main-bundled-mcp.json");
  const gitCapability = parse("src-tauri/capabilities/main-git-inventory.json");
  const permission = parse("src-tauri/permissions/runtime-snapshot.json");
  const pickerPermission = parse("src-tauri/permissions/workspace-picker.json");
  const mcpPermission = parse("src-tauri/permissions/bundled-mcp.json");
  const gitPermission = parse("src-tauri/permissions/git-inventory.json");
  const security = config?.app?.security ?? {};
  const productionCsp = flattenCsp(security.csp);

  if (!exactArray(security.capabilities, nativeCapabilities)) blockers.push("Desktop security must activate only the ten reviewed native capabilities.");
  const addedPermissions = {
    'main-native-drafts': ['allow-inspect-native-draft-proposal', 'allow-read-native-draft-snapshot', 'allow-submit-native-draft-proposal'],
    'main-agent-observation': ['allow-inspect-agent-sessions', 'allow-read-agent-exchange-notes', 'allow-stop-project-agent-broker', 'allow-prepare-agent-pairing', 'allow-prepare-agent-plan-pairing', 'allow-prepare-agent-proposal-pairing'],
    'main-check-setup': ['allow-choose-native-check-setup', 'allow-prepare-native-checks', 'allow-inspect-native-checks', 'allow-review-native-checks', 'allow-recover-native-check-review', 'allow-execute-native-check', 'allow-recover-native-check-execution', 'allow-execute-native-task', 'allow-recover-native-task-execution'],
    'main-task-results': ['allow-inspect-native-task-result', 'allow-list-native-task-results', 'allow-read-native-task-result-page'],
    'main-core-launch': ['allow-take-core-launch'],
    'main-jev-keychain': ['allow-jev-key-status', 'allow-jev-key-save', 'allow-jev-key-clear'],
  };
  for (const identifier of nativeCapabilities) {
    const value = parse(`src-tauri/capabilities/${identifier}.json`);
    if (value.remote !== undefined || value.local === false || value.webviews !== undefined || !exactArray(value.windows, ['main']) || !exactArray(value.platforms, ['windows'])) blockers.push(`${identifier} expanded beyond the local main Windows window.`);
    if (addedPermissions[identifier] && (value.identifier !== identifier || !exactArray(value.permissions, addedPermissions[identifier]))) blockers.push(`${identifier} expanded beyond its exact reviewed command permissions.`);
  }
  if (security.freezePrototype !== true) blockers.push("Desktop prototype freezing must remain enabled.");
  if (security.assetProtocol?.enable !== false || !exactArray(security.assetProtocol?.scope, [])) blockers.push("Tauri asset protocol must remain disabled and unscoped.");
  if (!security.csp || productionCsp.some((value) => value === "*" || (/^https?:/i.test(value) && value !== "http://ipc.localhost") || /unsafe-eval/i.test(value))) blockers.push("Production CSP contains a remote, wildcard, or unsafe-eval source.");
  for (const directive of ["object-src", "base-uri", "form-action", "frame-src", "worker-src"]) if (!exactArray(security.csp?.[directive], ["'none'"])) blockers.push(`Production CSP ${directive} must be exactly 'none'.`);
  if (security.headers?.["X-Content-Type-Options"] !== "nosniff") blockers.push("Desktop nosniff header is missing.");
  for (const device of ["camera=()", "microphone=()", "geolocation=()", "usb=()", "payment=()"]) if (!String(security.headers?.["Permissions-Policy"] ?? "").includes(device)) blockers.push(`Desktop Permissions-Policy does not disable ${device}.`);

  if (capability.identifier !== "main-read-only" || !exactArray(capability.windows, ["main"]) || !exactArray(capability.platforms, ["windows"]) || !exactArray(capability.permissions, ["allow-runtime-snapshot", "allow-select-workspace-folder", "allow-register-workspace-read-only", "allow-census-registered-workspace", "allow-preview-registered-workspace"])) blockers.push("Main-window capability expanded beyond the five exact bounded intake commands.");
  if (collisionCapability.identifier !== "main-collision-authority" || !exactArray(collisionCapability.windows, ["main"]) || !exactArray(collisionCapability.platforms, ["windows"]) || !exactArray(collisionCapability.permissions, ["allow-collision-authority-inspect", "allow-collision-authority-approve", "allow-collision-authority-commit"])) blockers.push("Collision capability expanded beyond the three exact app-local journal commands.");
  if (mcpCapability.identifier !== "main-bundled-mcp" || !exactArray(mcpCapability.windows, ["main"]) || !exactArray(mcpCapability.platforms, ["windows"]) || !exactArray(mcpCapability.permissions, ["allow-check-bundled-mcp-connection"])) blockers.push("Bundled MCP capability expanded beyond the exact metadata-only connection check.");
  if (permission.identifier !== "allow-runtime-snapshot" || !exactArray(permission.commands?.allow, ["runtime_snapshot"]) || !exactArray(permission.commands?.deny, [])) blockers.push("Runtime permission must allow only runtime_snapshot.");
  if (pickerPermission.identifier !== "allow-select-workspace-folder" || !exactArray(pickerPermission.commands?.allow, ["select_workspace_folder"]) || !exactArray(pickerPermission.commands?.deny, [])) blockers.push("Workspace picker permission must allow only select_workspace_folder.");
  if (mcpPermission.identifier !== "allow-check-bundled-mcp-connection" || !exactArray(mcpPermission.commands?.allow, ["check_bundled_mcp_connection"]) || !exactArray(mcpPermission.commands?.deny, [])) blockers.push("Bundled MCP permission must allow only check_bundled_mcp_connection.");
  if (gitCapability.identifier !== "main-git-inventory" || !exactArray(gitCapability.windows, ["main"]) || !exactArray(gitCapability.platforms, ["windows"]) || !exactArray(gitCapability.permissions, ["allow-inspect-registered-git-inventory"])) blockers.push("Git inventory capability must remain an exact main-window Windows metadata command.");
  if (gitPermission.identifier !== "allow-inspect-registered-git-inventory" || !exactArray(gitPermission.commands?.allow, ["inspect_registered_git_inventory"]) || !exactArray(gitPermission.commands?.deny, [])) blockers.push("Git inventory permission must allow only inspect_registered_git_inventory.");

  const buildSource = contents.get("src-tauri/build.rs");
  const rustSource = contents.get("src-tauri/src/lib.rs");
  const censusSource = contents.get("src-tauri/src/workspace_census.rs");
  const pickerSource = contents.get("src-tauri/src/workspace_picker.rs");
  const collisionSource = contents.get("src-tauri/src/collision_authority.rs");
  const mcpSource = contents.get("src-tauri/src/native_mcp.rs");
  const gitSource = contents.get("src-tauri/src/native_git.rs").split("#[cfg(test)]")[0];
  const cargoManifest = contents.get("src-tauri/Cargo.toml");
  const keychainSource = contents.get("src-tauri/src/jev_keychain.rs").split("#[cfg(test)]")[0];
  // The Jev key goes in once and never comes back out: status-only replies, Credential Manager only.
  if (/std::fs::|std::process::|Command::new|reqwest::|tauri_plugin_|File::create|OpenOptions|CredentialBlob\s*\)|from_utf8|-> *Result<String|-> *String/.test(keychainSource) || !/CredWriteW/.test(keychainSource) || !/MAX_KEY_BYTES:\s*usize\s*=\s*512/.test(keychainSource)) blockers.push("Jev keychain must stay a bounded Credential Manager write/status/delete bridge that never returns the key.");
  const clientSource = contents.get("src/native/runtimeSnapshot.js");
  const censusClientSource = contents.get("src/native/workspaceCensus.js");
  const collisionClientSource = contents.get("src/native/collisionAuthority.js");
  if (!exactArray(declaredNativeCommands(buildSource), nativeCommands)) blockers.push("Tauri app manifest must name exactly the reviewed commands.");
  if (!exactArray(declaredNativeHandlers(rustSource), nativeInvokeHandlers)) blockers.push("Rust invoke handler must expose exactly the reviewed command handlers.");
  if (!/deny_unknown_fields/.test(rustSource) || !/RUNTIME_SCHEMA_VERSION:\s*u32\s*=\s*1/.test(rustSource)) blockers.push("Rust runtime request must reject unknown fields and bind schema version one.");
  if (!/deny_unknown_fields/.test(censusSource) || !/const SCHEMA_VERSION:\s*u32\s*=\s*1/.test(censusSource) || !/MAX_FILES_LIMIT:\s*u32\s*=\s*50_000/.test(censusSource) || !/MAX_FILE_BYTES_LIMIT:\s*u64\s*=\s*2_000_000/.test(censusSource) || !/MAX_TOTAL_BYTES:\s*u64\s*=\s*500_000_000/.test(censusSource)) blockers.push("Workspace census must bind exact request schemas and hard resource ceilings.");
  if (!/symlink_metadata/.test(censusSource) || !/canonicalize/.test(censusSource) || !/app_data_dir/.test(censusSource) || !/content_returned:\s*false/.test(censusSource)) blockers.push("Workspace census must remain app-registered, containment-aware, symlink-refusing, and metadata-only.");
  if (!/deny_unknown_fields/.test(pickerSource) || !/PICKER_SCHEMA_VERSION:\s*u32\s*=\s*1/.test(pickerSource) || !/AsyncFileDialog/.test(pickerSource) || !/pick_folder\(\)/.test(pickerSource)) blockers.push("Workspace picker must be an exact schema-one, user-driven directory selection dialog.");
  if (!/deny_unknown_fields/.test(collisionSource) || !/const SCHEMA_VERSION:\s*u32\s*=\s*1/.test(collisionSource) || !/MAX_LEDGER_ENTRIES:\s*usize\s*=\s*10_000/.test(collisionSource) || !/MAX_ENTRY_BYTES:\s*u64\s*=\s*128_000/.test(collisionSource) || !/try_lock_exclusive/.test(collisionSource) || !/create_new\(true\)/.test(collisionSource) || !/app_data_dir/.test(collisionSource) || !/explicit_user_approval/.test(collisionSource)) blockers.push("Collision journal must remain versioned, bounded, lock-serialized, append-only, app-local, and explicitly approved.");
  if (!/deny_unknown_fields/.test(mcpSource) || !/check_bundled_mcp_connection/.test(mcpSource) || !/app_registry_root/.test(mcpSource) || !/current_exe\(\)/.test(mcpSource) || !/Command::new\(executable\)/.test(mcpSource) || !/\.arg\("--planner-mcp-stdio"\)\s*\.arg\("--registry-root"\)\s*\.arg\(registry\)/.test(mcpSource) || !/env_clear\(\)/.test(mcpSource) || !/metadata_only:\s*true/.test(mcpSource) || !/execution_authorized:\s*false/.test(mcpSource) || !/computer_use:\s*false/.test(mcpSource)) blockers.push("Bundled MCP bridge must use only the same executable, fixed metadata helper arguments, app-derived registry, cleared environment, and non-execution receipt.");
  if ((mcpSource.match(/Command::new\(/g) ?? []).length !== 1 || /reqwest::|tauri_plugin_|\.arg\(&?request\.|\.args\(|\.env\(/i.test(mcpSource)) blockers.push("Bundled MCP bridge introduces caller-controlled or additional process, environment, network, or plugin authority.");
  if (!/deny_unknown_fields/.test(gitSource) || !/registered_git_root/.test(gitSource) || !/fixed_executable/.test(gitSource) || !/AssignProcessToJobObject/.test(gitSource) || !/TerminateJobObject/.test(gitSource) || !/QueryInformationJobObject/.test(gitSource) || !/env_clear\(\)/.test(gitSource) || !/recv_timeout/.test(gitSource) || !/GIT_CLEANUP_UNCERTAIN/.test(gitSource)) blockers.push("Git inventory must retain exact registration, fixed executable, job containment, cleared environment, deadline and cleanup-uncertainty checks.");
  if ((gitSource.match(/Command::new\(/g) ?? []).length !== 2 || /reqwest::|tauri_plugin_|\.arg\(&?request\.|fs::(?:write|rename|remove|create)|File::create|OpenOptions/i.test(gitSource)) blockers.push("Git inventory introduces undeclared process, network or filesystem mutation authority.");
  if (/std::fs::|std::process::|Command::new|reqwest::|tauri_plugin_/i.test(rustSource) || /Command::new|reqwest::|tauri_plugin_/i.test(censusSource) || /std::fs::|std::process::|Command::new|reqwest::|tauri_plugin_/i.test(pickerSource) || /tauri-plugin-/i.test(cargoManifest)) blockers.push("Native source or dependencies introduce undeclared privileged authority.");
  if (/std::process::|Command::new|reqwest::|tauri_plugin_|project.*(?:write|rename|remove)/i.test(collisionSource)) blockers.push("Collision journal introduces process, network, plugin, or project-filesystem mutation authority.");
  if (!/nativeInvoke\(\s*["'`]runtime_snapshot["'`]/.test(clientSource) || /\b(?:nativeInvoke|invoke)\s*\(\s*["'`](?!runtime_snapshot["'`])/.test(clientSource)) blockers.push("Client native bridge must invoke only runtime_snapshot.");
  if (!/nativeInvoke\(\s*["'`]select_workspace_folder["'`]/.test(censusClientSource) || !/nativeInvoke\(\s*["'`]register_workspace_read_only["'`]/.test(censusClientSource) || !/nativeInvoke\(\s*["'`]census_registered_workspace["'`]/.test(censusClientSource) || /\b(?:nativeInvoke|invoke)\s*\(\s*["'`](?!select_workspace_folder["'`]|register_workspace_read_only["'`]|census_registered_workspace["'`]|preview_registered_workspace["'`])/.test(censusClientSource)) blockers.push("Workspace bridge must invoke only folder selection, registration, and metadata census commands.");
  if (!/nativeInvoke\(\s*["'`]collision_authority_inspect["'`]/.test(collisionClientSource) || !/nativeInvoke\(\s*["'`]collision_authority_approve["'`]/.test(collisionClientSource) || !/nativeInvoke\(\s*["'`]collision_authority_commit["'`]/.test(collisionClientSource) || /\b(?:nativeInvoke|invoke)\s*\(\s*["'`](?!collision_authority_inspect["'`]|collision_authority_approve["'`]|collision_authority_commit["'`])/.test(collisionClientSource)) blockers.push("Collision bridge must invoke only the three app-local journal commands.");

  return Object.freeze({ passed: blockers.length === 0, blockers: Object.freeze(blockers), coveredFiles: Object.freeze(selected) });
}

export async function executeCargoClippy({ cargoPath, workspaceRoot, timeoutMs = 300_000, maxOutputBytes = 2_000_000 }) {
  if (!path.isAbsolute(cargoPath)) throw new Error("Cargo analyzer path must be absolute.");
  const args = ["clippy", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets", "--locked", "--", "-D", "warnings"];
  return new Promise((resolve, reject) => {
    let settled = false; let bytes = 0; const stdout = []; const stderr = [];
    const child = spawn(cargoPath, args, { cwd: workspaceRoot, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); finish(new Error("Tauri analyzer timed out.")); }, timeoutMs);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const collect = (target) => (chunk) => { bytes += chunk.length; if (bytes > maxOutputBytes) { child.kill(); finish(new Error("Tauri analyzer output exceeded its bound.")); return; } target.push(chunk); };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(error));
    child.once("exit", (exitCode, signal) => finish(null, { exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut: false, shell: false, args }));
  });
}

export async function runTauriTechnicalDebtAnalyzer({ workspaceRoot, files, cargoPath, execute = executeCargoClippy }) {
  const inspection = await inspectTauriTechnicalDebtSurface(workspaceRoot, files);
  if (!inspection.passed) return { passed: false, inspection, cargo: null };
  const cargo = await execute({ cargoPath, workspaceRoot });
  return { passed: cargo?.exitCode === 0 && !cargo?.signal && cargo?.timedOut !== true && cargo?.shell === false, inspection, cargo };
}



