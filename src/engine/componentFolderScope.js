// Shared preflight only. Backend callers still verify and lock exact parent heads.
export function assessComponentFolderScope(input, folderNodes) {
  const blockers = [];
  if (!Array.isArray(folderNodes) || folderNodes.some(node => !node || typeof node.id !== "string" || typeof node.path !== "string" || !["folder", "file"].includes(node.kind)) || !Array.isArray(input?.inventory) || !Array.isArray(input?.components)) return { ready: false, blockers: ["Component folder scope input is invalid."] };
  const nodes = new Map(folderNodes.map(node => [node.id, node]));
  // Primary home is not exclusive: source, tests and explicit root config files
  // may belong to one component, provided every exact claim is covered.
  const covered = claimed => folderNodes.some(node => node.kind === "folder" ? claimed.startsWith(`${node.path}/`) : claimed === node.path);
  for (const item of input.inventory) if (nodes.get(item?.folderNodeId)?.kind !== "folder") blockers.push("Component inventory references an unknown approved folder.");
  const claims = new Map();
  for (const component of input.components) {
    if (nodes.get(component?.folderNodeId)?.kind !== "folder") blockers.push("Component references an unknown approved folder.");
    if (!Array.isArray(component?.fileClaims)) { blockers.push("Component file claims are invalid."); continue; }
    for (const claim of component.fileClaims) {
      const claimed = typeof claim?.path === "string" ? claim.path : "";
      if (claimed.includes("\\") || claimed.split("/").some(segment => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) || /[:\u0000-\u001f<>"|?*]/.test(claimed) || !covered(claimed)) blockers.push("Component file claim is outside its exact approved folder or file boundary or has an ambiguous portable path.");
      const prior = claims.get(claimed.toLowerCase()) ?? [];
      if (prior.some(item => item.componentId !== component.id && (item.access === "write" || claim?.access === "write"))) blockers.push("Component file claims have a case-insensitive write collision.");
      prior.push({ componentId: component.id, access: claim?.access }); claims.set(claimed.toLowerCase(), prior);
    }
  }
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)] };
}
