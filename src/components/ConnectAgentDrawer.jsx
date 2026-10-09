import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightIcon, CheckCircleIcon, CopyIcon, InfoIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { AGENT_TOOLS, buildAgentSnippets, copyText, resolveAgentSetup } from "../project/connectAgentSetup.js";
import "./ConnectAgentDrawer.css";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const buildSetup = () => ({ serverPath: import.meta.env?.VITE_PP_MCP_SERVER_PATH, registryRoot: import.meta.env?.VITE_PP_MCP_REGISTRY_ROOT });

export function ConnectAgentDrawer({ open, onClose, onWorkspace, setup: setupOverride }) {
  const setup = useMemo(() => resolveAgentSetup(setupOverride ?? buildSetup()), [setupOverride]);
  const tabs = useMemo(() => buildAgentSnippets(setup), [setup]);
  const [tabId, setTabId] = useState(tabs[0].id);
  const [copied, setCopied] = useState(null);
  const panelRef = useRef(null);
  const returnRef = useRef(null);
  const tab = tabs.find((item) => item.id === tabId) ?? tabs[0];

  useEffect(() => {
    if (!open) return undefined;
    returnRef.current = document.activeElement;
    panelRef.current?.querySelector(FOCUSABLE)?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
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
  }, [open, onClose]);

  useEffect(() => { if (!open) setCopied(null); }, [open]);
  if (!open) return null;

  const copy = async (block) => setCopied({ id: block.id, ok: await copyText(block.text) });
  const onTabKey = (event, index) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    setTabId(next.id);
    panelRef.current?.querySelector(`#connect-agent-tab-${next.id}`)?.focus();
  };

  return (
    <>
      <button type="button" className="connect-agent-scrim" aria-label="Close agent setup" tabIndex={-1} onClick={onClose} />
      <aside ref={panelRef} className="connect-agent-drawer" role="dialog" aria-modal="true" aria-labelledby="connect-agent-title">
        <header className="connect-agent-head">
          <span><RobotIcon weight="duotone" /></span>
          <div>
            <small className="eyebrow">Read-only planning context</small>
            <h2 id="connect-agent-title">Connect agent</h2>
          </div>
          <button type="button" className="connect-agent-close" aria-label="Close" onClick={onClose}><XIcon /></button>
        </header>

        <div className="connect-agent-scroll">
          <p className="connect-agent-lede">
            Let your coding agent read the apps you added to Perfect Planner. It can look, search and suggest tasks.
            It cannot change Perfect Planner, approve plans or edit your files through this connection.
          </p>

          <div className="connect-agent-tabs" role="tablist" aria-label="Agent">
            {tabs.map((item, index) => (
              <button key={item.id} id={`connect-agent-tab-${item.id}`} type="button" role="tab" aria-selected={item.id === tab.id}
                aria-controls="connect-agent-tabpanel" tabIndex={item.id === tab.id ? 0 : -1}
                onClick={() => { setTabId(item.id); setCopied(null); }} onKeyDown={(event) => onTabKey(event, index)}>
                {item.label}
              </button>
            ))}
          </div>

          <section id="connect-agent-tabpanel" role="tabpanel" aria-labelledby={`connect-agent-tab-${tab.id}`} className="connect-agent-panel">
            {tab.blocks.map((block) => (
              <div key={block.id} className="connect-agent-snippet">
                <div className="connect-agent-snippet-head">
                  <strong>{block.title}</strong>
                  <button type="button" onClick={() => copy(block)} aria-label={`Copy ${block.title}`}>
                    {copied?.id === block.id && copied.ok ? <><CheckCircleIcon /> Copied</> : <><CopyIcon /> Copy</>}
                  </button>
                </div>
                <pre tabIndex={0} aria-label={`${block.title} setup text`}><code>{block.text}</code></pre>
                {copied?.id === block.id && !copied.ok && <p role="alert" className="connect-agent-warn">Copy did not work here. Select the text above and copy it by hand.</p>}
              </div>
            ))}
            <p className="connect-agent-note">{tab.note}</p>
            <p role="status" className="connect-agent-sr">{copied?.ok ? "Copied to clipboard." : ""}</p>
          </section>

          <section className="connect-agent-section" aria-label="Before you paste">
            <h3><InfoIcon /> Before you paste</h3>
            <ul>
              {!setup.serverPathKnown && <li className="connect-agent-warn">This build does not know where Perfect Planner is on your computer. Replace <code>&lt;path-to-perfect-planner&gt;</code> with the folder you cloned, or start the app with <code>npm run dev</code> to fill it in.</li>}
              {!setup.registryKnown && <li className="connect-agent-warn">Replace the app data placeholder with your Perfect Planner app data folder (on Windows: <code>%APPDATA%\com.perfectplanner.desktop\workspace-registry-v1</code>).</li>}
              <li>Run <code>npm install</code> in the Perfect Planner folder first. The server uses that folder's <code>node_modules</code> and needs Node.js 18 or newer.</li>
              <li>Your agent only sees app folders you have added in the Perfect Planner desktop app. If none are added, it will find an empty list.</li>
              <li>To try the server by hand, run <code>npm run --silent mcp</code>. It waits quietly for an agent to talk to it.</li>
            </ul>
          </section>

          <section className="connect-agent-section" aria-label="What your agent can do">
            <h3>What your agent can do</h3>
            <ul className="connect-agent-tools">
              {AGENT_TOOLS.map((tool) => <li key={tool.name}><span>{tool.label}</span><code>{tool.name}</code></li>)}
            </ul>
            <p className="connect-agent-note">All of these only read. Task proposals come back to you to review and import in Ledger; nothing is added to your plan on its own.</p>
          </section>

          <section className="connect-agent-section" aria-label="Hand your plan to the agent">
            <h3>Hand your plan to the agent</h3>
            <p>Once your plan is approved, open Build and use <strong>Copy brief</strong> to paste the current task into your agent's chat.</p>
            {onWorkspace && <button type="button" className="connect-agent-link" onClick={() => { onClose(); onWorkspace("build"); }}>Open Build <ArrowRightIcon /></button>}
          </section>
        </div>
      </aside>
    </>
  );
}
