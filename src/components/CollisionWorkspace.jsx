import { useEffect, useMemo, useState } from "react";
import { ArrowRightIcon, CheckCircleIcon, HardDrivesIcon, ListChecksIcon, ShieldCheckIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import { assessCollisions, collisionCensusDigest, validateManifest, verifyLedger } from "../engine/collisionEngine.js";
import { createCollisionAuthorityClient, createHttpCollisionAuthorityAdapter } from "../engine/collisionAuthorityClient.js";
import { createNativeCollisionAuthorityAdapter } from "../native/collisionAuthority.js";
import { collisionSeedManifests } from "../engine/collisionSeed.js";

const statusLabel = { verified: "verified", risk: "at risk", blocked: "hard stop", queued: "queued" };
function StatusChip({ status, children }) { return <span className={`status-chip status-${status}`}>{children ?? statusLabel[status] ?? status}</span>; }

export function CollisionWorkspace({ onGateChange, onToast }) {
  const [manifests, setManifests] = useState(collisionSeedManifests);
  const authorityClient = useMemo(() => createCollisionAuthorityClient({
    planId: "PP-CLEANROOM",
    adapter: createNativeCollisionAuthorityAdapter() ?? createHttpCollisionAuthorityAdapter(),
  }), []);
  const [authority, setAuthority] = useState({ authoritative: false, approvedIds: [], ledger: [], reason: "Calculating plan census…" });
  const [stagedIds, setStagedIds] = useState(new Set());
  const [censusDigest, setCensusDigest] = useState("");
  const [ledgerIntegrity, setLedgerIntegrity] = useState("unchecked");
  const [importErrors, setImportErrors] = useState([]);
  const assessment = useMemo(() => assessCollisions(manifests), [manifests]);
  const approvedIds = useMemo(() => new Set(authority.approvedIds), [authority.approvedIds]);
  const ledger = authority.ledger;
  const remaining = assessment.collisions.filter((collision) => !approvedIds.has(collision.id));
  const gateReady = authority.authoritative === true && assessment.manifestErrors.length === 0 && remaining.length === 0;

  useEffect(() => {
    let current = true;
    collisionCensusDigest(manifests).then(async (digest) => {
      const snapshot = await authorityClient.inspect(digest);
      if (current) { setCensusDigest(digest); setAuthority(snapshot); setStagedIds(new Set()); setLedgerIntegrity("unchecked"); }
    });
    return () => { current = false; };
  }, [authorityClient, manifests]);

  useEffect(() => {
    onGateChange({ ready: gateReady, unresolved: remaining.length, hardStops: remaining.filter((collision) => collision.severity === "hard-stop").length, authorityAvailable: authority.authoritative === true, authorityReason: authority.authoritative ? null : authority.reason });
  }, [authority.authoritative, authority.reason, gateReady, remaining.length, onGateChange]);

  const approveCollision = async (collision) => {
    if (!authorityClient.available) {
      setStagedIds((current) => new Set(current).add(collision.id));
      onToast("Order staged for review only. Native authority is required to unlock allocation.");
      return;
    }
    const snapshot = await authorityClient.approve(censusDigest, collision);
    setAuthority(snapshot); setLedgerIntegrity("unchecked");
    if (!snapshot.approvedIds.includes(collision.id)) onToast(`Approval for ${collision.id} was not recorded: ${snapshot.reason ?? "the authority did not confirm it"}`);
  };
  const commitAssessment = async () => {
    const surfaces = [...new Set(assessment.claims.map((claim) => `${claim.access}:${claim.surface}`))];
    const snapshot = await authorityClient.commit(censusDigest, { manifestIds: manifests.map((manifest) => manifest.planId), claims: surfaces.length, collisionIds: assessment.collisions.map((collision) => collision.id), surfaces });
    setAuthority(snapshot);
    onToast(snapshot.authoritative ? "Collision assessment committed by native authority." : snapshot.reason);
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
  const resetCensus = () => { setManifests(collisionSeedManifests); setStagedIds(new Set()); setImportErrors([]); };

  return (
    <section className="workspace collision-workspace" aria-label="Collision assessment workspace">
      <header className="collision-page-header">
        <div><span className="eyebrow">LOCAL MANIFEST CENSUS · READ ONLY</span><h1>Collision control</h1><p>Compare every active plan claim before an agent receives a file, API, database, or dependency lease.</p></div>
        <div className="collision-actions"><label className="soft-button manifest-import"><HardDrivesIcon /> Import manifests<input type="file" accept="application/json,.json" multiple onChange={importManifests} /></label><button className="soft-button" onClick={resetCensus}>Reset demo census</button></div>
      </header>
      <div className="collision-metrics"><div><strong>{manifests.length}</strong><span>plan manifests</span></div><div><strong>{assessment.claims.length}</strong><span>normalized claims</span></div><div><strong>{assessment.collisions.length}</strong><span>detected collisions</span></div><div className={remaining.length ? "metric-danger" : "metric-success"}><strong>{remaining.length}</strong><span>unresolved</span></div><div><strong>{ledger.length}</strong><span>ledger entries</span></div></div>
      {(importErrors.length > 0 || assessment.manifestErrors.length > 0) && <section className="manifest-errors"><WarningIcon weight="fill" /><div><strong>Manifest rejected before assessment</strong>{[...importErrors, ...assessment.manifestErrors.map((error) => `${error.planId}: ${error.message}`)].map((error) => <span key={error}>{error}</span>)}</div></section>}
      <div className="collision-grid">
        <section className="collision-panel manifest-panel"><div className="collision-panel-title"><HardDrivesIcon /><strong>Active plan census</strong><span>{assessment.safeClaims.length} non-colliding claims</span></div><div className="manifest-list">{manifests.map((manifest) => <article className="manifest-card" key={manifest.planId}><header><code>{manifest.planId}</code><strong>{manifest.title}</strong><span>P{manifest.priority}</span></header>{manifest.tasks.map((task) => <div className="manifest-task" key={task.taskId}><span><code>{task.taskId}</code>{task.title}</span><small>{task.claims.length} claims · depends on {(task.dependsOn ?? []).join(", ") || "none"}</small></div>)}</article>)}</div></section>
        <section className="collision-panel collision-results-panel"><div className="collision-panel-title"><WarningIcon /><strong>Deterministic resolution queue</strong><span>{remaining.length ? "allocation blocked" : "allocation ready"}</span></div><div className="collision-list">{assessment.collisions.map((collision) => {
          const approved = approvedIds.has(collision.id); const staged = stagedIds.has(collision.id);
          return <article className={`collision-card ${approved ? "collision-approved" : ""}`} key={collision.id}><header><code>{collision.id}</code><strong>{collision.surface}</strong><StatusChip status={approved ? "verified" : collision.severity === "hard-stop" ? "blocked" : "risk"}>{approved ? "order approved" : staged ? "staged only" : collision.severity}</StatusChip></header><p>{collision.reason}</p><div className="collision-pair"><span><small>FIRST</small><strong>{collision.first.planId} · {collision.first.taskId}</strong><code>{collision.first.access}</code></span><ArrowRightIcon /><span><small>THEN</small><strong>{collision.then.planId} · {collision.then.taskId}</strong><code>{collision.then.access}</code></span></div><div className="collision-contingency"><span>CONTINGENCY</span><p>{collision.contingency}</p></div><button disabled={approved || staged} onClick={() => approveCollision(collision)}>{approved ? <CheckCircleIcon weight="fill" /> : <ShieldCheckIcon />}{approved ? "Recorded by authority" : staged ? "Staged · gate locked" : authorityClient.available ? "Request approval" : "Stage proposed order"}</button></article>;
        })}</div></section>
      </div>
      <section className={`collision-gate ${gateReady ? "gate-ready" : "gate-locked"}`}><div>{gateReady ? <CheckCircleIcon weight="fill" /> : <XCircleIcon weight="fill" />}<span><strong>{gateReady ? "Allocation conveyor unlocked" : "Allocation conveyor blocked"}</strong><small>{gateReady ? "Every collision has an authoritative order bound to this census." : authority.authoritative ? `${remaining.length} collision decisions still require approval.` : authority.reason}</small></span></div><button className="primary-button" disabled={!gateReady} onClick={commitAssessment}><ListChecksIcon /> Commit assessment</button></section>
      <section className="integrity-ledger-panel"><header><div><span className="eyebrow">DURABLE APPEND-ONLY AUTHORITY</span><strong>Collision integrity ledger</strong></div><button className="soft-button" disabled={!authority.authoritative} onClick={verifyChain}><ShieldCheckIcon /> Verify chain</button></header><div className="integrity-ledger-summary"><StatusChip status={authority.authoritative ? ledgerIntegrity === "verified" ? "verified" : "queued" : "blocked"}>{authority.authoritative ? ledgerIntegrity : "authority unavailable"}</StatusChip><span>{ledger.length ? `head ${ledger.at(-1).hash.slice(0, 12)}` : `census ${censusDigest.slice(0, 12) || "calculating"} · no authoritative decisions`}</span></div><div className="integrity-ledger-entries">{ledger.slice().reverse().slice(0, 5).map((entry) => <div key={entry.hash}><code>{String(entry.sequence).padStart(3, "0")}</code><strong>{entry.type}</strong><span>{entry.actor}</span><code>{entry.hash.slice(0, 12)}</code></div>)}</div></section>
    </section>
  );
}
