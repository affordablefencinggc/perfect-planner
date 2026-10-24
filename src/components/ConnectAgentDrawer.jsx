import { lazy, Suspense, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ArrowRightIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { CoreAgentConnect } from "../core-screens/CoreAgentConnect.jsx";
import "./ConnectAgentDrawer.css";

// Loaded only when the drawer opens, so the main bundle does not carry the terminal.
const CoreTerminal = lazy(() => import("../core-screens/CoreTerminal.jsx"));

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Connect agent: the live check-in panel (CoreAgentConnect), whose lines come from the running host,
// so an installed copy never shows a placeholder path. The old read-only setup snippets were removed
// because they needed a build-time path and showed <path-to-perfect-planner> without one.
export function ConnectAgentDrawer({ open, onClose, onWorkspace, hasProject = true }) {
  const panelRef = useRef(null);
  const returnRef = useRef(null);
  // Latest onClose without re-running the focus effect: an inline onClose changes every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    returnRef.current = document.activeElement;
    panelRef.current?.querySelector(FOCUSABLE)?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0], last = items.at(-1);
      if (!panelRef.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => { document.removeEventListener("keydown", onKeyDown, true); returnRef.current?.focus?.(); };
  }, [open]);

  if (!open) return null;

  // Portalled so the header's backdrop filter cannot clip the full-height panel.
  return createPortal(
    <>
      <button type="button" className="connect-agent-scrim" aria-label="Close agent setup" tabIndex={-1} onClick={onClose} />
      <aside ref={panelRef} className="connect-agent-drawer" role="dialog" aria-modal="true" aria-labelledby="connect-agent-title">
        <header className="connect-agent-head">
          <span><RobotIcon weight="duotone" /></span>
          <div>
            <small className="eyebrow">Agent check-in</small>
            <h2 id="connect-agent-title">Connect agent</h2>
          </div>
          <button type="button" className="connect-agent-close" aria-label="Close" onClick={onClose}><XIcon /></button>
        </header>

        <div className="connect-agent-scroll">
          <CoreAgentConnect />
          {hasProject && <Suspense fallback={null}><CoreTerminal /></Suspense>}
          <section className="connect-agent-section" aria-label="Hand your plan to the agent">
            <h3>Hand your plan to the agent</h3>
            <p>Once your plan is approved, open Build and use <strong>Copy brief</strong> to paste the current task into your agent's chat.</p>
            {onWorkspace && (hasProject
              ? <button type="button" className="connect-agent-link" onClick={() => { onClose(); onWorkspace("build"); }}>Open Build <ArrowRightIcon /></button>
              : <button type="button" className="connect-agent-link" onClick={() => { onClose(); onWorkspace("structure"); }}>Choose an app folder <ArrowRightIcon /></button>)}
          </section>
        </div>
      </aside>
    </>,
    document.body,
  );
}
