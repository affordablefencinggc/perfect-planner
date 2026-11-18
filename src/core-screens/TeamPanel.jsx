import { UserIcon } from "@phosphor-icons/react";
import { useCoreResource } from "./coreApi.js";
import "./TeamPanel.css";

const ROLE_LABEL = {
  owner: "Owner",
  maintainer: "Maintainer",
  builder: "Builder",
  reviewer: "Reviewer",
  "release-manager": "Release manager",
  observer: "Observer",
};

const AVAILABILITY_LABEL = { online: "On", busy: "Busy", offline: "Off" };

function initials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

// The team strip is a fold over the same roster the People screen writes. It shows who is
// on, what each person holds, and what is free. An empty roster says so instead of inventing
// a teammate; a member with no active task says "free" instead of showing a stale claim.
export function TeamPanel({ onOpenTask }) {
  const resource = useCoreResource("/teams", { pollMs: 15000, isEmpty: (data) => !data?.members?.length });
  const members = resource.status === "ready" ? resource.data?.members ?? [] : [];

  if (resource.status === "error") {
    return (
      <section className="team-panel team-panel-empty" aria-label="Team">
        <UserIcon weight="duotone" aria-hidden="true" />
        <div>
          <strong>Team roster could not be read</strong>
          <p>{resource.error?.message ?? "The roster is unavailable. Work can still continue on the board."}</p>
        </div>
      </section>
    );
  }

  if (!members.length) {
    return (
      <section className="team-panel team-panel-empty" aria-label="Team">
        <UserIcon weight="duotone" aria-hidden="true" />
        <div>
          <strong>Roster empty · working alone</strong>
          <p>Add people in People to tag work in and out.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="team-panel" aria-label="Team">
      <header>
        <strong>Team</strong>
        <span>{members.length} {members.length === 1 ? "person" : "people"}</span>
      </header>
      <ul>
        {members.map((member) => (
          <li key={member.id} className={`team-member team-${member.availability ?? "offline"}`}>
            <span className="team-avatar" aria-hidden="true">{initials(member.name)}</span>
            <span className="team-name">
              <strong>{member.name}</strong>
              <small>{ROLE_LABEL[member.role] ?? member.role} · {AVAILABILITY_LABEL[member.availability] ?? member.availability ?? "unknown"}</small>
            </span>
            {member.activeTask ? (
              <button
                type="button"
                className="team-task"
                onClick={() => onOpenTask?.(member.activeTask)}
                title={`Open ${member.activeTask.id}`}
              >
                {member.activeTask.id} · {member.activeTask.title}
              </button>
            ) : (
              <span className="team-free">free</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default TeamPanel;
