// Clause numbering, reference parsing and lookup for the Perfect Planner core loop.
//
// Contract notes for the ledger and MCP modules:
//   - Task attempts: "T-14.a2" names the second attempt of task "T-14". The first
//     attempt has no suffix. parseRef returns { id: "T-14", attempt: 2 }, and
//     lookup("T-14.a2") keeps "T-14.a2" as its ref. Its history is the task's full
//     history across all attempts, so attempts are not filtered out.
//   - Entry numbers: "L-" followed by six digits (zero-padded), or seven or more
//     digits with no leading zero.
//   - lookup cites an entry through its refs, its corrects field and its evidence items.
export { numberPlan, parsePlanBlocks, matchKeys, normalizeText, CLAUSE_ID_PATTERN } from "./numbering.mjs";
export { parseRef, parseImplements, canonicalRef } from "./refs.mjs";
export { lookup } from "./lookup.mjs";
