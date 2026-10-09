import { useEffect, useRef, useState } from "react";
import { createPlannerGitInventoryController } from "../runtime/plannerGitInventory.js";

const initial = { status: "unavailable", canCheck: false, result: null, reason: "Choose a registered desktop project." };

export default function GitInventoryPanel({ activeProject, onCopy, onEvent, runtime = globalThis, invoke }) {
  const controller = useRef(null);
  const project = useRef(activeProject);
  project.current = activeProject;
  const event = useRef(onEvent);
  event.current = onEvent;
  const [snapshot, setSnapshot] = useState(initial);
  useEffect(() => {
    const instance = createPlannerGitInventoryController({ runtime, invoke, onEvent: (entry) => event.current?.(entry) });
    controller.current = instance;
    const unsubscribe = instance.subscribe(() => setSnapshot(instance.getSnapshot()));
    instance.setProject(project.current);
    return () => { unsubscribe(); instance.dispose(); controller.current = null; };
  }, [runtime, invoke]);
  useEffect(() => { controller.current?.setProject(activeProject); }, [activeProject]);
  const r = snapshot.result;
  const registration = activeProject?.registration;
  // Generation is not compared: it advances on view changes, which do not change Git metadata.
  const current = r && r.projectId === activeProject?.projectId && r.workspaceId === registration?.workspaceId && r.registryRevision === registration?.registryRevision && r.rootIdentity === registration?.rootIdentity && r.expiresAt > Date.now();
  const observation = current ? r.observation : null;
  return <section aria-label="Local branches and working copies" className="git-inventory-panel">
    <div className="git-inventory-actions">
      <strong>Local branches &amp; working copies</strong>
      <button type="button" disabled={!snapshot.canCheck} onClick={() => { controller.current?.setProject(activeProject); void controller.current?.check(); }}>Inspect local Git</button>
      {observation && <button type="button" onClick={() => onCopy?.(JSON.stringify(r, null, 2))}>Copy observation</button>}
    </div>
    <p role="status">{snapshot.reason}</p>
    {observation?.state === "no-git-marker" && <p>This folder has no Git marker. No branches or working copies were assumed.</p>}
    {observation?.state === "observed" && <>
      <p>{observation.branches.length} local branches · {observation.worktrees.length} working copies. Observed {new Date(r.observedAt).toLocaleTimeString()}. Expires after 30 seconds.</p>
      <div className="git-inventory-scroll"><table>
        <caption>Working copies — inspection never authorizes deletion or merging</caption>
        <thead><tr><th scope="col">Branch / mode</th><th scope="col">Folder</th><th scope="col">Git annotations</th></tr></thead>
        <tbody>{observation.worktrees.map((w) => <tr key={w.path}><td><code>{w.branchRef || (w.mode === "detached" ? "Detached HEAD" : "Bare repository")}</code><details><summary>Commit reference</summary><code>{w.headSha || "Not applicable"}</code></details></td><td><code>{w.path}</code></td><td>{w.locked ? "Locked" : "Not marked locked"}{w.prunable ? " · Marked prunable — not permission to delete" : ""}</td></tr>)}</tbody>
      </table></div>
      <details><summary>All local branch references ({observation.branches.length})</summary><ul>{observation.branches.map((b) => <li key={b.ref}><code>{b.ref} — {b.headSha}</code></li>)}</ul></details>
      <p>Two matching reads, not an atomic snapshot. Uncommitted files, CI, production and ownership are not inspected.</p>
    </>}
  </section>;
}
