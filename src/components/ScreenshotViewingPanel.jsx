import { useState } from "react";
import "./ScreenshotViewingPanel.css";

export function ScreenshotViewingPanel({ record, challenge, onAttest }) {
  const [actor, setActor] = useState(""); const [observation, setObservation] = useState(""); const [confirmed, setConfirmed] = useState(false); const [submitting, setSubmitting] = useState(false);
  const pending = record?.viewingStatus === "UNVIEWED" && challenge?.challengeId && challenge?.token;
  const valid = pending && actor.trim() === challenge.requestedViewer && observation.trim().length >= 12 && confirmed && !submitting;
  const submit = async (event) => { event.preventDefault(); if (!valid) return; setSubmitting(true); try { await onAttest?.({ challengeId: challenge.challengeId, token: challenge.token, actor: actor.trim(), explicitGesture: true, observation: observation.trim() }); } finally { setSubmitting(false); } };
  if (!pending) return <section className="screenshot-viewing-panel" aria-label="Screenshot viewing"><strong>{record?.viewingStatus === "VIEWED" ? "Viewing attested" : "No viewing challenge available"}</strong><p>No attestation can be created from this screen without a current durable challenge.</p></section>;
  return <form className="screenshot-viewing-panel" aria-label="Screenshot viewing" onSubmit={submit}>
    <header><strong>Human screenshot review</strong><span>UNVIEWED</span></header>
    <p>Inspect the exact artifact, identify yourself as <b>{challenge.requestedViewer}</b>, and describe something concrete you observed.</p>
    <label>Viewer name<input aria-label="Viewer name" value={actor} onChange={(event) => setActor(event.target.value)} autoComplete="name" /></label>
    <label>Concrete observation<textarea aria-label="Concrete observation" value={observation} onChange={(event) => setObservation(event.target.value)} /></label>
    <label className="screenshot-viewing-confirm"><input aria-label="I viewed this exact screenshot" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I viewed this exact screenshot and am submitting my own observation.</label>
    <button type="submit" disabled={!valid}>{submitting ? "Recording…" : "Record viewing attestation"}</button>
  </form>;
}
