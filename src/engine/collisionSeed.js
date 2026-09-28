export const collisionSeedManifests = [
  {
    schemaVersion: 1,
    planId: "PP-014",
    title: "Local Collaboration Workspace",
    priority: 90,
    createdAt: "2026-09-02T00:00:00.000Z",
    tasks: [
      { taskId: "B07", title: "Collision-safe plan capsule", dependsOn: [], claims: [
        { kind: "file", surface: "src/sync/plan.ts", access: "write" },
        { kind: "database", surface: "plan-registry:v2", access: "write" },
        { kind: "file", surface: "src/plans/pp-014.json", access: "write" },
      ] },
      { taskId: "B08", title: "Core skeleton", dependsOn: ["B07"], claims: [
        { kind: "api", surface: "POST /api/plans", access: "write" },
        { kind: "dependency", surface: "@planner/contracts", access: "read" },
      ] },
    ],
  },
  {
    schemaVersion: 1,
    planId: "PP-021",
    title: "Cross-repository Collision Assessor",
    priority: 70,
    createdAt: "2026-09-02T00:15:00.000Z",
    tasks: [
      { taskId: "C04", title: "Registry adapter", dependsOn: [], claims: [
        { kind: "file", surface: "src/sync/plan.ts", access: "write" },
        { kind: "database", surface: "plan-registry:v2", access: "read" },
        { kind: "file", surface: "src/collision/**", access: "write" },
      ] },
    ],
  },
  {
    schemaVersion: 1,
    planId: "PP-008",
    title: "Peer Review Vault",
    priority: 50,
    createdAt: "2026-09-02T00:30:00.000Z",
    tasks: [
      { taskId: "V03", title: "Review result writer", dependsOn: [], claims: [
        { kind: "api", surface: "POST /api/plans", access: "read" },
        { kind: "file", surface: "src/review/results.ts", access: "write" },
        { kind: "dependency", surface: "@planner/contracts", access: "read" },
      ] },
    ],
  },
];
