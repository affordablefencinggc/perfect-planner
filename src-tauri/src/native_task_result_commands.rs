//! Project-bound owner result read. No execution, tool paths or worker secrets.
use super::*;
#[path="native_task_result_index.rs"]
mod index;
pub use index::TaskResultIndexRequest;
pub async fn list_native_task_results(app:tauri::AppHandle,request:TaskResultIndexRequest)->Result<Value,DraftError>{index::perform(app,request).await}
pub async fn read_native_task_result_page(app:tauri::AppHandle,request:TaskResultIndexRequest)->Result<Value,DraftError>{index::perform_page(app,request).await}

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TaskResultRequest{identity:InspectRequest,grant_id:String}
fn uuid(id:&str)->bool{id.len()==36&&id.bytes().enumerate().all(|(i,b)|if [8,13,18,23].contains(&i){b==b'-'}else{b.is_ascii_digit()||(b'a'..=b'f').contains(&b)})}
fn validate_request(r:&TaskResultRequest)->Result<(),DraftError>{validate(&r.identity)?;if !uuid(&r.grant_id){return Err(error("NATIVE_TASK_RESULT_REQUEST_INVALID"));}Ok(())}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct ResultSummary{
 schema_version:u32,project_id:String,root_identity:String,grant_id:String,run_id:String,
 task_id:String,check_id:String,attempt_id:String,attempt_number:u64,worker_id:String,
 state:String,exit_code:Option<i64>,failure_reasons:Vec<String>,artifact_digest:String,intent_digest:String,
 journal_linked:bool,observation_link_digest:Option<String>,cleanup:String,authority_verified:bool,execution_authorized:bool,
}
fn project_result(value:Value,binding:&Binding,grant_id:&str)->Result<Value,DraftError>{
 let invalid=||error("NATIVE_TASK_RESULT_INVALID");
 // Option fields must be present too; serde otherwise accepts missing nulls.
 if !value.as_object().is_some_and(|o|o.len()==20&&o.contains_key("exitCode")&&o.contains_key("observationLinkDigest")){return Err(invalid());}
 let r:ResultSummary=serde_json::from_value(value).map_err(|_|invalid())?;
 let task=r.task_id.as_bytes();
 if r.schema_version!=1||r.project_id!=binding.project_id||r.root_identity!=binding.root_identity||r.grant_id!=grant_id||!uuid(&r.grant_id)||!uuid(&r.run_id)
  ||!(5..=7).contains(&task.len())||task[0]!=b'T'||!task[1..].iter().all(u8::is_ascii_digit)
  ||[&r.check_id,&r.attempt_id,&r.worker_id].iter().any(|s|!request_token(s))||r.attempt_number==0||r.attempt_number>9_007_199_254_740_991
  ||!digest(&r.artifact_digest)||!digest(&r.intent_digest)||r.cleanup!="unknown"||r.authority_verified||r.execution_authorized
  ||(if r.journal_linked{!r.observation_link_digest.as_deref().is_some_and(digest)}else{r.observation_link_digest.is_some()})
  ||r.exit_code.is_some_and(|n|!(-4294967295..=4294967295).contains(&n)){return Err(invalid());}
 let allowed=["nonzero-exit","time-limit","cancellation-observed","output-limit","cpu-limit","cpu-observation-failed","output-read-failed"];
 let mut last=None;
 for reason in &r.failure_reasons{let Some(index)=allowed.iter().position(|v|v==reason)else{return Err(invalid());};if last.is_some_and(|n|index<=n){return Err(invalid());}last=Some(index);}
 if r.failure_reasons.iter().any(|s|s=="nonzero-exit")!=r.exit_code.is_some_and(|n|n!=0)||r.state!=if r.failure_reasons.is_empty(){"result-unverified"}else{"failure-observed"}{return Err(invalid());}
 let mut output=serde_json::to_value(r).map_err(|_|invalid())?;
 output["binding"]=json!(binding);output["transportCleanupComplete"]=json!(true);Ok(output)
}
fn registered(registry:&Path,r:&InspectRequest)->Result<(),DraftError>{
 validate(r)?;
 crate::workspace_census::registered_metadata(registry,&r.workspace_id,r.registry_revision,&r.root_identity).map_err(|_|error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))?;
 let o=crate::workspace_census::retained_census_binding(registry,&r.workspace_id,r.registry_revision,&r.root_identity).map_err(|_|error("NATIVE_DRAFT_CENSUS_UNAVAILABLE"))?;
 if o["censusDigest"]!=r.census_digest||o["retainedObservation"]!=true||o["liveFilesystemVerified"]!=false||o["executionAuthorized"]!=false{return Err(error("NATIVE_DRAFT_CENSUS_MISMATCH"));}Ok(())
}
pub async fn inspect_native_task_result(app:tauri::AppHandle,request:TaskResultRequest)->Result<Value,DraftError>{
 validate_request(&request)?;perform_read(app,request.identity,ReadOperation::Detail(request.grant_id)).await
}
enum ReadOperation{Detail(String),Index{offset:u32,expected:Option<String>},Page{offset:u32,expected:Option<String>}}
async fn perform_read(app:tauri::AppHandle,identity:InspectRequest,operation:ReadOperation)->Result<Value,DraftError>{
 validate(&identity)?;let admission=Admission::acquire()?;
 tauri::async_runtime::spawn_blocking(move||{
  let _admission=admission;let r=&identity;
  let registry=crate::workspace_census::app_registry_root(&app).map_err(|_|error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))?;registered(&registry,r)?;
  let resources=app.path().resource_dir().map_err(|_|error("NATIVE_DRAFT_RESOURCES_UNAVAILABLE"))?;
  crate::native_host_resources::verify_installed(&resources).map_err(|_|error("NATIVE_DRAFT_HOST_NOT_AVAILABLE"))?;
  let(executable,pin)=self_executable()?;let data=app.path().app_data_dir().map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;
  let config=HostConfiguration{metadata_executable:executable,metadata_digest:pin,registry_root:registry.clone(),state_directory:state_directory(&data)?,workspace_id:r.workspace_id.clone(),registry_revision:r.registry_revision,
   expected_binding:Binding{project_id:project_id(&r.root_identity),root_identity:r.root_identity.clone(),census_digest:r.census_digest.clone()},actor:"local-native-user".into(),source:"perfect-planner-native-result-read".into(),check_contract:None,check_profile_provision:None,prepared_check_selection:None};
  match operation{
   ReadOperation::Detail(grant_id)=>inspect_with(&resources,&config,&grant_id,crate::native_host_supervisor::run_single,||registered(&registry,r)),
   ReadOperation::Index{offset,expected}=>read_with(&resources,&config,"list-task-results",json!({"offset":offset,"expectedHeadDigest":expected}),crate::native_host_supervisor::run_single,||registered(&registry,r),|v|index::project(v,&config.expected_binding,offset,expected.as_deref())),
   ReadOperation::Page{offset,expected}=>read_with(&resources,&config,"read-task-result-page",json!({"offset":offset,"expectedHeadDigest":expected}),crate::native_host_supervisor::run_single,||registered(&registry,r),|v|index::project_page(v,&config.expected_binding,offset,expected.as_deref())),
  }
 }).await.map_err(|_|uncertain(false))?
}
fn inspect_with<F,C>(resources:&Path,config:&HostConfiguration,grant_id:&str,dispatch:F,current:C)->Result<Value,DraftError>
where F:FnOnce(&Path,&HostConfiguration,&Value)->crate::native_host_supervisor::SupervisorReceipt,C:FnOnce()->Result<(),DraftError>{
 if !uuid(grant_id){return Err(error("NATIVE_TASK_RESULT_REQUEST_INVALID"));}
 read_with(resources,config,"inspect-task-result",json!({"grantId":grant_id}),dispatch,current,|v|project_result(v,&config.expected_binding,grant_id))
}
fn read_with<F,C,P>(resources:&Path,config:&HostConfiguration,command:&str,payload:Value,dispatch:F,current:C,project:P)->Result<Value,DraftError>
where F:FnOnce(&Path,&HostConfiguration,&Value)->crate::native_host_supervisor::SupervisorReceipt,C:FnOnce()->Result<(),DraftError>,P:FnOnce(Value)->Result<Value,DraftError>{
 if !matches!(command,"inspect-task-result"|"list-task-results"|"read-task-result-page"){return Err(error("NATIVE_TASK_RESULT_REQUEST_INVALID"));}
 let mut guard=session_store::LiveGuard::open(&config.state_directory,&config.expected_binding.root_identity,None)?;
 let diagnostic=prepare_live_diagnostics(&mut guard,&config.state_directory,&config.expected_binding,false,None,command)?;
 guard.append("BEGIN")?;
 let proof=dispatch(resources,config,&json!({"version":1,"requestId":guard.session,"command":command,"payload":payload}));
 if diagnostic.supervisor(&proof).is_err(){return Err(uncertain(false));}
 if !proof.cleanup_complete||!proof.process_exited||!proof.descendants_settled||!proof.io_settled||proof.execution_authorized{return Err(uncertain(false));}
 // Settled transport is independent of a missing/malformed result. Never clear
 // an outstanding draft obligation or label task cleanup from host shutdown.
 guard.append("SETTLED")?;current()?;
 match proof.reply{Some(reply)if reply["ok"]==true=>project(reply["result"].clone()),Some(reply)if matches!(command,"list-task-results"|"read-task-result-page")&&reply["error"]["code"]=="NATIVE_TASK_INDEX_STALE"=>Err(error("NATIVE_TASK_INDEX_STALE")),_=>Err(error("NATIVE_TASK_RESULT_UNAVAILABLE"))}
}

#[cfg(test)]mod tests{
 use super::*;
 const GRANT:&str="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
 fn binding()->Binding{Binding{project_id:project_id(&"a".repeat(64)),root_identity:"a".repeat(64),census_digest:"b".repeat(64)}}
 fn summary()->Value{json!({"schemaVersion":1,"projectId":binding().project_id,"rootIdentity":"a".repeat(64),"grantId":GRANT,"runId":"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb","taskId":"T0001","checkId":"unit","attemptId":"attempt1","attemptNumber":1,"workerId":"worker1","state":"failure-observed","exitCode":7,"failureReasons":["nonzero-exit"],"artifactDigest":"c".repeat(64),"intentDigest":"d".repeat(64),"journalLinked":true,"observationLinkDigest":"e".repeat(64),"cleanup":"unknown","authorityVerified":false,"executionAuthorized":false})}
 fn fixture()->(PathBuf,HostConfiguration){let dir=std::env::temp_dir().join(format!("pp-result-{}",fresh_id()));fs::create_dir(&dir).unwrap();let cfg=HostConfiguration{metadata_executable:dir.join("not-run.exe"),metadata_digest:"f".repeat(64),registry_root:dir.clone(),state_directory:dir.clone(),workspace_id:"fixture".into(),registry_revision:1,expected_binding:binding(),actor:"fixture".into(),source:"fixture".into(),check_contract:None,check_profile_provision:None,prepared_check_selection:None};(dir,cfg)}
 fn proof(value:Value)->crate::native_host_supervisor::SupervisorReceipt{crate::native_host_supervisor::SupervisorReceipt{reason:"NATIVE_HOST_REQUEST_FINISHED",reply:Some(json!({"ok":true,"result":value})),stopped:None,request_may_have_committed:false,process_exited:true,descendants_settled:true,io_settled:true,cleanup_complete:true,execution_authorized:false,pre_execution_containment:false,child_exit_code:Some(0)}}
 #[test]fn result_read_projects_failure_without_task_cleanup_or_execution(){let r=project_result(summary(),&binding(),GRANT).unwrap();assert_eq!(r["exitCode"],7);assert_eq!(r["cleanup"],"unknown");assert_eq!(r["transportCleanupComplete"],true);assert_eq!(r["executionAuthorized"],false);}
 #[test]fn result_read_rejects_foreign_authority_and_malformed_fields(){
  for patch in [json!({"projectId":"foreign"}),json!({"grantId":"wrong"}),json!({"rootIdentity":"b".repeat(64)}),json!({"state":"passed"}),json!({"failureReasons":[]}),json!({"failureReasons":["nonzero-exit","nonzero-exit"]}),json!({"failureReasons":["unknown"]}),json!({"authorityVerified":true}),json!({"executionAuthorized":true}),json!({"cleanup":"complete"}),json!({"journalLinked":false}),json!({"runId":"x"}),json!({"attemptNumber":0}),json!({"stdout":"secret"}),json!({"exitCode":4294967296i64})]{let mut value=summary();for(k,v)in patch.as_object().unwrap(){value[k]=v.clone();}assert!(project_result(value,&binding(),GRANT).is_err());}
  let mut value=summary();value.as_object_mut().unwrap().remove("exitCode");assert!(project_result(value,&binding(),GRANT).is_err());
 }
 #[test]fn result_read_request_rejects_paths_and_credentials(){let value=json!({"identity":{"schemaVersion":1,"workspaceId":"fixture","registryRevision":1,"rootIdentity":"a".repeat(64),"censusDigest":"b".repeat(64)},"grantId":GRANT});assert!(validate_request(&serde_json::from_value(value.clone()).unwrap()).is_ok());for key in ["path","credentials","actor","command","executionAuthorized"]{let mut changed=value.clone();changed[key]=json!("injected");assert!(serde_json::from_value::<TaskResultRequest>(changed).is_err());}}
 #[test]fn result_read_transport_uses_only_grant_and_rechecks_registration(){let(dir,cfg)=fixture();let r=inspect_with(&dir,&cfg,GRANT,|_,_,request|{assert_eq!(request["command"],"inspect-task-result");assert_eq!(request["payload"],json!({"grantId":GRANT}));proof(summary())},||Ok(())).unwrap();assert_eq!(r["binding"],json!(binding()));assert!(inspect_with(&dir,&cfg,GRANT,|_,_,_|proof(summary()),||Err(error("NATIVE_DRAFT_CENSUS_MISMATCH"))).is_err());}
 #[test]fn result_read_unclean_host_stays_unresolved_and_does_not_redispatch(){let(dir,cfg)=fixture();assert!(inspect_with(&dir,&cfg,GRANT,|_,_,_|{let mut p=proof(summary());p.io_settled=false;p},||Ok(())).is_err());assert!(inspect_with(&dir,&cfg,GRANT,|_,_,_|panic!("must not redispatch"),||Ok(())).is_err());}
 #[test]fn result_read_bad_business_reply_keeps_transport_settled(){let(dir,cfg)=fixture();assert!(inspect_with(&dir,&cfg,GRANT,|_,_,_|proof(json!({})),||Ok(())).is_err());assert!(inspect_with(&dir,&cfg,GRANT,|_,_,_|proof(summary()),||Ok(())).is_ok());}
 fn outcome_page()->Value{let v=summary();json!({"page":{"schemaVersion":1,"kind":"NATIVE_TASK_RESULT_INDEX","projectId":binding().project_id,"rootIdentity":"a".repeat(64),"journalHead":{"revision":4,"headDigest":"f".repeat(64)},"offset":0,"totalGrants":1,"nextOffset":null,"entries":[{"grantId":GRANT,"taskId":"T0001","checkId":"unit","attemptId":"attempt1","attemptNumber":1,"workerId":"worker1","lifecycleState":"result-recorded","journalRevision":4,"recordedAt":"2026-09-14T00:00:00.000Z","runId":v["runId"],"intentDigest":v["intentDigest"],"artifactDigest":v["artifactDigest"]}],"authorityVerified":false,"executionAuthorized":false},"outcomes":[{"grantId":GRANT,"phase":"ready","value":v}]})}
 #[test]fn outcome_page_projects_one_bound_failure(){let p=index::project_page(outcome_page(),&binding(),0,None).unwrap();assert_eq!(p["outcomes"][0]["value"]["exitCode"],7);assert_eq!(p["transportCleanupComplete"],true);assert_eq!(p["outcomes"][0]["value"]["authorityVerified"],false);}
 #[test]fn outcome_page_refuses_mismatched_or_missing_results(){
  for patch in [json!({"workerId":"other"}),json!({"intentDigest":"e".repeat(64)}),json!({"artifactDigest":"e".repeat(64)}),json!({"stdout":"secret"})]{let mut p=outcome_page();for(k,v)in patch.as_object().unwrap(){p["outcomes"][0]["value"][k]=v.clone();}assert!(index::project_page(p,&binding(),0,None).is_err());}
  let mut p=outcome_page();p["outcomes"]=json!([]);assert!(index::project_page(p,&binding(),0,None).is_err());
  let mut p=outcome_page();p["outcomes"][0]["phase"]=json!("unavailable");assert!(index::project_page(p.clone(),&binding(),0,None).is_err());p["outcomes"][0]["value"]=Value::Null;assert!(index::project_page(p,&binding(),0,None).is_ok());
 }
 #[test]fn outcome_page_transport_is_one_read_with_settled_cleanup(){let(dir,cfg)=fixture();let r=read_with(&dir,&cfg,"read-task-result-page",json!({"offset":0,"expectedHeadDigest":null}),|_,_,r|{assert_eq!(r["command"],"read-task-result-page");proof(outcome_page())},||Ok(()),|v|index::project_page(v,&binding(),0,None)).unwrap();assert_eq!(r["outcomes"].as_array().unwrap().len(),1);}
 // Runtime lifetime qualification uses the actual owner admission and disk
 // writes with controlled supervisor results, not an installed process claim.
 #[test]fn capacity_live_reads_cross_old_ceiling_with_complete_retained_accounting(){
  let(dir,cfg)=fixture();let started=std::time::Instant::now();let mut dispatches=0;
  for _ in 0..300{inspect_with(&dir,&cfg,GRANT,|_,_,_|{dispatches+=1;proof(summary())},||Ok(())).unwrap();}
  let guard=session_store::LiveGuard::open(&dir,&cfg.expected_binding.root_identity,None).unwrap();
  assert_eq!(guard.sequence(),600);assert!(guard.outstanding.is_none());drop(guard);
  fn count_files(path:&Path)->usize{fs::read_dir(path).unwrap().map(|entry|{let path=entry.unwrap().path();if path.is_dir(){count_files(&path)}else{1}}).sum()}
  let diagnostics=dir.join(format!("{}.diagnostics-v2",cfg.expected_binding.project_id));
  assert_eq!(count_files(&diagnostics),601); // 600 immutable receipts + import inventory.
  assert_eq!(dispatches,300);
  println!("CAPACITY_REPAIR {}",json!({"successfulReads":dispatches,"retainedSessionEvents":600,"diagnosticFiles":600,"elapsedMs":started.elapsed().as_millis(),"retainedDirectory":dir,"installedRuntime":false}));
 }
 #[test]fn capacity_full_legacy_migrates_and_reopens_exact_outstanding_original(){
  let(dir,cfg)=fixture();let digest="c".repeat(64);let project=&cfg.expected_binding.project_id;
  {let mut g=Guard::open(&dir,project,None).unwrap();for _ in 0..255{g.append("BEGIN").unwrap();g.outstanding=Some("unresolved-original".into());g.outstanding_digest=Some(digest.clone());g.append("SETTLED").unwrap();}}
  let legacy=dir.join(format!("{project}.sessions.jsonl"));let original=fs::read(&legacy).unwrap();
  let diagnostics=dir.join(format!("{project}.diagnostics"));fs::create_dir(&diagnostics).unwrap();
  for n in 0..255{for kind in ["intent","supervisor"]{fs::write(diagnostics.join(format!("legacy-{n}.{kind}.json")),b"{\"schemaVersion\":1}").unwrap();}}
  for _ in 0..10{inspect_with(&dir,&cfg,GRANT,|_,_,_|proof(summary()),||Ok(())).unwrap();}
  let guard=session_store::LiveGuard::open(&dir,&cfg.expected_binding.root_identity,Some(("unresolved-original",&digest))).unwrap();
  assert_eq!(guard.outstanding.as_deref(),Some("unresolved-original"));assert_eq!(guard.outstanding_digest.as_deref(),Some(digest.as_str()));assert_eq!(guard.sequence(),20);drop(guard);
  assert_eq!(fs::read(legacy).unwrap(),original);assert_eq!(fs::read_dir(&diagnostics).unwrap().count(),510);
  for entry in fs::read_dir(&diagnostics).unwrap(){assert_eq!(fs::read(entry.unwrap().path()).unwrap(),b"{\"schemaVersion\":1}");}
  assert_eq!(session_store::LiveGuard::open(&dir,&cfg.expected_binding.root_identity,Some(("replacement",&digest))).err().unwrap().code,"NATIVE_DRAFT_OUTCOME_UNKNOWN");
 }
 #[test]fn capacity_unclean_read_cannot_be_cleared_to_gain_capacity(){
  let(dir,cfg)=fixture();assert!(inspect_with(&dir,&cfg,GRANT,|_,_,_|{let mut p=proof(summary());p.cleanup_complete=false;p},||Ok(())).is_err());
  let path=dir.join(format!("{}.sessions-v2/head.json",cfg.expected_binding.project_id));let before=fs::read(&path).unwrap();
  for _ in 0..3{assert!(inspect_with(&dir,&cfg,GRANT,|_,_,_|panic!("unsettled transport redispatched"),||Ok(())).is_err());}
  assert_eq!(fs::read(path).unwrap(),before);let head:Value=serde_json::from_slice(&before).unwrap();assert_eq!(head["sequence"],1);assert!(head["state"]["pending"].is_string());
 }
 #[test]fn result_read_reservation_failure_never_dispatches_and_preserves_evidence(){
  let(dir,cfg)=fixture();let mut guard=session_store::LiveGuard::open(&dir,&cfg.expected_binding.root_identity,None).unwrap();guard.append("PRE_DISPATCH_REFUSED").unwrap();drop(guard);
  let root=dir.join(format!("{}.sessions-v2",cfg.expected_binding.project_id));fs::create_dir(root.join("terminal-head.reserve")).unwrap();
  assert!(inspect_with(&dir,&cfg,GRANT,|_,_,_|panic!("allocation failure dispatched host"),||Ok(())).is_err());
  let guard=session_store::LiveGuard::open(&dir,&cfg.expected_binding.root_identity,None).unwrap();assert!(!guard.begun);assert!(guard.outstanding.is_none());assert_eq!(guard.sequence(),2);
 }
}