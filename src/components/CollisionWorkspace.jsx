import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightIcon, CheckCircleIcon, HardDrivesIcon, ListChecksIcon, ShieldCheckIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import { assessCollisions, collisionCensusDigest, validateManifest, verifyLedger } from "../engine/collisionEngine.js";
import { createCollisionAuthorityClient, createHttpCollisionAuthorityAdapter } from "../engine/collisionAuthorityClient.js";
import { createNativeCollisionAuthorityAdapter } from "../native/collisionAuthority.js";
import { collisionSeedManifests } from "../engine/collisionSeed.js";

const statusLabel = { verified: "verified", risk: "at risk", blocked: "hard stop", queued: "queued" };
function StatusChip({ status, children }) { return <span className={`status-chip status-${status}`}>{children ?? statusLabel[status] ?? status}</span>; }

const DEMO_PLAN_ID = "PP-CLEANROOM";
const demoAuthorityClient = () => createCollisionAuthorityClient({
  planId: DEMO_PLAN_ID,
  adapter: createNativeCollisionAuthorityAdapter() ?? createHttpCollisionAuthorityAdapter(),
});
const committedFor = (ledger, digest) => ledger.some((entry) => entry.type === "collision.assessment-committed" && entry.payload?.censusDigest === digest);

/** Collision gate as the shell shows it, computed from an authority snapshot. */
export function collisionGateFrom(assessment, authority) {
  const approved = new Set(authority.approvedIds ?? []);
  const remaining = assessment.collisions.filter((collision) => !approved.has(collision.id));
  return { ready: authority.authoritative === true && assessment.manifestErrors.length === 0 && remaining.length === 0, unresolved: remaining.length, hardStops: remaining.filter((collision) => collision.severity === "hard-stop").length, authorityAvailable: authority.authoritative === true, authorityReason: authority.authoritative ? null : authority.reason };
}

/** One read of the demo census's saved decisions, so the shell is right before Collisions is opened. */
export async function readDemoCollisionGate(client = demoAuthorityClient()) {
  const digest = await collisionCensusDigest(collisionSeedManifests);
  return collisionGateFrom(assessCollisions(collisionSeedManifests), await client.inspect(digest));
}

export function CollisionWorkspace({ onGateChange, onToast }) {
  const [manifests, setManifests] = useState(collisionSeedManifests);
  const authorityClient = useMemo(demoAuthorityClient, []);
  // One authority request at a time; a second click while one is in flight is ignored.
  const [pending, setPending] = useState(null);
  const inFlight = useRef(false);
  const [authority, setAuthority] = useState({ authoritative: false, approvedIds: [], ledger: [], reason: "Calculating plan census…" });
  // Set when a refused write's re-read also failed: the record on screen is last known, not live.
  const [staleReason, setStaleReason] = useState(null);
  const [stagedIds, setStagedIds] = useState(new Set());
  const [censusDigest, setCensusDigest] = useState("");
  const [ledgerIntegrity, setLedgerIntegrity] = useState("unchecked");
  const [importErrors, setImportErrors] = useState([]);
  const assessment = useMemo(() => assessCollisions(manifests), [manifests]);
  const approvedIds = useMemo(() => new Set(authority.approvedIds), [authority.approvedIds]);
  const ledger = authority.ledger;
  const remaining = assessment.collisions.filter((collision) => !approvedIds.has(collision.id));
  const live = authority.authoritative === true && staleReason === null;
  const gateReady = live && assessment.manifestErrors.length === 0 && remaining.length === 0;
  const committed = live && committedFor(ledger, censusDigest);
  const gateAuthority = useMemo(() => staleReason === null ? authority : { ...authority, authoritative: false, reason: `Last known record; re-read failed: ${staleReason}` }, [authority, staleReason]);

  useEffect(() => {
    let current = true;
    collisionCensusDigest(manifests).then(async (digest) => {
      const snapshot = await authorityClient.inspect(digest);
      if (current) { setCensusDigest(digest); setAuthority(snapshot); setStaleReason(null); setStagedIds(new Set()); setLedgerIntegrity("unchecked"); }
    });
    return () => { current = false; };
  }, [authorityClient, manifests]);

  useEffect(() => {
    if (censusDigest) onGateChange(collisionGateFrom(assessment, gateAuthority));
  }, [gateAuthority, assessment, censusDigest, onGateChange]);

  const reread = async () => {
    const current = await authorityClient.inspect(censusDigest);
    if (current.authoritative || !authority.authoritative) { setAuthority(current); setStaleReason(null); setLedgerIntegrity("unchecked"); return current; }
    setStaleReason(current.reason ?? "the authority did not answer");
    return current;
  };
  // A refused write never replaces what the authority already proved: keep it, say why, and re-read.
  // If the re-read fails too, the kept record is labelled last known and its actions are paused.
  const send = async (key, request, success, after) => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(key);
    try {
      const snapshot = await request();
      if (snapshot.authoritative) { setAuthority(snapshot); setStaleReason(null); setLedgerIntegrity("unchecked"); if (success) onToast(success); after?.(snapshot); return; }
      const current = await reread();
      onToast(current.authoritative || !authority.authoritative
        ? `Not recorded: ${snapshot.reason} Showing the authority's current record.`
        : `Not recorded: ${snapshot.reason} Re-read failed (${current.reason}), so this is the last known record, not live. Actions are paused until a re-read succeeds.`);
    } finally { inFlight.current = false; setPending(null); }
  };
  const retryRead = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setPending("reread");
    try { const current = await reread(); if (current.authoritative) onToast("Authority re-read; showing its current record."); }
    finally { inFlight.current = false; setPending(null); }
  };
  const approveCollision = (collision) => {
    if (!authorityClient.available) {
      setStagedIds((current) => new Set(current).add(collision.id));
      onToast("Order staged for review only. Native authority is required to unlock allocation.");
      return;
    }
    return send(collision.id, () => authorityClient.approve(censusDigest, collision), null, (snapshot) => {
      if (!snapshot.approvedIds.includes(collision.id)) onToast(`Approval for ${collision.id} was not recorded: ${snapshot.reason ?? "the authority did not confirm it"}`);
    });
  };
  const commitAssessment = () => {
    if (committed) return;
    const surfaces = [...new Set(assessment.claims.map((claim) => `${claim.access}:${claim.surface}`))];
    return send("commit", () => authorityClient.commit(censusDigest, { manifestIds: manifests.map((manifest) => manifest.planId), claims: surfaces.length, collisionIds: assessment.collisions.map((collision) => collision.id), surfaces }), "Collision assessment committed by native authority.");
  };
  const verifyChain = async () => { const result = await verifyLedger(ledger); setLedgerIntegrity(result.valid ? "verified" : `broken at ${result.brokenAt}`); };
  const importManifests = async (event) => {
    const parsed = []; const errors = [];
    for (const file of [...event.target.files]) {
      try { const manifest = JSON.parse(await file.text()); const validation = validateManifest(manifest); if (validation.length) validation.forEach((message) => errors.push(`${file.name}: ${message}`)); else parsed.push(manifest); }
      catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    setImportErrors(errors);
    if (parsed.length && errors.length === 0) { setManifests(parsed); setStagedIds(new Set()); onToast(`${parsed.length} local plan manifests loaded read-only.`); }
    event.target.value = "";
  };
  // Reset only restores the sample census and clears what lives on this page; recorded decisions are append-only.
  const resetCensus = () => { setManifests(collisionSeedManifests); setStagedIds(new Set()); setImportErrors([]); setLedgerIntegrity("unchecked"); onToast(authority.ledger.length ? "Sample census restored. Approvals already recorded in this computer's demo journal stay recorded; it is append-only." : "Sample census restored."); };

  return (
    <section className="workspace collision-workspace" aria-label="Collision assessment workspace">
      <header className="collision-page-header">
        <div><span className="eyebrow">LOCAL MANIFEST CENSUS · READ ONLY</span><h1>Collision control</h1><p>Compare every active plan claim before an agent receives a file, API, database, or dependency lease.</p><p className="collision-demo-note" role="note"><strong>Demo journal:</strong> approvals here are written to a real append-only journal on this computer, kept apart from your imported projects. Reset restores the sample census; it cannot erase recorded approvals.</p></div>
        <div className="collision-actions"><label className="soft-button manifest-import"><HardDrivesIcon /> Import manifests<input type="file" accept="application/json,.json" multiple onChange={importManifests} /></label><button className="soft-button" onClick={resetCensus}>Reset demo census</button></div>
      </header>
      <div className="collision-metrics"><div><strong>{manifests.length}</strong><span>plan manifests</span></div><div><strong>{assessment.claims.length}</strong><span>normalized claims</span></div><div><strong>{assessment.collisions.length}</strong><span>detected collisions</span></div><div className={remaining.length ? "metric-danger" : "metric-success"}><strong>{remaining.length}</strong><span>unresolved</span></div><div><strong>{ledger.length}</strong><span>ledger entries</span></div></div>
      {staleReason !== null && <section className="manifest-errors collision-stale" role="alert"><WarningIcon weight="fill" /><div><strong>Last known record, re-read failed</strong><span>The authority could not be read again ({staleReason}). Approvals and the commit are paused because this may not match the journal now.</span><button className="soft-button" disabled={pending !== null} aria-busy={pending === "reread" || undefined} onClick={retryRead}>{pending === "reread" ? "Re-reading…" : "Re-read authority"}</button></div></section>}
      {(importErrors.length > 0 || assessment.manifestErrors.length > 0) && <section className="manifest-errors"><WarningIcon weight="fill" /><div><strong>Manifest rejected before assessment</strong>{[...importErrors, ...assessment.manifestErrors.map((error) => `${error.planId}: ${error.message}`)].map((error) => <span key={error}>{error}</span>)}</div></section>}
      <div className="collision-grid">
        <section className="collision-panel manifest-panel"><div className="collision-panel-title"><HardDrivesIcon /><strong>Active plan census</strong><span>{assessment.safeClaims.length} non-colliding claims</span></div><div className="manifest-list">{manifests.map((manifest) => <article className="manifest-card" key={manifest.planId}><header><code>{manifest.planId}</code><strong>{manifest.title}</strong><span>P{manifest.priority}</span></header>{manifest.tasks.map((task) => <div className="manifest-task" key={task.taskId}><span><code>{task.taskId}</code>{task.title}</span><small>{task.claims.length} claims · depends on {(task.dependsOn ?? []).join(", ") || "none"}</small></div>)}</article>)}</div></section>
        <section className="collision-panel collision-results-panel"><div className="collision-panel-title"><WarningIcon /><strong>Deterministic resolution queue</strong><span>{remaining.length ? "allocation blocked" : "allocation ready"}</span></div><div className="collision-list">{assessment.collisions.map((collision) => {
          const approved = approvedIds.has(collision.id); const staged = stagedIds.has(collision.id);
          return <article className={`collision-card ${approved ? "collision-approved" : ""}`} key={collision.id}><header><code>{collision.id}</code><strong>{collision.displaySurface ?? collision.surface}</strong><StatusChip status={approved ? "verified" : collision.severity === "hard-stop" ? "blocked" : "risk"}>{approved ? "order approved" : staged ? "staged only" : collision.severity}</StatusChip></header><p>{collision.reason}</p><div className="collision-pair"><span><small>FIRST</small><strong>{collision.first.planId} · {collision.first.taskId}</strong><code>{collision.first.access}</code></span><ArrowRightIcon /><span><small>THEN</small><strong>{collision.then.planId} · {collision.then.taskId}</strong><code>{collision.then.access}</code></span></div><div className="collision-contingency"><span>CONTINGENCY</span><p>{collision.contingency}</p></div><button disabled={approved || staged || pending !== null || committed || staleReason !== null} aria-busy={pending === collision.id || undefined} onClick={() => approveCollision(collision)}>{approved ? <CheckCircleIcon weight="fill" /> : <ShieldCheckIcon />}{approved ? "Recorded by authority" : pending === collision.id ? "Requesting…" : staged ? "Staged · gate locked" : authorityClient.available ? "Request approval" : "Stage proposed order"}</button></article>;
        })}</div></section>
      </div>
      <section className={`collision-gate ${gateReady ? "gate-ready" : "gate-locked"}`}><div>{gateReady ? <CheckCircleIcon weight="fill" /> : <XCircleIcon weight="fill" />}<span><strong>{gateReady ? "Allocation conveyor unlocked" : "Allocation conveyor blocked"}</strong><small>{committed ? "Assessment committed. Every collision has an authoritative order bound to this census." : gateReady ? "Every collision has an authoritative order bound to this census." : live ? `${remaining.length} collision decisions still require approval.` : gateAuthority.reason}</small></span></div><button className="primary-button" disabled={!gateReady || committed || pending !== null} aria-busy={pending === "commit" || undefined} onClick={commitAssessment}>{committed ? <CheckCircleIcon weight="fill" /> : <ListChecksIcon />} {committed ? "Assessment committed" : pending === "commit" ? "Committing…" : "Commit assessment"}</button></section>
      <section className="integrity-ledger-panel"><header><div><span className="eyebrow">DURABLE APPEND-ONLY AUTHORITY</span><strong>Collision integrity ledger</strong></div><button className="soft-button" disabled={!live} onClick={verifyChain}><ShieldCheckIcon /> Verify chain</button></header><div className="integrity-ledger-summary"><StatusChip status={live ? ledgerIntegrity === "verified" ? "verified" : "queued" : staleReason !== null ? "risk" : "blocked"}>{live ? ledgerIntegrity : staleReason !== null ? "last known · not live" : "authority unavailable"}</StatusChip><span>{ledger.length ? `head ${ledger.at(-1).hash.slice(0, 12)}` : `census ${censusDigest.slice(0, 12) || "calculating"} · no authoritative decisions`}</span></div><div className="integrity-ledger-entries">{ledger.slice().reverse().slice(0, 5).map((entry) => <div key={entry.hash}><code>{String(entry.sequence).padStart(3, "0")}</code><strong>{entry.type}</strong><span>{entry.actor}</span><code>{entry.hash.slice(0, 12)}</code></div>)}</div></section>
    </section>
  );
}
