// Presentation only. Raw assessment remains authoritative for approval.
export function folderPlanGuidance(blockers = []) {
  const messages = new Set();
  for (const blocker of blockers) {
    if (blocker.startsWith('architectureContractDigest ') || blocker.startsWith('architectureRevision ')) {
      messages.add('Approve an architecture in Blueprint before approving a folder plan. Scanning and viewing your existing repository do not require this approval.');
    } else if (blocker === 'At least one named folder or file is required.') {
      messages.add('No proposed folder plan yet. Add the folder or file boundaries you intend to manage. This does not mean your scanned repository is empty.');
    } else messages.add(blocker);
  }
  return [...messages];
}
