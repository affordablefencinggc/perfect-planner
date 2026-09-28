// Metadata-only projection. Do not return arbitrary writer results or errors.
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function projectAgentWriteReceipt(value){
 const keys=['schemaVersion','submissionPersisted','idempotent','submitted','observedHead','submittedMatchesObservedHead','registrationCurrent','registrationLeaseHeld','approvalState','executionAuthorized'];
 const s=value?.submitted,h=value?.observedHead;
 if(!exact(value,keys)||value.schemaVersion!==1||value.submissionPersisted!==true||typeof value.idempotent!=='boolean'||typeof value.registrationCurrent!=='boolean'||value.registrationLeaseHeld!==false||value.approvalState!=='unapproved-proposal'||value.executionAuthorized!==false||!exact(s,['hostRevision','headDigest','ledgerDigest'])||!Number.isSafeInteger(s.hostRevision)||s.hostRevision<1||!digest(s.headDigest)||!digest(s.ledgerDigest)||!exact(h,['hostRevision','headDigest'])||!Number.isSafeInteger(h.hostRevision)||h.hostRevision<s.hostRevision||!digest(h.headDigest)||value.submittedMatchesObservedHead!==(h.hostRevision===s.hostRevision&&h.headDigest===s.headDigest))throw Error('AGENT_WRITE_RECEIPT_INVALID');
 if(h.hostRevision===s.hostRevision&&h.headDigest!==s.headDigest)throw Error('AGENT_WRITE_RECEIPT_INVALID');
 return Object.freeze({...value,submitted:Object.freeze({...s}),observedHead:Object.freeze({...h})});
}
