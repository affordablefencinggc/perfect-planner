import { inspectArchitecture } from '../runtime/architectureClient.js';
import { inspectFolder } from '../runtime/folderClient.js';

// These observations update summaries only; they never authorize filesystem work.
export function createFolderRefresh({ registry, recordStatus }) {
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
      const architectureReceipt = await inspectArchitecture(projectId);
      if (!current()) return null;
      const receipt = await inspectFolder(projectId);
      if (!current()) return null;
      if (receipt?.valid !== true || receipt.planId !== projectId || architectureReceipt?.valid !== true || architectureReceipt.planId !== projectId) throw Error('Invalid observation');
      let saved;
      try { saved = record('observed', { receipt, architectureReceipt }); }
      catch { return { status: 'local-cache-unavailable' }; }
      if (saved?.persisted === false) return { status: 'local-cache-unavailable' };
      const head = receipt.head, parent = architectureReceipt.head;
      const mismatch = head && (!parent || head.architectureContractDigest !== parent.contractDigest || head.architectureRevision !== parent.revision);
      const stale = mismatch || saved?.project?.authorities?.folder?.state === 'stale';
      return { status: stale ? 'stale' : 'observed', receipt, architectureReceipt };
    } catch {
      if (!current()) return null;
      try { if (record('unavailable')?.persisted === false) return { status: 'local-cache-unavailable' }; }
      catch { return { status: 'local-cache-unavailable' }; }
      return { status: 'unavailable' };
    }
  }
  return { refresh, invalidate, dispose() { disposed = true; sequences.clear(); } };
}
