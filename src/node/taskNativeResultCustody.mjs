// Private host-owned persistence composition. This contains no executor and
// cannot restore launch permission. No paths or journal requests come from MCP.
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const wire=v=>JSON.stringify(canonical(v));
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export function createTaskNativeResultCustody({grants,observations}){
 if(typeof grants?.inspect!=='function'||typeof grants?.recordObservationReceipt!=='function'||typeof observations?.record!=='function'||typeof observations?.inspect!=='function')throw Error('NATIVE_RESULT_CUSTODY_CONFIG_INVALID');
 const inspectGrants=grants.inspect.bind(grants),link=grants.recordObservationReceipt.bind(grants),read=observations.inspect.bind(observations),write=observations.record.bind(observations);
 async function reconcile(intent){
  intent=structuredClone(intent);
  const state=await inspectGrants(),entry=state.grants.find(item=>item.grant.grantId===intent?.grantId);
  if(!entry?.intentReceipt||wire(entry.intentReceipt)!==wire(intent))throw Error('NATIVE_RESULT_CUSTODY_INTENT_MISMATCH');
  const saved=await read(entry.intentReceipt);
  if(saved.receipt.kind==='NATIVE_TASK_PROVISIONAL_RECEIPT')throw Error('NATIVE_TASK_FINALIZATION_UNRESOLVED');
  // Recover the exact original request if a link flush/reply was lost. A new
  // journal head must not turn that retry into a conflicting or second event.
  const prior=state.history.find(item=>item.event==='result-recorded'&&item.grant.grantId===intent.grantId);
  const request=prior?.request??{grantId:intent.grantId,requestId:`result:${intent.runId}`,expectedRevision:state.revision};
  const linked=await link(entry.intentReceipt,saved.receipt,request);
  const after=await read(entry.intentReceipt);
  if(wire(after.receipt)!==wire(saved.receipt))throw Error('NATIVE_RESULT_CUSTODY_ARTIFACT_CHANGED');
  return freeze({observationReceipt:after.receipt,observationLink:linked.observationLink,executionAuthorized:false});
 }
 return Object.freeze({reconcile,
 async retainCandidate(input){return observations.retainCandidate(structuredClone(input));},
 async retainInputs(input){return observations.retainInputs(structuredClone(input));},
 async retainIsolatedProvisional(input){return observations.retainIsolatedProvisional(structuredClone(input));},
 async retainProvisional(input){return observations.retainProvisional(structuredClone(input));},
 async finalize(input){input=structuredClone(input);await observations.finalize(input);return (await reconcile(input.intentReceipt)).observationReceipt;},
 async record(input){
  input=structuredClone(input);await write(input);
  return (await reconcile(input.intentReceipt)).observationReceipt;
 }});
}
