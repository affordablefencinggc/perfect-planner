// "Next honest action" for imported-project workflow pages. It never routes to
// the page that is already open: when the first open requirement belongs to the
// current page, `workspace` is null and `target` names the requirement so the
// page can bring its own panel ([data-requirement-target]) or row into view.

// Which page can record each requirement. Unknown ids belong to the page showing them.
export const REQUIREMENT_OWNERS = Object.freeze({
  "REC-REGISTRATION": "structure",
  "REC-CENSUS": "structure",
  "REC-DISCOVERY": "structure",
  "AUTH-FOLDER": "structure",
  "AUTH-ARCHITECTURE": "blueprint",
  "AUTH-COMPONENT": "components",
  "AUTH-PLAN": "plan",
  "LEDGER-TASKS": "plan",
  "COL-EVALUATION": "collision",
  "ALLOC-CLEARANCE": "collision",
  "BUILD-CLEARANCE": "collision",
  "ALLOC-OWNERS": "allocation",
  "ALLOC-WORKTREES": "allocation",
  "BUILD-ALLOCATION": "allocation",
  "BUILD-RUN": "build",
  "PROOF-SCREENSHOT": "evidence",
  "PROOF-DIFF": "evidence",
  "PROOF-TEST": "evidence",
  "INT-PROOF": "evidence",
  "INT-REVIEW": "integrity",
  "INT-MERGED": "integrity",
  "INDEX-BUILD": "index",
});

const NEXT_WHEN_DONE = Object.freeze({
  plan: ["Open collision review", "collision"],
  collision: ["Open allocation", "allocation"],
  allocation: ["Open build", "build"],
  build: ["Open evidence", "evidence"],
  evidence: ["Open integrity", "integrity"],
  integrity: ["Review ledger", "ledger"],
  ledger: ["Open project index", "index"],
  index: ["Return to project home", "home"],
});
const NAMES = Object.freeze({ blueprint: "Blueprint", structure: "Structure", components: "Components" });
const pageName = (id) => NAMES[id] ?? `${id[0].toUpperCase()}${id.slice(1)}`;

export function workflowNextAction(workspace, requirements) {
  const firstOpen = requirements.find((item) => item.state !== "recorded");
  if (!firstOpen) {
    const [label, next] = NEXT_WHEN_DONE[workspace];
    return { label, workspace: next, target: null, reason: "All receipts represented on this surface are recorded." };
  }
  const owner = REQUIREMENT_OWNERS[firstOpen.id] ?? workspace;
  if (owner === workspace) return { label: `Review ${firstOpen.label}`, workspace: null, target: firstOpen.id, reason: firstOpen.detail };
  return { label: `Open ${pageName(owner)}`, workspace: owner, target: firstOpen.id, reason: firstOpen.detail };
}
