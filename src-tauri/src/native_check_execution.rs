//! Native-owned execution admission and exact saved-request recovery.
use super::*;

#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ExecutionRequest{
 identity:InspectRequest,setup_reference:String,expected:Head,contract_head:Value,
 request_id:String,confirmation_id:String,task_id:String,check_id:String,attempt_id:String,attempt_number:u64,
}
fn payload(r:&ExecutionRequest)->Value{json!({"requestId":r.request_id,"expected":r.expected,"contractHead":r.contract_head,"confirmationId":r.confirmation_id,"taskId":r.task_id,"checkId":r.check_id,"attemptId":r.attempt_id,"attemptNumber":r.attempt_number})}
fn validate_request(r:&ExecutionRequest)->Result<(),DraftError>{
 validate(&r.identity)?;
 let h=&r.contract_head;
 let id=&r.task_id;
 let task=(5..=7).contains(&id.len())&&id.starts_with('T')&&id.as_bytes()[1..].iter().all(u8::is_ascii_digit)&&id[1..].parse::<u32>().ok().is_some_and(|n|n>0&&format!("T{n:04}")==*id);
 if !digest(&r.setup_reference)||![&r.request_id,&r.confirmation_id,&r.check_id,&r.attempt_id].iter().all(|s|request_token(s))||!task||r.attempt_number==0||r.attempt_number>9_007_199_254_740_991||r.expected.host_revision==0||!head_valid(&r.expected)
  ||!h.as_object().is_some_and(|o|o.len()==2&&o.contains_key("revision")&&o.contains_key("headDigest"))||!h["revision"].as_u64().is_some_and(|n|n>0&&n<=9_007_199_254_740_991)||!h["headDigest"].as_str().is_some_and(digest){return Err(error("NATIVE_CHECK_EXECUTION_INVALID"));}Ok(())
}
fn read(path:&Path)->Result<Value,DraftError>{
 safe(path)?;let mut file=File::open(path).map_err(|_|error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE"))?;let before=stamp(&file)?;
 if before.0==0||before.0>16384{return Err(error("NATIVE_CHECK_EXECUTION_STORAGE_INVALID"));}
 let mut bytes=Vec::new();(&mut file).take(16385).read_to_end(&mut bytes).map_err(|_|error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE"))?;
 safe(path)?;let current=File::open(path).map_err(|_|error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE"))?;
 if bytes.len()as u64!=before.0||stamp(&file)?!=before||stamp(&current)?!=before{return Err(error("NATIVE_CHECK_EXECUTION_STORAGE_CHANGED"));}
 serde_json::from_slice(&bytes).map_err(|_|error("NATIVE_CHECK_EXECUTION_STORAGE_INVALID"))
}
fn retain(path:&Path,value:&Value)->Result<(),DraftError>{
 let bytes=serde_json::to_vec(value).map_err(|_|error("NATIVE_CHECK_EXECUTION_INVALID"))?;
 if bytes.len()>16384{return Err(error("NATIVE_CHECK_EXECUTION_INVALID"));}
 match OpenOptions::new().write(true).create_new(true).open(path){
  Ok(mut file)=>{safe(path)?;identity(&file)?;file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE"))?;},
  Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE")),
 }
 if read(path)?!=*value{return Err(error("NATIVE_CHECK_EXECUTION_REQUEST_CONFLICT"));}Ok(())
}
fn terminal(value:&Value,r:&ExecutionRequest,binding:&Binding)->Result<Value,DraftError>{
 let keys=["schemaVersion","kind","requestId","originalDigest","grantId","runId","intentDigest","artifactDigest","state","cleanupComplete","executionAuthorized"];
 let uuid=|v:&Value|v.as_str().is_some_and(|s|s.len()==36&&s.bytes().enumerate().all(|(i,b)|if [8,13,18,23].contains(&i){b==b'-'}else{b.is_ascii_digit()||(b'a'..=b'f').contains(&b)}));
 // serde_json Value maps sort keys; this matches the helper's canonical JSON.
 let original=json!({"schemaVersion":1,"binding":binding,"request":payload(r)});
 let original_digest=format!("{:x}",Sha256::digest(serde_json::to_vec(&original).unwrap()));
 if value["kind"]=="NATIVE_CHECK_NOT_STARTED_RECEIPT"{
  let keys=["schemaVersion","kind","requestId","originalDigest","proofDigest","state","cleanupComplete","executionAuthorized"];
  if !value.as_object().is_some_and(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k)))||value["schemaVersion"]!=1||value["requestId"]!=r.request_id||value["originalDigest"]!=original_digest||!value["proofDigest"].as_str().is_some_and(digest)||value["state"]!="not-started"||value["cleanupComplete"]!=true||value["executionAuthorized"]!=false{return Err(error("NATIVE_CHECK_EXECUTION_RESULT_INVALID"));}
  return Ok(value.clone());
 }
 if !value.as_object().is_some_and(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k)))||value["schemaVersion"]!=1||value["kind"]!="NATIVE_CHECK_EXECUTION_RECEIPT"||value["requestId"]!=r.request_id||value["originalDigest"]!=original_digest||!uuid(&value["grantId"])||!uuid(&value["runId"])||!["intentDigest","artifactDigest"].iter().all(|k|value[k].as_str().is_some_and(digest))||value["state"]!="result-recorded"||value["cleanupComplete"]!=true||value["executionAuthorized"]!=false{return Err(error("NATIVE_CHECK_EXECUTION_RESULT_INVALID"));}Ok(value.clone())
}
fn response(r:&ExecutionRequest,binding:&Binding,receipt:Value,retained:bool,recovered:bool)->Value{
 json!({"schemaVersion":1,"binding":binding,"requestId":r.request_id,"expected":r.expected,"contractHead":r.contract_head,"receipt":receipt,"retainedResult":retained,"recoveredSession":recovered,"executionAuthorized":false,"cleanupComplete":true})
}
pub(super) fn perform(app:tauri::AppHandle,r:ExecutionRequest,recovery:bool)->Result<Value,DraftError>{
 validate_request(&r)?;
 let(resources,mut config)=check_preparation::configuration(&app,&r.identity,&r.setup_reference)?;
 config.prepared_check_selection=Some(json!({"expected":r.expected,"contractHead":r.contract_head}));
 if recovery{settle_saved_pending(&config.state_directory,&r)?;}
 run_with(&resources,&config,&r,recovery,crate::native_host_supervisor::run_single)
}
// A pending native session can only be settled from its exact durable supervisor
// evidence. This never assumes process termination from a stale lock or PID.
fn settle_saved_pending(state:&Path,r:&ExecutionRequest)->Result<(),DraftError>{
 let dir=state.join("native-check-execution-v1");safe(&dir)?;
 let input=serde_json::to_value(r).unwrap();let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).unwrap()));
 let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));
 let mut store=session_store::MigratedStore::open(&dir,&r.identity.root_identity)?;
 if read(&dir.join(format!("{key}.original.json")))?!=input{return Err(error("NATIVE_CHECK_EXECUTION_REQUEST_CONFLICT"));}
 let saved=store.state().clone();
 if saved.original.as_deref().is_some_and(|id|id!=r.request_id)||saved.original_digest.as_deref().is_some_and(|h|h!=hash){return Err(uncertain(true));}
 if let Some(session)=saved.pending{
  let binding=Binding{project_id:project_id(&r.identity.root_identity),root_identity:r.identity.root_identity.clone(),census_digest:r.identity.census_digest.clone()};
  let prior=store.sequence().checked_sub(1).ok_or_else(||uncertain(true))?;
  let diagnostics=dir.join(format!("{}.diagnostics-v2",binding.project_id)).join(format!("{:016x}",prior/256)).join(&session);
  let intent=read(&diagnostics.join(format!("{session}.intent.json")))?;
  if intent["schemaVersion"]!=1||intent["sessionId"]!=session||intent["binding"]!=json!(binding)||!matches!(intent["command"].as_str(),Some("execute-check"|"recover-check-execution"))||intent["originalRequestId"]!=r.request_id||intent["originalObligationDigest"]!=hash||intent["executionAuthorized"]!=false||intent["recoveryAuthorized"]!=false{return Err(uncertain(true));}
  let proof=read(&diagnostics.join(format!("{session}.supervisor.json")))?;
  if proof["schemaVersion"]!=1||proof["sessionId"]!=session||proof["reason"]!="NATIVE_HOST_REQUEST_FINISHED"||proof["executionAuthorizationObserved"]!=false||proof["executionAuthorized"]!=false||["processExited","descendantsSettled","ioSettled","cleanupComplete"].iter().any(|k|proof[k]!=true){return Err(uncertain(true));}
  let result=dir.join(format!("{key}.result.json"));
  let completed=result.try_exists().map_err(|_|error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE"))?;
  if completed{terminal(&read(&result)?,r,&binding)?;}
  store.append_reserved("SETTLED",session_store::State{pending:None,original:if completed{None}else{Some(r.request_id.clone())},original_digest:if completed{None}else{Some(hash)}})?;
 }Ok(())
}
fn run_with<F:FnOnce(&Path,&HostConfiguration,&Value)->crate::native_host_supervisor::SupervisorReceipt>(resources:&Path,config:&HostConfiguration,r:&ExecutionRequest,recovery:bool,dispatch:F)->Result<Value,DraftError>{
 validate_request(r)?;
 if config.prepared_check_selection.as_ref()!=Some(&json!({"expected":r.expected,"contractHead":r.contract_head}))||config.workspace_id!=r.identity.workspace_id||config.registry_revision!=r.identity.registry_revision||config.expected_binding.root_identity!=r.identity.root_identity||config.expected_binding.census_digest!=r.identity.census_digest||config.expected_binding.project_id!=project_id(&r.identity.root_identity){return Err(error("NATIVE_CHECK_EXECUTION_BINDING_MISMATCH"));}
 safe(&config.state_directory)?;let dir=config.state_directory.join("native-check-execution-v1");
 match fs::create_dir(&dir){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE"))}safe(&dir)?;
 let input=serde_json::to_value(r).unwrap();let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).unwrap()));let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));
 let mut guard=session_store::LiveGuard::open(&dir,&r.identity.root_identity,Some((&r.request_id,&hash)))?;
 let original=dir.join(format!("{key}.original.json"));
 let existed=original.try_exists().map_err(|_|error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE"))?;
 if recovery&&!existed{return Err(error("NATIVE_CHECK_EXECUTION_ORIGINAL_MISSING"));}
 retain(&original,&input)?;
 let result_path=dir.join(format!("{key}.result.json"));
 if result_path.try_exists().map_err(|_|error("NATIVE_CHECK_EXECUTION_STORAGE_UNAVAILABLE"))?{
  let receipt=terminal(&read(&result_path)?,r,&config.expected_binding)?;
  // Cached results do not launch a process. Preserve any prior unresolved
  // obligation until an explicit recovery has validated its session evidence.
  if guard.outstanding.is_some(){return Err(uncertain(true));}
  guard.outstanding=None;guard.outstanding_digest=None;guard.append("PRE_DISPATCH_REFUSED")?;
  return Ok(response(r,&config.expected_binding,receipt,true,recovery));
 }
 if !recovery&&(existed||guard.outstanding.is_some()){guard.append("PRE_DISPATCH_REFUSED")?;return Err(uncertain(true));}
 let command=if recovery{"recover-check-execution"}else{"execute-check"};
 let diagnostic=prepare_live_diagnostics(&mut guard,&dir,&config.expected_binding,true,Some((&r.request_id,&hash)),command)?;
 guard.append("BEGIN")?;guard.outstanding=Some(r.request_id.clone());guard.outstanding_digest=Some(hash.clone());
 let proof=dispatch(resources,config,&json!({"version":1,"requestId":guard.session,"command":command,"payload":payload(r)}));
 diagnostic.supervisor(&proof).map_err(|_|uncertain(proof.request_may_have_committed))?;
 if !proof.cleanup_complete||!proof.process_exited||!proof.descendants_settled||!proof.io_settled||proof.execution_authorized{return Err(uncertain(proof.request_may_have_committed));}
 let value=proof.reply.filter(|v|v["ok"]==true).map(|v|v["result"].clone());
 let receipt=value.as_ref().ok_or_else(||uncertain(proof.request_may_have_committed)).and_then(|v|terminal(v,r,&config.expected_binding));
 let receipt=match receipt{Ok(v)=>v,Err(e)=>{guard.append("SETTLED")?;return Err(e);}};
 retain(&result_path,&receipt).map_err(|_|uncertain(true))?;
 guard.outstanding=None;guard.outstanding_digest=None;guard.append("SETTLED")?;
 Ok(response(r,&config.expected_binding,receipt,recovery,recovery))
}


#[cfg(test)]mod tests{
 use super::*;
 fn fixture()->(PathBuf,HostConfiguration,ExecutionRequest){
  assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
  let dir=std::env::temp_dir().join(fresh_id());fs::create_dir(&dir).unwrap();let dir=fs::canonicalize(dir).unwrap();
  let binding=Binding{project_id:project_id(&"a".repeat(64)),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};
  let r:ExecutionRequest=serde_json::from_value(json!({"identity":{"schemaVersion":1,"workspaceId":"fixture","registryRevision":1,"rootIdentity":binding.root_identity,"censusDigest":binding.census_digest},"setupReference":"d".repeat(64),"expected":{"hostRevision":1,"headDigest":"e".repeat(64)},"contractHead":{"revision":1,"headDigest":"f".repeat(64)},"requestId":"execution-1","confirmationId":"approved-1","taskId":"T0001","checkId":"unit","attemptId":"attempt-1","attemptNumber":1})).unwrap();
  let config=HostConfiguration{metadata_executable:dir.join("native.exe"),metadata_digest:"c".repeat(64),registry_root:dir.clone(),state_directory:dir.clone(),workspace_id:"fixture".into(),registry_revision:1,expected_binding:binding,actor:"local-native-user".into(),source:"execution-test".into(),check_contract:None,check_profile_provision:None,prepared_check_selection:Some(json!({"expected":r.expected,"contractHead":r.contract_head}))};(dir,config,r)
 }
 fn proof(reply:Option<Value>)->crate::native_host_supervisor::SupervisorReceipt{crate::native_host_supervisor::SupervisorReceipt{reason:"NATIVE_HOST_REQUEST_FINISHED",reply,stopped:None,request_may_have_committed:true,process_exited:true,descendants_settled:true,io_settled:true,cleanup_complete:true,execution_authorized:false,pre_execution_containment:false,child_exit_code:Some(0)}}
 fn receipt(r:&ExecutionRequest,binding:&Binding)->Value{
  let original=json!({"schemaVersion":1,"binding":binding,"request":payload(r)});
  json!({"schemaVersion":1,"kind":"NATIVE_CHECK_EXECUTION_RECEIPT","requestId":r.request_id,"originalDigest":format!("{:x}",Sha256::digest(serde_json::to_vec(&original).unwrap())),"grantId":"11111111-1111-4111-8111-111111111111","runId":"22222222-2222-4222-8222-222222222222","intentDigest":"a".repeat(64),"artifactDigest":"b".repeat(64),"state":"result-recorded","cleanupComplete":true,"executionAuthorized":false})
 }
 fn good(r:&ExecutionRequest,c:&HostConfiguration)->crate::native_host_supervisor::SupervisorReceipt{proof(Some(json!({"ok":true,"result":receipt(r,&c.expected_binding)})))}
 #[test]fn exact_original_precedes_dispatch_and_retry_reads_retained_result(){
  let(dir,c,r)=fixture();let first=run_with(&dir,&c,&r,false,|_,_,request|{
   let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));assert_eq!(read(&dir.join("native-check-execution-v1").join(format!("{key}.original.json"))).unwrap(),serde_json::to_value(&r).unwrap());
   assert_eq!(request["command"],"execute-check");assert_eq!(request["payload"],payload(&r));good(&r,&c)
  }).unwrap();assert_eq!(first["retainedResult"],false);assert_eq!(first["receipt"],receipt(&r,&c.expected_binding));
  let cached=run_with(&dir,&c,&r,false,|_,_,_|panic!("duplicate launch")).unwrap();assert_eq!(cached["retainedResult"],true);assert_eq!(cached["receipt"],first["receipt"]);
 }
 #[test]fn lost_reply_blocks_launch_and_only_exact_read_recovery_can_settle(){
  let(dir,c,mut r)=fixture();assert!(run_with(&dir,&c,&r,false,|_,_,_|proof(None)).is_err());
  assert!(run_with(&dir,&c,&r,false,|_,_,_|panic!("replayed")).is_err());r.request_id="replacement".into();assert!(run_with(&dir,&c,&r,false,|_,_,_|panic!("replaced")).is_err());r.request_id="execution-1".into();
  let result=run_with(&dir,&c,&r,true,|_,_,request|{assert_eq!(request["command"],"recover-check-execution");assert_eq!(request["payload"],payload(&r));good(&r,&c)}).unwrap();assert_eq!(result["recoveredSession"],true);
 }
 #[test]fn uncertain_cleanup_cannot_be_reopened_or_cleared(){
  let(dir,c,r)=fixture();assert!(run_with(&dir,&c,&r,false,|_,_,_|{let mut p=good(&r,&c);p.cleanup_complete=false;p}).is_err());
  assert!(settle_saved_pending(&dir,&r).is_err());assert!(run_with(&dir,&c,&r,true,|_,_,_|panic!("unclean process reused")).is_err());
 }
 #[test]fn changed_original_and_foreign_receipts_never_authorize_replay(){
  for field in ["originalDigest","requestId","cleanupComplete","executionAuthorized"]{
   let(dir,c,mut r)=fixture();assert!(run_with(&dir,&c,&r,false,|_,_,_|{let mut v=receipt(&r,&c.expected_binding);v[field]=json!("foreign");proof(Some(json!({"ok":true,"result":v})))}).is_err());
   r.attempt_number=2;assert!(run_with(&dir,&c,&r,true,|_,_,_|panic!("changed attempt accepted")).is_err());
  }
 }
 #[test]fn invalid_task_and_foreign_selection_refuse_before_storage(){
  for task in ["T0000","T00001","T1","../other"]{let(dir,c,mut r)=fixture();r.task_id=task.into();assert!(run_with(&dir,&c,&r,false,|_,_,_|panic!("invalid task")).is_err());assert!(!dir.join("native-check-execution-v1").exists());}
  let(dir,mut c,r)=fixture();c.prepared_check_selection.as_mut().unwrap()["contractHead"]["revision"]=json!(2);assert!(run_with(&dir,&c,&r,false,|_,_,_|panic!("foreign head")).is_err());assert!(!dir.join("native-check-execution-v1").exists());
 }
 #[test]fn partial_original_or_corrupt_result_are_preserved_without_launch(){
  let(dir,c,r)=fixture();run_with(&dir,&c,&r,false,|_,_,_|good(&r,&c)).unwrap();let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));let file=dir.join("native-check-execution-v1").join(format!("{key}.result.json"));fs::write(&file,b"partial").unwrap();
  assert!(run_with(&dir,&c,&r,true,|_,_,_|panic!("corrupt result replayed")).is_err());assert_eq!(fs::read(file).unwrap(),b"partial");
 }
 #[test]fn saved_clean_supervisor_recovers_pending_without_executing_again(){
  for cached in [false,true]{
  let(dir,c,r)=fixture();let state=dir.join("native-check-execution-v1");fs::create_dir(&state).unwrap();let input=serde_json::to_value(&r).unwrap();let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).unwrap()));let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));retain(&state.join(format!("{key}.original.json")),&input).unwrap();
  let mut guard=session_store::LiveGuard::open(&state,&r.identity.root_identity,Some((&r.request_id,&hash))).unwrap();let diagnostic=prepare_live_diagnostics(&mut guard,&state,&c.expected_binding,true,Some((&r.request_id,&hash)),"execute-check").unwrap();guard.append("BEGIN").unwrap();guard.outstanding=Some(r.request_id.clone());guard.outstanding_digest=Some(hash);diagnostic.supervisor(&good(&r,&c)).unwrap();drop(guard);
  if cached{retain(&state.join(format!("{key}.result.json")),&receipt(&r,&c.expected_binding)).unwrap();}
  settle_saved_pending(&dir,&r).unwrap();let result=run_with(&dir,&c,&r,true,|_,_,request|{assert!(!cached,"cached result launched helper");assert_eq!(request["command"],"recover-check-execution");good(&r,&c)}).unwrap();assert_eq!(result["recoveredSession"],true);
  }
 }
 #[test]fn original_retained_before_begin_never_becomes_implicit_launch_permission(){
  let(dir,c,r)=fixture();let state=dir.join("native-check-execution-v1");fs::create_dir(&state).unwrap();let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));retain(&state.join(format!("{key}.original.json")),&serde_json::to_value(&r).unwrap()).unwrap();
  assert!(run_with(&dir,&c,&r,false,|_,_,_|panic!("original replayed")).is_err());
  assert!(run_with(&dir,&c,&r,true,|_,_,request|{assert_eq!(request["command"],"recover-check-execution");proof(None)}).is_err());
 }
 #[test]fn not_started_recovery_is_retained_without_a_fabricated_run(){
  let(dir,c,r)=fixture();assert!(run_with(&dir,&c,&r,false,|_,_,_|proof(None)).is_err());
  let old=receipt(&r,&c.expected_binding);
  let value=json!({"schemaVersion":1,"kind":"NATIVE_CHECK_NOT_STARTED_RECEIPT","requestId":r.request_id,"originalDigest":old["originalDigest"],"proofDigest":"a".repeat(64),"state":"not-started","cleanupComplete":true,"executionAuthorized":false});
  let recovered=run_with(&dir,&c,&r,true,|_,_,request|{assert_eq!(request["command"],"recover-check-execution");proof(Some(json!({"ok":true,"result":value})))}).unwrap();
  assert_eq!(recovered["receipt"]["state"],"not-started");assert!(recovered["receipt"].get("grantId").is_none());
  let repeated=run_with(&dir,&c,&r,false,|_,_,_|panic!("settled original launched again")).unwrap();assert_eq!(repeated["receipt"],recovered["receipt"]);
  for patch in [json!({"grantId":"fake"}),json!({"proofDigest":"bad"}),json!({"state":"result-recorded"}),json!({"cleanupComplete":false})]{let mut invalid=value.clone();for(k,v)in patch.as_object().unwrap(){invalid[k]=v.clone();}assert!(terminal(&invalid,&r,&c.expected_binding).is_err());}
 }
}

