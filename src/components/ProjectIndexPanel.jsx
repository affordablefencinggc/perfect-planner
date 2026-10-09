import { useMemo, useState } from "react";
import { ArrowRightIcon, ListMagnifyingGlassIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useTaskDraftLedger } from "../project/useTaskDraftLedger.js";
import { taskDraftLink } from "../project/taskDraftMap.js";
import { buildProjectIndex, INDEX_KINDS, searchProjectIndex } from "../project/projectIndexModel.js";
import "./ProjectIndexPanel.css";

const WORKSPACE_NAMES = { ledger: "Ledger", structure: "Structure", blueprint: "Blueprint", components: "Components", plan: "Plan", evidence: "Evidence", build: "Build" };
const COUNT_LABELS = [["task", "tasks"], ["area", "discovery areas"], ["saved", "saved plans"], ["proof", "proof items"], ["file", "named files"], ["build", "build notes"]];

export function ProjectIndexPanel({ project, records, onWorkspace, store = null }) {
  const drafts = useTaskDraftLedger(project, store);
  const [query, setQuery] = useState("");
  const index = useMemo(
    () => buildProjectIndex({ project, ledger: drafts.ledger, sections: records?.sections ?? {} }),
    [project, drafts.ledger, records],
  );
  const results = useMemo(() => searchProjectIndex(index, query), [index, query]);
  const searching = query.trim().length > 0;

  function open(item) {
    if (item.taskId && item.workspace === "ledger" && drafts.binding && !drafts.stale && typeof window !== "undefined") {
      try { window.history.replaceState(window.history.state, "", taskDraftLink(window.location.href, drafts.binding, item.taskId)); } catch { /* link is a convenience */ }
    }
    onWorkspace?.(item.workspace);
  }

  return <section className="project-index-panel" aria-label="Project search">
    <header>
      <div><h2><ListMagnifyingGlassIcon aria-hidden="true" />Search this project</h2><p>Find tasks, discovery areas, saved plans, proof and the files your tasks name. Results open the page where each one lives.</p></div>
    </header>
    <label className="project-index-search"><MagnifyingGlassIcon aria-hidden="true" /><span className="sr-only">Search this project</span>
      <input type="search" value={query} maxLength={160} onChange={(event) => setQuery(event.target.value.slice(0, 160))} placeholder="Search tasks, areas, saved plans, proof and file names…" />
    </label>
    <p className="project-index-counts" aria-label="What is searchable">{COUNT_LABELS.map(([kind, label]) => `${index.counts[kind]} ${label}`).join(" · ")}</p>
    {drafts.busy && !drafts.ledger && <p role="status">Reading saved tasks…</p>}
    {drafts.error && <p role="alert" className="project-index-error">Saved tasks could not be read, so tasks are missing from search: {drafts.error}</p>}
    {drafts.stale && <p className="project-index-note">Saved tasks belong to an earlier folder scan. They are still searchable; review them in the Ledger.</p>}
    <p className="project-index-note">The folder scan keeps a count of {index.fileCount != null ? index.fileCount.toLocaleString() : "the"} files, not their names, so only files named in your tasks can be found here.</p>
    {searching && <div className="project-index-results" role="list" aria-label="Search results">
      {results.map((item) => <div role="listitem" key={item.key}><button type="button" className={`project-index-result kind-${item.kind}`} onClick={() => open(item)} aria-label={`${INDEX_KINDS[item.kind]} ${item.title} — open ${WORKSPACE_NAMES[item.workspace] ?? item.workspace}`}>
        <span className="project-index-kind">{INDEX_KINDS[item.kind]}</span>
        <span className="project-index-copy"><strong>{item.kind === "task" || item.kind === "area" ? `${item.id} · ${item.title}` : item.title}</strong><small>{item.detail}</small></span>
        <span className="project-index-open">{WORKSPACE_NAMES[item.workspace] ?? item.workspace}<ArrowRightIcon aria-hidden="true" /></span>
      </button></div>)}
      {!results.length && <p className="project-index-empty">Nothing in this project matches “{query.trim()}”.</p>}
    </div>}
  </section>;
}
