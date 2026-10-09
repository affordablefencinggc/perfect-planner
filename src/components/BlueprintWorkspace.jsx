import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ListChecksIcon,
  ShieldCheckIcon,
  TreeStructureIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { buildBlueprintWorkspaceModel } from "../engine/blueprintWorkspaceModel.js";
import { workspaceDiscoveryCategories } from "../engine/workspaceDiscoveryEngine.js";
import "./BlueprintWorkspace.css";
import { DEMO_ONLY_REASON, DemoOnlyReason } from "../demo/DemoSampleNotice.jsx";
import { ArchitectureDraftPanel } from "./ArchitectureDraftPanel.jsx";
import { inspectArchitecture } from "../runtime/architectureClient.js";
import { useOptionalProject } from "../project/ProjectProvider.jsx";
import { useProjectWorkRecords } from "../project/useProjectWorkRecords.js";
import { deriveDiscoveryReview } from "../project/discoveryReviewModel.js";

const gateStatus = (gate) => gate.status === "clear" ? "verified" : gate.status === "unknown" ? "queued" : "blocked";
const statusLabel = { verified: "verified", blocked: "hard stop", queued: "unknown" };

function StatusChip({ status, children }) {
  return <span className={`status-chip status-${status}`}>{children ?? statusLabel[status] ?? status}</span>;
}

const authorityLabels = Object.freeze({ architecture: "Architecture", folder: "Folder contract", component: "Components", plan: "Plan" });

function evidenceLabel(state) {
  if (state === "observed" || state === "authoritative" || state === "imported") return "Observed";
  if (state === "signal" || state === "generated" || state === "stale") return "Needs review";
  return "Unavailable";
}

function evidenceTone(state) {
  const label = evidenceLabel(state);
  return label === "Observed" ? "observed" : label === "Needs review" ? "review" : "unavailable";
}

function EvidenceLabel({ state }) {
  const label = evidenceLabel(state);
  return <span className={`blueprint-evidence-label evidence-${evidenceTone(state)}`}>{label}</span>;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function shortDigest(value) {
  return typeof value === "string" && value ? `${value.slice(0, 12)}…` : null;
}

function ImportedProjectBlueprint({ activeProject, onSelect, onOpenStructure }) {
  const projectContext=useOptionalProject();
  const [savedArchitecture, setSavedArchitecture] = useState(null);
  const [architectureError,setArchitectureError]=useState(false);
  const architectureRequest=useRef(0);
  const workRecords=useProjectWorkRecords(activeProject.projectId);
  const discoveryReview=useMemo(()=>deriveDiscoveryReview(activeProject,workRecords),[activeProject,workRecords]);
  const hasProvider=Boolean(projectContext);
  useEffect(() => {
    const request=++architectureRequest.current;
    setSavedArchitecture(null);
    setArchitectureError(false);
    if(hasProvider)return;
    inspectArchitecture(activeProject.projectId).then((state) => {
      if (request===architectureRequest.current) setSavedArchitecture(state);
    }).catch(() => { if (request===architectureRequest.current) setArchitectureError(true); });
    return () => { architectureRequest.current++; };
  }, [activeProject.projectId,hasProvider]);
  const registration = activeProject.registration ?? null;
  const census = activeProject.census ?? null;
  const discovery = activeProject.discovery ?? null;
  const categoryReceipts = new Map((discovery?.categories ?? []).map((category) => [category.id, category]));
  const providerProject=projectContext?.projects?.find(project=>project.projectId===activeProject.projectId)??(projectContext?.activeProject?.projectId===activeProject.projectId?projectContext.activeProject:null);
  const architectureAuthority = hasProvider ? providerProject?.authorities?.architecture??null : savedArchitecture?.head ? { state: architectureError?'unavailable':"authoritative", revision: savedArchitecture.head.revision, digest: savedArchitecture.head.contractDigest } : null;
  const projectUnavailable = activeProject.state === "unavailable";
  const projectStale = activeProject.state === "stale" || discovery?.state === "stale";
  const overallState = projectUnavailable||architectureAuthority?.state==='unavailable'||architectureError ? "unavailable" : architectureAuthority?.state === "authoritative" ? "observed" : architectureAuthority?.state==='stale'?'stale':"generated";
  const censusState = projectUnavailable ? "unavailable" : projectStale ? "stale" : census ? "observed" : "unavailable";
  const registrationState = projectUnavailable ? "unavailable" : registration ? "observed" : "unavailable";
  const discoveryState = projectUnavailable ? "unavailable" : projectStale ? "stale" : discovery ? "generated" : "unavailable";

  return (
    <section className="workspace blueprint-workspace imported-blueprint-workspace" aria-label={`${activeProject.name} blueprint evidence`} data-project-id={activeProject.projectId}>
      <header className="imported-blueprint-header">
        <div>
          <span className="eyebrow">P0 · Evidence-backed intake</span>
          <h1>{activeProject.name}</h1>
          <p>This Blueprint shows only redacted project-session receipts. Metadata observations and generated discovery signals stay separate from verified architecture.</p>
        </div>
        <div className={`imported-blueprint-verdict verdict-${evidenceTone(overallState)}`}>
          {overallState === "observed" ? <CheckCircleIcon weight="fill" /> : overallState === "unavailable" ? <XCircleIcon weight="fill" /> : <WarningIcon weight="fill" />}
          <span><small>Blueprint decision</small><strong>{overallState === "observed" ? "AUTHORITY RECORDED" : overallState === "unavailable" ? "EVIDENCE UNAVAILABLE" : overallState==='stale'?'REFRESH REQUIRED':"REVIEW REQUIRED"}</strong><em>{architectureAuthority?.state === "authoritative" ? `Architecture authority revision ${architectureAuthority.revision} is recorded.` : architectureAuthority ? `Last known architecture revision ${architectureAuthority.revision}; current approval has not been confirmed.` : architectureError||projectContext?.architectureRefreshStatus?.state==='unavailable' ? 'Saved architecture could not be checked. Its current status is unknown.' : "No authoritative architecture contract is recorded."}</em></span>
          <EvidenceLabel state={overallState} />
        </div>
      </header>

      <section className="imported-blueprint-facts" aria-label="Observed project facts">
        <article>
          <header><TreeStructureIcon /><span>Workspace receipt</span><EvidenceLabel state={registrationState} /></header>
          {registration ? <><strong>{registration.rootLabel}</strong><p>{registration.adapter} adapter · {registration.access}</p><small>Registry revision {registration.registryRevision} · {registration.persistence}</small></> : <><strong>Unavailable</strong><p>No redacted workspace registration receipt is present.</p></>}
        </article>
        <article>
          <header><ActivityIcon /><span>Census receipt</span><EvidenceLabel state={censusState} /></header>
          {census ? <><strong>{census.fileCount.toLocaleString()} files indexed</strong><p>{census.skippedCount} skipped{formatBytes(census.totalBytesHashed) ? ` · ${formatBytes(census.totalBytesHashed)} hashed` : ""}</p><small>Fingerprint {shortDigest(census.digest)} · {new Date(census.generatedAt).toLocaleString()}</small></> : <><strong>Unavailable</strong><p>No authoritative metadata census receipt is present.</p></>}
        </article>
        <article>
          <header><ListChecksIcon /><span>Discovery snapshot</span><EvidenceLabel state={discoveryState} /></header>
          {discovery ? <><strong>{discovery.counts.observed} observed · {discovery.counts.signals} signals</strong><p>{workspaceDiscoveryCategories.reduce((total, category) => total + category.questions.length, 0)} open review questions · {discovery.counts.unanswered} areas without metadata findings.</p><small>Generated from census {shortDigest(discovery.censusDigest)}; not architecture proof. Findings do not answer these questions.</small></> : <><strong>Unavailable</strong><p>No sanitized discovery snapshot is present.</p></>}
        </article>
      </section>

      {census?.skippedCount > 0 && <div className="imported-blueprint-caveat" role="note"><WarningIcon weight="fill" /><span><strong>Coverage needs review</strong><small>{census.skippedCount} entries were skipped by the bounded census. Their contents and architecture impact are unknown.</small></span><EvidenceLabel state="signal" /></div>}

      <div className="imported-blueprint-layout">
        <section className="blueprint-panel imported-discovery-panel">
          <header><span><ListChecksIcon /><strong>Discovery review map</strong></span><small>{discovery ? `${discovery.categories.length} sanitized categories` : "No discovery receipt"}</small></header>
          <p>Finding IDs and counts are traceable metadata receipts. The questions remain unanswered until a person or connected authority supplies evidence.</p>
          <div className="imported-review-grid">
            {workspaceDiscoveryCategories.map((definition) => {
              const receipt = categoryReceipts.get(definition.id) ?? null;
              const receiptState = projectUnavailable ? "unavailable" : projectStale && receipt ? "stale" : receipt?.state ?? "unavailable";
              const count = receipt?.findingCount;
              const receiptIds = receipt?.findingIds ?? [];
              return (
                <button key={definition.id} type="button" onClick={() => onSelect?.({ id: definition.id, title: definition.title, status: evidenceTone(receiptState) === "observed" ? "ready" : evidenceTone(receiptState) === "review" ? "active" : "queued", estimate: receipt ? `${count} metadata receipt${count === 1 ? "" : "s"}` : "no receipt", items: [`Provenance: ${evidenceLabel(receiptState)}`, receiptIds.length ? `Finding receipts: ${receiptIds.join(", ")}` : "No finding receipt is stored for this area.", ...definition.questions.map((question) => `Review question: ${question}`)] })}>
                  <span className="imported-review-heading"><code>{definition.id}</code><strong>{definition.title}</strong><EvidenceLabel state={receiptState} /></span>
                  <span className="imported-review-receipt">{receipt ? `${count} sanitized metadata finding${count === 1 ? "" : "s"}${receiptIds.length ? ` · ${receiptIds.join(" · ")}` : ""}` : "No discovery evidence recorded"}</span>
                  <span className="imported-review-questions">{definition.questions.map((question) => <span key={question}><b>?</b>{question}</span>)}</span>
                </button>
              );
            })}
          </div>
        </section>

        <aside className="imported-blueprint-side">
          <section className="blueprint-panel imported-authority-panel">
            <header><span><ShieldCheckIcon /><strong>Authority boundary</strong></span><EvidenceLabel state={architectureAuthority?.state ?? "unavailable"} /></header>
            <p>Receipts below are displayed exactly as recorded. Generated records require review and missing records stay unavailable.</p>
            <div className="imported-authority-list">
              {Object.entries(authorityLabels).map(([key, label]) => {
                const authority = key === "architecture" ? architectureAuthority : activeProject.authorities?.[key] ?? null;
                const state = authority?.state ?? "unavailable";
                return <article key={key}><span><strong>{label}</strong><small>{authority ? `${authority.state} · revision ${authority.revision} · ${shortDigest(authority.digest)}` : "No authority receipt recorded"}</small></span><EvidenceLabel state={state} /></article>;
              })}
            </div>
          </section>

          <section className="blueprint-panel imported-next-step">
            <header><span><ArrowRightIcon /><strong>Next honest action</strong></span><EvidenceLabel state="signal" /></header>
            <p>Review the metadata map, answer the open questions with sourced evidence, and create an architecture contract. Nothing on this page auto-approves a design.</p>
            <button className="primary-button" type="button" onClick={onOpenStructure}><TreeStructureIcon /> Open Structure evidence</button>
            <small>Use the architecture draft below to record decisions and explicitly approve a complete contract.</small>
          </section>
        </aside>
      </div>
      <ArchitectureDraftPanel key={activeProject.projectId} projectId={activeProject.projectId} discoveryReview={discoveryReview} onPublished={(receipt)=>{architectureRequest.current++;if(hasProvider){projectContext.refreshArchitecture?.(activeProject.projectId);}else{setSavedArchitecture(receipt);setArchitectureError(false);}}} />
    </section>
  );
}

export function BlueprintWorkspace({ onSelect, onOpenStructure, activeProject = null }) {
  if (activeProject && activeProject.kind !== "demo") return <ImportedProjectBlueprint activeProject={activeProject} onSelect={onSelect} onOpenStructure={onOpenStructure} />;
  return <DemoBlueprintWorkspace onSelect={onSelect} onOpenStructure={onOpenStructure} />;
}

function DemoBlueprintWorkspace({ onSelect, onOpenStructure }) {
  const model = useMemo(() => buildBlueprintWorkspaceModel(), []);
  const map = model.rulebook.executionMap;
  // The Demo debt scan is a fixed sample; no analyzer ran, so it never shows as cleared.
  const gates = model.gates.map((gate) => gate.id === "G-DEBT" ? { ...gate, status: "unknown", verdict: "SAMPLE ONLY", metric: "sample", detail: "Sample scan result. No analyzer ran in the Demo." } : gate);
  return (
    <section className="workspace blueprint-workspace" aria-label="Blueprint decision gates">
      <header className="blueprint-header">
        <div><span className="eyebrow">P0 · Before architecture</span><h1>Blueprint Gate</h1><p>Planning cannot enter the build spine until the business case, exact architecture template, named folder contract, compatibility rules, evidence, contingencies, decisions, and debt coverage agree.</p></div>
        <div className="blueprint-verdict"><XCircleIcon weight="fill" /><span><small>Current decision</small><strong>{model.verdict}</strong><em>Next: {model.nextAction}</em></span></div>
      </header>

      <section className="blueprint-gates" aria-label="Blueprint gate status">
        {gates.map((gate) => (
          <button key={gate.id} className={`blueprint-gate gate-${gate.status}`} onClick={() => onSelect({ id: gate.id, title: gate.title, status: gateStatus(gate), estimate: gate.metric, items: [gate.verdict, gate.detail, "This gate cannot be manually rounded up to green."] })}>
            <span className="blueprint-gate-icon">{gate.status === "clear" ? <CheckCircleIcon weight="fill" /> : gate.status === "unknown" ? <WarningIcon weight="fill" /> : <XCircleIcon weight="fill" />}</span>
            <span><code>{gate.id}</code><strong>{gate.title}</strong><small>{gate.detail}</small></span>
            <span><b>{gate.metric}</b><StatusChip status={gateStatus(gate)}>{gate.verdict}</StatusChip></span>
          </button>
        ))}
      </section>

      <div className="blueprint-layout">
        <section className="blueprint-panel decision-panel">
          <header><span><ListChecksIcon /><strong>Required contracts</strong></span><small>{model.decisions.length} unanswered</small></header>
          <p>Each stable number is a named contract. It cannot drift around the conversation and reappear after implementation has begun.</p>
          <div className="decision-list">
            {model.decisions.map((decision) => <button key={decision.id} onClick={() => onSelect({ id: decision.id, title: decision.title, status: "blocked", estimate: decision.source, items: [`Contract key: ${decision.key}`, "Answer with evidence or an explicit bounded assumption.", "Record an owner, validation date, and fallback before clearing."] })}><code>{decision.id}</code><span><strong>{decision.title}</strong><small>{decision.source}</small></span><StatusChip status="blocked">required</StatusChip><ArrowRightIcon /></button>)}
          </div>
        </section>

        <section className="blueprint-panel evidence-requirements">
          <header><span><ShieldCheckIcon /><strong>Evidence coverage</strong></span><small>No confident zeros</small></header>
          <p>Counts represent sourced records currently present, not model estimates or placeholders.</p>
          <div className="coverage-list">
            {model.evidence.map((item) => {
              const percent = Math.min(100, Math.round(item.count / item.target * 100));
              return <button key={item.id} onClick={() => onSelect({ id: item.id, title: item.title, status: item.count >= item.target ? "ready" : "blocked", estimate: `${item.count}/${item.target}`, items: [item.note, "Every source needs a date and confidence level.", "Stale or missing evidence remains visible."] })}><span><code>{item.id}</code><strong>{item.title}</strong><small>{item.note}</small></span><span className="coverage-meter"><i style={{ width: `${percent}%` }} /></span><b>{item.count}/{item.target}</b></button>;
            })}
          </div>
          <div className="economics-unknown"><WarningIcon weight="fill" /><span><strong>Economics intentionally blank</strong><small>P50/P80 cost, margin, runway, and delivery stay empty until evidence-backed ranges and team pace are supplied.</small></span></div>
        </section>

        <section className="blueprint-panel architecture-choice">
          <header><span><TreeStructureIcon /><strong>Exact architecture contract</strong></span><StatusChip status="blocked">not cleared</StatusChip></header>
          <div className="template-card"><span className="template-key">AI</span><span><strong>{model.rulebook.template?.title}</strong><small>{model.rulebook.template?.id}@{model.rulebook.template?.version} · {model.rulebook.template?.platform}</small></span><b>{model.decisions.length} open</b></div>
          <div className="architecture-rule"><strong>Compatibility result</strong><p>{model.rulebook.blockers[0] ?? "The selected platform is compatible, but bounded native execution still requires mitigation and proof before architecture may begin."}</p></div>
          <div className="rulebook-coverage"><span><b>{model.rulebook.scenarioCoverage.present}/{model.rulebook.scenarioCoverage.required}</b><small>failure scenarios</small></span><span><b>{model.rulebook.decisionCoverage.present}/{model.rulebook.decisionCoverage.required}</b><small>architecture decisions</small></span><span><b>{model.rulebook.capabilityAssessment.length}</b><small>capability assessed</small></span></div>
          <button className="primary-button" disabled title={`${DEMO_ONLY_REASON}: the sample gates never clear.`}><ShieldCheckIcon /> Enter planning spine</button>
          <DemoOnlyReason className="button-explanation">the sample gates never clear, so this stays off. In a real project it unlocks once all four gates are clear.</DemoOnlyReason>
        </section>

        <section className="blueprint-panel rulebook-map-panel">
          <header><span><TreeStructureIcon /><strong>Top-down build path</strong></span><small>{map.nodes.length} ordered stages</small></header>
          <p>This is the selected template's required path. Parallel packages may branch beneath a stage, but evidence cannot skip the stage contract.</p>
          <div className="rulebook-map" aria-label="Seven-stage top-down architecture map">
            {map.nodes.map((node, index) => <button key={node.id} onClick={() => onSelect({ id: node.id, title: node.stage.replace(/-/g, " "), status: index === 0 ? "ready" : "blocked", estimate: `${index + 1}/${map.nodes.length}`, items: [`Template: ${map.template}`, `Predecessor: ${index ? map.nodes[index - 1].id : "none"}`, "Stage exit requires recorded proof before dependent work advances."] })}><code>{node.id}</code><strong>{node.stage.replace(/-/g, " ")}</strong><span>{index ? "locked by predecessor" : "current entry"}</span></button>)}
          </div>
        </section>

        <section className="blueprint-panel debt-coverage-panel">
          <header><span><ActivityIcon /><strong>Debt coverage contract</strong></span><StatusChip status="queued">SAMPLE ONLY</StatusChip></header>
          <div className="debt-surface-grid">{["ui", "engine", "storage", "native"].map((surface) => (
            <button key={surface} onClick={() => onSelect({ id: `DEBT-${surface.toUpperCase()}`, title: `${surface} debt coverage`, status: "queued", estimate: "sample", items: ["Sample scan entry from the Demo project.", "No analyzer ran here, so nothing was checked for this surface.", "Coverage for a real project only counts once its own scan has run."] })}><WarningIcon weight="fill" /><strong>{surface}</strong><small>sample</small></button>
          ))}</div>
          <p className="debt-truth">Sample findings: {model.debt.counts.medium} medium · weighted open {model.debt.weightedOpen}. No analyzer ran in the Demo, so this is not a coverage result.</p>
        </section>

        <section className="blueprint-panel folder-contract-panel">
          <header><span><TreeStructureIcon /><strong>Virtual folder contract</strong></span><button className="soft-button" onClick={onOpenStructure}>Open structure builder <ArrowRightIcon /></button></header>
          <p>These are named future surfaces, not empty-folder theatre. Approval freezes their identity, ownership, creation wave, and collision policy before any worker improvises a location.</p>
          <div className="folder-contract-summary"><span><b>{model.folderContract.nodes.length}</b><small>named paths</small></span><span><b>{model.folderContract.reservations.length}</b><small>forward reservations</small></span><span><b>0</b><small>physically created</small></span></div>
          <div className="folder-contract-tree">{model.folderContract.nodes.map((node) => {
            const depth = node.path.split("/").length - 1;
            return <button key={node.id} style={{ "--folder-depth": depth }} onClick={() => onSelect({ id: node.id, title: node.path, status: "blocked", estimate: node.createAtStage, items: [`Purpose: ${node.purpose}`, `Owner: ${node.owner} · task ${node.taskId}`, `Policy: ${node.changePolicy}`, `Allowed: ${node.allowedContents}`, `Rename: ${node.renameFallback}`] })}><code>{node.id}</code><span><strong>{node.path.split("/").at(-1)}</strong><small>{node.path}</small></span><em>{node.owner}</em><b>{node.createAtStage}</b><ArrowRightIcon /></button>;
          })}</div>
          <div className="folder-contract-rule"><WarningIcon weight="fill" /><span><strong>Rename means replan</strong><small>Adding, removing, or renaming a reserved path requires architecture approval and a collision rescan across every dependent plan.</small></span></div>
        </section>
      </div>
    </section>
  );
}
