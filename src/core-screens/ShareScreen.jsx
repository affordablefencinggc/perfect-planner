import { useState } from "react";
import { CoreScreen } from "./CoreScreen.jsx";
import { useCoreResource } from "./coreApi.js";
import "./ShareScreen.css";

// Share: send work to a teammate as a file and receive theirs, with no server in between.
// Reads GET /api/core/share; writes through /share/export, /share/import and /share/check.
// Files live in two folders inside the project, so nothing here names a path.

const OUT = ".perfect-planner/share/outbox";
const IN = ".perfect-planner/share/inbox";
const errorText = (error) => error?.message || "That did not work. Try again.";

function Send({ branches, post, reload }) {
  const [picked, setPicked] = useState([]);
  const [name, setName] = useState("my-work");
  const [state, setState] = useState({ busy: false, done: null, error: null });
  const toggle = (branch) => setPicked((now) => (now.includes(branch) ? now.filter((b) => b !== branch) : [...now, branch]));
  const send = async () => {
    setState({ busy: true, done: null, error: null });
    try {
      const done = await post("/share/export", { name: name.trim(), branches: picked });
      setState({ busy: false, done, error: null });
      reload();
    } catch (error) {
      setState({ busy: false, done: null, error: errorText(error) });
    }
  };
  return (
    <section className="share-card" aria-labelledby="share-send">
      <h3 id="share-send">Send your work</h3>
      {branches.length === 0 ? (
        <p className="core-muted">No task branches yet. Work started from the Tasks page shows up here.</p>
      ) : (
        <>
          <ul className="share-list">
            {branches.map((branch) => (
              <li key={branch}>
                <label><input type="checkbox" checked={picked.includes(branch)} onChange={() => toggle(branch)} /> {branch}</label>
              </li>
            ))}
          </ul>
          <label className="share-field">File name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={70} />
          </label>
          <button type="button" className="core-button" disabled={state.busy || picked.length === 0 || !name.trim()} onClick={send}>
            {state.busy ? "Making the file…" : "Make the file"}
          </button>
        </>
      )}
      {state.error && <p className="share-error" role="alert">{state.error}</p>}
      {state.done && <p role="status">Saved <strong>{state.done.file}</strong> in <code>{OUT}</code>. Send that file to your teammate any way you like.</p>}
    </section>
  );
}

function Receive({ inbox, received, post, reload }) {
  const [message, setMessage] = useState(null);
  const [checks, setChecks] = useState({});
  const run = async (action) => {
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(errorText(error));
    }
  };
  const take = (file) => run(async () => {
    const result = await post("/share/import", { file });
    setMessage(`Received ${Object.keys(result.refs).length} branch(es) from ${result.sender}. Your own work was not changed.`);
    reload();
  });
  const check = (ref) => run(async () => {
    const [sender, ...rest] = ref.split("/");
    const result = await post("/share/check", { sender, branch: rest.join("/") });
    setChecks((now) => ({ ...now, [ref]: result }));
  });
  return (
    <section className="share-card" aria-labelledby="share-receive">
      <h3 id="share-receive">Receive work</h3>
      <p className="core-muted">Put the file you were sent in <code>{IN}</code>, then pick it here.</p>
      {inbox.length === 0 ? <p className="core-muted">The inbox is empty.</p> : (
        <ul className="share-list">
          {inbox.map((file) => (
            <li key={file.name}>{file.name} <button type="button" className="core-button" onClick={() => take(file.name)}>Check and receive</button></li>
          ))}
        </ul>
      )}
      {message && <p role="status" className="share-note">{message}</p>}
      {received.length > 0 && (
        <>
          <h4>Received</h4>
          <ul className="share-list">
            {received.map((ref) => (
              <li key={ref}>
                {ref} <button type="button" className="core-button" onClick={() => check(ref)}>Will it merge?</button>
                <Verdict result={checks[ref]} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Verdict({ result }) {
  if (!result) return null;
  if (result.clean) return <p className="share-ok">{result.alreadyIn ? `Already part of ${result.base}.` : `Merges cleanly into ${result.base}.`}</p>;
  return (
    <div className="share-conflict">
      <p>These files were changed on both sides, so they need a person to choose:</p>
      <ul>{result.conflicts.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
      <p className="core-muted">Nothing was merged. Both versions are kept until you decide.</p>
    </div>
  );
}

export default function ShareScreen() {
  const resource = useCoreResource("/share", { isEmpty: () => false });
  const data = resource.data;
  return (
    <CoreScreen id="share" title="Share" purpose="Send work to a teammate as a file and receive theirs. Private: no GitHub, no server." resource={resource}>
      {data && (
        <>
          <p className="share-note" role="note">Files are checked for damage but not yet for who sent them, so only accept files from people you know.</p>
          <Send branches={data.branches} post={resource.post} reload={resource.reload} />
          <Receive inbox={data.inbox} received={data.received} post={resource.post} reload={resource.reload} />
        </>
      )}
    </CoreScreen>
  );
}
