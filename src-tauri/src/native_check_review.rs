//! Prepared native review only. A decision is not an execution grant.
use super::*;

#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ReviewRequest{identity:InspectRequest,setup_reference:String,expected:Head,contract_head:Value,request_id:String}

fn validate_review(r:&ReviewRequest)->Result<(),DraftError>{
    validate(&r.identity)?;
    let h=&r.contract_head;
    if !digest(&r.setup_reference)||!request_token(&r.request_id)||r.expected.host_revision==0||!head_valid(&r.expected)
        ||!h.as_object().is_some_and(|o|o.len()==2&&o.contains_key("revision")&&o.contains_key("headDigest"))
        ||!h["revision"].as_u64().is_some_and(|n|n>0&&n<=9_007_199_254_740_991)||!h["headDigest"].as_str().is_some_and(digest){return Err(error("NATIVE_CHECK_REVIEW_INVALID"));}Ok(())
}
fn read(path:&Path)->Result<Value,DraftError>{
    safe(path)?;let mut file=File::open(path).map_err(|_|error("NATIVE_CHECK_REVIEW_STORAGE_UNAVAILABLE"))?;let before=stamp(&file)?;
    if before.0==0||before.0>8192{return Err(error("NATIVE_CHECK_REVIEW_STORAGE_INVALID"));}
    let mut bytes=Vec::new();(&mut file).take(8193).read_to_end(&mut bytes).map_err(|_|error("NATIVE_CHECK_REVIEW_STORAGE_UNAVAILABLE"))?;
    safe(path)?;let current=File::open(path).map_err(|_|error("NATIVE_CHECK_REVIEW_STORAGE_UNAVAILABLE"))?;
    if bytes.len()as u64!=before.0||stamp(&file)?!=before||stamp(&current)?!=before{return Err(error("NATIVE_CHECK_REVIEW_STORAGE_CHANGED"));}
    serde_json::from_slice(&bytes).map_err(|_|error("NATIVE_CHECK_REVIEW_STORAGE_INVALID"))
}
fn retain(path:&Path,value:&Value)->Result<(),DraftError>{
    let bytes=serde_json::to_vec(value).map_err(|_|error("NATIVE_CHECK_REVIEW_INVALID"))?;
    if bytes.len()>8192{return Err(error("NATIVE_CHECK_REVIEW_INVALID"));}
    match OpenOptions::new().write(true).create_new(true).open(path){
        Ok(mut file)=>{safe(path)?;identity(&file)?;file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|error("NATIVE_CHECK_REVIEW_STORAGE_UNAVAILABLE"))?;},
        Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},
        Err(_)=>return Err(error("NATIVE_CHECK_REVIEW_STORAGE_UNAVAILABLE")),
    }
    if read(path)?!=*value{return Err(error("NATIVE_CHECK_REVIEW_REQUEST_CONFLICT"));}Ok(())
}
fn decision(value:&Value)->Result<Value,DraftError>{
    let c=&value["confirmation"];
    if !value.as_object().is_some_and(|o|o.len()==1&&o.contains_key("confirmation"))
        ||!c.as_object().is_some_and(|o|o.len()==2&&o.contains_key("id")&&o.contains_key("status"))
        ||!c["id"].as_str().is_some_and(request_token)||!matches!(c["status"].as_str(),Some("approved"|"rejected"|"cancelled")){return Err(error("NATIVE_CHECK_REVIEW_RESULT_INVALID"));}
    Ok(c.clone())
}
pub(super) fn perform(app:tauri::AppHandle,r:ReviewRequest)->Result<Value,DraftError>{
    validate_review(&r)?;
    let(resources,mut config)=check_preparation::configuration(&app,&r.identity,&r.setup_reference)?;
    config.prepared_check_selection=Some(json!({"expected":r.expected,"contractHead":r.contract_head}));
    run_with(&resources,&config,&r,crate::native_host_supervisor::run_single)
}
pub(super) fn recover(app:tauri::AppHandle,r:ReviewRequest)->Result<Value,DraftError>{
    validate_review(&r)?;
    let registry=crate::workspace_census::app_registry_root(&app).map_err(|_|error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))?;
    check_setup_root(&registry,&r.identity)?;
    let data=app.path().app_data_dir().map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;
    let state=state_directory(&data)?;
    let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));
    let result=state.join("native-check-review-v1").join(format!("{key}.result.json"));
    if result.try_exists().map_err(|_|error("NATIVE_CHECK_REVIEW_STORAGE_UNAVAILABLE"))?{return recover_with(&state,&r);}
    if recover_not_started(&state,&r)?{return Err(error("NATIVE_CHECK_REVIEW_NOT_STARTED"));}
    let(resources,mut config)=check_preparation::configuration(&app,&r.identity,&r.setup_reference)?;
    config.prepared_check_selection=Some(json!({"expected":r.expected,"contractHead":r.contract_head}));
    run_mode(&resources,&config,&r,true,crate::native_host_supervisor::run_single)
}
// Never launches a helper or modifies a confirmation. A cached decision only
// settles a pending session when its exact persisted supervisor proves cleanup.
fn recover_with(state:&Path,r:&ReviewRequest)->Result<Value,DraftError>{
    validate_review(r)?;safe(state)?;
    let dir=state.join("native-check-review-v1");safe(&dir)?;
    let input=serde_json::to_value(r).map_err(|_|error("NATIVE_CHECK_REVIEW_INVALID"))?;
    let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));
    let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).unwrap()));
    let binding=Binding{project_id:project_id(&r.identity.root_identity),root_identity:r.identity.root_identity.clone(),census_digest:r.identity.census_digest.clone()};
    let mut store=session_store::MigratedStore::open(&dir,&r.identity.root_identity)?;
    if read(&dir.join(format!("{key}.original.json")))?!=input{return Err(error("NATIVE_CHECK_REVIEW_REQUEST_CONFLICT"));}
    let c=decision(&read(&dir.join(format!("{key}.result.json"))).map_err(|_|uncertain(true))?)?;
    let saved=store.state().clone();
    if saved.original.is_some(){return Err(uncertain(true));}
    let recovered=if let Some(session)=saved.pending{
        let prior=store.sequence().checked_sub(1).ok_or_else(||uncertain(true))?;
        let diagnostics=dir.join(format!("{}.diagnostics-v2",binding.project_id)).join(format!("{:016x}",prior/256)).join(&session);
        let intent=read(&diagnostics.join(format!("{session}.intent.json")))?;
        if intent["schemaVersion"]!=1||intent["sessionId"]!=session||intent["binding"]!=json!(binding)||intent["command"]!="review-proposal"||intent["originalRequestId"]!=r.request_id||intent["originalObligationDigest"]!=hash||intent["executionAuthorized"]!=false||intent["recoveryAuthorized"]!=false{return Err(uncertain(true));}
        let proof=read(&diagnostics.join(format!("{session}.supervisor.json")))?;
        if proof["schemaVersion"]!=1||proof["sessionId"]!=session||proof["reason"]!="NATIVE_HOST_REQUEST_FINISHED"||proof["executionAuthorizationObserved"]!=false||proof["executionAuthorized"]!=false||["processExited","descendantsSettled","ioSettled","cleanupComplete"].iter().any(|k|proof[k]!=true){return Err(uncertain(true));}
        store.append_reserved("SETTLED",session_store::State{pending:None,original:None,original_digest:None})?;true
    }else{false};
    Ok(json!({"schemaVersion":1,"binding":binding,"requestId":r.request_id,"expected":r.expected,"contractHead":r.contract_head,"confirmation":c,"retainedResult":true,"recoveredSession":recovered,"executionAuthorized":false,"cleanupComplete":true}))
}
// Recovery does not retry the business request. A terminal adjacent session
// pair lets repeated recovery report the same refusal after a process restart.
fn recover_not_started(state:&Path,r:&ReviewRequest)->Result<bool,DraftError>{
    validate_review(r)?;safe(state)?;
    let dir=state.join("native-check-review-v1");safe(&dir)?;
    let input=serde_json::to_value(r).map_err(|_|error("NATIVE_CHECK_REVIEW_INVALID"))?;
    let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));
    let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).unwrap()));
    let mut store=session_store::MigratedStore::open(&dir,&r.identity.root_identity)?;
    if read(&dir.join(format!("{key}.original.json")))?!=input{return Err(error("NATIVE_CHECK_REVIEW_REQUEST_CONFLICT"));}
    // A cached decision or a previously dispatched original belongs to the
    // existing decision recovery path, never this not-started path.
    if dir.join(format!("{key}.result.json")).try_exists().map_err(|_|uncertain(true))?||store.state().original.is_some(){return Ok(false);}
    let pending=store.state().pending.clone();
    let (session,prior)=if let Some(session)=&pending{
        (session.clone(),store.sequence().checked_sub(1).ok_or_else(||uncertain(true))?)
    }else{match store.just_settled_session()?{Some(pair)=>pair,None=>return Ok(false)}};
    let binding=Binding{project_id:project_id(&r.identity.root_identity),root_identity:r.identity.root_identity.clone(),census_digest:r.identity.census_digest.clone()};
    let diagnostics=dir.join(format!("{}.diagnostics-v2",binding.project_id)).join(format!("{:016x}",prior/256)).join(&session);
    let intent=read(&diagnostics.join(format!("{session}.intent.json")))?;
    let exact=intent["schemaVersion"]==1&&intent["sessionId"]==session&&intent["binding"]==json!(binding)
        &&intent["command"]=="review-proposal"&&intent["originalRequestId"]==r.request_id&&intent["originalObligationDigest"]==hash
        &&intent["executionAuthorized"]==false&&intent["recoveryAuthorized"]==false
        &&intent.get("priorOutstandingRequestId")==Some(&Value::Null)&&intent.get("priorOutstandingObligationDigest")==Some(&Value::Null);
    if !exact{return if pending.is_some(){Err(uncertain(true))}else{Ok(false)};}
    let proof=read(&diagnostics.join(format!("{session}.supervisor.json")))?;
    let refused=proof["schemaVersion"]==1&&proof["sessionId"]==session&&proof["reason"]=="NATIVE_HOST_READY_MISMATCH"
        &&proof["requestMayHaveCommitted"]==false&&proof["executionAuthorizationObserved"]==false
        &&proof["executionAuthorized"]==false&&proof["recoveryAuthorized"]==false
        &&["processExited","descendantsSettled","ioSettled"].iter().all(|k|proof[k]==true);
    if !refused{return if pending.is_some(){Err(uncertain(true))}else{Ok(false)};}
    if pending.is_some(){store.append_reserved("SETTLED",session_store::State{pending:None,original:None,original_digest:None})?;}
    Ok(true)
}
fn run_with<F:FnOnce(&Path,&HostConfiguration,&Value)->crate::native_host_supervisor::SupervisorReceipt>(resources:&Path,config:&HostConfiguration,r:&ReviewRequest,dispatch:F)->Result<Value,DraftError>{
    run_mode(resources,config,r,false,dispatch)
}
fn run_mode<F:FnOnce(&Path,&HostConfiguration,&Value)->crate::native_host_supervisor::SupervisorReceipt>(resources:&Path,config:&HostConfiguration,r:&ReviewRequest,recovery:bool,dispatch:F)->Result<Value,DraftError>{
    validate_review(r)?;
    let selected=json!({"expected":r.expected,"contractHead":r.contract_head});
    if config.prepared_check_selection.as_ref()!=Some(&selected)||config.workspace_id!=r.identity.workspace_id||config.registry_revision!=r.identity.registry_revision
        ||config.expected_binding.root_identity!=r.identity.root_identity||config.expected_binding.census_digest!=r.identity.census_digest||config.expected_binding.project_id!=project_id(&r.identity.root_identity){return Err(error("NATIVE_CHECK_REVIEW_BINDING_MISMATCH"));}
    let dir=config.state_directory.join("native-check-review-v1");safe(&config.state_directory)?;
    match fs::create_dir(&dir){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_CHECK_REVIEW_STORAGE_UNAVAILABLE"))}safe(&dir)?;
    let input=serde_json::to_value(r).map_err(|_|error("NATIVE_CHECK_REVIEW_INVALID"))?;
    let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).unwrap()));
    let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));
    let mut guard=session_store::LiveGuard::open(&dir,&r.identity.root_identity,Some((&r.request_id,&hash)))?;
    let original=dir.join(format!("{key}.original.json"));
    if recovery{
        if read(&original)?!=input{return Err(error("NATIVE_CHECK_REVIEW_REQUEST_CONFLICT"));}
    }else if let Err(e)=retain(&original,&input){guard.append("PRE_DISPATCH_REFUSED")?;return Err(e);}
    let result_path=dir.join(format!("{key}.result.json"));
    if result_path.try_exists().map_err(|_|error("NATIVE_CHECK_REVIEW_STORAGE_UNAVAILABLE"))?{
        let saved=read(&result_path)?;let c=decision(&saved)?;
        guard.append("PRE_DISPATCH_REFUSED")?;
        return Ok(json!({"schemaVersion":1,"binding":config.expected_binding,"requestId":r.request_id,"expected":r.expected,"contractHead":r.contract_head,"confirmation":c,"retainedResult":true,"recoveredSession":false,"executionAuthorized":false,"cleanupComplete":true}));
    }
    // An unresolved original is never permission to redisplay a dialog.
    if if recovery{guard.outstanding.as_deref()!=Some(r.request_id.as_str())||guard.outstanding_digest.as_deref()!=Some(hash.as_str())}else{guard.outstanding.is_some()}{guard.append("PRE_DISPATCH_REFUSED")?;return Err(uncertain(true));}
    let command=if recovery{"recover-original-request"}else{"review-original-request"};
    let diagnostic=prepare_live_diagnostics(&mut guard,&dir,&config.expected_binding,true,Some((&r.request_id,&hash)),if recovery{command}else{"review-proposal"})?;
    guard.append("BEGIN")?;
    let proof=dispatch(resources,config,&json!({"version":1,"requestId":guard.session,"command":command,"payload":{"expected":r.expected,"originalDigest":hash}}));
    diagnostic.supervisor(&proof).map_err(|_|uncertain(proof.request_may_have_committed))?;
    // READY refusal precedes the business request. Once the owned process tree
    // and pipes are settled, this attempt has no decision to recover. Never
    // apply this to recovery: its prior original may already have committed.
    if !recovery&&proof.reason=="NATIVE_HOST_READY_MISMATCH"&&!proof.request_may_have_committed
        &&proof.reply.is_none()&&proof.stopped.is_none()&&!proof.execution_authorized
        &&proof.process_exited&&proof.descendants_settled&&proof.io_settled{
        guard.append("SETTLED")?;
        return Err(error("NATIVE_CHECK_REVIEW_NOT_STARTED"));
    }
    if !proof.cleanup_complete||!proof.process_exited||!proof.descendants_settled||!proof.io_settled||proof.execution_authorized{return Err(uncertain(proof.request_may_have_committed));}
    let value=proof.reply.filter(|v|v["ok"]==true).map(|v|v["result"].clone());
    let c=value.as_ref().ok_or_else(||uncertain(proof.request_may_have_committed)).and_then(decision).and_then(|c|{
        if recovery&&c["id"]!=format!("review-{hash}"){Err(error("NATIVE_CHECK_REVIEW_RESULT_INVALID"))}else{Ok(c)}
    });
    let c=match c{Ok(c)=>c,Err(e)=>{guard.outstanding=Some(r.request_id.clone());guard.outstanding_digest=Some(hash);guard.append("SETTLED")?;return Err(e);}};
    retain(&result_path,&json!({"confirmation":c})).map_err(|_|uncertain(true))?;
    guard.outstanding=None;guard.outstanding_digest=None;guard.append("SETTLED")?;
    Ok(json!({"schemaVersion":1,"binding":config.expected_binding,"requestId":r.request_id,"expected":r.expected,"contractHead":r.contract_head,"confirmation":c,"retainedResult":recovery,"recoveredSession":recovery,"executionAuthorized":false,"cleanupComplete":true}))
}

#[cfg(test)]mod tests{
 use super::*;
 fn fixture()->(PathBuf,HostConfiguration,ReviewRequest){
  assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
  let dir=std::env::temp_dir().join(fresh_id());fs::create_dir(&dir).unwrap();let dir=fs::canonicalize(dir).unwrap();
  let binding=Binding{project_id:project_id(&"a".repeat(64)),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};
  let r:ReviewRequest=serde_json::from_value(json!({"identity":{"schemaVersion":1,"workspaceId":"fixture","registryRevision":1,"rootIdentity":binding.root_identity,"censusDigest":binding.census_digest},"setupReference":"d".repeat(64),"expected":{"hostRevision":1,"headDigest":"e".repeat(64)},"contractHead":{"revision":1,"headDigest":"f".repeat(64)},"requestId":"review-original-1"})).unwrap();
  let cfg=HostConfiguration{metadata_executable:dir.join("native.exe"),metadata_digest:"c".repeat(64),registry_root:dir.clone(),state_directory:dir.clone(),workspace_id:"fixture".into(),registry_revision:1,expected_binding:binding,actor:"local-native-user".into(),source:"native-review-test".into(),check_contract:None,check_profile_provision:None,prepared_check_selection:Some(json!({"expected":r.expected,"contractHead":r.contract_head}))};(dir,cfg,r)
 }
 fn proof(reply:Option<Value>)->crate::native_host_supervisor::SupervisorReceipt{crate::native_host_supervisor::SupervisorReceipt{reason:"NATIVE_HOST_REQUEST_FINISHED",reply,stopped:None,request_may_have_committed:true,process_exited:true,descendants_settled:true,io_settled:true,cleanup_complete:true,execution_authorized:false,pre_execution_containment:false,child_exit_code:Some(0)}}
 fn success(status:&str)->Value{json!({"ok":true,"result":{"confirmation":{"id":"confirmation-1","status":status}}})}
 fn startup_refusal()->crate::native_host_supervisor::SupervisorReceipt{
  let mut p=proof(None);p.reason="NATIVE_HOST_READY_MISMATCH";p.request_may_have_committed=false;p.cleanup_complete=false;p.child_exit_code=Some(1);p
 }
 #[test]fn fully_settled_startup_refusal_preserves_original_without_fabricating_decision(){
  let(dir,cfg,r)=fixture();let e=run_with(&dir,&cfg,&r,|_,_,_|startup_refusal()).unwrap_err();
  assert_eq!(e.code,"NATIVE_CHECK_REVIEW_NOT_STARTED");assert!(!e.requires_recovery);assert!(!e.request_may_have_committed);
  let state=dir.join("native-check-review-v1");let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));
  assert_eq!(read(&state.join(format!("{key}.original.json"))).unwrap(),serde_json::to_value(&r).unwrap());
  assert!(!state.join(format!("{key}.result.json")).exists());
  {let store=session_store::MigratedStore::open(&state,&r.identity.root_identity).unwrap();assert!(store.state().pending.is_none());assert!(store.state().original.is_none());}
  // Only a subsequent explicit review action can try again.
  assert_eq!(run_with(&dir,&cfg,&r,|_,_,_|proof(Some(success("cancelled")))).unwrap()["retainedResult"],false);
 }
 #[test]fn startup_refusal_never_settles_uncertain_or_dispatched_work(){
  for field in ["process","descendants","io","committed","authority","reply","stopped","reason"]{
   let(dir,cfg,r)=fixture();let e=run_with(&dir,&cfg,&r,|_,_,_|{let mut p=startup_refusal();match field{
    "process"=>p.process_exited=false,"descendants"=>p.descendants_settled=false,"io"=>p.io_settled=false,
    "committed"=>p.request_may_have_committed=true,"authority"=>p.execution_authorized=true,
    "reply"=>p.reply=Some(success("approved")),"stopped"=>p.stopped=Some(json!({})),_=>p.reason="NATIVE_HOST_EXIT_FAILED"};p}).unwrap_err();
   assert!(e.requires_recovery,"{field}");
   assert!(run_with(&dir,&cfg,&r,|_,_,_|panic!("uncertain attempt relaunched")).unwrap_err().requires_recovery);
  }
 }
 #[test]fn startup_refusal_during_recovery_preserves_prior_outstanding_original(){
  let(dir,cfg,r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).is_err());
  assert!(run_mode(&dir,&cfg,&r,true,|_,_,_|startup_refusal()).unwrap_err().requires_recovery);
  let store=session_store::MigratedStore::open(&dir.join("native-check-review-v1"),&r.identity.root_identity).unwrap();
  assert!(store.state().pending.is_some());assert_eq!(store.state().original.as_deref(),Some(r.request_id.as_str()));
 }
 #[test]fn terminal_decisions_are_retained_and_exact_retry_never_redisplays(){
  for status in ["approved","rejected","cancelled"]{
   let(dir,cfg,r)=fixture();let result=run_with(&dir,&cfg,&r,|_,_,p|{
    let originals=fs::read_dir(dir.join("native-check-review-v1")).unwrap().map(|e|e.unwrap().path()).filter(|p|p.to_string_lossy().ends_with(".original.json")).collect::<Vec<_>>();
    assert_eq!(originals.len(),1);assert_eq!(read(&originals[0]).unwrap(),serde_json::to_value(&r).unwrap());
    assert_eq!(p["command"],"review-original-request");assert_eq!(p["payload"],json!({"expected":r.expected,"originalDigest":format!("{:x}",Sha256::digest(serde_json::to_vec(&serde_json::to_value(&r).unwrap()).unwrap()))}));proof(Some(success(status)))
   }).unwrap();assert_eq!(result["confirmation"]["status"],status);assert_eq!(result["executionAuthorized"],false);assert_eq!(result["retainedResult"],false);
   let retained=run_with(&dir,&cfg,&r,|_,_,_|panic!("duplicate review launched")).unwrap();assert_eq!(retained["retainedResult"],true);
  }
 }
 #[test]fn unknown_reply_blocks_original_and_new_review(){
  let(dir,cfg,mut r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).is_err());
  assert!(run_with(&dir,&cfg,&r,|_,_,_|panic!("uncertain original replayed")).is_err());r.request_id="new-review".into();assert!(run_with(&dir,&cfg,&r,|_,_,_|panic!("uncertain review replaced")).is_err());
 }
 #[test]fn uncertain_cleanup_blocks_reopen(){
  let(dir,cfg,r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|{let mut p=proof(Some(success("approved")));p.cleanup_complete=false;p}).unwrap_err().requires_recovery);
  assert!(run_with(&dir,&cfg,&r,|_,_,_|panic!("unclean session reused")).unwrap_err().requires_recovery);
 }
 #[test]fn same_id_cannot_change_saved_setup(){
  let(dir,cfg,mut r)=fixture();run_with(&dir,&cfg,&r,|_,_,_|proof(Some(success("cancelled")))).unwrap();r.setup_reference="c".repeat(64);
  assert_eq!(run_with(&dir,&cfg,&r,|_,_,_|panic!("conflict launched")).unwrap_err().code,"NATIVE_CHECK_REVIEW_REQUEST_CONFLICT");
 }
 #[test]fn foreign_binding_and_selected_head_are_refused_without_storage(){
  for field in ["census","head"]{let(dir,mut cfg,r)=fixture();if field=="census"{cfg.expected_binding.census_digest="c".repeat(64);}else{cfg.prepared_check_selection.as_mut().unwrap()["expected"]["hostRevision"]=json!(2);}
   assert!(run_with(&dir,&cfg,&r,|_,_,_|panic!("foreign review launched")).is_err());assert!(!dir.join("native-check-review-v1").exists());}
 }
 fn interrupted(clean:bool,has_result:bool)->(PathBuf,HostConfiguration,ReviewRequest){
  let mut p=proof(Some(success("approved")));p.cleanup_complete=clean;interrupted_with(p,has_result)
 }
 fn interrupted_with(p:crate::native_host_supervisor::SupervisorReceipt,has_result:bool)->(PathBuf,HostConfiguration,ReviewRequest){
  let(dir,cfg,r)=fixture();let state=dir.join("native-check-review-v1");fs::create_dir(&state).unwrap();
  let input=serde_json::to_value(&r).unwrap();let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).unwrap()));let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));retain(&state.join(format!("{key}.original.json")),&input).unwrap();
  let mut guard=session_store::LiveGuard::open(&state,&r.identity.root_identity,Some((&r.request_id,&hash))).unwrap();
  let diagnostic=prepare_live_diagnostics(&mut guard,&state,&cfg.expected_binding,true,Some((&r.request_id,&hash)),"review-proposal").unwrap();guard.append("BEGIN").unwrap();
  diagnostic.supervisor(&p).unwrap();
  if has_result{retain(&state.join(format!("{key}.result.json")),&success("approved")["result"]).unwrap();}
  drop(guard);(dir,cfg,r)
 }
 #[test]fn historical_startup_refusal_recovers_without_launch_and_survives_reopen(){
  let(dir,cfg,r)=interrupted_with(startup_refusal(),false);
  assert!(recover_not_started(&dir,&r).unwrap());assert!(recover_not_started(&dir,&r).unwrap());
  let state=dir.join("native-check-review-v1");let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));
  assert!(!state.join(format!("{key}.result.json")).exists());
  // A later attempt supersedes the old refusal; recovery cannot use stale proof.
  assert!(run_with(&dir,&cfg,&r,|_,_,_|{let mut p=proof(None);p.cleanup_complete=false;p}).is_err());
  assert!(recover_not_started(&dir,&r).unwrap_err().requires_recovery);
  assert!(session_store::MigratedStore::open(&state,&r.identity.root_identity).unwrap().state().pending.is_some());
 }
 #[test]fn historical_recovery_requires_exact_original_and_complete_refusal_proof(){
  for field in ["committed","process","descendants","io","authority","reason"]{
   let mut p=startup_refusal();match field{"committed"=>p.request_may_have_committed=true,"process"=>p.process_exited=false,"descendants"=>p.descendants_settled=false,"io"=>p.io_settled=false,"authority"=>p.execution_authorized=true,_=>p.reason="NATIVE_HOST_EXIT_FAILED"};
   let(dir,_,r)=interrupted_with(p,false);assert!(recover_not_started(&dir,&r).unwrap_err().requires_recovery,"{field}");
   assert!(session_store::MigratedStore::open(&dir.join("native-check-review-v1"),&r.identity.root_identity).unwrap().state().pending.is_some());
  }
  let(dir,_,mut r)=interrupted_with(startup_refusal(),false);r.contract_head["revision"]=json!(2);
  assert_eq!(recover_not_started(&dir,&r).unwrap_err().code,"NATIVE_CHECK_REVIEW_REQUEST_CONFLICT");
 }
 #[test]fn recovery_refuses_missing_or_foreign_persisted_evidence(){
  for field in ["binding","originalObligationDigest","priorOutstandingRequestId","supervisor"]{
   let(dir,cfg,r)=interrupted_with(startup_refusal(),false);let state=dir.join("native-check-review-v1");
   let store=session_store::MigratedStore::open(&state,&r.identity.root_identity).unwrap();let session=store.state().pending.clone().unwrap();let seq=store.sequence()-1;drop(store);
   let diagnostics=state.join(format!("{}.diagnostics-v2",cfg.expected_binding.project_id)).join(format!("{:016x}",seq/256)).join(&session);
   if field=="supervisor"{fs::rename(diagnostics.join(format!("{session}.supervisor.json")),diagnostics.join("preserved-supervisor.json")).unwrap();}
   else{let file=diagnostics.join(format!("{session}.intent.json"));let mut value=read(&file).unwrap();value[field]=json!("foreign");fs::write(file,serde_json::to_vec(&value).unwrap()).unwrap();}
   assert!(recover_not_started(&dir,&r).is_err());assert!(session_store::MigratedStore::open(&state,&r.identity.root_identity).unwrap().state().pending.is_some());
  }
 }
 #[test]fn refusal_recovery_does_not_override_decision_or_prior_outstanding_request(){
  let(dir,_,r)=interrupted_with(startup_refusal(),true);assert!(!recover_not_started(&dir,&r).unwrap());
  let(dir,cfg,r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).is_err());
  assert!(run_mode(&dir,&cfg,&r,true,|_,_,_|startup_refusal()).is_err());
  assert!(!recover_not_started(&dir,&r).unwrap());
  let store=session_store::MigratedStore::open(&dir.join("native-check-review-v1"),&r.identity.root_identity).unwrap();assert!(store.state().pending.is_some());assert_eq!(store.state().original.as_deref(),Some(r.request_id.as_str()));
 }
 #[test]fn retained_decision_and_exact_cleanup_recover_pending_session_without_launch(){
  let(dir,cfg,r)=interrupted(true,true);let result=recover_with(&dir,&r).unwrap();assert_eq!(result["recoveredSession"],true);assert_eq!(result["confirmation"]["status"],"approved");assert_eq!(result["executionAuthorized"],false);
  assert_eq!(recover_with(&dir,&r).unwrap()["recoveredSession"],false);
  assert_eq!(run_with(&dir,&cfg,&r,|_,_,_|panic!("recovered result relaunched")).unwrap()["retainedResult"],true);
 }
 #[test]fn missing_decision_or_uncertain_cleanup_cannot_clear_pending_session(){
  for(clean,result)in [(false,true),(true,false)]{let(dir,_,r)=interrupted(clean,result);assert!(recover_with(&dir,&r).is_err());let store=session_store::MigratedStore::open(&dir.join("native-check-review-v1"),&r.identity.root_identity).unwrap();assert!(store.state().pending.is_some());}
 }
 #[test]fn recovery_cannot_substitute_original_contract(){
  let(dir,_,mut r)=interrupted(true,true);r.contract_head["revision"]=json!(2);assert_eq!(recover_with(&dir,&r).unwrap_err().code,"NATIVE_CHECK_REVIEW_REQUEST_CONFLICT");
  let store=session_store::MigratedStore::open(&dir.join("native-check-review-v1"),&r.identity.root_identity).unwrap();assert!(store.state().pending.is_some());
 }
 #[test]fn decision_cannot_smuggle_authority_or_pending_state(){
  for v in [json!({"confirmation":{"id":"c1","status":"pending"}}),json!({"confirmation":{"id":"c1","status":"approved","executionAuthorized":true}}),json!({"confirmation":{"id":"c1","status":"approved"},"secret":"private"})]{assert!(decision(&v).is_err());}
 }
 #[test]fn missing_reply_recovers_exact_original_once_without_presenting_again(){
  let(dir,cfg,r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).is_err());
  let result=run_mode(&dir,&cfg,&r,true,|_,_,p|{
   assert_eq!(p["command"],"recover-original-request");
   proof(Some(json!({"ok":true,"result":{"confirmation":{"id":format!("review-{}",p["payload"]["originalDigest"].as_str().unwrap()),"status":"cancelled"}}})))
  }).unwrap();assert_eq!(result["retainedResult"],true);assert_eq!(result["recoveredSession"],true);assert_eq!(result["executionAuthorized"],false);
  assert_eq!(recover_with(&dir,&r).unwrap()["confirmation"],result["confirmation"]);
  assert!(run_mode(&dir,&cfg,&r,true,|_,_,_|panic!("duplicate recovery launched")).is_ok());
 }
 #[test]fn recovery_requires_original_and_exact_terminal_identity(){
  let(dir,cfg,mut r)=fixture();assert!(run_mode(&dir,&cfg,&r,true,|_,_,_|panic!("new recovery launched")).is_err());
  assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).is_err());
  assert!(run_mode(&dir,&cfg,&r,true,|_,_,_|proof(Some(success("approved")))).is_err());
  assert!(run_with(&dir,&cfg,&r,|_,_,_|panic!("invalid recovery cleared original")).is_err());
  r.request_id="replacement".into();assert!(run_mode(&dir,&cfg,&r,true,|_,_,_|panic!("foreign recovery launched")).is_err());
 }
 #[test]fn recovery_never_bypasses_pending_cleanup_or_corrupt_result(){
  let(dir,cfg,r)=interrupted(false,false);assert!(run_mode(&dir,&cfg,&r,true,|_,_,_|panic!("unclean recovery launched")).is_err());
  let(dir,cfg,r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).is_err());
  let key=format!("{:x}",Sha256::digest(r.request_id.as_bytes()));fs::write(dir.join("native-check-review-v1").join(format!("{key}.result.json")),b"corrupt").unwrap();
  assert!(run_mode(&dir,&cfg,&r,true,|_,_,_|panic!("corrupt result replaced")).is_err());
 }
}



