const GENERIC_STEMS = new Set(["audit", "audits", "common", "component", "data", "helper", "helpers", "index", "manager", "misc", "module", "service", "shared", "tracker", "tracking", "util", "utils"]);
const CONVENTION_FILES = new Map([
  ["index.html", "vite-root-entrypoint"],
  ["package.json", "npm-package-manifest"],
  ["package-lock.json", "npm-package-lockfile"],
  ["vite.config.mjs", "vite-configuration"],
  ["worker/index.js", "sites-worker-entrypoint"],
  ["src/main.jsx", "vite-react-entrypoint"],
  ["src-tauri/build.rs", "tauri-build-script"],
  ["src-tauri/cargo.toml", "cargo-package-manifest"],
  ["src-tauri/cargo.lock", "cargo-package-lockfile"],
  ["src-tauri/capabilities/main-read-only.json", "tauri-main-read-only-capability"],
  ["src-tauri/src/lib.rs", "tauri-library-entrypoint"],
  ["src-tauri/src/main.rs", "tauri-binary-entrypoint"],
]);
const text = (value) => Boolean(String(value ?? "").trim());
const normalizePath = (value) => String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
const pathStem = (value) => normalizePath(value).split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
export const namingTokens = (value) => String(value ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((token) => token.replace(/s$/, ""));
const subset = (left, right) => left.every((token) => right.includes(token));

export function assessNamingGuardrails(input) {
  const blockers = []; const inventory = Array.isArray(input?.inventory) ? input.inventory : []; const components = Array.isArray(input?.components) ? input.components : []; const labels = new Set(); const inventoryTokenSets = [];
  for (const [index, item] of inventory.entries()) { const prefix = `inventory[${index}]`; const labelTokens = namingTokens(item?.scopeLabel); const nameTokens = namingTokens(item?.name); if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(item?.scopeLabel ?? "")) blockers.push(`${prefix}.scopeLabel must be a distinctive multi-token kebab-case name.`); else if (labels.has(item.scopeLabel)) blockers.push(`Duplicate component scope label ${item.scopeLabel}.`); labels.add(item?.scopeLabel); if (nameTokens.length < 2 || (nameTokens.length === 1 && GENERIC_STEMS.has(nameTokens[0]))) blockers.push(`${prefix}.name is too vague to distinguish safely.`); if (!text(item?.definition) || !text(item?.notThis)) blockers.push(`${prefix} requires positive definition and notThis boundary.`); inventoryTokenSets.push({ id: item?.id, name: item?.name, tokens: nameTokens, labelTokens }); }
  for (let leftIndex = 0; leftIndex < inventoryTokenSets.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < inventoryTokenSets.length; rightIndex += 1) { const left = inventoryTokenSets[leftIndex]; const right = inventoryTokenSets[rightIndex]; if ((subset(left.tokens, right.tokens) || subset(right.tokens, left.tokens)) && Math.min(left.tokens.length, right.tokens.length) < 2) blockers.push(`Ambiguous component names ${left.id} "${left.name}" and ${right.id} "${right.name}" require distinct bounded-context names.`); if (left.labelTokens.join("-") === right.labelTokens.join("-")) blockers.push(`Component scope labels for ${left.id} and ${right.id} normalize to the same meaning.`); }
  const claims = [];
  for (const component of components) { const policy = component?.fileNaming; const roots = Array.isArray(policy?.allowedRoots) ? policy.allowedRoots.map(normalizePath) : []; const required = Array.isArray(policy?.requiredTerms) ? policy.requiredTerms.flatMap(namingTokens) : []; const forbidden = new Set([...(policy?.forbiddenStems ?? []).flatMap(namingTokens), ...GENERIC_STEMS]); if (!roots.length || roots.some((root) => !root || root.startsWith("/") || root.split("/").includes(".."))) blockers.push(`${component?.id ?? "component"}.fileNaming requires safe allowedRoots.`); if (!required.length) blockers.push(`${component?.id ?? "component"}.fileNaming requires distinctive requiredTerms.`); if (!text(policy?.newFileRule) || !text(policy?.renameRule)) blockers.push(`${component?.id ?? "component"}.fileNaming requires newFileRule and renameRule.`);
    for (const claim of component?.fileClaims ?? []) { const normalized = normalizePath(claim.path); const stem = pathStem(normalized); const tokens = namingTokens(stem); const convention = CONVENTION_FILES.get(normalized.toLowerCase()); const conventionAllowed = Boolean(convention && claim.convention === convention); if (!roots.some((root) => root === "." ? !normalized.includes("/") : normalized === root || normalized.startsWith(`${root}/`))) blockers.push(`${component.id} file ${claim.path} is outside its allowed component roots.`); if (!conventionAllowed && !tokens.some((token) => required.includes(token))) blockers.push(`${component.id} file ${claim.path} does not contain a required bounded-context term.`); if (!conventionAllowed && tokens.length === 1 && forbidden.has(tokens[0])) blockers.push(`${component.id} file ${claim.path} uses vague stem "${stem}".`); if (claim.convention && !conventionAllowed) blockers.push(`${component.id} file ${claim.path} names an unapproved convention exception.`); claims.push({ componentId: component.id, path: normalized.toLowerCase(), stem, tokens, conventionAllowed }); }
  }
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) { const left = claims[leftIndex]; const right = claims[rightIndex]; if (!left.conventionAllowed && !right.conventionAllowed && left.componentId !== right.componentId && (subset(left.tokens, right.tokens) || subset(right.tokens, left.tokens)) && Math.min(left.tokens.length, right.tokens.length) === 1) blockers.push(`Ambiguous cross-component filenames ${left.path} and ${right.path}; add bounded-context terms before approval.`); }
  return { ready: blockers.length === 0, blockers, componentCount: components.length, claimCount: claims.length, reservedNames: claims.map((claim) => ({ componentId: claim.componentId, path: claim.path, stem: claim.stem })) };
}

export function authorizePlannedEdits(input, request) {
  const blockers = []; const naming = assessNamingGuardrails(input); if (!naming.ready) blockers.push(...naming.blockers); const component = input?.components?.find((item) => item.id === request?.componentId);
  if (!text(request?.planId) || request.planId !== input?.planId) blockers.push("Edit request is not bound to the exact plan.");
  if (!text(request?.architectureDigest) || request.architectureDigest !== input?.architectureDigest) blockers.push("Edit request is not bound to the exact architecture digest.");
  if (!component) blockers.push("Edit request names an unknown component.");
  if (component && request?.taskId !== component.taskId) blockers.push("Edit request task does not own this component contract.");
  if (!Array.isArray(request?.paths) || !request.paths.length) blockers.push("Edit request requires at least one exact path.");
  const claims = new Map((component?.fileClaims ?? []).map((claim) => [normalizePath(claim.path).toLowerCase(), claim]));
  for (const item of request?.paths ?? []) { const normalized = normalizePath(item?.path).toLowerCase(); const claim = claims.get(normalized); if (!claim) blockers.push(`Out-of-scope edit refused: ${item?.path}.`); else if (item?.access !== claim.access && !(claim.access === "write" && item?.access === "read")) blockers.push(`Access ${item?.access} exceeds the ${claim.access} claim for ${item.path}.`); }
  return { allowed: blockers.length === 0, verdict: blockers.length ? "REFUSED" : "AUTHORIZED", blockers, componentId: component?.id ?? null, taskId: component?.taskId ?? null, requiredRecovery: blockers.some((blocker) => blocker.startsWith("Out-of-scope")) ? "Amend the component contract, approve a successor catalog, rescan collisions, then obtain a new exact claim." : null };
}

export const genericFileStems = [...GENERIC_STEMS].sort();
