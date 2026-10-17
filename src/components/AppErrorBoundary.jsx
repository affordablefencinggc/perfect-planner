import React from "react";

// Session-only flag: the app starts with an in-memory registry for this tab. Saved projects in localStorage are never touched.
export const SAFE_START_KEY = "perfect-planner.safe-start.v1";
export const SAFE_START_PARAM = "safe-start";

function sessionStore(runtime = globalThis) {
  try { return runtime?.sessionStorage ?? null; } catch { return null; }
}

export function isSafeStart(runtime = globalThis) {
  try { if (new URL(runtime.location.href).searchParams.get(SAFE_START_PARAM) === "1") return true; } catch { /* No usable URL. */ }
  try { return sessionStore(runtime)?.getItem(SAFE_START_KEY) === "1"; } catch { return false; }
}

function withoutParam(runtime) {
  try { const url = new URL(runtime.location.href); url.searchParams.delete(SAFE_START_PARAM); return url.toString(); } catch { return null; }
}

export function enterSafeStart(runtime = globalThis) {
  let stored = false;
  try { sessionStore(runtime)?.setItem(SAFE_START_KEY, "1"); stored = sessionStore(runtime)?.getItem(SAFE_START_KEY) === "1"; } catch { /* Fall back to the query parameter. */ }
  if (stored) return runtime.location.reload();
  try { const url = new URL(runtime.location.href); url.searchParams.set(SAFE_START_PARAM, "1"); runtime.location.assign(url.toString()); } catch { runtime.location.reload(); }
}

export function leaveSafeStart(runtime = globalThis) {
  try { sessionStore(runtime)?.removeItem(SAFE_START_KEY); } catch { /* Nothing stored. */ }
  const next = withoutParam(runtime);
  if (next && next !== runtime.location.href) runtime.location.assign(next); else runtime.location.reload();
}

export function SafeStartNotice({ onLeave = () => leaveSafeStart() }) {
  return (
    <div className="app-safe-start-notice" role="status">
      <span>Saved projects are hidden in this tab. They are still stored on this device.</span>
      <button type="button" onClick={onLeave}>Show saved projects</button>
    </div>
  );
}

export class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; this.headingRef = React.createRef(); }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("Perfect Planner could not render.", error, info?.componentStack ?? ""); }
  // Move keyboard and screen-reader focus to the fallback; the focused control was unmounted with the crashed tree.
  // A crash on first render mounts the fallback directly, so both lifecycles are needed.
  componentDidMount() { if (this.state.error) this.focusHeading(); }
  componentDidUpdate(_props, previous) { if (this.state.error && !previous.error) this.focusHeading(); }
  focusHeading() { this.headingRef.current?.focus({ preventScroll: true }); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { onReload = () => globalThis.location.reload(), onSafeStart = () => enterSafeStart(), onLeaveSafeStart = () => leaveSafeStart(), safeStart = false } = this.props;
    const message = error instanceof Error ? (error.message || error.name) : String(error);
    return (
      <main className="app-error-boundary" role="alert" aria-labelledby="app-error-title">
        <section className="app-error-card">
          <h1 id="app-error-title" ref={this.headingRef} tabIndex={-1}>Something went wrong showing the planner</h1>
          {safeStart
            ? <p>Your saved projects have not been deleted. They are hidden in this tab, so this problem is not caused by them. Try reloading, or show your saved projects again.</p>
            : <p>Your saved projects have not been deleted. Try reloading. If the problem keeps happening, open the planner without saved projects for this tab.</p>}
          <details className="app-error-details">
            <summary>Error details</summary>
            <pre>{message}</pre>
          </details>
          <div className="app-error-actions">
            <button type="button" className="app-error-primary" onClick={onReload}>Reload</button>
            {safeStart
              ? <button type="button" onClick={onLeaveSafeStart}>Show saved projects</button>
              : <button type="button" onClick={onSafeStart}>Open without saved projects</button>}
          </div>
        </section>
      </main>
    );
  }
}
