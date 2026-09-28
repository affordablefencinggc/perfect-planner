# DANS1-only native window proof

This standalone Cargo harness compiles the shared source directly without adding
production Tauri commands or permissions. Run/build only on DANS1. It uses a
native Win32 window and readonly multiline edit, not a WebView decision button.

The default harness requests cancellation immediately. Passing proves the
native creation/cancellation/destruction path, not visibility, screenshots,
human action, native-host IPC authenticity, or packaged application integration.

API: `open_review(ReviewDisplay)` validates request/digests and bounded content,
then returns a host-only cancellation/result handle. `wait(timeout)` returning
an error never proves closure. A successful receipt has `destroyed:true` only
after `WM_NCDESTROY` on that thread/window, and always `human_verified:false`.
Cancel uses a capacity-one mailbox. Dropping a handle requests cancellation but
does not synchronously verify destruction. Keep the handle until acknowledged.

The handle and receipt include a fresh per-process correlation instance ID and
the host-provided full-display digest. The module does not calculate that digest
from canonical JSON; the eventual host must calculate/verify it before calling.
The fixture digest is deliberately synthetic and is not content-binding proof.
No State reference is held across reentrant Win32 calls. If destruction fails,
the State allocation is deliberately retained rather than freeing userdata;
that exceptional path reports closure unconfirmed, not successful cleanup.

Remaining integration limits: persist the fresh instance ID,
packaged host authentication, process shutdown
ownership, actual visible UI/keyboard/accessibility proof, and recovery after
process death. Native button notifications may be synthesized by automation;
they must not be described as cryptographic evidence of a human decision.

`--presenter` reads exactly one bounded JSON object until stdin EOF, verifies
the SHA-256 of the exact content string, checks its request/subject identities,
and opens the native review. It emits a single JSON receipt only after native
destruction acknowledgement. Input deadline is 5 seconds; presentation deadline
is 120 seconds followed by cancellation and a 10-second closure deadline.
Native receipt delivery is not a human-authentication proof. Parent disconnect
or process kill is not yet correlated closure proof. This remains a standalone
DANS1 proof helper, not production packaging. Cargo tests cover input validation
only and must run on DANS1.
