export const guaranteeManifest = {
  schemaVersion: 1,
  planId: "PP-014",
  title: "Local Collaboration Workspace",
  tasks: [
    { taskId: "B01", title: "Brief contract", estimateMinutes: 45, dependsOn: [], claims: [{ kind: "file", surface: "docs/brief.md", access: "write" }] },
    { taskId: "B02", title: "Market sonar", estimateMinutes: 60, dependsOn: [], claims: [{ kind: "api", surface: "GET /market-scan", access: "read" }] },
    { taskId: "B03", title: "Architecture contract", estimateMinutes: 90, dependsOn: ["B01"], claims: [{ kind: "file", surface: "src/contracts/plan.ts", access: "write" }, { kind: "database", surface: "public.plans", access: "write" }] },
    { taskId: "B04", title: "Plan capsule", estimateMinutes: 55, dependsOn: ["B01"], claims: [{ kind: "file", surface: "src/contracts/plan.ts", access: "write" }] },
    { taskId: "B07", title: "Collision-safe capsule", estimateMinutes: 120, dependsOn: ["B03", "B04"], claims: [{ kind: "database", surface: "public.plans", access: "read" }, { kind: "file", surface: "src/collision/**", access: "write" }] },
    { taskId: "B08", title: "Core skeleton", estimateMinutes: 180, dependsOn: ["B07"], claims: [{ kind: "file", surface: "src/app/**", access: "write" }] },
    { taskId: "B09", title: "Independent review", estimateMinutes: 80, dependsOn: ["B07"], claims: [{ kind: "file", surface: "src/app/**", access: "read" }] },
    { taskId: "B10", title: "Merged-state rehearsal", estimateMinutes: 70, dependsOn: ["B08", "B09"], claims: [{ kind: "dependency", surface: "lockfile", access: "write" }] },
  ],
};

export const guaranteeSessions = [
  { id: "s-8bf321a0", actor: "Build Agent A", heartbeat: "2026-09-02T09:55:00.000Z", claim: "B07 · src/collision/**" },
  { id: "s-31c4d892", actor: "Review Agent B", heartbeat: "2026-09-02T09:36:00.000Z", claim: "B09 · src/app/** read" },
  { id: "s-a0c942f1", actor: "Mira", heartbeat: "2026-08-31T07:00:00.000Z", claim: "released" },
];

export const guaranteeItems = [
  {
    id: "B07-1", title: "Collision engine proof pack", built: true, tested: true, ui: true,
    builtBy: { actor: "Build Agent A", at: "2026-09-02T08:00:00Z", commit: "8cf12a7" },
    proof: { by: "local-runner", at: "2026-09-02T08:10:00Z", verify: "npm test", artifact: "b07.log", sha256: "sha-b07", screenshot: "collision-gate.png", viewedNote: "The screen shows the unresolved hard stop and disabled allocation.", environment: "node/windows", loc: { added: 341, removed: 0 }, tokensEstimate: 18000 },
  },
  {
    id: "B08-1", title: "Core skeleton visual state", built: true, tested: true, ui: true,
    builtBy: { actor: "Jon", at: "2026-09-02T09:10:00Z", commit: "37ad1f0" },
    proof: { by: "local-runner", at: "2026-09-02T09:18:00Z", verify: "npm run build", artifact: "b08.log", sha256: "sha-b08", screenshot: "core-shell.png", environment: "node/windows", loc: { added: 212, removed: 14 }, tokensEstimate: 9000 },
  },
  { id: "B09-1", title: "Human design confirmation", built: true, tested: false, ui: true, builtBy: { actor: "Review Agent B", at: "2026-09-02T09:25:00Z", commit: "37ad1f0" } },
];

export const guaranteeJournal = [
  { action: "prove", itemId: "B07-1", artifact: "b07.log", sha256: "sha-b07", exit: 0 },
  { action: "prove", itemId: "B08-1", artifact: "b08.log", sha256: "sha-b08", exit: 0 },
];

export const guaranteeArtifacts = { "b07.log": { sha256: "sha-b07" }, "b08.log": { sha256: "sha-b08" } };
