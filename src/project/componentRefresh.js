import { readComponentContext } from '../runtime/componentClient.js';

// A checked planning observation is not permission to execute a component.
export function createComponentRefresh({ registry, recordStatus }) {
  const sequences = new Map();
  let disposed = false;
  function invalidate(id) { sequences.set(id, (sequences.get(id) ?? 0) + 1); }
  async function refresh(projectId) {
    const project = registry.get(projectId);
    if (disposed || project?.kind !== 'imported' || !project.registration) return null;
    const rootIdentity = project.registration.rootIdentity;
    const sequence = (sequences.get(projectId) ?? 0) + 1;
    sequences.set(projectId, sequence);
    const current = () => !disposed && sequences.get(projectId) === sequence && registry.get(projectId)?.registration?.rootIdentity === rootIdentity;
    const record = (state, extra = {}) => recordStatus(projectId, { state, expectedRootIdentity: rootIdentity, ...extra });
    try { if (record('stale')?.persisted === false) return { status: 'local-cache-unavailable' }; }
    catch { return { status: 'local-cache-unavailable' }; }
    try {
      const receipt = await readComponentContext(projectId);
      if (!current()) return null;
      if (receipt?.planId !== projectId || receipt.publicationAuthorized !== false || receipt.executionAuthorized !== false) throw Error('Invalid observation');
      let saved;
      try { saved = record('observed', { receipt }); }
      catch { return { status: 'local-cache-unavailable' }; }
      if (saved?.persisted === false) return { status: 'local-cache-unavailable' };
      const stale = receipt.catalogState === 'stale' || saved?.project?.authorities?.component?.state === 'stale';
      return { status: stale ? 'stale' : 'observed', receipt };
    } catch {
      if (!current()) return null;
      try { if (record('unavailable')?.persisted === false) return { status: 'local-cache-unavailable' }; }
      catch { return { status: 'local-cache-unavailable' }; }
      return { status: 'unavailable' };
    }
  }
  return { refresh, invalidate, dispose() { disposed = true; sequences.clear(); } };
}
