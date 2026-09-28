import { useEffect, useState } from 'react';
import './IndexingActivity.css';

export function IndexingActivity({ stage = 'scanning' }) {
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const started = performance.now();
    const timer = setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const label = stage === 'registering' ? 'Preparing read-only access' : stage === 'analyzing' ? 'Organizing observed structure' : 'Exploring your app';
  return <section className={`indexing-activity${paused ? ' motion-paused' : ''}`} aria-label="Indexing activity">
    <div className="indexing-orbit" aria-hidden="true">
      <svg viewBox="0 0 160 80"><path className="scan-route" d="M20 40H65V18H135M65 40H135M65 40V62H135"/><g className="scan-folders"><path d="M10 30h14l5 5h16v24H10z"/><rect x="126" y="10" width="21" height="16" rx="3"/><rect x="126" y="32" width="21" height="16" rx="3"/><rect x="126" y="54" width="21" height="16" rx="3"/></g><circle className="scan-ball scan-ball-top" cx="0" cy="0" r="4"/><circle className="scan-ball scan-ball-bottom" cx="0" cy="0" r="4"/><circle className="scan-ball scan-ball-middle" cx="0" cy="0" r="4"/></svg>
    </div>
    <div className="indexing-copy"><strong role="status">{label}…</strong><span>Read-only scan · <span aria-live="off">{elapsed}s elapsed</span></span><small>Activity animation—not a completion estimate. The map appears when the scan returns.</small></div>
    <button type="button" className="soft-button" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? 'Resume animation' : 'Pause animation'}</button>
  </section>;
}
