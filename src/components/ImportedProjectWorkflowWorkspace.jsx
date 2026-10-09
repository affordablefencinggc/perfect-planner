import { lazy, Suspense, useMemo, useState } from "react";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  FileMagnifyingGlassIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  ShieldWarningIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { deriveImportedProjectWorkflowModel } from "../project/importedProjectWorkflowModel.js";
import { useProjectWorkRecords } from "../project/useProjectWorkRecords.js";
import { useTaskDraftLedger } from "../project/useTaskDraftLedger.js";
import { workspacePanels } from "./workspacePanels.js";
import { usePlanTaskDriftWatch } from "../project/usePlanApproval.js";
import { focusRequirementTarget } from "./focusRequirementTarget.js";
import { ProjectTruthGate } from "./ProjectTruthGate.jsx";
const TaskDraftLedger = lazy(() => import("./TaskDraftLedger.jsx").then(module => ({ default: module.TaskDraftLedger })));
const TaskDraftMap = lazy(() => import("./TaskDraftMap.jsx").then(module => ({ default: module.TaskDraftMap })));
import "./ImportedProjectWorkflowWorkspace.css";

const STATE_LABELS = Object.freeze({
  recorded: "Recorded",
  review: "Needs review",
  unanswered: "Unanswered",
  stale: "Stale",
  unavailable: "Unavailable",
});

function StateMark({ state }) {
  const label = STATE_LABELS[state] ?? "Unavailable";
  const Icon = state === "recorded"
    ? CheckCircleIcon
    : state === "stale"
      ? ClockCounterClockwiseIcon
      : state === "unavailable"
        ? ShieldWarningIcon
        : WarningIcon;
  return <span className={`imported-workflow-state state-${state}`}><Icon weight={state === "recorded" ? "fill" : "regular"} aria-hidden="true" />{label}</span>;
}

function selectedItem(item, model) {
  return {
    id: item.id,
    title: item.label,
    status: item.state === "recorded" ? "ready" : item.state === "review" || item.state === "stale" ? "active" : "queued",
    estimate: STATE_LABELS[item.state] ?? "Unavailable",
    items: [
      item.detail,
      item.source ? `Source record: ${item.source}` : "No source record is saved for this requirement.",
      `Project: ${model.project.projectId}`,
      `Scan: ${model.project.generation}`,
    ],
  };
}

function RequirementList({ model, onSelect, query }) {
  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery
    ? model.requirements.filter((item) => `${item.id} ${item.label} ${item.detail} ${item.state}`.toLowerCase().includes(normalizedQuery))
    : model.requirements;

  return <div className="imported-workflow-requirements" role="list" aria-label={`${model.copy.title} requirements`}>
    {visible.map((item, index) => <div key={item.id} role="listitem" className="imported-workflow-requirement-item"><button
      type="button"
      data-requirement-id={item.id}
      aria-label={`${item.id} ${item.label} — ${STATE_LABELS[item.state] ?? "Unavailable"}`}
      className={`imported-workflow-requirement state-${item.state}`}
      onClick={() => onSelect?.(selectedItem(item, model))}
    >
      <span className="imported-workflow-requirement-number">{String(index + 1).padStart(2, "0")}</span>
      <code className="advanced-only">{item.id}</code>
      <span className="imported-workflow-requirement-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
      <StateMark state={item.state} />
    </button></div>)}
    {!visible.length && <p className="imported-workflow-search-empty">No project record or question matches “{query}”.</p>}
  </div>;
}

function QuestionMap({ model, onSelect, query }) {
  const normalizedQuery = query.trim().toLowerCase();
  const questions = normalizedQuery
    ? model.questions.filter((item) => `${item.id} ${item.title} ${item.questions.join(" ")} ${item.findingIds.join(" ")}`.toLowerCase().includes(normalizedQuery))
    : model.questions;
  if (!questions.length && !normalizedQuery) return null;

  return <section className="imported-workflow-question-section" aria-label="Unanswered project planning questions">
    <header><span><ListChecksIcon aria-hidden="true" /><strong>{model.workspace === "index" ? "Discovery question index" : "Questions that still need sourced answers"}</strong></span><small>{questions.length} of {model.questions.length} areas</small></header>
    <div className="imported-workflow-question-grid">
      {questions.map((item) => <button
        key={item.id}
        type="button"
        aria-label={`${item.id} ${item.title} — ${STATE_LABELS[item.state] ?? "Unavailable"}`}
        className={`imported-workflow-question state-${item.state}`}
        onClick={() => onSelect?.({
          id: item.id,
          title: item.title,
          status: item.state === "recorded" ? "ready" : item.state === "review" || item.state === "stale" ? "active" : "queued",
          estimate: STATE_LABELS[item.state],
          items: [
            item.findingIds.length ? `Saved finding references: ${item.findingIds.join(", ")}` : "No finding record is saved for this area.",
            ...item.questions.map((question) => `Unanswered: ${question}`),
            `Project: ${model.project.projectId}`,
          ],
        })}
      >
        <span><code className="advanced-only">{item.id}</code><strong>{item.title}</strong></span>
        <StateMark state={item.state} />
        {item.findingIds.length > 0 && <small className="imported-workflow-finding-ids advanced-only">Finding references: {item.findingIds.join(" · ")}</small>}
        <ul>{item.questions.map((question) => <li key={question}>{question}</li>)}</ul>
      </button>)}
      {!questions.length && <p className="imported-workflow-search-empty">No discovery question matches “{query}”.</p>}
    </div>
  </section>;
}

export function ImportedProjectWorkflowWorkspace({
  workspace,
  activeProject,
  onWorkspace,
  onSelect,
}) {
  const records = useProjectWorkRecords(activeProject?.projectId);
  usePlanTaskDriftWatch(activeProject, records);
  useTaskDraftLedger(activeProject); // keeps the "saved task drafts" requirement current
  const model = useMemo(
    () => deriveImportedProjectWorkflowModel(activeProject, workspace, records),
    [activeProject, workspace, records],
  );
  const [query, setQuery] = useState("");
  const firstOpen = model.requirements.find((item) => item.state !== "recorded") ?? null;
  const showSearch = workspace === "ledger" || (workspace === "index" && !workspacePanels.index);
  const handleNext = (event) => {
    if (model.nextAction.workspace && model.nextAction.workspace !== workspace) {
      onWorkspace?.(model.nextAction.workspace);
      return;
    }
    // This page owns the open requirement: bring its own panel (or row) into view.
    focusRequirementTarget(event.currentTarget.closest(".imported-workflow-workspace"), model.nextAction.target);
    if (firstOpen) onSelect?.(selectedItem(firstOpen, model));
  };

  return <section
    className={`workspace imported-workflow-workspace imported-workflow-${workspace}`}
    aria-label={`${model.project.name} ${workspace} workflow`}
    data-project-id={model.project.projectId}
    data-project-generation={model.project.generation}
    data-page-state={model.pageState}
  >
    <ProjectTruthGate
      projectSession={activeProject}
      provenance={{
        field: `${model.copy.title} binding`,
        value: model.pageState,
        projectId: model.binding.projectId,
        generation: model.binding.sessionGeneration,
        digest: model.binding.censusDigest,
        revision: model.binding.registryRevision,
        authorityReason: firstOpen?.detail ?? "All represented receipts are recorded.",
      }}
      workspaceLabel={model.copy.title}
      workspaceState={model.pageState === "recorded" ? "ready" : activeProject.state}
      showWorkspaceState={false}
    />

    <header className="imported-workflow-header">
      <div>
        <span className="eyebrow">{model.copy.eyebrow}</span>
        <h1>{model.copy.title}</h1>
        <p>{workspace === "plan" ? "Review the saved task drafts before approving work." : model.copy.purpose}</p>
      </div>
      <div className={`imported-workflow-verdict state-${model.pageState}`}>
        {model.pageState === "recorded" ? <CheckCircleIcon weight="fill" aria-hidden="true" /> : <WarningIcon weight="fill" aria-hidden="true" />}
        <span><small>CURRENT PROJECT STATE</small><strong>{model.pageState === "recorded" ? "RECORDS SAVED" : model.pageState === "stale" ? "STALE — REFRESH REQUIRED" : model.pageState === "unavailable" ? "APPROVAL UNAVAILABLE" : "Not done yet"}</strong><em>No Demo tasks, people, dates, collisions, or proof are shown.</em></span>
      </div>
    </header>

    {workspace === "ledger" && <Suspense fallback={<p role="status">Opening task drafts…</p>}><TaskDraftLedger project={activeProject} /></Suspense>}
    {workspace === "plan" && <Suspense fallback={<p role="status">Opening the saved task map…</p>}><TaskDraftMap project={activeProject} onWorkspace={onWorkspace} /></Suspense>}

    {workspacePanels[workspace] && (() => { const FeaturePanel = workspacePanels[workspace]; return <Suspense fallback={<p role="status">Opening this step…</p>}><FeaturePanel project={activeProject} records={records} onWorkspace={onWorkspace} onSelect={onSelect} /></Suspense>; })()}

    <section className="imported-workflow-context" aria-label="Workspace contract">
      <article><small>PURPOSE</small><span>{model.copy.purpose}</span></article>
      <article><small>REQUIRED OUTCOME</small><span>{model.copy.outcome}</span></article>
      <article><small>UNLOCK NEXT</small><span>{model.copy.unlock}</span></article>
    </section>

    <section className="imported-workflow-summary" aria-label="Workflow record summary">
      <span><b>{model.counts.recorded}</b><small>recorded</small></span>
      <span><b>{model.counts.review}</b><small>needs review</small></span>
      <span><b>{model.counts.unanswered}</b><small>unanswered or unavailable</small></span>
      <span><b>—</b><small>{workspace === "collision" ? (records?.sections?.collisions ? "overlap check saved above" : "collisions not evaluated") : workspace === "allocation" ? (records?.sections?.allocation ? "owners saved above" : "owners not allocated") : workspace === "build" ? "statuses are set by you" : workspace === "evidence" ? "proof not claimed" : "no inferred completion"}</small></span>
    </section>

    {showSearch && <label className="imported-workflow-search"><MagnifyingGlassIcon aria-hidden="true" /><span className="sr-only">Search current project evidence</span><input value={query} maxLength={160} onChange={(event) => setQuery(event.target.value.slice(0, 160))} placeholder="Search this project’s saved records and questions…" /></label>}

    <div className="imported-workflow-layout">
      <main className="imported-workflow-main">
        <section className="imported-workflow-panel">
          <header><span><FileMagnifyingGlassIcon aria-hidden="true" /><strong>{workspace === "ledger" ? "Saved and missing ledger approvals" : workspace === "index" ? "Indexed record sources" : "Required project records"}</strong></span><small>{model.counts.recorded}/{model.counts.total} recorded</small></header>
          <p>Every row is derived from this project’s validated session. “Unanswered” means no matching record is saved; it does not mean zero.</p>
          <RequirementList model={model} onSelect={onSelect} query={query} />
        </section>
        <QuestionMap model={model} onSelect={onSelect} query={query} />
      </main>

      <aside className="imported-workflow-aside">
        <section className="imported-workflow-panel imported-workflow-binding advanced-only">
          <header><span><ShieldWarningIcon aria-hidden="true" /><strong>Scan binding</strong></span></header>
          <dl>
            <div><dt>Project</dt><dd>{model.binding.projectId}</dd></div>
            <div><dt>Scan</dt><dd>{model.binding.sessionGeneration}</dd></div>
            <div><dt>Registry revision</dt><dd>{model.binding.registryRevision ?? "Unavailable"}</dd></div>
            <div><dt>Folder scan fingerprint</dt><dd>{model.binding.censusDigest ? `${model.binding.censusDigest.slice(0, 12)}…` : "Unavailable"}</dd></div>
          </dl>
        </section>

        <section className="imported-workflow-panel imported-workflow-caveats" aria-label="Status boundaries">
          <header><span><WarningIcon aria-hidden="true" /><strong>Status boundaries</strong></span></header>
          <ul>{model.caveats.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>

        <section className="imported-workflow-panel imported-workflow-next">
          <header><span><ArrowRightIcon aria-hidden="true" /><strong>Next honest action</strong></span></header>
          <p>{model.nextAction.reason}</p>
          <button type="button" className="primary-button" onClick={handleNext}><ArrowRightIcon aria-hidden="true" />{model.nextAction.label}</button>
          <small>The action opens the relevant evidence surface. It does not approve, assign, build, or prove work.</small>
        </section>
      </aside>
    </div>
  </section>;
}
