import { useEffect, useId, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, CopyIcon, GearSixIcon, KeyIcon } from "@phosphor-icons/react";
import { useViewMode } from "../project/viewMode.js";
import {
  ADVISORY,
  agentDefaultsBrief,
  DOCK_TABS,
  REVIEW_PRESETS,
  STAGE_PAGES,
  TEXT_SIZES,
  TOAST_SECONDS,
  useAppSettings,
} from "./appSettings.js";
import { clearJevKey, JEV_UNAVAILABLE, readJevKeyStatus, saveJevKey } from "./jevKeychain.js";
import "./settings.css";

const PAGE_LABELS = {
  blueprint: "Blueprint",
  structure: "Structure",
  components: "Components",
  plan: "Plan",
  collision: "Collisions",
  allocation: "Allocation",
  build: "Build",
  integrity: "Integrity",
  evidence: "Evidence",
  ledger: "To-do / Ledger",
  index: "Index",
};
const DOCK_TAB_LABELS = {
  logs: "Logs",
  errors: "Errors",
  mcp: "MCP events",
  branches: "Branches & worktrees",
  merge: "Merge queue",
  delivery: "Delivery pipeline",
  guards: "Hooks & catchers",
};
const STAGES = [
  { id: "define", number: "01", label: "Define", purpose: "Blueprint, folder structure and component contracts." },
  { id: "coordinate", number: "02", label: "Coordinate", purpose: "Plan order, collision checks and owner allocation." },
  { id: "build", number: "03", label: "Build", purpose: "The guarded conveyor where claimed work is built." },
  { id: "prove", number: "04", label: "Prove", purpose: "Integrity verdict and screenshot-led evidence." },
  { id: "release", number: "05", label: "Release", purpose: "Close the ledger and prepare the handover." },
];
const SECTIONS = [
  ["display", "Display"],
  ["navigation", "Start & navigation"],
  ...STAGES.map((stage) => [`stage-${stage.id}`, `${stage.number} ${stage.label}`]),
  ["agents", "Agents & Jev"],
  ["index", "Index"],
  ["panels", "Panels & notices"],
  ["data", "Your data"],
  ["reset", "Reset"],
];

const ADVISORY_STATUS = { tone: "amber", label: ADVISORY };

function Row({ title, help, children, status }) {
  const id = useId();
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <strong id={id}>{title}</strong>
        {help && <small>{help}</small>}
        {status && <span className={`settings-status settings-status-${status.tone}`}>{status.label}</span>}
      </div>
      <div className="settings-row-control" role="group" aria-labelledby={id}>{children}</div>
    </div>
  );
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ label, checked, onChange }) {
  return (
    <label className="settings-switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true" />
      <b>{checked ? "On" : "Off"}</b>
    </label>
  );
}

function Section({ id, title, intro, children }) {
  return (
    <section className="settings-section" id={`settings-${id}`} aria-labelledby={`settings-${id}-title`}>
      <header>
        <h2 id={`settings-${id}-title`} tabIndex={-1}>{title}</h2>
        {intro && <p>{intro}</p>}
      </header>
      {children}
    </section>
  );
}

function PageLinks({ pages, onWorkspace }) {
  return (
    <div className="settings-page-links">
      {pages.map((page) => (
        <button key={page} type="button" onClick={() => onWorkspace(page)}>
          Open {PAGE_LABELS[page]} <ArrowRightIcon aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function JevKeyField({ invoke, onToast }) {
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    readJevKeyStatus({ invoke }).then((next) => live && setStatus(next));
    return () => { live = false; };
  }, [invoke]);
  const current = status ?? JEV_UNAVAILABLE;
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    const result = await saveJevKey(draft, { invoke });
    setDraft("");
    setBusy(false);
    setStatus(result.status);
    setMessage(result.ok ? "Key saved to the Windows keychain." : result.message);
    onToast?.(result.ok ? "Jev key saved to the Windows keychain." : `Jev key not saved: ${result.message}`, result.ok ? "success" : "error");
  };
  const clear = async () => {
    setBusy(true);
    const result = await clearJevKey({ invoke });
    setBusy(false);
    setStatus(result.status);
    setMessage(result.ok ? "Key removed from the Windows keychain." : result.message);
    onToast?.(result.ok ? "Jev key removed." : `Jev key not removed: ${result.message}`, result.ok ? "neutral" : "error");
  };
  const statusLabel = status === null
    ? { tone: "muted", label: "Checking keychain…" }
    : current.store === "error"
      ? { tone: "amber", label: "Keychain did not respond" }
      : current.store === "unsupported-os"
      ? { tone: "amber", label: "Windows only today" }
      : !current.available
      ? { tone: "amber", label: "Windows only today (desktop app)" }
      : current.stored
        ? { tone: "green", label: "Key stored in keychain" }
        : { tone: "muted", label: "No key stored" };
  return (
    <Row
      title="Jev API key"
      help="Windows only today. Saved only to the Windows keychain (Credential Manager). Perfect Planner never shows it again, never writes it to a file, and never sends it to an agent brief. Once the key is saved, Jev must review each task's test before work on that task starts."
      status={statusLabel}
    >
      <form className="settings-key-form" onSubmit={save}>
        <KeyIcon aria-hidden="true" />
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="Jev API key"
          placeholder={current.stored ? "•••••••• (stored)" : "Paste key"}
          value={draft}
          disabled={!current.available || busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!current.available || busy || !draft.trim()}>Save to keychain</button>
        <button type="button" className="settings-danger-link" disabled={!current.available || busy || !current.stored} onClick={clear}>Remove</button>
      </form>
      {current.store === "unsupported-os" && !message && (
        <p className="settings-inline-note" role="status">Windows only today. Linux and macOS cannot save the key yet, so nothing is stored here.</p>
      )}
      {message && <p className="settings-inline-note" role="status">{message}</p>}
    </Row>
  );
}

export function SettingsWorkspace({ onWorkspace, onClose, onToast, invoke, jevStatusOverride }) {
  const { settings, update, reset } = useAppSettings();
  const { mode, setMode } = useViewMode();
  const [jevStored, setJevStored] = useState(Boolean(jevStatusOverride?.stored));
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    let live = true;
    readJevKeyStatus({ invoke }).then((status) => live && setJevStored(status.stored));
    return () => { live = false; };
  }, [invoke]);
  const setStageEntry = (stage, page) => update((current) => ({ stageEntry: { ...current.stageEntry, [stage]: page } }));
  const copyAgentDefaults = async () => {
    const text = agentDefaultsBrief(settings, { jevKeyStored: jevStored });
    try {
      await navigator.clipboard.writeText(text);
      onToast?.("Agent defaults copied. Paste them into your agent's first message.", "success");
    } catch {
      onToast?.("Copy was blocked by the browser. Select the preview text and copy it instead.", "warning");
    }
  };
  // Scroll only the settings page; scrollIntoView would also shift the fixed app frame.
  const jump = (id) => {
    const target = document.getElementById(`settings-${id}`);
    const page = target?.closest(".settings-workspace");
    if (!target || !page) return;
    let top = -12;
    for (let node = target; node && node !== page; node = node.offsetParent) top += node.offsetTop;
    if (typeof page.scrollTo === "function") page.scrollTo({ top, behavior: settings.reduceMotion ? "auto" : "smooth" });
    else page.scrollTop = top;
    target.querySelector("h2")?.focus?.({ preventScroll: true });
  };

  return (
    <div className="settings-workspace" aria-label="Settings">
      <header className="settings-hero">
        <button type="button" className="settings-back" onClick={onClose}><ArrowLeftIcon aria-hidden="true" /> Back</button>
        <span className="settings-hero-mark"><GearSixIcon weight="fill" aria-hidden="true" /></span>
        <div>
          <h1>Settings</h1>
          <p>Fine-tune every stage and feature. Changes apply immediately and are saved on this device. Safety rules (collision gates, proof, review) are never relaxed from here.</p>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} type="button" onClick={() => jump(id)}>{label}</button>
          ))}
        </nav>
        <div className="settings-sections">
          <Section id="display" title="Display" intro="How Perfect Planner looks on this device.">
            <Row title="Detail level" help="Simple shows plain outcomes and next actions. Advanced also shows IDs, fingerprints, revisions and scan numbers. Both read the same data.">
              <Segmented label="Detail level" value={mode} onChange={setMode} options={[{ value: "simple", label: "Simple" }, { value: "advanced", label: "Advanced" }]} />
            </Row>
            <Row title="Theme" help="Warm ledger is the standard look. High contrast darkens text and borders for readability. A dark theme is not available yet.">
              <Segmented
                label="Theme"
                value={settings.theme}
                onChange={(theme) => update({ theme })}
                options={[
                  { value: "warm", label: "Warm ledger" },
                  { value: "contrast", label: "High contrast" },
                  { value: "dark", label: "Dark (not available yet)", disabled: true, title: "Not available yet: many surfaces still use fixed light colours." },
                ]}
              />
            </Row>
            <Row title="Text size" help="Scales the whole interface.">
              <Segmented
                label="Text size"
                value={settings.textSize}
                onChange={(textSize) => update({ textSize })}
                options={Object.keys(TEXT_SIZES).map((size) => ({ value: size, label: size === "standard" ? "Standard" : size === "large" ? "Large" : "Larger" }))}
              />
            </Row>
            <Row title="Reduce motion" help="Stops the planner worker laps and other animations.">
              <Switch label="Reduce motion" checked={settings.reduceMotion} onChange={(reduceMotion) => update({ reduceMotion })} />
            </Row>
          </Section>

          <Section id="navigation" title="Start & navigation" intro="Where the app opens and where each stage button lands.">
            <Row title="Open the app on" help="Last page reopens the page you were on when you closed the app.">
              <Segmented label="Open the app on" value={settings.startPage} onChange={(startPage) => update({ startPage })} options={[{ value: "home", label: "Project Home" }, { value: "last", label: "Last page" }]} />
            </Row>
          </Section>

          {STAGES.map((stage) => (
            <Section key={stage.id} id={`stage-${stage.id}`} title={`${stage.number} ${stage.label}`} intro={stage.purpose}>
              {STAGE_PAGES[stage.id].length > 1 && (
                <Row title={`${stage.label} button opens`} help={`Which page opens when you press ${stage.label} in the top bar.`}>
                  <Segmented
                    label={`${stage.label} button opens`}
                    value={settings.stageEntry[stage.id]}
                    onChange={(page) => setStageEntry(stage.id, page)}
                    options={STAGE_PAGES[stage.id].map((page) => ({ value: page, label: PAGE_LABELS[page] }))}
                  />
                </Row>
              )}
              {stage.id === "build" && (
                <Row status={ADVISORY_STATUS} title="Worktree mode" help="Isolated gives each task its own worktree. Shared runs one task at a time in your working copy.">
                  <Segmented label="Worktree mode" value={settings.worktreeMode} onChange={(worktreeMode) => update({ worktreeMode })} options={[{ value: "isolated", label: "Isolated per task" }, { value: "shared", label: "Shared, one at a time" }]} />
                </Row>
              )}
              {stage.id === "prove" && (
                <Row status={ADVISORY_STATUS} title="Review preset" help={`${REVIEW_PRESETS[settings.reviewPreset]}. The app's own review setting is not changed from here.`}>
                  <Segmented label="Review preset" value={settings.reviewPreset} onChange={(reviewPreset) => update({ reviewPreset })} options={Object.keys(REVIEW_PRESETS).map((preset) => ({ value: preset, label: preset[0].toUpperCase() + preset.slice(1) }))} />
                </Row>
              )}
              {(stage.id === "prove" || stage.id === "release") && (
                <p className="settings-fixed-rule">
                  {stage.id === "prove"
                    ? "Fixed rule: green only ever means verified. Integrity stays fail-closed whatever preset you choose."
                    : "Fixed rule: a release needs every required proof accepted. That gate cannot be turned off."}
                </p>
              )}
              <PageLinks pages={STAGE_PAGES[stage.id]} onWorkspace={onWorkspace} />
            </Section>
          ))}

          <Section id="agents" title="Agents & Jev" intro="Defaults you hand to a connected agent. They are preferences in the brief you copy, not permissions: Planner gates still decide what may run.">
            <Row status={ADVISORY_STATUS} title="Orchestration rounds" help="The most review-and-revise rounds a lead model runs before stopping.">
              <Segmented label="Orchestration rounds" value={settings.maxRounds} onChange={(maxRounds) => update({ maxRounds })} options={[1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) }))} />
            </Row>
            <Row status={ADVISORY_STATUS} title="Budget cap per run" help="Leave empty for no cap. Agents are told to stop and ask before going over it.">
              <label className="settings-number">
                <span>AUD</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  inputMode="decimal"
                  aria-label="Budget cap per run in AUD"
                  value={settings.budgetCapAud ?? ""}
                  placeholder="No cap"
                  onChange={(event) => update({ budgetCapAud: event.target.value === "" ? null : event.target.value })}
                />
              </label>
            </Row>
            <Row status={ADVISORY_STATUS} title="Use Jev as a reviewer" help="Records that you want Jev as a reviewer and adds that request to the agent brief you copy. Perfect Planner does not run Jev reviews itself yet.">
              <Switch label="Use Jev as a reviewer" checked={settings.jevReviewer} onChange={(jevReviewer) => update({ jevReviewer })} />
            </Row>
            <JevKeyField invoke={invoke} onToast={(message, tone) => { onToast?.(message, tone); readJevKeyStatus({ invoke }).then((status) => setJevStored(status.stored)); }} />
            <div className="settings-brief">
              <pre aria-label="Agent defaults preview">{agentDefaultsBrief(settings, { jevKeyStored: jevStored })}</pre>
              <button type="button" onClick={copyAgentDefaults}><CopyIcon aria-hidden="true" /> Copy agent defaults</button>
            </div>
          </Section>

          <Section id="index" title="Index" intro="The searchable index of everything in the project. It opens over any page.">
            <PageLinks pages={["index"]} onWorkspace={onWorkspace} />
          </Section>

          <Section id="panels" title="Panels & notices" intro="The bottom operations console, developer notes and pop-up notices.">
            <Row title="Open the operations console on launch" help="Otherwise it starts collapsed at the bottom.">
              <Switch label="Open the operations console on launch" checked={settings.opsDockOpenOnLaunch} onChange={(opsDockOpenOnLaunch) => update({ opsDockOpenOnLaunch })} />
            </Row>
            <Row title="Console opens on" help="The tab shown first when the console opens.">
              <select aria-label="Console opens on" value={settings.opsDockTab} onChange={(event) => update({ opsDockTab: event.target.value })}>
                {DOCK_TABS.map((tab) => <option key={tab} value={tab}>{DOCK_TAB_LABELS[tab]}</option>)}
              </select>
            </Row>
            <Row title="Show Developer Notes" help="The notes button for prompts, replies and errors exchanged with agents.">
              <Switch label="Show Developer Notes" checked={settings.developerNotesVisible} onChange={(developerNotesVisible) => update({ developerNotesVisible })} />
            </Row>
            <Row title="Notices stay for" help="How long pop-up notices stay before closing themselves.">
              <Segmented label="Notices stay for" value={settings.toastSeconds} onChange={(toastSeconds) => update({ toastSeconds })} options={TOAST_SECONDS.map((value) => ({ value, label: value ? `${value} s` : "Until closed" }))} />
            </Row>
          </Section>

          <Section id="data" title="Your data" intro="Uninstalling Perfect Planner keeps your plans, proof and settings on this computer. That is deliberate: the ledger is your record, and a reinstall picks it up again.">
            <Row title="Where it lives" help="Windows: %LOCALAPPDATA%\com.perfectplanner.desktop. macOS: ~/Library/Application Support/com.perfectplanner.desktop. Linux: ~/.local/share/com.perfectplanner.desktop." />
            <Row title="Test commands" help="This command runs as you, with your files and network. When you approve a test, Perfect Planner runs it on this computer like any program you start yourself. Only the Tasks screen can say contained: bubblewrap, and that is an opt-in on Linux, off by default, and not available on Windows." />
            <Row title="To remove it" help="Close Perfect Planner, uninstall it, then delete that folder. This cannot be undone, and it also deletes the signed ledger. Your own project folders are never in it." />
          </Section>

          <Section id="reset" title="Reset" intro="Put every setting on this page back to its default. Your projects, plans and proof are not touched, and the Jev key stays in the keychain.">
            {confirmReset ? (
              <div className="settings-reset-confirm" role="alert">
                <span>Reset all settings to defaults?</span>
                <button type="button" className="settings-danger" onClick={() => { reset(); setMode("simple"); setConfirmReset(false); onToast?.("Settings reset to defaults.", "neutral"); }}>Yes, reset</button>
                <button type="button" onClick={() => setConfirmReset(false)}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="settings-danger" onClick={() => setConfirmReset(true)}>Reset all settings</button>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
