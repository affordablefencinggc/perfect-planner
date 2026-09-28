// Historical display only. The native receipt binds the exact ordered results;
// this projection never promotes a task or supplies execution authority.
export async function readNativeTaskBatchOutcome(reader,receipt,request){
 const fail=()=>{throw Error('Task results could not be matched to the saved attempt. Keep the original request for recovery.');};
 if(receipt?.kind!=='NATIVE_TASK_EXECUTION_RECEIPT'||receipt.requestId!==request.requestId||!Number.isSafeInteger(receipt.checkCount)||receipt.checkCount<1||receipt.checkCount>256||receipt.authorityVerified!==false||receipt.executionAuthorized!==false)fail();
 const found=[];let offset=0,head=null,pages=0;
 do{
  if(++pages>104)fail();
  const {page,outcomes}=await reader.readPage({offset,expectedHeadDigest:head});
  if(page.offset!==offset||(head!==null&&page.journalHead.headDigest!==head))fail();head=page.journalHead.headDigest;
  for(const row of page.entries){
   if(row.taskId!==request.taskId||row.attemptId!==request.attemptId)continue;
   const result=outcomes.find(o=>o.grantId===row.grantId);
   if(row.attemptNumber!==request.attemptNumber||row.lifecycleState!=='result-recorded'||result?.phase!=='ready'||!result.value.journalLinked)fail();
   found.push({revision:row.journalRevision,value:result.value});
  }
  if(page.nextOffset!==null&&(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset))fail();
  offset=page.nextOffset;
 }while(offset!==null);
 found.sort((a,b)=>a.revision-b.revision);const checks=found.map(row=>row.value);
 if(checks.length!==receipt.checkCount||new Set(checks.map(c=>c.checkId)).size!==checks.length||new Set(checks.map(c=>c.grantId)).size!==checks.length||checks[0]?.grantId!==receipt.anchorGrantId)fail();
 const refs=checks.map(c=>({artifactDigest:c.artifactDigest,checkId:c.checkId,grantId:c.grantId,intentDigest:c.intentDigest,runId:c.runId}));
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(refs)))),b=>b.toString(16).padStart(2,'0')).join('');
 if(hash!==receipt.checksDigest)fail();
 return Object.freeze({batch:true,checks:Object.freeze(checks),authorityVerified:false,executionAuthorized:false});
}
