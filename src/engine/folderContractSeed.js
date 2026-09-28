const folderNode = (id, path, purpose, owner, taskId, createAtStage = "approval", dependsOn = []) => ({ id, kind: "folder", path, purpose, owner, taskId, createAtStage, dependsOn, allowedContents: purpose, changePolicy: "collision-review", renameFallback: "Stop dependants, assess references, approve rename, and rescan every plan claim." });

export const currentFolderContractInput = { schemaVersion: 1, planId: "PP-CLEANROOM", workspaceMode: "hybrid", nodes: [
  folderNode("F001", "src", "Application source only", "Architecture owner", "B01"),
  folderNode("F002", "src/features", "User-facing feature ownership boundaries", "UI owner", "B02", "approval", ["F001"]),
  folderNode("F003", "src/features/planning", "Planning spine and strict-plan authoring", "Planning owner", "B03", "architecture", ["F002"]),
  folderNode("F004", "src/features/collisions", "Claims, reservations, and forced resolution", "Collision owner", "B04", "architecture", ["F002"]),
  folderNode("F005", "src/features/exchange", "Encrypted Git-free draft exchange", "Exchange owner", "B05", "architecture", ["F002"]),
  folderNode("F006", "src/contracts", "Frozen shared schemas and compatibility contracts", "Architecture owner", "B06", "approval", ["F001"]),
  folderNode("F007", "src/adapters", "Git, private-folder, CI, and provider boundaries", "Integration owner", "B07", "build", ["F001", "F006"]),
  folderNode("F008", "tests", "Adversarial and contract verification", "Proof owner", "B08"),
  folderNode("F009", "evidence", "Generated diffs, screenshots, receipts, and reports", "Proof owner", "B09", "proof", ["F008"]),
] };
