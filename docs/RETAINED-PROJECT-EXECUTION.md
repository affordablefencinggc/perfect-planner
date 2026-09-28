# Retained project execution: compatibility work still required

The real Boundaries copy has 50,176 files (965,899,676 bytes), including
48,185 dependency files. The DANS1 metadata inventory found no reparse points.
Its reviewed command profile invokes an external npm CLI, `test` runs Vitest,
and `build` has a prebuild lifecycle hook before its Node build script.
That script invokes Vite and distinguishes a CI compile artifact from a release.
These observations are not successful isolated execution evidence.

The current retained-node path only admits project-contained Node entry scripts
and executes the read-only archived tree. It cannot faithfully replace this
npm/build workflow: normal generated files, caches and temporary configuration
bundles require a writable execution directory. Do not omit hooks, translate a
script into a different command, silently enable CI mode, or use the legacy
runner as fallback and call that isolated execution.

## Required extension

1. Retain an immutable, complete initial project snapshot and a separately
   pinned toolchain inventory. Preserve current path, stream, link, byte-limit,
   ACL and binding checks. Keep original project custody through initial
   capture and acknowledgment. A retained snapshot is evidence of initial
   inputs, not a promise that a build never modifies its execution copy.
2. Prepare a fresh writable execution copy inside the fresh AppContainer.
   Verify every initial relative name, kind, length and content digest against
   the retained snapshot before resuming a child. Do not share writable files
   with either the original project or the archive. Record this mapping and
   policy in a new versioned input receipt; do not reinterpret schema one.
3. Keep Node and the complete selected npm runtime outside that writable copy,
   under independently derived read-only ACLs. Extend owner-provisioned review
   evidence to bind the toolchain tree, not only npm-cli.js. Recheck and pin it
   at capture. The worker cannot select a toolchain path or retention mode.
4. Invoke the actual reviewed npm lifecycle with the original arguments in the
   disposable execution copy. Scope and record environment/configuration
   changes in the reviewed contract. Do not inherit credentials, network
   authority or user-global configuration. Preserve any unsupported behavior
   as a named failure with a next action rather than changing the command to
   obtain a passing result. OS runtime dependencies remain explicit; this is
   not a fully hermetic machine image.
5. Hold the immutable inputs and toolchain through settlement and owner
   acknowledgment. The working copy may change as the admitted command runs.
   After the Job and output streams settle, independently inventory its final
   contents and changes. Bound this scan; refuse links, streams, unavailable
   entries or limit overruns. Retain exact selected output artifacts with
   digests; a path or generated-file listing is not retained output proof.
6. Persist the provisional result, initial-input identity, working-copy
   mapping, final changes, captured output and observed settlement before
   finalization. Reopen verifies their exact bindings without relaunching.
   Preserve failed/unresolved copies and history. No result claims promotion,
   release, human approval or test correctness merely because exit code is zero.
7. Account for the approximately 1 GB project before allocating multiple
   copies. Enforce an owner storage budget and preserve-first disposition.
   Use one explicit end-to-end deadline with bounded stages; never multiply
   independent validation allowances beyond enclosing transport budgets.

## Qualification before enabling the installed default

- Actual writable-copy isolation: generated files and source mutations remain
  inside the execution copy; original and retained initial bytes are unchanged.
- Real npm lifecycle order, nested Node/tool execution, command/environment
  binding, cancellation and descendant settlement. No substitution of a small
  Node fixture for this requirement.
- Actual Boundaries test/build commands on the disposable copy, with complete
  output and required-check accounting. Any CI-only build remains labeled a
  compile check, and requires its own reviewed configuration.
- Lost acknowledgments, transient edits, partial artifact persistence,
  restart/reopen, altered retained inputs/runtime/output, exhausted storage and
  deadline expiration all preserve unresolved history without relaunch.
- The installed owner selects this mode only after those checks and current
  package qualification. The genuine picker/IDE approval journey remains a
  separate required exit; scripted admission cannot replace it.

All items above remain open. This extension serves M1/M2; it does not remove
M3–M6, SHIP, the full population proof or orchestration from the finish line.
