import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
} from "@phosphor-icons/react";
import { AdvancedOnly, CoreError, CoreLoading, CoreScreen, useAdvanced } from "./CoreScreen.jsx";
import { useCoreResource } from "./coreApi.js";
import { LEDGER_LOOKUP_EVENT, clearLedgerLookup, peekLedgerLookup, takeLedgerLookup, withSectionSign } from "./LedgerSearchBox.jsx";
import "./LedgerLookupScreen.css";

const FALLBACK_EXAMPLES = ["P-1 §1.1", "R-1", "T-1", "D-1", "L-000001"];
const KIND_LABELS = {
  clause: "Clause",
  plan: "Plan",
  task: "Task",
  question: "Question",
  decision: "Decision",
  release: "Release",
  entry: "Ledger entry",
};
const REF_LIKE = /^(?:[LPTQDR]\s*-?\s*\d|§|\d+\.\d)/i;
const PAGE_SIZE = 20;

export function entryLabel(n, advanced) {
  if (advanced || typeof n !== "string") return n;
  const m = /^L-0*(\d+)$/.exec(n);
  return m ? `Entry ${m[1]}` : n;
}

function plainType(type) {
  const text = String(type ?? "").replace(/[._]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function when(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at ?? "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Who({ actor }) {
  if (!actor) return null;
  return (
    <span className="lookup-who">
      {actor.id}
      {actor.kind && actor.kind !== "person" && <span className="core-muted"> ({actor.kind === "jev" ? "Jev" : actor.kind})</span>}
      {actor.model && <AdvancedOnly> · {actor.model}</AdvancedOnly>}
    </span>
  );
}

function RefChip({ value, onOpen }) {
  return (
    <button type="button" className="lookup-chip lookup-chip-ref" onClick={() => onOpen(value)} aria-label={`Look up ${value}`}>
      {value}
    </button>
  );
}

function EvidenceChip({ value, onOpen }) {
  if (/^https?:\/\//i.test(value)) {
    let label = value;
    try { const url = new URL(value); label = `${url.host}${url.pathname === "/" ? "" : url.pathname}`; } catch { /* keep raw */ }
    return (
      <a className="lookup-chip lookup-chip-link" href={value} target="_blank" rel="noreferrer noopener">
        {label} <ArrowSquareOutIcon aria-hidden="true" />
      </a>
    );
  }
  if (REF_LIKE.test(value) && !value.includes(":")) return <RefChip value={value} onOpen={onOpen} />;
  const [kind, ...rest] = value.split(":");
  return <span className="lookup-chip">{rest.length ? `${kind} ${rest.join(":")}` : value}</span>;
}

function Chips({ label, items, render }) {
  if (!items?.length) return null;
  return (
    <div className="lookup-chips">
      <span className="lookup-label">{label}</span>
      <div className="lookup-chip-row">{items.map((item) => <span key={item}>{render(item)}</span>)}</div>
    </div>
  );
}

function EntryRow({ entry, onOpen, advanced }) {
  return (
    <li className="lookup-entry">
      <button type="button" className="lookup-entry-button" onClick={() => onOpen(entry.n)} aria-label={`Open ${entryLabel(entry.n, true)}: ${entry.summary}`}>
        <span className="lookup-entry-n">{entryLabel(entry.n, advanced)}</span>
        <span className="lookup-entry-summary">{entry.summary}</span>
        <span className="lookup-entry-meta">
          <Who actor={entry.actor} /> · {when(entry.at)}
          {advanced && <span className="core-advanced"> · {entry.type} · {entry.shortHash}</span>}
        </span>
      </button>
    </li>
  );
}

function EntryList({ title, entries, onOpen, advanced, empty }) {
  if (!entries?.length) return empty ? <p className="core-muted">{empty}</p> : null;
  return (
    <section className="lookup-section" aria-label={title}>
      <h4>{title}</h4>
      <ul className="lookup-entries">{entries.map((e) => <EntryRow key={e.n} entry={e} onOpen={onOpen} advanced={advanced} />)}</ul>
    </section>
  );
}

function ClauseVersions({ clause }) {
  return (
    <section className="lookup-section" aria-label="Version history">
      <h4>Version history</h4>
      <ol className="lookup-versions">
        {clause.versions.map((v) => (
          <li key={v.n}>
            <div className="lookup-version-head">
              <strong>{v.type === "clause.added" ? "Added" : v.type === "clause.changed" ? "Changed" : "Withdrawn"}</strong>
              <span className="core-muted"> by <Who actor={v.actor} /> · {when(v.at)}</span>
              <AdvancedOnly> · {v.n} · {v.shortHash}</AdvancedOnly>
            </div>
            {v.text != null && <p className="lookup-version-text">{v.text}</p>}
            {v.reason && <p className="lookup-version-why">Why: {v.reason}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ClauseBody({ data }) {
  const clause = data.clause;
  if (!clause) return <p className="lookup-text">{data.text}</p>;
  const current = clause.current;
  const differs = clause.plan && current && current.text !== clause.textInPlan;
  return (
    <>
      {clause.plan ? (
        <div className="lookup-clause-text">
          <span className="lookup-label">As approved in {clause.plan}</span>
          <blockquote>{clause.textInPlan}</blockquote>
        </div>
      ) : null}
      {(!clause.plan || differs) && current && (
        <div className="lookup-clause-text">
          <span className="lookup-label">{clause.plan ? "Current text" : "Text"}</span>
          <blockquote className={current.status === "withdrawn" ? "withdrawn" : ""}>{current.text}</blockquote>
        </div>
      )}
      {current?.status === "withdrawn" && <p><span className="core-pill bad">Withdrawn</span></p>}
      <ClauseVersions clause={clause} />
    </>
  );
}

function ReleaseBody({ data, onOpen, advanced }) {
  const r = data.release;
  if (!r) return null;
  return (
    <>
      <dl className="lookup-facts">
        <div><dt>Version</dt><dd>{r.version}</dd></div>
        {r.plan && <div><dt>Plan</dt><dd><RefChip value={r.plan} onOpen={onOpen} /></dd></div>}
        <div><dt>Ledger range</dt><dd>{r.from && r.to ? `${entryLabel(r.from, advanced)} to ${entryLabel(r.to, advanced)}` : "No entries"} ({r.count} {r.count === 1 ? "entry" : "entries"})</dd></div>
        {r.restores && <div><dt>Rolls back to</dt><dd><RefChip value={r.restores} onOpen={onOpen} /></dd></div>}
        {advanced && r.commit && <div><dt>Commit</dt><dd className="core-advanced">{r.commit}</dd></div>}
      </dl>
      <details className="lookup-range">
        <summary>Show the {r.count} {r.count === 1 ? "entry" : "entries"} in this release</summary>
        <ul className="lookup-entries">{r.entries.map((e) => <EntryRow key={e.n} entry={e} onOpen={onOpen} advanced={advanced} />)}</ul>
        {r.truncated && <p className="core-muted">Showing the first {r.entries.length}.</p>}
      </details>
    </>
  );
}

function DetailCard({ data, onOpen }) {
  const advanced = useAdvanced();
  const kindLabel = KIND_LABELS[data.kind] ?? "Result";
  const title = data.kind === "entry" ? `${kindLabel} ${advanced ? data.ref : entryLabel(data.ref, false).replace(/^Entry /, "")}` : `${kindLabel} ${data.ref}`;
  return (
    <article className="core-card lookup-detail" aria-labelledby="lookup-detail-title">
      <header className="lookup-detail-head">
        <div>
          <h3 id="lookup-detail-title">{title}</h3>
          <p className="lookup-detail-meta">
            {data.who && <>By <Who actor={data.who} /></>}{data.when && <> · {when(data.when)}</>}
            {data.entry && <AdvancedOnly> · {data.entry.n} · {data.entry.shortHash}</AdvancedOnly>}
          </p>
        </div>
        {data.status && <span className="core-pill">{plainType(data.status)}</span>}
      </header>

      {data.kind === "clause" ? <ClauseBody data={data} /> : data.kind !== "release" && data.text && <p className="lookup-text">{data.text}</p>}
      {data.kind === "release" && <p className="lookup-text">{advanced ? data.text : data.what}</p>}

      <dl className="lookup-facts">
        {data.what && <div><dt>What</dt><dd>{data.what}</dd></div>}
        <div><dt>Why</dt><dd>{data.why || <span className="core-muted">No reason was recorded.</span>}</dd></div>
      </dl>

      <Chips label="Evidence" items={data.evidence} render={(v) => <EvidenceChip value={v} onOpen={onOpen} />} />
      <Chips label="Refers to" items={data.refs} render={(v) => <RefChip value={v} onOpen={onOpen} />} />
      {data.kind !== "task" && <Chips label="Tasks" items={data.tasks} render={(v) => <RefChip value={v} onOpen={onOpen} />} />}
      {advanced && <Chips label="Commits" items={data.commits} render={(v) => <span className="lookup-chip core-advanced">{v}</span>} />}

      {data.kind === "release" && <ReleaseBody data={data} onOpen={onOpen} advanced={advanced} />}
      {data.kind !== "clause" && data.kind !== "release" && data.history?.length > 1 && <EntryList title="History" entries={data.history} onOpen={onOpen} advanced={advanced} />}
      <EntryList title="Cited by" entries={data.citedBy} onOpen={onOpen} advanced={advanced} />
    </article>
  );
}

function ChainBadge({ verify }) {
  const advanced = useAdvanced();
  if (verify.status === "loading") return <span className="core-pill">Checking the ledger…</span>;
  if (verify.status === "no-session") return null;
  if (verify.status === "error") return <span className="core-pill warn">Ledger status unknown</span>;
  const v = verify.data ?? {};
  if (v.ok) {
    return (
      <span className="core-pill good lookup-chain" role="status">
        <ShieldCheckIcon aria-hidden="true" weight="fill" /> Ledger intact · {v.entries} {v.entries === 1 ? "entry" : "entries"}
        {advanced && v.headHash && <span className="core-advanced"> · head {v.head} {v.headHash}</span>}
      </span>
    );
  }
  return (
    <span className="core-pill bad lookup-chain" role="status" title={v.detail ?? undefined}>
      <ShieldWarningIcon aria-hidden="true" weight="fill" /> Ledger broken at {v.brokenAt}
      {advanced && v.problem && <span className="core-advanced"> · {v.problem}</span>}
    </span>
  );
}

function Examples({ items, onOpen }) {
  return (
    <div className="lookup-examples">
      <span className="lookup-label">Try</span>
      {items.map((ex) => <RefChip key={ex} value={ex} onOpen={onOpen} />)}
    </div>
  );
}

function SearchField({ value, onChange, onSubmit, inputRef }) {
  return (
    <form className="lookup-form" role="search" aria-label="Search the ledger" onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
      <MagnifyingGlassIcon className="lookup-form-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(withSectionSign(e.target.value))}
        placeholder="P-12 §3.2, R-5, T-14, or any words"
        aria-label="Reference or words to find"
        autoComplete="off"
        spellCheck={false}
      />
      <button type="button" className="core-button lookup-section-sign" onClick={() => { onChange(`${value}§`); inputRef.current?.focus(); }} aria-label="Insert section sign §">§</button>
      <button type="submit" className="core-button primary">Search</button>
    </form>
  );
}

function Results({ query, onOpen }) {
  const advanced = useAdvanced();
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [query]);
  const refLike = REF_LIKE.test(query);
  const lookup = useCoreResource(`/lookup?ref=${encodeURIComponent(query)}`, { isEmpty: () => false });
  const search = useCoreResource(`/search?q=${encodeURIComponent(query)}&page=${page}&pageSize=${PAGE_SIZE}`, { isEmpty: (d) => !d || d.total === 0 });

  if (lookup.status === "loading" && search.status === "loading") return <CoreLoading label="Searching the ledger" />;
  const exact = lookup.status === "ready" && lookup.data?.found ? lookup.data : null;
  const hits = (search.data?.hits ?? []).filter((h) => !(exact && h.ref === exact.ref));
  const others = search.status === "ready" ? search.data.total - (exact ? 1 : 0) : 0;

  return (
    <div className="lookup-results">
      {exact && <DetailCard data={exact} onOpen={onOpen} />}
      {!exact && refLike && lookup.status === "ready" && lookup.data?.problem && (
        <p className="core-card lookup-problem" role="status">Nothing found for {query}: {lookup.data.problem}.</p>
      )}
      {lookup.status === "error" && search.status === "error" && <CoreError error={search.error} onRetry={() => { lookup.reload(); search.reload(); }} />}
      {search.status === "empty" && !exact && (
        <p className="core-empty" role="status">No entries or clauses match “{query}”. Try a reference like P-1 §2.1 or fewer words.</p>
      )}
      {search.status === "ready" && hits.length > 0 && (
        <section className="lookup-section" aria-label="Matches">
          <h4>{exact ? `Other matches (${others})` : `${search.data.total}${search.data.capped ? "+" : ""} ${search.data.total === 1 ? "match" : "matches"}`}</h4>
          <ul className="lookup-hits">
            {hits.map((hit) => (
              <li key={`${hit.kind}-${hit.ref}`}>
                <button type="button" className="lookup-hit" onClick={() => onOpen(hit.ref)} aria-label={`Open ${hit.ref}: ${hit.text}`}>
                  <span className="lookup-hit-kind">{KIND_LABELS[hit.kind] ?? hit.kind}</span>
                  <span className="lookup-hit-ref">{hit.kind === "entry" ? (hit.entry && !advanced ? hit.entry.subject || entryLabel(hit.ref, false) : entryLabel(hit.ref, advanced)) : hit.ref}</span>
                  <span className="lookup-hit-text">{hit.text}</span>
                  {hit.entry && <span className="lookup-hit-meta"><Who actor={hit.entry.actor} /> · {when(hit.entry.at)}{advanced && <span className="core-advanced"> · {hit.entry.n} · {hit.entry.shortHash}</span>}</span>}
                </button>
              </li>
            ))}
          </ul>
          {search.data.pages > 1 && (
            <nav className="lookup-pager" aria-label="Result pages">
              <button type="button" className="core-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><CaretLeftIcon aria-hidden="true" /> Previous page</button>
              <span>Page {search.data.page} of {search.data.pages}</span>
              <button type="button" className="core-button" disabled={page >= search.data.pages} onClick={() => setPage((p) => p + 1)}>Next page <CaretRightIcon aria-hidden="true" /></button>
            </nav>
          )}
        </section>
      )}
    </div>
  );
}

function Recent({ data, onOpen }) {
  const advanced = useAdvanced();
  return (
    <div className="lookup-recent">
      <Examples items={data.examples?.length ? data.examples : FALLBACK_EXAMPLES} onOpen={onOpen} />
      <section className="lookup-section" aria-label="Recent entries">
        <h4><ClockCounterClockwiseIcon aria-hidden="true" /> Latest on the ledger</h4>
        <ul className="lookup-entries">{data.entries.map((e) => <EntryRow key={e.n} entry={e} onOpen={onOpen} advanced={advanced} />)}</ul>
      </section>
    </div>
  );
}

export default function LedgerLookupScreen() {
  const recent = useCoreResource("/recent", { isEmpty: (d) => !d || !d.total });
  const verify = useCoreResource("/verify");
  const initial = useRef(undefined);
  if (initial.current === undefined) initial.current = peekLedgerLookup() ?? "";
  const [value, setValue] = useState(initial.current);
  const [active, setActive] = useState(initial.current);
  const inputRef = useRef(null);

  const open = useCallback((text) => {
    const q = withSectionSign(String(text ?? "")).trim();
    setValue(q);
    setActive(q);
  }, []);

  // The handed-over query is used up only once this screen has really mounted with it.
  useEffect(() => { if (initial.current) clearLedgerLookup(); }, []);

  useEffect(() => {
    const onLookup = () => { const q = takeLedgerLookup(); if (q) open(q); };
    window.addEventListener(LEDGER_LOOKUP_EVENT, onLookup);
    return () => window.removeEventListener(LEDGER_LOOKUP_EVENT, onLookup);
  }, [open]);

  useEffect(() => { if (active) verify.reload(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const field = <SearchField value={value} onChange={setValue} onSubmit={open} inputRef={inputRef} />;
  const clear = active ? <button type="button" className="core-button lookup-clear" onClick={() => open("")}>Back to recent entries</button> : null;

  return (
    <CoreScreen
      id="lookup"
      title="Ledger search"
      purpose="Find any plan clause, task, question, decision, release or ledger entry, with who did it, when and why."
      actions={<ChainBadge verify={verify} />}
      resource={recent}
      empty={
        <div className="lookup-empty">
          {field}
          {active ? <>{clear}<Results query={active} onOpen={open} /></> : (
            <>
              <strong>The ledger has no entries yet.</strong>
              <p>Plans, tasks, decisions and releases show up here as they are recorded. Once they do, you can look them up by number:</p>
              <Examples items={FALLBACK_EXAMPLES} onOpen={open} />
            </>
          )}
        </div>
      }
    >
      <div className="lookup-body">
        {field}
        {active ? <>{clear}<Results key={active} query={active} onOpen={open} /></> : recent.data && <Recent data={recent.data} onOpen={open} />}
      </div>
    </CoreScreen>
  );
}
