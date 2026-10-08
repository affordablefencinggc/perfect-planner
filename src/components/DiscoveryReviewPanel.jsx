import { useMemo, useState } from "react";
import { CheckCircleIcon, ChatTextIcon, MinusCircleIcon, ArrowCounterClockwiseIcon, ListChecksIcon } from "@phosphor-icons/react";
import { writeSection } from "../project/projectWorkRecords.js";
import { useProjectWorkRecords } from "../project/useProjectWorkRecords.js";
import { deriveDiscoveryReview, nextDiscoveryReviewData, DISCOVERY_NOTE_LIMIT } from "../project/discoveryReviewModel.js";
import "./DiscoveryReviewPanel.css";

const FOUND_LABEL = { observed: "Found in your files", signal: "Possible match — please check", unanswered: "Nothing found" };
const DECISION_LABEL = { confirmed: "Looks right", "not-applicable": "Not applicable", answered: "Answered" };

function CategoryRow({ item, findings, disabled, onDecide }) {
  const [answering, setAnswering] = useState(false);
  const [note, setNote] = useState(item.decision?.decision === "answered" ? item.decision.note : "");
  const decide = (decision, text = "") => { if (onDecide(item.id, decision, text)) setAnswering(false); };
  return (
    <li className={`discovery-review-row ${item.state} ${item.decision ? "decided" : item.needsDecision ? "open" : ""}`} aria-label={item.title}>
      <div className="discovery-review-head">
        <span><code>{item.id}</code><strong>{item.title}</strong></span>
        <small>{FOUND_LABEL[item.state] ?? item.state}{item.needsDecision && !item.decision ? " · needs your answer" : ""}</small>
      </div>
      {findings?.length ? (
        <ul className="discovery-review-findings">
          {findings.map((finding) => <li key={finding.id}><b>{finding.certainty === "observed" ? "Found" : "Maybe"}</b> {finding.label}<small>{finding.detail}</small></li>)}
        </ul>
      ) : (
        <p className="discovery-review-empty">{item.findingCount ? `${item.findingCount} finding${item.findingCount === 1 ? "" : "s"} from the last scan. Scan the folder again in this session to see the details.` : "The scan found nothing for this area."}</p>
      )}
      {item.questions.length > 0 && <p className="discovery-review-questions">{item.questions.join(" ")}</p>}
      {item.decision && (
        <p className="discovery-review-decision" role="status">
          <CheckCircleIcon weight="fill" /> {DECISION_LABEL[item.decision.decision]}{item.decision.note ? `: ${item.decision.note}` : ""}
        </p>
      )}
      {answering ? (
        <form className="discovery-review-answer" onSubmit={(event) => { event.preventDefault(); decide("answered", note); }}>
          <label>
            <span>Your answer for {item.title}</span>
            <textarea value={note} maxLength={DISCOVERY_NOTE_LIMIT} rows={2} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div>
            <button type="submit" className="soft-button" disabled={disabled || !note.trim()}>Save answer</button>
            <button type="button" className="soft-button" onClick={() => setAnswering(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="discovery-review-actions">
          <button type="button" className="soft-button" disabled={disabled} aria-pressed={item.decision?.decision === "confirmed"} onClick={() => decide("confirmed")}><CheckCircleIcon /> Looks right</button>
          <button type="button" className="soft-button" disabled={disabled} aria-pressed={item.decision?.decision === "not-applicable"} onClick={() => decide("not-applicable")}><MinusCircleIcon /> Not applicable</button>
          <button type="button" className="soft-button" disabled={disabled} aria-pressed={item.decision?.decision === "answered"} onClick={() => setAnswering(true)}><ChatTextIcon /> Answer</button>
          {item.decision && <button type="button" className="soft-button" disabled={disabled} onClick={() => decide(null)}><ArrowCounterClockwiseIcon /> Undo</button>}
        </div>
      )}
    </li>
  );
}

/**
 * "Review what we found": records the user's decision on each discovery area for
 * one imported project. `liveDiscovery` (optional) is the in-session scan result;
 * its finding details are shown only when it belongs to the same census.
 */
export function DiscoveryReviewPanel({ project, liveDiscovery = null, liveCensusDigest = null, storage, onToast }) {
  const records = useProjectWorkRecords(project?.projectId, storage);
  const review = useMemo(() => deriveDiscoveryReview(project, records), [project, records]);
  const [error, setError] = useState("");
  const discovery = project?.discovery ?? null;
  const findingsById = useMemo(() => {
    if (!liveDiscovery?.categories || !discovery || liveCensusDigest !== discovery.censusDigest) return new Map();
    return new Map(liveDiscovery.categories.map((category) => [category.id, category.findings ?? []]));
  }, [liveDiscovery, liveCensusDigest, discovery]);
  if (!project || project.kind === "demo") return null;

  const usable = discovery?.state === "generated" && project.state !== "stale" && project.state !== "unavailable";
  const onDecide = (categoryId, decision, note) => {
    try {
      const data = nextDiscoveryReviewData(project, records.sections.discoveryReview?.data ?? null, categoryId, decision, { note });
      writeSection(project.projectId, "discoveryReview", data, storage ? { storage } : undefined);
      setError("");
      return true;
    } catch (cause) {
      const message = cause?.message === "DISCOVERY_REVIEW_ANSWER_REQUIRED" ? "Write a short answer before saving." : "Your answer could not be saved in this browser. Nothing was changed.";
      setError(message);
      onToast?.(message);
      return false;
    }
  };

  const summary = !discovery
    ? "Scan the app folder first. There is nothing to review yet."
    : !usable
      ? "This scan is out of date or unavailable. Scan the folder again before reviewing."
      : review.required === 0
        ? "Every area had clear findings. Nothing needs your answer."
        : review.open === 0
          ? `All ${review.required} areas that needed a look have your answer.`
          : `${review.open} of ${review.required} areas still need your answer.`;

  return (
    <section className="discovery-review-panel" aria-label="Review what we found">
      <header>
        <ListChecksIcon />
        <span>
          <strong>Review what we found</strong>
          <small>{summary}</small>
        </span>
        {usable && review.required > 0 && <b className={review.open === 0 ? "done" : ""}>{review.decided}/{review.required}</b>}
      </header>
      {review.outdated && usable && <p className="discovery-review-note" role="status">You scanned the folder again since your last review, so earlier answers no longer count. Please review this scan.</p>}
      {error && <p className="discovery-review-error" role="alert">{error}</p>}
      {discovery && (
        <ol>
          {review.items.map((item) => (
            <CategoryRow key={`${item.id}:${review.snapshot?.generatedAt ?? ""}:${item.decision?.decidedAt ?? ""}`} item={item} findings={findingsById.get(item.id)} disabled={!usable} onDecide={onDecide} />
          ))}
        </ol>
      )}
      <p className="discovery-review-footnote">Answers are saved for this project on this device and apply only to the current scan.</p>
    </section>
  );
}
