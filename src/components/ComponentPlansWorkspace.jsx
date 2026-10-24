import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightIcon, CaretDownIcon, CheckCircleIcon, CodeIcon, FileCodeIcon, FlowArrowIcon, FolderSimpleIcon, InfoIcon, MagnifyingGlassIcon, ShieldCheckIcon, WarningIcon } from "@phosphor-icons/react";
import { assessComponentPlans } from "../engine/componentPlanEngine.js";
import { currentComponentPlanInput } from "../engine/componentPlanSeed.js";
import { workspaceDiscoveryCategories } from "../engine/workspaceDiscoveryEngine.js";
import { boundedFetch } from "../runtime/boundedFetch.js";
import { ComponentDraftPanel } from "./ComponentDraftPanel.jsx";
import { useOptionalProject } from "../project/ProjectProvider.jsx";
import { useViewMode } from "../project/viewMode.js";
import atlasSource from "../../docs/architecture/maps/00-map-atlas.md?mermaid";
import productSource from "../../docs/architecture/maps/01-product-workspaces.md?mermaid";
import componentSource from "../../docs/architecture/maps/02-component-contracts.md?mermaid";
import authoritySource from "../../docs/architecture/maps/03-trust-authority.md?mermaid";
import collisionSource from "../../docs/architecture/maps/04-collision-conveyor.md?mermaid";
import evidenceSource from "../../docs/architecture/maps/05-evidence-release.md?mermaid";
import adapterSource from "../../docs/architecture/maps/06-private-exchange-adapters.md?mermaid";
import namingSource from "../../docs/architecture/maps/07-naming-edit-index.md?mermaid";
import uiShellSource from "../../docs/architecture/maps/08-ui-shell-workspaces.md?mermaid";
import planningSource from "../../docs/architecture/maps/09-planning-engines.md?mermaid";
import authoritiesSource from "../../docs/architecture/maps/10-local-authorities.md?mermaid";
import executionSource from "../../docs/architecture/maps/11-execution-collaboration.md?mermaid";
import integritySource from "../../docs/architecture/maps/12-integrity-proof-release.md?mermaid";
import deploymentSource from "../../docs/architecture/maps/13-build-tests-deployment.md?mermaid";
import coverageSource from "../../docs/architecture/maps/14-artifact-coverage.md?mermaid";
import parallelAgentsSource from "../../docs/architecture/maps/15-parallel-agent-build.md?mermaid";
import "./ComponentPlansWorkspace.css";
import { DEMO_ONLY_REASON, DemoOnlyReason } from "../demo/DemoSampleNotice.jsx";

const cloneSeed = () => structuredClone(currentComponentPlanInput);
const mapDefinitions = [
  { id: "M00", title: "Atlas index", mermaid: atlasSource }, { id: "M01", title: "Product & workspaces", mermaid: productSource }, { id: "M02", title: "Component contracts", mermaid: componentSource }, { id: "M03", title: "Trust & authority", mermaid: authoritySource }, { id: "M04", title: "Collision conveyor", mermaid: collisionSource }, { id: "M05", title: "Evidence & release", mermaid: evidenceSource }, { id: "M06", title: "Exchange & adapters", mermaid: adapterSource }, { id: "M07", title: "Naming & edit index", mermaid: namingSource },
  { id: "M08", title: "UI shell & workspaces", mermaid: uiShellSource }, { id: "M09", title: "Planning engines", mermaid: planningSource }, { id: "M10", title: "Local authorities", mermaid: authoritiesSource }, { id: "M11", title: "Execution & collaboration", mermaid: executionSource }, { id: "M12", title: "Integrity & release", mermaid: integritySource }, { id: "M13", title: "Build & deployment", mermaid: deploymentSource }, { id: "M14", title: "Artifact coverage", mermaid: coverageSource },
  { id: "M15", title: "Parallel agent build", mermaid: parallelAgentsSource },
];

function Disclosure({ id, title, summary, open, onToggle, children }) {
  return <section className={`component-section ${open ? "expanded" : "collapsed"}`}><button type="button" className="component-section-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}><CaretDownIcon /><span><strong>{title}</strong><small>{summary}</small></span></button>{open && <div className="component-section-body" id={id}>{children}</div>}</section>;
}
const TextList = ({ items, negative = false }) => <ul className={negative ? "negative-list" : ""}>{items.map((item) => <li key={item}>{item}</li>)}</ul>;

const discoveryDefinitionById = new Map(workspaceDiscoveryCategories.map((category) => [category.id, category]));

function discoveryState(category, project, discovery) {
  if (!project || project.state === "unavailable" || discovery?.state === "unavailable") return "unavailable";
  if (!category || category.state === "unanswered") return "unavailable";
  if (project.state === "stale" || discovery?.state === "stale" || category.state === "signal") return "review";
  return category.state === "observed" ? "observed" : "unavailable";
}

function stateLabel(state) {
  if (state === "observed") return "Observed";
  if (state === "review") return "Needs review";
  return "Unavailable";
}

function EvidenceState({ state }) {
  return <span className={`component-evidence-state state-${state}`}>{state === "observed" ? <CheckCircleIcon weight="fill" /> : <WarningIcon weight="fill" />}{stateLabel(state)}</span>;
}

function catalogStatus(project, discovery) {
  if (!project || project.state === "unavailable" || discovery?.state === "unavailable") return { state: "unavailable", title: "Component evidence unavailable", detail: "No component catalog can be generated until project evidence is available." };
  if (project.state === "stale" || discovery?.state === "stale") return { state: "review", title: "Last-known discovery needs review", detail: "Refresh the census and discovery snapshot before generating component candidates." };
  if (!discovery) return { state: "unavailable", title: "Discovery has not been generated", detail: "The folder census is useful, but it does not identify component boundaries by itself." };
  if (discovery.counts?.observed > 0) return { state: "observed", title: "Discovery evidence is available", detail: "Observed facts may seed a review; they are not approved component contracts." };
  return { state: "review", title: "Discovery needs review", detail: "Resolve signals and unanswered areas before generating component candidates." };
}

function ImportedComponentCatalogStart({ activeProject, onOpenStructure, onToast }) {
  const projectContext = useOptionalProject();
  const currentProject = useRef(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const project = activeProject ?? null;
  const registration = project?.registration ?? null;
  currentProject.current = { projectId: project?.projectId, rootIdentity: registration?.rootIdentity, activeId: projectContext?.activeProject?.projectId };
  const onPublished = async (published) => {
    const projectId = project?.projectId, rootIdentity = registration?.rootIdentity;
    if (projectContext?.refreshComponent) {
      if (projectContext.activeProject?.projectId !== projectId) return;
      const result = await projectContext.refreshComponent(projectId);
      const current = currentProject.current;
      if (!mounted.current || current.projectId !== projectId || current.rootIdentity !== rootIdentity || current.activeId !== projectId) return;
      if (result?.status !== 'observed' || result.receipt?.catalogState !== 'current' || !published?.catalogHead || result.receipt.catalogHead?.revision !== published.catalogHead.revision || result.receipt.catalogHead?.contractDigest !== published.catalogHead.contractDigest) throw new Error('Saved component summary needs a fresh check.');
    }
    onToast?.('Component planning approval saved. App verification and execution remain separate.');
  };
  const { isAdvanced } = useViewMode();
  const census = project?.census ?? null;
  const discovery = project?.discovery ?? null;
  const status = catalogStatus(project, discovery);
  const observedCategories = new Map((discovery?.categories ?? []).map((category) => [category.id, category]));
  const extraCategories = (discovery?.categories ?? []).filter((category) => !discoveryDefinitionById.has(category.id));
  const categories = [
    ...workspaceDiscoveryCategories.map((definition) => ({ definition, evidence: observedCategories.get(definition.id) ?? null })),
    ...extraCategories.map((evidence) => ({ definition: { id: evidence.id, title: evidence.id, questions: ["Review this recorded discovery category before generating a component contract."] }, evidence })),
  ];
  const openStructure = () => {
    if (typeof onOpenStructure === "function") onOpenStructure();
    else onToast?.("Open Structure to refresh discovery evidence before creating component contracts.");
  };

  return <section className="workspace component-plans-workspace component-catalog-start" aria-label="Project component catalog start">
    <header className="component-plans-header component-intake-header">
      <div><span className="eyebrow">DEFINE · PROJECT COMPONENTS</span><h1>Component contracts</h1><p>Give each part of your app clear responsibilities, exact files and proof requirements. Draft answers stay separate from saved approvals. No Demo answers are copied into your project.</p></div>
      <div className={`component-intake-verdict state-${status.state}`}><EvidenceState state={status.state} /><span><small>DISCOVERY EVIDENCE</small><strong>{status.title}</strong><em>{status.detail}</em></span></div>
    </header>

    <section className="component-intake-facts" aria-label="Available project facts">
      <article><small>ACTIVE PROJECT</small><strong>{project?.name ?? "No project selected"}</strong><span>{project?.projectId ?? "Project identity unavailable"}</span></article>
      <article><small>REGISTERED FOLDER</small><strong>{registration?.rootLabel ?? "Unavailable"}</strong><span>{registration ? `${registration.adapter} · revision ${registration.registryRevision}` : "No redacted registration receipt"}</span></article>
      <article><small>{isAdvanced ? "BOUNDED CENSUS" : "FILES FOUND"}</small><strong>{census ? `${census.fileCount} files` : "Unavailable"}</strong><span>{census ? `${census.skippedCount} skipped${isAdvanced ? ` · digest ${census.digest.slice(0, 12)}` : ""}` : isAdvanced ? "No census receipt" : "Not scanned yet"}</span></article>
      <article><small>DISCOVERY SNAPSHOT</small><strong>{discovery ? `${discovery.counts.observed} observed · ${discovery.counts.signals} review` : "Unavailable"}</strong><span>{discovery ? `${discovery.counts.unanswered} unanswered · ${readableTime(discovery.generatedAt)}` : "Run discovery from Structure"}</span></article>
    </section>

    {project?.projectId ? <ComponentDraftPanel key={`${project.projectId}:${registration?.rootIdentity ?? 'unregistered'}`} projectId={project.projectId} onPublished={onPublished} onOpenStructure={onOpenStructure} /> : <p>Select a project before writing its component contracts.</p>}
    <details className="component-discovery-reference">
      <summary>Reference · folder intake and discovery evidence</summary>
      <p>A file count or framework signal is not a component boundary. Use the recorded evidence to answer the draft; review uncertain findings before approval.</p>
      <button type="button" className="secondary-button" onClick={openStructure}><ArrowRightIcon /> Review Structure intake</button>
      <section className="component-discovery-catalog" aria-label="Component discovery evidence">
        <header><span><small>PRE-CATALOG QUESTIONS</small><strong>What the project evidence can—and cannot—support</strong></span><span>{categories.length} evidence areas</span></header>
        <div className="component-discovery-grid">
          {categories.map(({ definition, evidence }) => {
            const state = discoveryState(evidence, project, discovery);
            return <article key={definition.id} className={`component-discovery-card state-${state}`} data-discovery-category={definition.id}>
              <header><code>{definition.id}</code><strong>{definition.title}</strong><EvidenceState state={state} /></header>
              <p>{evidence ? evidence.findingCount ? `${evidence.findingCount} discovery record${evidence.findingCount === 1 ? "" : "s"} captured.` : "No discovery records captured." : "This evidence area is not present in the project snapshot."}</p>
              {evidence?.findingIds?.length > 0 && <div className="component-finding-ids" aria-label={`${definition.id} finding references`}>{evidence.findingIds.map((id) => <code key={id}>{id}</code>)}</div>}
              <ul>{definition.questions.map((question) => <li key={question}>{question}</li>)}</ul>
            </article>;
          })}
        </div>
      </section>
    </details>
  </section>;
}

// "2026-10-01T09:30:00.000Z" -> the viewer's local date and time; never a raw ISO string.
export function readableTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "time unknown";
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ComponentPlansWorkspace({ onToast, activeProject, onOpenStructure }) {
  if (activeProject !== undefined && activeProject?.kind !== "demo") return <ImportedComponentCatalogStart activeProject={activeProject} onOpenStructure={onOpenStructure} onToast={onToast} />;
  return <DemoComponentPlansWorkspace onToast={onToast} />;
}

function DemoComponentPlansWorkspace({ onToast }) {
  const [draft] = useState(cloneSeed); const assessment = useMemo(() => assessComponentPlans(draft), [draft]); const [selectedId, setSelectedId] = useState("C001"); const [query, setQuery] = useState(""); const [selectedMap, setSelectedMap] = useState("M00"); const [mapOpen, setMapOpen] = useState(false); const [openSections, setOpenSections] = useState({ handover: true }); const [registry, setRegistry] = useState({ available: false, revision: 0, head: null, actor: null, error: "Connecting durable registry…" }); const tokenRef = useRef(null);
  const map = mapDefinitions.find((item) => item.id === selectedMap) ?? mapDefinitions[0]; const filtered = draft.components.filter((component) => `${component.id} ${component.name} ${component.scopeLabel} ${component.definition}`.toLowerCase().includes(query.trim().toLowerCase()));
  // The dossier always belongs to a component the list is showing; a search
  // that hides the selected one moves to the first match, or to none.
  const selected = filtered.find((component) => component.id === selectedId) ?? filtered[0] ?? null;
  useEffect(() => { let current = true; const controller = new AbortController(); (async () => { try { const session = await boundedFetch("/api/component-plans/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }, { signal: controller.signal }); if (!session.ok) throw new Error(`registry session ${session.status}`); const identity = await session.json(); tokenRef.current = identity.token; const response = await boundedFetch("/api/component-plans/inspect", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pp-component-token": identity.token }, body: JSON.stringify({ planId: draft.planId }) }, { signal: controller.signal }); const state = await response.json(); if (!response.ok) throw new Error(state.error); if (current) setRegistry({ available: true, actor: identity.actor, error: null, ...state }); } catch (error) { if (current) setRegistry({ available: false, revision: 0, head: null, actor: null, error: error.message }); } })(); return () => { current = false; controller.abort(); }; }, [draft.planId]);
  const toggle = (key) => setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  return <section className="workspace component-plans-workspace" aria-label="Detailed component plans">
    <header className="component-plans-header"><div><span className="eyebrow">STRICT PLAN · MEMORY IS NOT AUTHORITY</span><h1>Component Contracts</h1><p>Every architecture component has one numbered, detailed, cold-start-safe dossier. No worker may invent scope or edit a plausible file outside its exact claim.</p></div><div className={`component-catalog-state ${assessment.ready ? "sample" : "blocked"}`}>{assessment.ready ? <InfoIcon weight="fill" /> : <WarningIcon weight="fill" />}<span><small>CATALOG COVERAGE · SAMPLE</small><strong>{assessment.coverage.complete}/{assessment.coverage.required} · {assessment.coverage.percentage}%</strong><em>{assessment.ready ? "Sample · not saved · nothing was checked for your app" : `${assessment.blockers.length} ${assessment.blockers.length === 1 ? "blocker" : "blockers"}`}</em></span></div></header>
    <section className="component-summary-bar"><span><b>{assessment.coverage.interfaces}</b><small>typed interfaces</small></span><span><b>{assessment.coverage.fileClaims}</b><small>exact file claims</small></span><span><b>{assessment.naming.reservedNames.length}</b><small>reserved names</small></span><span><b>{mapDefinitions.length}</b><small>connected maps</small></span><button className="soft-button" onClick={() => setMapOpen((value) => !value)}><FlowArrowIcon /> {mapOpen ? "Close map atlas" : "Open map atlas"}</button><span className="demo-freeze-control"><button className="primary-button" disabled title={`${DEMO_ONLY_REASON}: sample contracts are never saved.`}><ShieldCheckIcon /> Freeze revision</button><DemoOnlyReason>sample contracts are never saved.</DemoOnlyReason></span></section>
    {mapOpen && <section className="component-map-atlas"><header><div><span className="eyebrow">CONNECTED TOP-DOWN MERMAID ATLAS</span><strong>{map.id} · {map.title}</strong></div><small>Each map owns one boundary; portal nodes connect the whole.</small></header><nav>{mapDefinitions.map((item) => <button className={item.id === map.id ? "active" : ""} key={item.id} onClick={() => setSelectedMap(item.id)}><code>{item.id}</code><span>{item.title}</span></button>)}</nav><pre aria-label={`${map.id} Mermaid source`}><code>{map.mermaid}</code></pre></section>}
    <div className="component-plans-layout">
      <aside className="component-catalog"><header><span><FolderSimpleIcon /><strong>Component inventory</strong><small>{query.trim() ? `${filtered.length} of ${draft.components.length} dossiers match` : `${draft.components.length} exact dossiers`}</small></span></header><label className="component-search"><MagnifyingGlassIcon /><input aria-label="Find component, scope, or purpose" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find component, scope, or purpose…" /></label><div className="component-catalog-list">{!filtered.length && <p className="component-search-empty" role="status">No component matches “{query.trim()}”. <button type="button" className="soft-button" onClick={() => setQuery("")}>Clear search</button></p>}{filtered.map((component) => <button key={component.id} className={component.id === selected?.id ? "active" : ""} onClick={() => { setSelectedId(component.id); setOpenSections({ handover: true }); }}><code>{component.id}</code><span><strong>{component.name}</strong><small>{component.scopeLabel}</small></span><em>{component.wave}</em><ArrowRightIcon /></button>)}</div><footer><span>{registry.available ? registry.head ? `Saved registry · revision ${registry.revision}` : "Registry connected · nothing saved" : "Registry unavailable"}</span><small>{registry.head ? registry.head.contractDigest.slice(0, 16) : registry.available ? "Sample contracts are never saved." : registry.error}</small></footer></aside>
      {!selected ? <article className="component-dossier component-dossier-empty"><p>No component is shown while the search matches nothing.</p></article> : <article className="component-dossier"><header className="component-dossier-header"><div><span><code>{selected.id}</code><em>{selected.kind}</em><em>{selected.folderNodeId}</em></span><h2>{selected.name}</h2><p>{selected.scopeLabel}</p></div><dl><div><dt>OWNER</dt><dd>{selected.owner}</dd></div><div><dt>REVIEWER</dt><dd>{selected.reviewer}</dd></div><div><dt>TASK</dt><dd>{selected.taskId}</dd></div><div><dt>P80 INPUT</dt><dd>{selected.estimateHours}h</dd></div></dl></header>
        <section className="component-definition"><div><small>THIS IS</small><p>{selected.definition}</p></div><div><small>THIS IS NOT</small><p>{selected.notThis}</p></div></section>
        <Disclosure id="component-handover" title="Cold-start handover" summary="Read this first; no chat history required" open={Boolean(openSections.handover)} onToggle={() => toggle("handover")}><div className="handover-summary"><strong>{selected.handover.summary}</strong><span><small>FIRST ACTION</small>{selected.handover.firstAction}</span><div><section><small>READ FIRST</small><TextList items={selected.handover.readFirst} /></section><section><small>DO NOT ASSUME</small><TextList items={selected.handover.doNotAssume} negative /></section></div></div></Disclosure>
        <Disclosure id="component-outcome" title="Purpose & definitive outcome" summary={selected.definitiveOutcome} open={Boolean(openSections.outcome)} onToggle={() => toggle("outcome")}><div className="paired-copy"><section><small>PURPOSE</small><p>{selected.purpose}</p></section><section><small>DEFINITIVE OUTCOME</small><p>{selected.definitiveOutcome}</p></section></div></Disclosure>
        <Disclosure id="component-boundaries" title="Responsibility boundary" summary={`${selected.responsibilities.length} owns · ${selected.nonResponsibilities.length} excluded`} open={Boolean(openSections.boundaries)} onToggle={() => toggle("boundaries")}><div className="paired-copy"><section><small>OWNS</small><TextList items={selected.responsibilities} /></section><section><small>DOES NOT OWN</small><TextList items={selected.nonResponsibilities} negative /></section></div></Disclosure>
        <Disclosure id="component-interfaces" title="Interfaces & dependencies" summary={`${selected.interfaces.length} interfaces · ${selected.dependencies.length} dependencies`} open={Boolean(openSections.interfaces)} onToggle={() => toggle("interfaces")}><div className="contract-table">{selected.interfaces.map((item) => <div key={item.id}><code>{item.id}</code><b>{item.direction}</b><span><strong>{item.name}</strong><small>{item.contract} · v{item.version}</small></span></div>)}</div>{selected.dependencies.map((dependency) => <div className="dependency-row" key={dependency.componentId}><code>{dependency.componentId}</code><span><strong>{dependency.reason}</strong><small>{dependency.critical ? `CRITICAL FALLBACK · ${dependency.fallback}` : "non-critical"}</small></span></div>)}</Disclosure>
        <Disclosure id="component-files" title="Files, naming & edit scope" summary={`${selected.fileClaims.length} exact claims · ${selected.fileNaming.allowedRoots.join(", ")}`} open={Boolean(openSections.files)} onToggle={() => toggle("files")}><div className="naming-policy"><span><small>REQUIRED NAME TERMS</small><b>{selected.fileNaming.requiredTerms.join(" · ")}</b></span><span><small>ALLOWED ROOTS</small><b>{selected.fileNaming.allowedRoots.join(" · ")}</b></span></div><div className="file-claims">{selected.fileClaims.map((file) => <div key={file.path}><FileCodeIcon /><code>{file.path}</code><b>{file.access}</b><small>{file.reason}</small></div>)}</div><div className="edit-rule"><strong>NEW FILE</strong><p>{selected.fileNaming.newFileRule}</p><strong>RENAME</strong><p>{selected.fileNaming.renameRule}</p></div></Disclosure>
        <Disclosure id="component-state" title="Data ownership & lifecycle" summary={`${selected.dataOwnership.classification} · ${selected.states.length} explicit states`} open={Boolean(openSections.state)} onToggle={() => toggle("state")}><dl className="data-rules"><div><dt>SOURCE OF TRUTH</dt><dd>{selected.dataOwnership.sourceOfTruth}</dd></div><div><dt>RETENTION</dt><dd>{selected.dataOwnership.retention}</dd></div><div><dt>DELETION</dt><dd>{selected.dataOwnership.deletion}</dd></div></dl><div className="state-flow">{selected.states.map((state, index) => <section key={state.name}><code>S{index + 1}</code><strong>{state.name}</strong><small>IN · {state.entry}</small><small>OUT · {state.exit}</small></section>)}</div></Disclosure>
        <Disclosure id="component-failure" title="Failure, security & privacy" summary={`${selected.failureModes.length} contingency · ${selected.security.threats.length} named threats`} open={Boolean(openSections.failure)} onToggle={() => toggle("failure")}><div className="failure-card">{Object.entries(selected.failureModes[0]).map(([key, value]) => <span key={key}><small>{key}</small><p>{value}</p></span>)}</div><div className="paired-copy"><section><small>TRUST BOUNDARY</small><p>{selected.security.trustBoundary}</p><TextList items={selected.security.capabilities} /></section><section><small>THREATS / PRIVACY</small><TextList items={selected.security.threats} negative /><p>{selected.security.privacy}</p></section></div></Disclosure>
        <Disclosure id="component-proof" title="Proof & acceptance" summary={`${selected.proof.tests.length} test groups · diff required · screenshot ${selected.proof.screenshotRequired ? "required" : "not required"}`} open={Boolean(openSections.proof)} onToggle={() => toggle("proof")}><div className="paired-copy"><section><small>ACCEPTANCE CRITERIA</small><TextList items={selected.proof.acceptanceCriteria} /></section><section><small>MACHINE PROOF</small><TextList items={selected.proof.tests} /></section></div></Disclosure>
        <Disclosure id="component-decisions" title="Decisions & assumptions" summary="Owned, evidenced, and validation-bound" open={Boolean(openSections.decisions)} onToggle={() => toggle("decisions")}><div className="decision-card"><CodeIcon /><span><strong>{selected.decisions[0].decision}</strong><p>{selected.decisions[0].reason}</p><small>{selected.decisions[0].owner} · {selected.decisions[0].evidence}</small></span></div><div className="decision-card assumption"><WarningIcon /><span><strong>{selected.assumptions[0].statement}</strong><p>{selected.assumptions[0].validation}</p><small>{selected.assumptions[0].owner}</small></span></div></Disclosure>
      </article>}
    </div>
  </section>;
}
