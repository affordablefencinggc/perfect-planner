import { useRef, useState } from "react";
import "./ScreenshotViewingPanel.css";

// Not mounted in the app yet: nothing in the app supplies a durable challenge. This component only
// emits a decision; durable authority (src/node/screenshotEvidence.mjs) decides whether it counts.
export function ScreenshotViewingPanel({ record, challenge, onAttest }) {
  const [actor, setActor] = useState(""); const [observation, setObservation] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false); const [submitted, setSubmitted] = useState(false); const [error, setError] = useState("");
  const inFlight = useRef(false);
  const pending = record?.viewingStatus === "UNVIEWED" && challenge?.challengeId && challenge?.token;
  const nameMismatch = pending && actor.trim().length > 0 && actor.trim() !== challenge.requestedViewer;
  const valid = pending && actor.trim() === challenge.requestedViewer && observation.trim().length >= 12 && confirmed && !submitting && !submitted;
  const submit = async (event) => {
    event.preventDefault();
    if (!valid || inFlight.current) return;
    inFlight.current = true; setSubmitting(true); setError("");
    try {
      await onAttest?.({ challengeId: challenge.challengeId, token: challenge.token, actor: actor.trim(), explicitGesture: true, observation: observation.trim() });
      setSubmitted(true);
    } catch {
      // The decision was not recorded; keep the form so the reviewer can try again.
      setError("The viewing attestation was not recorded. The screenshot is still UNVIEWED. Check that the challenge has not expired, then try again.");
    } finally { inFlight.current = false; setSubmitting(false); }
  };
  if (!pending) return <section className="screenshot-viewing-panel" aria-label="Screenshot viewing">{record?.viewingStatus === "VIEWED"
    ? <><strong>Viewing attested</strong><p>A named reviewer has already recorded viewing this exact screenshot. Nothing more is needed here.</p></>
    : <><strong>No viewing challenge available</strong><p>No attestation can be created from this screen without a current durable challenge.</p></>}</section>;
  if (submitted) return <section className="screenshot-viewing-panel" aria-label="Screenshot viewing"><strong>Viewing decision submitted</strong><p role="status">Your observation was sent for recording. The screenshot counts as viewed only once the evidence record shows VIEWED.</p></section>;
  return <form className="screenshot-viewing-panel" aria-label="Screenshot viewing" onSubmit={submit}>
    <header><strong>Human screenshot review</strong><span>UNVIEWED</span></header>
    <p>Inspect the exact artifact, identify yourself as <b>{challenge.requestedViewer}</b>, and describe something concrete you observed.</p>
    <label>Viewer name<input aria-label="Viewer name" aria-describedby={nameMismatch ? "screenshot-viewing-name-hint" : undefined} aria-invalid={nameMismatch || undefined} value={actor} disabled={submitting} onChange={(event) => setActor(event.target.value)} autoComplete="name" /></label>
    {nameMismatch && <p id="screenshot-viewing-name-hint" className="screenshot-viewing-hint">This review was requested from <b>{challenge.requestedViewer}</b>. Enter that name exactly, including capitals.</p>}
    <label>Concrete observation<textarea aria-label="Concrete observation" value={observation} disabled={submitting} onChange={(event) => setObservation(event.target.value)} /></label>
    <label className="screenshot-viewing-confirm"><input aria-label="I viewed this exact screenshot" type="checkbox" checked={confirmed} disabled={submitting} onChange={(event) => setConfirmed(event.target.checked)} />I viewed this exact screenshot and am submitting my own observation.</label>
    {error && <p role="alert" className="screenshot-viewing-error">{error}</p>}
    <button type="submit" disabled={!valid}>{submitting ? "Recording…" : "Record viewing attestation"}</button>
  </form>;
}
