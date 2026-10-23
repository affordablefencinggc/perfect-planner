import { useState } from "react";
import "./PeoplePanel.css";
import { PersonProfile } from "./PersonProfile.jsx";
import { statsFromTasks } from "./profileStats.js";
import { ID_PATTERN, initials, isIdle, presenceLine, slugify, stageLabel } from "./presenceText.js";

const STAGES = ["plan", "task", "relay", "git", "proof", "release", "people", "housekeeping"];
const ROLE_LABEL = { owner: "Owner", helper: "Helper", viewer: "Viewer" };
const PHOTO_MAX_BYTES = 512 * 1024;
const PHOTO_TYPES = "image/png,image/jpeg,image/webp,image/gif";

function Avatar({ member, photos }) {
  const src = photos[member.person];
  if (src) return <img className="people-avatar" src={src} alt={member.name} />;
  return (
    <span className="people-avatar people-avatar-initials" role="img" aria-label={member.name}>
      <span aria-hidden="true">{initials(member.name)}</span>
    </span>
  );
}

function AddMemberForm({ members, firstMember, starter, onAddMember }) {
  const [name, setName] = useState("");
  const [idEdit, setIdEdit] = useState(null);
  const [role, setRole] = useState(firstMember ? "owner" : "helper");
  const [error, setError] = useState("");
  // The person who already wrote to this project on this computer is the only one who may become its owner.
  const fixedId = firstMember && starter ? starter : null;
  const person = fixedId ?? idEdit ?? slugify(name);
  const taken = members.some((m) => m.person === person);
  const idValid = ID_PATTERN.test(person);
  const idProblem = !person ? "" : !idValid ? "Use lowercase letters, digits and dashes (up to 40 characters)" : taken ? "That person id is already on this project" : "";
  const valid = name.trim().length > 0 && idValid && !taken;
  const roles = firstMember ? ["owner", "helper", "viewer"] : ["helper", "viewer"];
  // The role picked for the first member (owner) must not carry over once the roster has an owner.
  const chosenRole = roles.includes(role) ? role : roles[0];
  const submit = async (event) => {
    event.preventDefault();
    if (!valid) return;
    setError("");
    try {
      await onAddMember({ person, name: name.trim(), role: chosenRole });
      setName(""); setIdEdit(null);
    } catch (e) {
      setError(e?.message || "Could not add this person");
    }
  };
  return (
    <form className="people-form" aria-label="Add helper" onSubmit={submit}>
      <h3>{firstMember ? "Add the first person" : "Add helper"}</h3>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></label>
      <label>Person id<input value={person} onChange={(e) => setIdEdit(e.target.value)} readOnly={Boolean(fixedId)} autoComplete="off" aria-invalid={idProblem ? "true" : undefined} /></label>
      {fixedId && <p className="people-hint">You have already been working on this project as {fixedId}, so that stays your person id.</p>}
      <label>Role<select value={chosenRole} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
      {idProblem && <p className="people-error" role="alert">{idProblem}</p>}
      {error && <p className="people-error" role="alert">{error}</p>}
      <button type="submit" disabled={!valid}>Add person</button>
    </form>
  );
}

function ShareDocForm({ onShareDoc }) {
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const valid = title.trim() && path.trim();
  const submit = async (event) => {
    event.preventDefault();
    if (!valid) return;
    setError("");
    try {
      await onShareDoc({ title: title.trim(), path: path.trim() });
      setTitle(""); setPath("");
    } catch (e) {
      setError(e?.message || "Could not share this document");
    }
  };
  return (
    <form className="people-form" aria-label="Share a document" onSubmit={submit}>
      <h3>Share a document</h3>
      <label>Document title<input value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" /></label>
      <label>Document path<input value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" /></label>
      {error && <p className="people-error" role="alert">{error}</p>}
      <button type="submit" disabled={!valid}>Share document</button>
    </form>
  );
}

export function PeoplePanel({ view, photos = {}, me, starter, now = () => new Date(), onAddMember, onChangeRole, onRemoveMember, onSetPhoto, onShareDoc, onOpenDoc, tasks = [], onAssign }) {
  const [profileOf, setProfileOf] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [photoError, setPhotoError] = useState("");
  const members = view?.members ?? [];
  const docs = view?.docs ?? [];
  const nowDate = now();
  const solo = members.length === 0;
  const isOwner = Boolean(me) && me === view?.owner?.person;
  const canManage = isOwner;
  const canAdd = Boolean(onAddMember) && (isOwner || solo);
  const nameOf = (id) => members.find((m) => m.person === id)?.name ?? id;

  const pickPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPhotoError("");
    if (file.size > PHOTO_MAX_BYTES) { setPhotoError("Photos must be 512 KB or smaller"); return; }
    try { await onSetPhoto(file); } catch (e) { setPhotoError(e?.message || "Could not save the photo"); }
  };

  const stageGroups = STAGES.map((stage) => ({ stage, people: members.filter((m) => m.presence?.stage === stage) })).filter((g) => g.people.length);

  return (
    <div className="people-panel">
      <section className="people-section" aria-label="People on this project">
        <h2>People</h2>
        {solo && <p className="people-empty">Just you for now. Add a helper to share this project.</p>}
        {stageGroups.length > 0 && (
          <div className="people-stages" aria-label="Where everyone is">
            <h3>Where everyone is</h3>
            <ul>
              {stageGroups.map((g) => (
                <li key={g.stage} aria-label={`${stageLabel(g.stage)} stage: ${g.people.map((m) => m.name).join(", ")}`}>
                  <span className="people-stage-name">{stageLabel(g.stage)}</span>
                  <span className="people-stage-faces">{g.people.map((m) => <Avatar key={m.person} member={m} photos={photos} />)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {members.length > 0 && (
          <ul className="people-list">
            {members.map((m) => {
              const idle = isIdle(m.presence, nowDate);
              const isMe = m.person === me;
              return (
                <li key={m.person} className="people-row" data-person={m.person}>
                  <Avatar member={m} photos={photos} />
                  <div className="people-main">
                    <div className="people-head">
                      <strong className="people-name">{m.name}</strong>
                      <span className={`people-role people-role-${m.role}`}>{ROLE_LABEL[m.role] ?? m.role}</span>
                      {isMe && <span className="people-you">You</span>}
                    </div>
                    {m.role === "helper" && m.approves?.length > 0 && <p className="people-approves">Can approve: {m.approves.join(", ")}</p>}
                    <button type="button" className="people-profile-open" aria-label={`Open ${m.name} profile`} onClick={() => setProfileOf(m.person)}>Profile</button>
                    <p className={`people-presence${idle ? " is-idle" : ""}`}>{presenceLine(m, nowDate)}{idle && <span className="people-idle-tag"> (idle)</span>}</p>
                    {isMe && onSetPhoto && (
                      <label className="people-photo">Change photo<input type="file" accept={PHOTO_TYPES} onChange={pickPhoto} /></label>
                    )}
                    {isMe && photoError && <p className="people-error" role="alert">{photoError}</p>}
                  </div>
                  {canManage && m.role !== "owner" && (onChangeRole || onRemoveMember) && (
                    <div className="people-actions">
                      {onChangeRole && (
                        <select aria-label={`Role for ${m.name}`} value={m.role} onChange={(e) => onChangeRole(m.person, e.target.value)}>
                          <option value="helper">helper</option>
                          <option value="viewer">viewer</option>
                        </select>
                      )}
                      {onRemoveMember && (confirming === m.person ? (
                        <>
                          <button type="button" className="people-danger" onClick={() => { setConfirming(null); onRemoveMember(m.person); }}>Confirm remove</button>
                          <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
                        </>
                      ) : (
                        <button type="button" aria-label={`Remove ${m.name}`} onClick={() => setConfirming(m.person)}>Remove</button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canAdd && <AddMemberForm members={members} firstMember={solo} starter={starter} onAddMember={onAddMember} />}
      </section>

      {profileOf && (() => {
        const m = members.find((x) => x.person === profileOf);
        if (!m) return null;
        const stats = statsFromTasks(m, tasks);
        return (
          <PersonProfile
            onClose={() => setProfileOf(null)}
            onAssign={isOwner ? onAssign : undefined}
            onShareLink={isOwner ? onShareDoc : undefined}
            profile={{ person: m.person, name: m.name, role: ROLE_LABEL[m.role] ?? m.role, avatar: photos[m.person], stats, assignable: isOwner && onAssign ? tasks.filter((t) => !t.owner && t.status !== "done" && t.stage !== "done").map((t) => ({ id: t.id, label: t.label ?? t.id })) : undefined, today: now().toISOString().slice(0, 10) }}
          />
        );
      })()}

      <section className="people-section" aria-label="Shared documents">
        <h2>Shared documents</h2>
        {docs.length === 0 ? <p className="people-empty">No documents shared yet</p> : (
          <ul className="people-docs">
            {docs.map((d) => (
              <li key={`${d.doc}-${d.version}`} className="people-doc">
                {onOpenDoc ? <button type="button" className="people-doc-title" onClick={() => onOpenDoc(d)}>{d.title}</button> : <span className="people-doc-title">{d.title}</span>}
                <span className="people-version">{d.version}</span>
                <span className="people-kind">{d.kind === "plan" ? "Plan" : "Document"}</span>
                {d.clauses?.length > 0 && <span className="people-clauses">{d.clauses.length} clauses</span>}
                <span className="people-shared">Shared by {nameOf(d.sharedBy)} on {String(d.at ?? "").slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        )}
        {isOwner && onShareDoc && <ShareDocForm onShareDoc={onShareDoc} />}
      </section>
    </div>
  );
}

export default PeoplePanel;
