import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./PersonProfile.css";
import { MD_MAX_BYTES, isHttpsLink, isMarkdownName, move, nextFreeSlot, passRate, sampleHeat, weekdays } from "./profileStats.js";

// Dropped files and links live in memory for this app session only; nothing is written to browser storage.
const contexts = new Map();
const loadContext = (person) => contexts.get(person) ?? { files: [], links: [] };
const saveContext = (person, value) => contexts.set(person, value);

function useCountUp(target) {
  const n = typeof target === "number" ? target : Number.NaN;
  const [v, setV] = useState(Number.isNaN(n) ? 0 : 0);
  useEffect(() => {
    if (Number.isNaN(n)) return undefined;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setV(n); return undefined; }
    let raf = 0; const t0 = performance.now();
    const tick = (t) => { const k = Math.min(1, (t - t0 - 250) / 800); setV(Math.round(n * (1 - (1 - Math.max(0, k)) ** 3))); if (k < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  return Number.isNaN(n) ? target : v;
}

function Spark({ values, bad, i }) {
  if (!values?.length) return null;
  const max = Math.max(...values, 1);
  const pts = values.map((v, k) => [(k / Math.max(values.length - 1, 1)) * 100, 28 - (v / max) * 24]);
  const line = pts.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  return (
    <svg className={`pprofile-spark${bad ? " is-bad" : ""}`} style={{ "--i": i }} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path className="pprofile-area" d={`${line}L100 30L0 30Z`} />
      <path className="pprofile-line" d={line} pathLength="1" fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Tile({ label, value, trend, bad, i }) {
  const shown = useCountUp(typeof value === "number" ? value : Number.NaN);
  const text = typeof value === "number" ? shown.toLocaleString("en-AU") : value;
  return (
    <div className="pprofile-tile" style={{ "--i": i }}>
      <dt>{label}</dt>
      <dd className={bad && value ? "is-bad" : ""}>{text}</dd>
      <Spark values={trend} bad={bad} i={i} />
    </div>
  );
}

function Radar({ skills }) {
  const n = skills.length;
  const pt = (i, r) => { const a = (Math.PI * 2 * i) / n - Math.PI / 2; return `${(60 + Math.cos(a) * r).toFixed(1)},${(60 + Math.sin(a) * r).toFixed(1)}`; };
  return (
    <svg className="pprofile-radar" viewBox="0 0 120 120" role="img" aria-label={`Strengths: ${skills.map((k) => `${k.k} ${k.v}`).join(", ")}`}>
      {[0.33, 0.66, 1].map((f) => <polygon key={f} points={skills.map((_, i) => pt(i, 40 * f)).join(" ")} className="pprofile-ring-bg" />)}
      <polygon className="pprofile-radar-fill" points={skills.map((k, i) => pt(i, 40 * (k.v / 100))).join(" ")} />
      {skills.map((k, i) => <text key={k.k} x={pt(i, 52).split(",")[0]} y={pt(i, 52).split(",")[1]} textAnchor="middle" dominantBaseline="middle">{k.k}</text>)}
    </svg>
  );
}

function Ring({ pct }) {
  return (
    <svg className="pprofile-ringsvg" viewBox="0 0 80 80" role="img" aria-label={`${pct}% passed first time`}>
      <circle cx="40" cy="40" r="32" className="pprofile-ring-bg" />
      <circle cx="40" cy="40" r="32" className="pprofile-ring-fg" pathLength="100" strokeDasharray={`${pct} 100`} />
      <text x="40" y="45" textAnchor="middle">{pct}%</text>
    </svg>
  );
}

function Face({ profile }) {
  if (profile.avatar) return <img src={profile.avatar} alt="" />;
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="24" r="12" fill="currentColor" opacity=".9" /><path d="M8 64c2-16 12-24 24-24s22 8 24 24z" fill="currentColor" opacity=".9" /></svg>
  );
}

/**
 * One person's profile. `profile`: { person, name, role, state, avatar, color, stats, upNext, busy, sample, today,
 * trends, timeline, current, assignable }. Stats come from real ledger task rows unless `profile.sample` is set,
 * and then the panel says so. Trends, timeline and the calendar only exist for sample data: the ledger keeps no
 * calendar slots or review times, so a real project shows what it has and nothing invented.
 */
export function PersonProfile({ profile, onClose, onAssign, onShareLink }) {
  const { person, name, role, stats, sample } = profile;
  const [queue, setQueue] = useState(profile.upNext ?? []);
  const [scheduled, setScheduled] = useState([]);
  const [title, setTitle] = useState("");
  const [pick, setPick] = useState(null);
  const [taskId, setTaskId] = useState("");
  const real = Array.isArray(profile.assignable);
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

  const busyDates = [...(profile.busy ?? []), ...scheduled.map((x) => x.date)];
  const slot = nextFreeSlot(busyDates, profile.today);
  const days = weekdays(profile.today, 10);
  const canAssign = Boolean(onAssign) || sample;
  const date = pick ?? null;

  const assign = async (event) => {
    event.preventDefault();
    setError("");
    if (real) {
      const picked = profile.assignable.find((x) => x.id === taskId);
      if (!picked) return;
      try { await onAssign({ person, task: picked.id }); setTaskId(""); } catch (e) { setError(e?.message || "Could not assign this work"); }
      return;
    }
    const t = title.trim();
    if (!t) return;
    if (date) setScheduled((x) => [...x, { title: t, date }]);
    else setQueue((q) => [...q, { title: t }]);
    setTitle(""); setPick(null);
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

  const rate = passRate(stats.finished, stats.errors);
  const heat = sample ? sampleHeat(person) : null;
  const capacity = profile.capacity ?? 5;
  const added = Math.max(0, queue.length - (profile.upNext?.length ?? 0)) + scheduled.length;
  const used = stats.open + added;
  const load = Math.min(100, Math.round((used / capacity) * 100));
  const openRows = stats.openTasks ?? [];

  return createPortal(
    <div className="pprofile-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="pprofile" role="dialog" aria-modal="true" aria-label={`${name} profile`}>
        <header className="pprofile-hero">
          <span className="pprofile-avatar">
            <Face profile={profile} />
            {profile.state && <i className={`pprofile-dot is-${profile.state}`} title={profile.state} />}
          </span>
          <div className="pprofile-who">
            <h2>{name}</h2>
            <p>{role}{profile.state ? ` · ${profile.state}` : ""}</p>
            {profile.about && <p className="pprofile-about">{profile.about}</p>}
            {profile.current && <p className="pprofile-current"><b>Now</b> {profile.current}{profile.branch && <code>{profile.branch}</code>}</p>}
            <div className="pprofile-load" role="img" aria-label={`Workload ${load}%`}><span style={{ width: `${load}%` }} /></div>
            {(profile.meta?.length > 0 || profile.pairs) && <div className="pprofile-chips">{[...(profile.meta ?? []), ...(profile.pairs ? [`Pairs with ${profile.pairs}`] : [])].map((m) => <span key={m}>{m}</span>)}</div>}
            <small>Workload {load}% · {used} of {capacity} slots</small>
          </div>
          <button ref={closeRef} type="button" className="pprofile-close" onClick={onClose} aria-label="Close profile">Close</button>
        </header>
        {sample && <p className="pprofile-sample" role="note">Sample data. These numbers, charts and the calendar are examples, not this project's ledger.</p>}

        <dl className="pprofile-tiles" aria-label="Stats">
          <Tile i={1} label="Tasks finished" value={stats.finished} trend={profile.trends?.done} />
          <Tile i={2} label="Failed checks" value={stats.errors} trend={profile.trends?.errors} bad />
          {stats.linesDone != null && <Tile i={3} label="Lines changed" value={stats.linesDone} trend={profile.trends?.lines} />}
          {profile.reviewHours != null ? <Tile i={4} label="Review turnaround" value={`${profile.reviewHours} h`} trend={profile.trends?.review} /> : <Tile i={4} label="Open work" value={stats.open} />}
        </dl>
        {!sample && stats.total === 0 && <p className="pprofile-muted">No tasks are on this person's name yet.</p>}

        <div className="pprofile-insights" style={{ "--i": 4 }}>
          {profile.skills && <section aria-label="Strengths"><h3>Strengths</h3><Radar skills={profile.skills} /></section>}
          <section aria-label="Quality">
            <h3>Quality</h3>
            {rate != null ? <Ring pct={rate} /> : <p className="pprofile-muted">No finished or failed work yet.</p>}
            <small>{rate != null ? "of work passed its checks first time" : ""}</small>
            {profile.mix && (
              <>
                <div className="pprofile-mix" role="img" aria-label={profile.mix.map((m) => `${m.k} ${m.v}%`).join(", ")}>{profile.mix.map((m, i) => <span key={m.k} style={{ width: `${m.v}%`, "--k": i }} />)}</div>
                <small>{profile.mix.map((m) => `${m.k} ${m.v}%`).join(" · ")}</small>
              </>
            )}
            {profile.agents?.length > 0 && <small>Runs {profile.agents.join(", ")}</small>}
          </section>
        </div>
        {heat && (
          <section aria-label="Activity" style={{ "--i": 5 }}>
            <h3>Activity <small>last 26 weeks</small></h3>
            <div className="pprofile-heat" role="img" aria-label="Daily activity, last 26 weeks">{heat.map((v, i) => <i key={i} style={{ opacity: v ? 0.2 + v * 0.8 : 0.07, "--d": Math.floor(i / 7) }} />)}</div>
          </section>
        )}
        <div className="pprofile-grid" style={{ "--i": 5 }}>
          <section aria-label="Up next" style={{ "--i": 5 }}>
            <h3>Up next</h3>
            {openRows.length > 0 && <ul className="pprofile-cards">{openRows.map((t) => <li key={t.id}><span><b>{t.label}</b>{t.branch && <code>{t.branch}</code>}</span><small className={`pprofile-chip is-${t.status}`}>{t.status}</small></li>)}</ul>}
            {queue.length > 0 && (
              <ol className="pprofile-cards" aria-label="Queue">
                {queue.map((q, i) => (
                  <li key={`${q.title}-${i}`}>
                    <b>{q.title}</b><small className="pprofile-chip">up next</small>
                    <span className="pprofile-order">
                      <button type="button" aria-label={`Move ${q.title} up`} disabled={i === 0} onClick={() => setQueue((x) => move(x, i, -1))}>↑</button>
                      <button type="button" aria-label={`Move ${q.title} down`} disabled={i === queue.length - 1} onClick={() => setQueue((x) => move(x, i, 1))}>↓</button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {scheduled.length > 0 && <ul className="pprofile-cards">{scheduled.map((x, i) => <li key={`${x.title}-${i}`}><b>{x.title}</b><small>{x.date}</small></li>)}</ul>}
            {!openRows.length && !queue.length && !scheduled.length && <p className="pprofile-muted">Nothing planned yet.</p>}
          </section>

          {profile.timeline?.length > 0 && (
            <section aria-label="Recent work" style={{ "--i": 6 }}>
              <h3>Recent work</h3>
              <ol className="pprofile-timeline">
                {profile.timeline.map((t, i) => <li key={i} className={`is-${t.kind}`}><small>{t.when}</small> {t.text}</li>)}
              </ol>
            </section>
          )}
        </div>

        {sample && (
          <section aria-label="Calendar" style={{ "--i": 7 }}>
            <h3>Calendar <small>click a free day to book it</small></h3>
            <div className="pprofile-cal" role="group" aria-label="Next ten working days">
              {days.map((d) => {
                const booked = busyDates.includes(d.date);
                const free = !booked;
                return (
                  <button key={d.date} type="button" style={{ "--d": days.indexOf(d) }} disabled={booked} aria-pressed={pick === d.date}
                    className={`pprofile-day${booked ? " is-booked" : ""}${d.date === slot ? " is-next" : ""}${pick === d.date ? " is-picked" : ""}`}
                    title={booked ? "Booked" : d.date === slot ? "Next free slot" : "Free"}
                    onClick={() => free && setPick(pick === d.date ? null : d.date)}>
                    <small>{d.dow}</small><b>{d.day}</b>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section aria-label="Allocate work" style={{ "--i": 8 }}>
          <h3>Allocate work</h3>
          {canAssign ? (
            <form onSubmit={assign}>
              {real ? (
                <>
                  <label>Task
                    <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!profile.assignable.length}>
                      <option value="">{profile.assignable.length ? "Choose an unassigned task" : "No unassigned tasks"}</option>
                      {profile.assignable.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.label}</option>)}
                    </select>
                  </label>
                  <button type="submit" disabled={!taskId}>Allocate to {name}</button>
                </>
              ) : (
                <>
                  <label>Work<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should they do?" autoComplete="off" /></label>
                  <div className="pprofile-seg" role="group" aria-label="When">
                    <button type="button" aria-pressed={!pick} onClick={() => setPick(null)}>Up next</button>
                    <button type="button" aria-pressed={pick === slot} onClick={() => setPick(slot)}>Next free slot · {slot}</button>
                  </div>
                  <button type="submit" disabled={!title.trim()}>Allocate to {name}{pick ? ` on ${pick}` : ""}</button>
                </>
              )}
            </form>
          ) : <p className="pprofile-muted">Assigning work to people from here is not connected on this project yet.</p>}
        </section>

        <section aria-label="Context" style={{ "--i": 9 }}>
          <h3>Context</h3>
          <div className={`pprofile-drop${drag ? " is-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); takeFile(e.dataTransfer.files?.[0]); }}>
            Drop a markdown file here, or
            <label className="pprofile-pick">choose one<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
          </div>
          {ctx.files.length > 0 && <ul className="pprofile-cards">{ctx.files.map((f) => <li key={f.name}><b>{f.name}</b><small>{f.text.length.toLocaleString("en-AU")} chars</small> <button type="button" onClick={() => update({ ...ctx, files: ctx.files.filter((x) => x.name !== f.name) })}>Remove</button></li>)}</ul>}
          <form onSubmit={addLink} className="pprofile-linkform">
            <input aria-label="Reference link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" autoComplete="off" />
            <button type="submit" disabled={!link.trim()}>Add link</button>
          </form>
          {ctx.links.length > 0 && <ul className="pprofile-cards">{ctx.links.map((l) => <li key={l}><a href={l} target="_blank" rel="noopener noreferrer">{l}</a></li>)}</ul>}
          <p className="pprofile-muted">Files are kept until you close the app. Links are shared with the project when it is connected.</p>
        </section>
        {error && <p className="pprofile-error" role="alert">{error}</p>}
      </aside>
    </div>,
    document.body,
  );
}

export default PersonProfile;
