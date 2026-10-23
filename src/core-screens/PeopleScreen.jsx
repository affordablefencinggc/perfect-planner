import { useState } from "react";
import { PeoplePanel } from "../people/PeoplePanel.jsx";
import { AdvancedOnly, CoreScreen, useAdvanced } from "./CoreScreen.jsx";
import { useCoreResource } from "./coreApi.js";
import "./PeopleScreen.css";

// People (spec §9): who is on this project, what each person may do, where
// everyone is, and the documents everyone can see. The panel in src/people/
// draws it; this screen feeds it from /api/core/people and turns its
// callbacks into ledger writes.

// Same limit as core/people (PHOTO_MAX_BYTES); the service checks it again.
const PHOTO_UPLOAD_MAX = 512 * 1024;

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The photo could not be read."));
    reader.readAsDataURL(file);
  });
}

function PeopleDetails({ data }) {
  const { view } = data;
  return (
    <AdvancedOnly as="section" className="core-card people-screen-details">
      <h3>Ledger details</h3>
      <dl>
        <dt>You are</dt><dd>{data.me}</dd>
        {view.head && (<><dt>Built from</dt><dd>{view.head}</dd></>)}
      </dl>
      {view.members.length > 0 && (
        <table>
          <caption>People</caption>
          <thead><tr><th scope="col">Person id</th><th scope="col">Role</th><th scope="col">Added in</th><th scope="col">Last entry</th><th scope="col">Agents</th><th scope="col">Photo fingerprint</th></tr></thead>
          <tbody>
            {view.members.map((m) => (
              <tr key={m.person}>
                <td>{m.person}</td>
                <td>{m.role}{m.approves?.length ? ` (${m.approves.join(", ")})` : ""}</td>
                <td>{m.since}</td>
                <td>{m.presence ? `${m.presence.entry} ${m.presence.type}` : "—"}</td>
                <td>{m.agents?.length ? m.agents.join(", ") : "—"}</td>
                <td>{m.photo ? m.photo.sha256.slice(0, 12) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.docs.length > 0 && (
        <table>
          <caption>Shared documents</caption>
          <thead><tr><th scope="col">Document id</th><th scope="col">Version</th><th scope="col">Path</th><th scope="col">Entry</th></tr></thead>
          <tbody>
            {view.docs.map((d) => (
              <tr key={`${d.doc}-${d.version}`}><td>{d.doc}</td><td>{d.version}</td><td>{d.path || "—"}</td><td>{d.entry}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </AdvancedOnly>
  );
}

export default function PeopleScreen() {
  const resource = useCoreResource("/people", { isEmpty: (data) => !data || !data.view });
  const tasksResource = useCoreResource("/tasks", { isEmpty: () => false });
  const advanced = useAdvanced();
  const [notice, setNotice] = useState(null);
  const data = resource.data;

  // Panel callbacks. Add, photo and share errors are shown inside the panel;
  // role and remove errors are shown in the notice line above it.
  const run = async (path, body, done) => {
    const result = await resource.post(path, body);
    if (done) setNotice({ kind: "good", text: advanced && result?.entry ? `${done} (${result.entry})` : done });
    return result;
  };
  const guarded = (fn) => async (...args) => {
    setNotice(null);
    try { await fn(...args); } catch (error) { setNotice({ kind: "bad", text: error?.message || "That change could not be saved." }); }
  };
  const nameOf = (person) => data?.view?.members?.find((m) => m.person === person)?.name ?? person;

  const handlers = {
    onAddMember: async ({ person, name, role }) => {
      setNotice(null);
      const first = !data?.view?.members?.length;
      await run("/people/members", { person, name, role }, first ? `${name} is now the owner of this project.` : `${name} was added as a ${role}.`);
    },
    onChangeRole: guarded((person, role) => run(`/people/members/${encodeURIComponent(person)}/role`, { role }, `${nameOf(person)} is now a ${role}.`)),
    onRemoveMember: guarded((person) => run(`/people/members/${encodeURIComponent(person)}/remove`, {}, `${nameOf(person)} was removed from the project.`)),
    onSetPhoto: async (file) => {
      setNotice(null);
      if (file.size > PHOTO_UPLOAD_MAX) throw new Error("Photos must be 512 KB or smaller.");
      await run("/people/photo", { image: await readAsBase64(file) }, "Your photo was saved.");
    },
    onAssign: async ({ person, task }) => {
      setNotice(null);
      await run("/people/assign", { person, task }, `${task} was given to ${nameOf(person)}.`);
      tasksResource.reload?.();
    },
    onShareDoc: async ({ title, path }) => {
      setNotice(null);
      await run("/people/docs", { title, path }, `${title} is now shared with everyone on the project.`);
    },
    onOpenDoc: (doc) => {
      if (/^https:\/\//i.test(doc.path)) {
        window.open(doc.path, "_blank", "noopener,noreferrer");
        return;
      }
      setNotice({ kind: "info", text: doc.path ? `${doc.title} is in the project folder at ${doc.path}.` : `${doc.title} has no file path recorded.` });
    },
  };

  return (
    <CoreScreen
      id="people"
      title="People"
      purpose="See who is on this project, what each person may do and where everyone is, and share the documents everyone should read."
      resource={resource}
      empty={<strong>People could not be shown yet.</strong>}
    >
      {data?.ownerMissing && (
        <p className="people-screen-notice is-bad" role="alert">
          This device does not have this project's owner key, so nobody can add people or share documents here. Open the project on the computer where it was started, or start a new project.
        </p>
      )}
      {data?.firstRun && (
        <p className="people-screen-intro core-card">
          Nobody is on the roster yet, so this project works just for you. Add yourself first: the first person added is the owner, who can then add helpers and viewers.
        </p>
      )}
      {notice && (
        <p className={`people-screen-notice is-${notice.kind}`} role={notice.kind === "bad" ? "alert" : "status"}>{notice.text}</p>
      )}
      {data && <PeoplePanel view={data.view} photos={data.photos ?? {}} tasks={tasksResource.data?.tasks ?? []} me={data.me} starter={data.starter} {...handlers} {...(data.ownerMissing ? { onAddMember: undefined, onShareDoc: undefined, onAssign: undefined } : {})} />}
      {data && <PeopleDetails data={data} />}
    </CoreScreen>
  );
}
