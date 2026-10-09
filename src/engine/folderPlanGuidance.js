// Presentation only. Raw assessment remains authoritative for approval.
// Field-path blockers (nodes[0].path ...) read as plain sentences naming the
// folder; the raw text stays available under "Technical approval checks".
const FIELD_LABELS = { purpose: 'purpose', owner: 'owner', taskId: 'task ID', allowedContents: 'allowed contents' };
function nodeSentence(blocker, nodes) {
  const match = /^nodes\[(\d+)\](?:\.(\w+))? (.+)$/.exec(blocker);
  if (!match) return null;
  const [, index, field, rest] = match;
  const path = String(nodes?.[Number(index)]?.path ?? '').trim();
  const name = `Folder ${Number(index) + 1}${path ? ` (${path.length > 60 ? `${path.slice(0, 57)}…` : path})` : ''}`;
  if (field === 'path' && rest === 'must be a normalized safe relative path.') return `${name}: use a relative path like src/features, with no leading slash, drive letter or "..".`;
  if (field === 'path') return `${name}: the path ${rest}`;
  if (field === 'taskId') return `${name}: the task ID must be a task number such as T0001 or B01, not free text.`;
  if (field === 'id') return `${name}: its number must look like F001.`;
  if (field === 'kind') return `${name}: choose folder or file.`;
  if (field === 'createAtStage') return `${name}: choose when it is created (creation wave).`;
  if (field === 'changePolicy') return `${name}: choose a change policy.`;
  if (field && rest === 'is an unresolved placeholder.') return `${name}: replace the placeholder ${FIELD_LABELS[field] ?? field} with a real answer.`;
  if (!field && rest === 'requires purpose, owner, and taskId.') return `${name}: fill in its purpose, owner and task ID.`;
  if (!field && rest === 'requires allowedContents and renameFallback.') return `${name}: say what belongs in it and what happens if it must be renamed.`;
  const parent = /^is missing planned parent folder (.+)\.$/.exec(rest);
  if (!field && parent) return `${name}: add its parent folder ${parent[1]} to the plan first.`;
  return null;
}
export function folderPlanGuidance(blockers = [], nodes = []) {
  const messages = new Set();
  for (const blocker of blockers) {
    if (blocker.startsWith('architectureContractDigest ') || blocker.startsWith('architectureRevision ')) {
      messages.add('Approve an architecture in Blueprint before approving a folder plan. Scanning and viewing your existing repository do not require this approval.');
    } else if (blocker === 'At least one named folder or file is required.') {
      messages.add('No proposed folder plan yet. Add the folder or file boundaries you intend to manage. This does not mean your scanned repository is empty.');
    } else messages.add(nodeSentence(blocker, nodes) ?? blocker);
  }
  return [...messages];
}
