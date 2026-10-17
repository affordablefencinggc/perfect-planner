import React, { useEffect, useState } from "react";
import { useOptionalProject } from "../project/ProjectProvider.jsx";
import "./RegistryHealthNotice.css";

// Saved-project storage problems the person must hear about; each can be dismissed. Healthy states stay silent.
const ONGOING = new Set(["storage-write-failed", "storage-unavailable", "schema-version-unsupported"]);
// One-off read failures stay visible after a later save succeeds, until the person dismisses them.
const LATCHED = new Set(["storage-corrupt", "external-storage-invalid"]);

export function registryHealthMessage(health, backupKey = null) {
  const reason = health?.reason;
  if (reason === "storage-corrupt") {
    return {
      title: "Saved projects could not be read",
      body: backupKey
        ? [`The planner started with an empty project list. The unreadable data was copied to “${backupKey}” in this browser's storage. Nothing was deleted.`]
        : ["The planner started with an empty project list. Nothing has been deleted, but a backup copy could not be made, so saving a project here will replace the unreadable data."],
    };
  }
  if (reason === "external-storage-invalid") {
    return {
      title: "Another tab saved project data that could not be read",
      body: ["This tab keeps showing the projects it already had. Nothing was deleted."],
    };
  }
  if (reason === "storage-write-failed") {
    return {
      title: "Changes could not be saved on this device",
      body: ["Storage may be full or blocked. Changes are kept in this tab only and will be lost when it closes. Nothing was deleted."],
    };
  }
  if (reason === "storage-unavailable") {
    return {
      title: "This browser is not letting the planner save",
      body: ["Changes are kept in this tab only and will be lost when it closes."],
    };
  }
  if (reason === "schema-version-unsupported") {
    return {
      title: "Saved projects were made by a newer version of Perfect Planner",
      body: ["They have been left untouched. Changes are kept in this tab only."],
    };
  }
  return null;
}

export function RegistryHealthNotice() {
  const project = useOptionalProject();
  const health = project?.registryHealth ?? null;
  const backupKey = project?.registryBackupKey ?? null;
  const [latched, setLatched] = useState(() => (LATCHED.has(health?.reason) ? health : null));
  const [dismissed, setDismissed] = useState(null);

  useEffect(() => {
    if (LATCHED.has(health?.reason)) setLatched(health);
    // A dismissed ongoing problem comes back once storage recovers and then fails again.
    if (ONGOING.has(dismissed) && health?.reason !== dismissed) setDismissed(null);
  }, [health]); // Only a new health value changes what is shown.

  const shown = (ONGOING.has(health?.reason) && health.reason !== dismissed ? health : null) ?? latched;
  const message = registryHealthMessage(shown, backupKey);
  if (!message) return null;
  const dismiss = () => {
    if (shown === latched) setLatched(null);
    else setDismissed(shown.reason);
  };
  return (
    <div className="registry-health-notice" role="alert" data-reason={shown.reason}>
      <div className="registry-health-notice__text">
        <strong>{message.title}</strong>
        {message.body.map((line) => <span key={line}>{line}</span>)}
      </div>
      <button type="button" onClick={dismiss}>Dismiss</button>
    </div>
  );
}
