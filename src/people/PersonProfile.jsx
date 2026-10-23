import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./PersonProfile.css";
import { MD_MAX_BYTES, isHttpsLink, isMarkdownName, nextFreeSlot } from "./profileStats.js";

const contextKey = (person) => `pp.profile.context.${person}`;
function loadContext(person) {
  try { return JSON.parse(localStorage.getItem(contextKey(person)) ?? "null") ?? { files: [], links: [] }; } catch { return { files: [], links: [] }; }
}
function saveContext(person, value) {
  try { localStorage.setItem(contextKey(person), JSON.stringify(value)); } catch { /* storage may be blocked */ }
}

/**
 * One person's profile. `profile`: { person, name, role, avatar, stats, upNext, busy, sample, today }.
 * Stats come from real ledger task rows unless `profile.sample` is set, and then the panel says so.
 */
export function PersonProfile({ profile, onClose, onAssign, onShareLink }) {
  const { person, name, role, stats, sample } = profile;
  const [queue, setQueue] = useState(profile.upNext ?? []);
  const [scheduled, setScheduled] = useState([]);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("up-next");
  const [ctx, setCtx] = useState(() => loadContext(person));
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const closeRef = useRef(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const busy = [...(profile.busy ?? []), ...scheduled.map((s) => s.date)];
  const slot = nextFreeSlot(busy, profile.today);
  const canAssign = Boolean(onAssign) || sample;

  const assign = async (event) => {
    event.preventDefault();
    const t = title.trim();
    if (!t) return;
    setError("");
    try {
      if (onAssign) await onAssign({ person, title: t, when, date: slot });
      if (when === "up-next") setQueue((q) => [...q, { title: t }]);
      else setScheduled((s) => [...s, { title: t, date: slot }]);
      setTitle("");
    } catch (e) { setError(e?.message || "Could not assign this work"); }
  };
  const update = (next) => { setCtx(next); saveContext(person, next); };
  const takeFile = async (file) => {
    setError("");
    if (!file) return;
    if (!isMarkdownName(file.name)) { setError("Drop a .md or .txt file"); return; }
    if (file.size > MD_MAX_BYTES) { setError("Files must be 64 KB or smaller"); return; }
    const text = await file.text();
    update({ ...ctx, files: [...ctx.files.filter((f) => f.name !== file.name), { name: file.name, text }] });
  };
  const addLink = async (event) => {
    event.preventDefault();
    const url = link.trim();
    if (!isHttpsLink(url)) { setError("Links must start with https://"); return; }
    setError("");
    try {
      if (onShareLink) await onShareLink({ person, title: url, path: url });
      update({ ...ctx, links: [...ctx.links.filter((l) => l !== url), url] });
      setLink("");
    } catch (e) { setError(e?.message || "Could not save this link"); }
  };

  return createPortal(
    <div className="pprofile-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="pprofile" role="dialog" aria-modal="true" aria-label={`${name} profile`}>
        <header className="pprofile-head">
          <span className="pprofile-avatar" style={profile.color ? { borderColor: profile.color } : undefined}>
            {profile.avatar ? <img src={profile.avatar} alt="" /> : name.slice(0, 1)}
          </span>
          <div><h2>{name}</h2><p>{role}{profile.state ? ` · ${profile.state}` : ""}</p></div>
          <button ref={closeRef} type="button" className="pprofile-close" onClick={onClose} aria-label="Close profile">Close</button>
        </header>
        {sample && <p className="pprofile-sample" role="note">Sample data. These numbers and the schedule are examples, not this project's ledger.</p>}

        <section aria-label="Stats">
          <dl className="pprofile-stats">
            <div><dt>Tasks finished</dt><dd>{stats.finished}</dd></div>
            <div><dt>Open work</dt><dd>{stats.open}</dd></div>
            <div><dt>Failed checks</dt><dd className={stats.errors ? "is-bad" : ""}>{stats.errors}</dd></div>
            {stats.linesDone != null && <div><dt>Lines of code done</dt><dd>{stats.linesDone.toLocaleString("en-AU")}</dd></div>}
          </dl>
          {!sample && stats.total === 0 && <p className="pprofile-muted">No tasks are on this person's name yet.</p>}
        </section>

        <section aria-label="Planned next">
          <h3>Planned next</h3>
          {stats.openTasks?.length > 0 && <ul>{stats.openTasks.map((t) => <li key={t.id}>{t.label} <small>{t.status}</small></li>)}</ul>}
          {queue.length > 0 && <ul>{queue.map((q, i) => <li key={`${q.title}-${i}`}>{q.title} <small>up next</small></li>)}</ul>}
          {scheduled.length > 0 && <ul>{scheduled.map((s, i) => <li key={`${s.title}-${i}`}>{s.title} <small>{s.date}</small></li>)}</ul>}
          {!stats.openTasks?.length && !queue.length && !scheduled.length && <p className="pprofile-muted">Nothing planned yet.</p>}
        </section>

        <section aria-label="Allocate work">
          <h3>Allocate work</h3>
          {canAssign ? (
            <form onSubmit={assign}>
              <label>Work<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should they do?" autoComplete="off" /></label>
              <fieldset>
                <legend>When</legend>
                <label><input type="radio" name={`when-${person}`} checked={when === "up-next"} onChange={() => setWhen("up-next")} /> Up next</label>
                <label><input type="radio" name={`when-${person}`} checked={when === "slot"} onChange={() => setWhen("slot")} /> Next free slot ({slot})</label>
              </fieldset>
              <button type="submit" disabled={!title.trim()}>Allocate to {name}</button>
            </form>
          ) : <p className="pprofile-muted">Assigning work to people from here is not connected on this project yet.</p>}
        </section>

        <section aria-label="Context">
          <h3>Context</h3>
          <div className={`pprofile-drop${drag ? " is-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); takeFile(e.dataTransfer.files?.[0]); }}>
            Drop a markdown file here, or
            <label className="pprofile-pick">choose one<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
          </div>
          {ctx.files.length > 0 && <ul>{ctx.files.map((f) => <li key={f.name}>{f.name} <small>{f.text.length.toLocaleString("en-AU")} chars</small> <button type="button" onClick={() => update({ ...ctx, files: ctx.files.filter((x) => x.name !== f.name) })}>Remove</button></li>)}</ul>}
          <form onSubmit={addLink} className="pprofile-linkform">
            <input aria-label="Reference link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" autoComplete="off" />
            <button type="submit" disabled={!link.trim()}>Add link</button>
          </form>
          {ctx.links.length > 0 && <ul>{ctx.links.map((l) => <li key={l}><a href={l} target="_blank" rel="noopener noreferrer">{l}</a></li>)}</ul>}
          <p className="pprofile-muted">Files are kept in this browser only. Links are shared with the project when it is connected.</p>
        </section>
        {error && <p className="pprofile-error" role="alert">{error}</p>}
      </aside>
    </div>,
    document.body,
  );
}

export default PersonProfile;
