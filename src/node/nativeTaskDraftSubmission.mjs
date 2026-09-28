import {createTaskLedgerAuthorityStore} from './taskLedgerAuthorityStore.mjs';
import {createAgentTaskIntentStore} from './agentTaskIntentStore.mjs';
import {validateTaskDraftLedger,validateTaskDraftBinding,sameTaskDraftBinding,TASK_DRAFT_BYTES,emptyTaskDraftLedger,updateTaskDraft,inspectTaskDraft} from '../project/taskDraftLedger.js';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function uniqueKeys(text){const stack=[];for(const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)){if(token==='{'||token==='['){stack.push({object:token==='{',keys:new Set(),key:true});if(stack.length>16)return false;}else if(token==='}'||token===']')stack.pop();else if(token===','){if(stack.at(-1)?.object)stack.at(-1).key=true;}else if(token.startsWith('"')&&stack.at(-1)?.object&&stack.at(-1).key){const frame=stack.at(-1),key=JSON.parse(token);if(frame.keys.has(key))return false;frame.keys.add(key);frame.key=false;}}return true;}
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
// Private host composition, not a renderer endpoint. Registration is observed
// before/after append, not held under a native lease. Draft submission never
// approves tasks or configures checks, actors, executable paths or grants.
export function createNativeTaskDraftSubmission({proposalConfig,registeredBinding}) {
  if(typeof registeredBinding!=='function')throw Error('DRAFT_SUBMISSION_HOST_CONFIG_INVALID');
  const config=structuredClone(proposalConfig),observe=registeredBinding;
  const store=createTaskLedgerAuthorityStore(config);
  const intents=createAgentTaskIntentStore({file:`${config.journalPath}.agent-intents.jsonl`,projectId:config.projectId,rootIdentity:config.rootIdentity});
  async function binding(){
    const value=structuredClone(await observe());
    if(!value)throw Error('DRAFT_REGISTRATION_UNAVAILABLE');
    validateTaskDraftBinding(value);
    if(value.projectId!==config.projectId||value.rootIdentity!==config.rootIdentity)throw Error('DRAFT_REGISTRATION_FOREIGN');
    return freeze(value);
  }
  const api={
    // Recovery-only private host read; this never retries or submits by itself.
    async readTaskChangeOriginal(requestId){
      if(typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))throw Error('DRAFT_SUBMISSION_REQUEST_INVALID');
      const initial=await binding(),state=await intents.inspect();
      if(!sameTaskDraftBinding(initial,await binding()))throw Error('DRAFT_REGISTRATION_CHANGED');
      const record=state.records.find(r=>r.original.request.requestId===requestId)??null;
      if(record&&!sameTaskDraftBinding(initial,record.original.binding))throw Error('DRAFT_PROPOSAL_INVENTORY_STALE');
      return freeze({original:record?.original??null,originalDigest:record?.originalDigest??null,originalRetained:Boolean(record),submissionOutcome:'not-checked',executionAuthorized:false});
    },
    // Internal proposal composition only, not agent authorization. Resolve the
    // original retained parent (not today's head) so exact retries reproduce
    // the same ledger even after another submission. The existing journal owns
    // the atomic CAS, request receipt and retry flush; no second store is used.
    async proposeTaskChange(input){
      if(!exact(input,['binding','request','task','updatedAt']))throw Error('DRAFT_TASK_CHANGE_INVALID');
      input=structuredClone(input);
      if(!exact(input.request,['requestId','expectedRevision','expectedHeadDigest']))throw Error('DRAFT_TASK_CHANGE_INVALID');
      const {request}=input;
      if(typeof request.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)||!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<0||(request.expectedRevision===0?request.expectedHeadDigest!=='GENESIS':!hash(request.expectedHeadDigest)))throw Error('DRAFT_TASK_CHANGE_INVALID');
      validateTaskDraftBinding(input.binding);
      if(typeof input.updatedAt!=='string'||!Number.isFinite(Date.parse(input.updatedAt))||new Date(input.updatedAt).toISOString()!==input.updatedAt)throw Error('DRAFT_TASK_CHANGE_INVALID');
      if(Buffer.byteLength(JSON.stringify(input))>TASK_DRAFT_BYTES+4096)throw Error('DRAFT_SUBMISSION_INPUT_LIMIT');
      if(!sameTaskDraftBinding(input.binding,await binding()))throw Error('DRAFT_SUBMISSION_BINDING_MISMATCH');
      // Flush and read back the exact original before any proposal append.
      // A retained original is NOT evidence that a proposal was submitted.
      await intents.retain(input);
      const parent=request.expectedRevision===0?emptyTaskDraftLedger(input.binding):await store.withRetainedProposal({hostRevision:request.expectedRevision,headDigest:request.expectedHeadDigest},record=>record.ledger);
      if(!sameTaskDraftBinding(parent.binding,input.binding))throw Error('DRAFT_SUBMISSION_BINDING_MISMATCH');
      const ledger=updateTaskDraft(parent,input.task,input.updatedAt);
      const conflictKey=f=>JSON.stringify([f.kind,[...f.taskIds].sort()]);
      const conflicts=l=>{
        const byId=new Map(l.tasks.map(t=>[t.id,t]));
        const depends=(from,on)=>{const seen=new Set(),pending=[from];while(pending.length){const id=pending.pop();if(seen.has(id))continue;seen.add(id);for(const dep of byId.get(id)?.dependsOn??[]){if(dep===on)return true;pending.push(dep);}}return false;};
        return inspectTaskDraft(l).findings.filter(f=>{
          if(f.kind==='file-overlap'){
            const [left,right]=f.taskIds;
            // Sequential work may deliberately touch the same file. Explicit
            // acyclic dependency order is not a lease or execution permission.
            return depends(left,right)===depends(right,left);
          }
          return ['dependency-cycle','archived-dependency'].includes(f.kind);
        });
      };
      const existing=new Set(conflicts(parent).map(conflictKey));
      if(conflicts(ledger).some(f=>!existing.has(conflictKey(f))))throw Error('DRAFT_TASK_CHANGE_CONFLICT');
      // Release the retained-parent lock before entering propose's lock. Any
      // competing new head is rejected there, never silently rebased.
      return api.submitDraft({ledger,request});
    },
    // Host composition only. These read the same journal used by native draft
    // submissions; they do not expose or replace a user's unsent editor draft.
    async readProposal(){
      const initial=await binding(),current=await store.inspect();
      const proposal=current.proposals.at(-1)??null;
      if(!sameTaskDraftBinding(initial,await binding()))throw Error('DRAFT_REGISTRATION_CHANGED');
      if(proposal&&!sameTaskDraftBinding(initial,proposal.ledger.binding))throw Error('DRAFT_PROPOSAL_INVENTORY_STALE');
      return freeze({schemaVersion:1,binding:initial,observedHead:{hostRevision:current.hostRevision,headDigest:current.headDigest},
        ledger:proposal?.ledger??null,ledgerDigest:proposal?.ledgerDigest??null,
        registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false});
    },
    async readRequestResult(requestId){
      if(typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))throw Error('DRAFT_SUBMISSION_REQUEST_INVALID');
      const initial=await binding(),current=await store.inspect();
      const proposal=current.proposals.find(record=>record.requestId===requestId);
      if(!sameTaskDraftBinding(initial,await binding()))throw Error('DRAFT_REGISTRATION_CHANGED');
      if(proposal&&!sameTaskDraftBinding(initial,proposal.ledger.binding))throw Error('DRAFT_PROPOSAL_INVENTORY_STALE');
      return freeze({schemaVersion:1,binding:initial,requestId,
        outcome:proposal?'recorded-proposal':'not-found',
        submitted:proposal?{hostRevision:proposal.hostRevision,headDigest:proposal.recordHash,ledgerDigest:proposal.ledgerDigest}:null,
        observedHead:{hostRevision:current.hostRevision,headDigest:current.headDigest},
        submittedMatchesObservedHead:proposal?proposal.recordHash===current.headDigest:false,
        registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false});
    },
    async inspectHead(){
      const initial=await binding(),current=await store.inspect();let registrationCurrent=false;
      try{registrationCurrent=sameTaskDraftBinding(initial,await binding());}catch{}
      return freeze({schemaVersion:1,observedHead:{hostRevision:current.hostRevision,headDigest:current.headDigest},registrationCurrent,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false});
    },
    submitDraft(input){
      if(!exact(input,['ledger','request']))return Promise.reject(Error('DRAFT_SUBMISSION_REQUEST_INVALID'));
      return api.submit(JSON.stringify({version:1,ledger:input.ledger,request:input.request}));
    },
    async submit(wire){
      if(typeof wire!=='string'||Buffer.byteLength(wire)>TASK_DRAFT_BYTES+4096)throw Error('DRAFT_SUBMISSION_INPUT_LIMIT');
      let input;try{input=JSON.parse(wire);if(!uniqueKeys(wire))throw Error();}catch{throw Error('DRAFT_SUBMISSION_REQUEST_INVALID');}
      if(!exact(input,['version','ledger','request'])||input.version!==1||!exact(input.request,['requestId','expectedRevision','expectedHeadDigest']))throw Error('DRAFT_SUBMISSION_REQUEST_INVALID');
      const {request}=input;
      if(typeof request.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)||!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<0||(request.expectedRevision===0?request.expectedHeadDigest!=='GENESIS':!hash(request.expectedHeadDigest)))throw Error('DRAFT_SUBMISSION_REQUEST_INVALID');
      const ledger=validateTaskDraftLedger(input.ledger);
      freeze(request);
      const initial=await binding();
      if(!sameTaskDraftBinding(initial,ledger.binding))throw Error('DRAFT_SUBMISSION_BINDING_MISMATCH');
      const submitted=await store.propose(ledger,request);
      // A retry may refer to an older retained proposal. Report it separately
      // from the observed head; never relabel that historical result current.
      const current=await store.inspect();
      let registrationCurrent=false;
      try{registrationCurrent=sameTaskDraftBinding(initial,await binding());}catch{}
      return freeze({schemaVersion:1,submissionPersisted:true,idempotent:submitted.idempotent,
        submitted:{hostRevision:submitted.proposal.hostRevision,headDigest:submitted.proposal.recordHash,ledgerDigest:submitted.proposal.ledgerDigest},
        observedHead:{hostRevision:current.hostRevision,headDigest:current.headDigest},
        submittedMatchesObservedHead:current.headDigest===submitted.proposal.recordHash,
        registrationCurrent,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false});
    },
  };
  return Object.freeze(api);
}
