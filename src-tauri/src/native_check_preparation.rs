//! Owner-only saved-setup preparation. No review, selection or execution.
use super::*;

pub(super) fn validate_request(r:&CheckPreparationRequest)->Result<(),DraftError>{
    validate(&r.identity)?;
    if !digest(&r.setup_reference)||r.expected.host_revision==0||!head_valid(&r.expected){return Err(error("NATIVE_CHECK_PREPARATION_INVALID"));}
    validate_submission(&json!({}),&r.original_request)
}
fn original(r:&CheckPreparationRequest)->Value{json!({"identity":{"schemaVersion":r.identity.schema_version,"workspaceId":r.identity.workspace_id,"registryRevision":r.identity.registry_revision,"rootIdentity":r.identity.root_identity,"censusDigest":r.identity.census_digest},"setupReference":r.setup_reference,"expected":r.expected,"originalRequest":{"requestId":r.original_request.request_id,"expectedRevision":r.original_request.expected_revision,"expectedHeadDigest":r.original_request.expected_head_digest}})}
fn preparation_state(state:&Path)->Result<PathBuf,DraftError>{
    safe(state)?;let dir=state.join("native-check-preparation-v1");
    match fs::create_dir(&dir){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_CHECK_PREPARATION_UNAVAILABLE"))}
    safe(&dir)?;if !dir.is_dir(){return Err(error("NATIVE_CHECK_PREPARATION_UNAVAILABLE"));}Ok(dir)
}
// Called under the project session lock before BEGIN. Exact original input is
// retained even when the page closes or no usable business reply is returned.
fn retain_original(dir:&Path,hash:&str,value:&Value)->Result<(),DraftError>{
    let bytes=serde_json::to_vec(value).map_err(|_|error("NATIVE_CHECK_PREPARATION_INVALID"))?;
    if bytes.len()>4096||format!("{:x}",Sha256::digest(&bytes))!=hash{return Err(error("NATIVE_CHECK_PREPARATION_INVALID"));}
    safe(dir)?;let path=dir.join(format!("{hash}.original.json"));
    match OpenOptions::new().write(true).create_new(true).open(&path){
        Ok(mut file)=>{safe(&path)?;identity(&file)?;file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|error("NATIVE_CHECK_PREPARATION_UNAVAILABLE"))?;},
        Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},
        Err(_)=>return Err(error("NATIVE_CHECK_PREPARATION_UNAVAILABLE")),
    }
    safe(&path)?;let mut file=File::open(&path).map_err(|_|error("NATIVE_CHECK_PREPARATION_UNAVAILABLE"))?;let before=stamp(&file)?;
    if before.0!=bytes.len()as u64{return Err(error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"));}
    let mut observed=Vec::new();(&mut file).take(4097).read_to_end(&mut observed).map_err(|_|error("NATIVE_CHECK_PREPARATION_UNAVAILABLE"))?;
    safe(&path)?;let current=File::open(&path).map_err(|_|error("NATIVE_CHECK_PREPARATION_UNAVAILABLE"))?;
    if observed!=bytes||stamp(&file)?!=before||stamp(&current)?!=before{return Err(error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"));}Ok(())
}
fn project_result(mut value:Value,r:&CheckPreparationRequest,binding:&Binding,profile:Option<&str>)->Result<Value,DraftError>{
    let keys=["schemaVersion","profileId","originalRequestId","contractDigest","policyDigest","contractHead","idempotent","matchesObservedContractHead","preparationPersisted","observationEvidencePersisted","reviewEnabled","toolchainVerified","candidateVerified","executionAuthorized","registrationLeaseHeld"];
    let h=&value["contractHead"];
    if !value.as_object().is_some_and(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k)))||value["schemaVersion"]!=1||!profile.is_some_and(valid_check_profile)||value["profileId"].as_str()!=profile||value["originalRequestId"]!=r.original_request.request_id
        ||!value["contractDigest"].as_str().is_some_and(digest)||!value["policyDigest"].as_str().is_some_and(digest)
        ||!h.as_object().is_some_and(|o|o.len()==2&&o.contains_key("revision")&&o.contains_key("headDigest"))||!h["revision"].as_u64().is_some_and(|n|n==r.original_request.expected_revision+1&&n<=9_007_199_254_740_991)||!h["headDigest"].as_str().is_some_and(digest)
        ||!value["idempotent"].is_boolean()||!value["matchesObservedContractHead"].is_boolean()
        ||["preparationPersisted","observationEvidencePersisted"].iter().any(|k|value[k]!=true)
        ||["reviewEnabled","toolchainVerified","candidateVerified","executionAuthorized","registrationLeaseHeld"].iter().any(|k|value[k]!=false){return Err(unknown(&r.original_request.request_id));}
    value["binding"]=json!(binding);value["setupReference"]=json!(r.setup_reference);value["expectedProposal"]=json!(r.expected);value["cleanupComplete"]=json!(true);Ok(value)
}
pub(super) fn perform(app:tauri::AppHandle,r:CheckPreparationRequest)->Result<Value,DraftError>{
    validate_request(&r)?;
    let(resources,config)=configuration(&app,&r.identity,&r.setup_reference)?;
    run(&resources,&config,&r)
}
pub(super) fn configuration(app:&tauri::AppHandle,identity:&InspectRequest,setup_reference:&str)->Result<(PathBuf,HostConfiguration),DraftError>{
    validate(identity)?;if !digest(setup_reference){return Err(error("NATIVE_CHECK_PREPARATION_INVALID"));}
    let registry=crate::workspace_census::app_registry_root(&app).map_err(|_|error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))?;
    let root=check_setup_root(&registry,identity)?;
    let binding=Binding{project_id:project_id(&identity.root_identity),root_identity:identity.root_identity.clone(),census_digest:identity.census_digest.clone()};
    let resources=app.path().resource_dir().map_err(|_|error("NATIVE_DRAFT_RESOURCES_UNAVAILABLE"))?;
    crate::native_host_resources::verify_installed(&resources).map_err(|_|error("NATIVE_DRAFT_HOST_NOT_AVAILABLE"))?;
    let(executable,pin)=self_executable()?;
    let data=app.path().app_data_dir().map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;let state=state_directory(&data)?;
    let provision=check_setup::resolve(&state,&binding,&root,setup_reference)?;
    let config=HostConfiguration{metadata_executable:executable,metadata_digest:pin,registry_root:registry,state_directory:state,workspace_id:identity.workspace_id.clone(),registry_revision:identity.registry_revision,expected_binding:binding,actor:"local-native-user".into(),source:"perfect-planner-native-checks".into(),check_contract:None,check_profile_provision:Some(provision),prepared_check_selection:None};
    Ok((resources,config))
}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct CheckHead{revision:u64,head_digest:String}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct HistoricalCheck{binding:Binding,request:OriginalRequest,contract_head:CheckHead,contract_digest:String,policy_digest:String,proposal_head:Head,matches_observed_contract_head:bool,observation_evidence_verified:bool}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct CheckState{schema_version:u32,binding:Binding,contract_head:CheckHead,requested_original_id:Option<String>,original:Option<HistoricalCheck>,registration_lease_held:bool,execution_authorized:bool}
fn project_state(value:Value,binding:&Binding,wanted:Option<&str>)->Result<Value,DraftError>{
    let keys=["schemaVersion","binding","contractHead","requestedOriginalId","original","registrationLeaseHeld","executionAuthorized"];
    if !value.as_object().is_some_and(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k))){return Err(error("NATIVE_CHECK_STATE_INVALID"));}
    let state:CheckState=serde_json::from_value(value).map_err(|_|error("NATIVE_CHECK_STATE_INVALID"))?;
    let h=&state.contract_head;
    if state.schema_version!=1||state.binding!=*binding||state.requested_original_id.as_deref()!=wanted||state.execution_authorized||state.registration_lease_held||h.revision>9_007_199_254_740_991||(if h.revision==0{h.head_digest!="GENESIS"}else{!digest(&h.head_digest)}){return Err(error("NATIVE_CHECK_STATE_INVALID"));}
    if let Some(o)=&state.original{
        if o.binding.project_id!=binding.project_id||o.binding.root_identity!=binding.root_identity||!digest(&o.binding.census_digest)||Some(o.request.request_id.as_str())!=wanted||validate_submission(&json!({}),&o.request).is_err()||o.contract_head.revision!=o.request.expected_revision+1||o.contract_head.revision>h.revision||!digest(&o.contract_head.head_digest)||!digest(&o.contract_digest)||!digest(&o.policy_digest)||!head_valid(&o.proposal_head)||o.proposal_head.host_revision==0||o.observation_evidence_verified||o.matches_observed_contract_head!=(o.contract_head.revision==h.revision&&o.contract_head.head_digest==h.head_digest){return Err(error("NATIVE_CHECK_STATE_INVALID"));}
    }
    serde_json::to_value(state).map_err(|_|error("NATIVE_CHECK_STATE_INVALID"))
}
fn retained_original(dir:&Path,guard:&session_store::LiveGuard,binding:&Binding)->Result<Option<Value>,DraftError>{
    let Some(id)=guard.outstanding.as_deref()else{return Ok(None);};
    let hash=guard.outstanding_digest.as_deref().ok_or_else(||error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"))?;
    let path=dir.join(format!("{hash}.original.json"));safe(&path)?;
    let mut file=File::open(&path).map_err(|_|error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"))?;let before=stamp(&file)?;
    if before.0==0||before.0>4096{return Err(error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"));}
    let mut bytes=Vec::new();(&mut file).take(4097).read_to_end(&mut bytes).map_err(|_|error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"))?;
    safe(&path)?;let current=File::open(&path).map_err(|_|error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"))?;
    if bytes.len()as u64!=before.0||stamp(&file)?!=before||stamp(&current)?!=before||format!("{:x}",Sha256::digest(&bytes))!=hash{return Err(error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"));}
    let r:CheckPreparationRequest=serde_json::from_slice(&bytes).map_err(|_|error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"))?;validate_request(&r)?;
    if r.original_request.request_id!=id||r.identity.root_identity!=binding.root_identity||project_id(&r.identity.root_identity)!=binding.project_id{return Err(error("NATIVE_CHECK_PREPARATION_ORIGINAL_CHANGED"));}
    Ok(Some(original(&r)))
}
pub(super) fn inspect(app:tauri::AppHandle,r:CheckStateRequest)->Result<Value,DraftError>{
    let(resources,config)=configuration(&app,&r.identity,&r.setup_reference)?;
    let setup=setup_summary(&config,&r.setup_reference)?;
    let mut result=inspect_with(&resources,&config,crate::native_host_supervisor::run_single)?;
    result["setup"]=setup;Ok(result)
}
fn setup_summary(config:&HostConfiguration,reference:&str)->Result<Value,DraftError>{
    if !digest(reference){return Err(error("NATIVE_CHECK_SETUP_INVALID"));}
    let provision=config.check_profile_provision.as_ref().ok_or_else(||error("NATIVE_CHECK_SETUP_INVALID"))?;
    crate::native_host_supervisor::check_configuration(None,Some(provision),None).map_err(|_|error("NATIVE_CHECK_SETUP_INVALID"))?;
    Ok(json!({"setupReference":reference,"profileId":provision["profileId"],"assignments":provision["assignments"]}))
}
fn inspect_with<F:FnOnce(&Path,&HostConfiguration,&Value)->crate::native_host_supervisor::SupervisorReceipt>(resources:&Path,config:&HostConfiguration,dispatch:F)->Result<Value,DraftError>{
    let dir=preparation_state(&config.state_directory)?;let mut guard=session_store::LiveGuard::open(&dir,&config.expected_binding.root_identity,None)?;
    let original=match retained_original(&dir,&guard,&config.expected_binding){Ok(v)=>v,Err(e)=>{guard.append("PRE_DISPATCH_REFUSED")?;return Err(e);}};
    let diagnostic=prepare_live_diagnostics(&mut guard,&dir,&config.expected_binding,false,None,"inspect-checks")?;
    guard.append("BEGIN")?;
    let proof=dispatch(resources,config,&json!({"version":1,"requestId":guard.session,"command":"inspect-checks","payload":{"requestId":guard.outstanding}}));
    if diagnostic.supervisor(&proof).is_err(){return Err(uncertain(proof.request_may_have_committed));}
    if !proof.cleanup_complete||!proof.process_exited||!proof.descendants_settled||!proof.io_settled||proof.execution_authorized{return Err(uncertain(proof.request_may_have_committed));}
    let result=match proof.reply{Some(reply)if reply["ok"]==true=>project_state(reply["result"].clone(),&config.expected_binding,guard.outstanding.as_deref()),_=>Err(error("NATIVE_CHECK_STATE_UNAVAILABLE"))};
    // Reading never resolves the outstanding original, even if a matching ID
    // exists remotely. Full obligation reconciliation remains a separate action.
    guard.append("SETTLED")?;
    result.map(|mut value|{value["retainedOriginal"]=original.unwrap_or(Value::Null);value["cleanupComplete"]=json!(true);value})
}
fn run(resources:&Path,config:&HostConfiguration,r:&CheckPreparationRequest)->Result<Value,DraftError>{
    run_with(resources,config,r,crate::native_host_supervisor::run_single)
}
fn run_with<F:FnOnce(&Path,&HostConfiguration,&Value)->crate::native_host_supervisor::SupervisorReceipt>(resources:&Path,config:&HostConfiguration,r:&CheckPreparationRequest,dispatch:F)->Result<Value,DraftError>{
    validate_request(r)?;
    let dir=preparation_state(&config.state_directory)?;let input=original(r);let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).map_err(|_|error("NATIVE_CHECK_PREPARATION_INVALID"))?));
    let id=&r.original_request.request_id;let mut guard=session_store::LiveGuard::open(&dir,&config.expected_binding.root_identity,Some((id,&hash)))?;
    if let Err(failure)=retain_original(&dir,&hash,&input){guard.append("PRE_DISPATCH_REFUSED")?;return Err(failure);}
    let diagnostic=prepare_live_diagnostics(&mut guard,&dir,&config.expected_binding,true,Some((id,&hash)),"prepare-checks")?;
    guard.append("BEGIN")?;
    let payload=json!({"expected":r.expected,"request":{"requestId":id,"expectedRevision":r.original_request.expected_revision,"expectedHeadDigest":r.original_request.expected_head_digest}});
    let proof=dispatch(resources,config,&json!({"version":1,"requestId":guard.session,"command":"prepare-checks","payload":payload}));
    if diagnostic.supervisor(&proof).is_err(){let mut failure=uncertain(proof.request_may_have_committed);failure.code="NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE";failure.original_request_id=Some(id.clone());return Err(failure);}
    if !proof.cleanup_complete||!proof.process_exited||!proof.descendants_settled||!proof.io_settled||proof.execution_authorized{return Err(uncertain(proof.request_may_have_committed));}
    // Unknown business results retain the original. Clean process exit is not
    // evidence that persistence failed. Only an exact valid receipt clears it.
    let result=match proof.reply{Some(reply)if reply["ok"]==true=>project_result(reply["result"].clone(),r,&config.expected_binding,config.check_profile_provision.as_ref().and_then(|v|v["profileId"].as_str())),_=>Err(unknown(id))};
    if result.is_ok(){guard.outstanding=None;guard.outstanding_digest=None;}else{guard.outstanding=Some(id.clone());guard.outstanding_digest=Some(hash);}
    guard.append("SETTLED")?;result
}

#[cfg(test)]mod tests{
    use super::*;
    fn inspection(cfg:&HostConfiguration,id:Option<&str>)->Value{json!({"schemaVersion":1,"binding":cfg.expected_binding,"contractHead":{"revision":0,"headDigest":"GENESIS"},"requestedOriginalId":id,"original":null,"registrationLeaseHeld":false,"executionAuthorized":false})}
    #[test]fn check_state_read_returns_genesis_without_an_original_or_execution(){
        let(dir,cfg,_)=fixture();let value=inspection(&cfg,None);
        let read=inspect_with(&dir,&cfg,|_,_,protocol|{assert_eq!(protocol["command"],"inspect-checks");assert!(protocol["payload"]["requestId"].is_null());proof(Some(json!({"ok":true,"result":value})))}).unwrap();
        assert!(read["retainedOriginal"].is_null());assert_eq!(read["contractHead"]["revision"],0);assert_eq!(read["executionAuthorized"],false);assert_eq!(read["cleanupComplete"],true);
    }
    #[test]fn inspection_preserves_unknown_original_and_never_reconciles_it(){
        let(dir,cfg,mut r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).is_err());
        let value=inspection(&cfg,Some(&r.original_request.request_id));
        let read=inspect_with(&dir,&cfg,|_,_,_|proof(Some(json!({"ok":true,"result":value})))).unwrap();
        assert_eq!(read["retainedOriginal"],original(&r));assert!(read["original"].is_null());
        let guard=session_store::LiveGuard::open(&dir.join("native-check-preparation-v1"),&cfg.expected_binding.root_identity,None).unwrap();assert_eq!(guard.outstanding.as_deref(),Some("prepare-original-1"));drop(guard);
        r.setup_reference="f".repeat(64);let mut called=false;assert!(run_with(&dir,&cfg,&r,|_,_,_|{called=true;proof(None)}).is_err());assert!(!called);
    }
    #[test]fn corrupt_retained_original_blocks_inspection_without_repair(){
        let(dir,cfg,r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).is_err());let state=dir.join("native-check-preparation-v1");
        let file=fs::read_dir(&state).unwrap().map(|e|e.unwrap().path()).find(|p|p.to_string_lossy().ends_with(".original.json")).unwrap();fs::write(&file,b"{}").unwrap();
        let mut called=false;assert!(inspect_with(&dir,&cfg,|_,_,_|{called=true;proof(None)}).is_err());assert!(!called);assert_eq!(fs::read(file).unwrap(),b"{}");
    }
    #[test]fn inspection_projection_refuses_extra_authority_and_wrong_binding(){
        let(_,cfg,_)=fixture();let good=inspection(&cfg,None);assert!(project_state(good.clone(),&cfg.expected_binding,None).is_ok());
        for(k,v)in [("executionAuthorized",json!(true)),("privatePath",json!("secret")),("binding",json!({"projectId":"foreign","rootIdentity":"a".repeat(64),"censusDigest":"b".repeat(64)})),("requestedOriginalId",json!("wrong")),("contractHead",json!({"revision":0,"headDigest":"a".repeat(64)}))]{let mut value=good.clone();value[k]=v;assert!(project_state(value,&cfg.expected_binding,None).is_err());}
    }
    #[test]fn unresolved_process_also_blocks_check_inspection(){let(dir,cfg,r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|{let mut p=proof(None);p.cleanup_complete=false;p}).is_err());let mut called=false;assert!(inspect_with(&dir,&cfg,|_,_,_|{called=true;proof(None)}).unwrap_err().requires_recovery);assert!(!called);}
    #[test]
    #[ignore="Requires explicit DANS1 registered package fixture"]
    fn actual_saved_setup_prepare_and_exact_retry(){
        let bytes=fs::read(std::env::var_os("PP_TEST_CHECK_PREPARATION_CONFIG").expect("fixture required")).unwrap();assert!(bytes.len()<=65536);
        let v:Value=serde_json::from_slice(&bytes).unwrap();let m=&v["metadataConfig"];let text=|x:&Value|x.as_str().unwrap().to_owned();
        let mut cfg=HostConfiguration{metadata_executable:PathBuf::from(text(&m["executable"])),metadata_digest:text(&m["executableDigest"]),registry_root:PathBuf::from(text(&m["registryRoot"])),state_directory:PathBuf::from(text(&v["stateDirectory"])),workspace_id:text(&m["workspaceId"]),registry_revision:m["registryRevision"].as_u64().unwrap().try_into().unwrap(),expected_binding:serde_json::from_value(v["expectedBinding"].clone()).unwrap(),actor:"local-native-user".into(),source:"perfect-planner-native-checks".into(),check_contract:None,check_profile_provision:Some(json!({"profileId":"perfect-planner-checks-v1"})),prepared_check_selection:None};
        let identity=InspectRequest{schema_version:1,workspace_id:cfg.workspace_id.clone(),registry_revision:cfg.registry_revision,root_identity:cfg.expected_binding.root_identity.clone(),census_digest:cfg.expected_binding.census_digest.clone()};
        let root=check_setup_root(&cfg.registry_root,&identity).unwrap();
        let assignments:Vec<CheckAssignment>=serde_json::from_value(v["checkProfileProvision"]["assignments"].clone()).unwrap();
        let selected=PathBuf::from(text(&v["checkProfileProvision"]["npmCli"]["path"]));
        // Same native selection completion used by the picker, with a supplied
        // inert fixture path. This does not claim the OS dialog was exercised.
        let setup=save_picked_check_setup(&cfg.state_directory,&cfg.expected_binding,&assignments,&selected,||check_setup_root(&cfg.registry_root,&identity)).unwrap();
        let reference=text(&setup["setupReference"]);
        cfg.check_profile_provision=Some(check_setup::resolve(&cfg.state_directory,&cfg.expected_binding,&root,&reference).unwrap());
        let r=CheckPreparationRequest{identity,setup_reference:reference,expected:serde_json::from_value(v["preparePayload"]["expected"].clone()).unwrap(),original_request:serde_json::from_value(v["preparePayload"]["request"].clone()).unwrap()};
        let resources=PathBuf::from(std::env::var_os("PP_TEST_NATIVE_HOST_RESOURCE_ROOT").expect("package required"));
        let mut evidence=vec![setup];let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
            let before=inspect_with(&resources,&cfg,crate::native_host_supervisor::run_single).unwrap();evidence.push(before.clone());assert_eq!(before["contractHead"]["revision"],r.original_request.expected_revision);assert!(before["retainedOriginal"].is_null());
            let lost=run_with(&resources,&cfg,&r,|resource,config,request|{
                let mut p=crate::native_host_supervisor::run_single(resource,config,request);evidence.push(json!({"deliberatelyWithheldReply":p.reply}));
                assert!(p.cleanup_complete&&p.process_exited&&p.descendants_settled&&p.io_settled);assert_eq!(p.reply.as_ref().unwrap()["ok"],true);
                p.reply=None;p
            }).unwrap_err();assert!(lost.request_may_have_committed&&!lost.requires_recovery);evidence.push(json!({"lostReplyOutcome":lost}));
            let pending=inspect_with(&resources,&cfg,crate::native_host_supervisor::run_single).unwrap();evidence.push(pending.clone());assert_eq!(pending["contractHead"]["revision"],r.original_request.expected_revision+1);assert_eq!(pending["retainedOriginal"],original(&r));assert_eq!(pending["original"]["request"]["requestId"],r.original_request.request_id);
            {let guard=session_store::LiveGuard::open(&cfg.state_directory.join("native-check-preparation-v1"),&cfg.expected_binding.root_identity,None).unwrap();assert_eq!(guard.outstanding.as_deref(),Some(r.original_request.request_id.as_str()));}
            let second=run(&resources,&cfg,&r).unwrap();evidence.push(second.clone());assert_eq!(second["idempotent"],true);assert_eq!(second["contractHead"],pending["contractHead"]);assert_eq!(second["executionAuthorized"],false);assert_eq!(second["reviewEnabled"],false);
            let after=inspect_with(&resources,&cfg,crate::native_host_supervisor::run_single).unwrap();evidence.push(after.clone());assert_eq!(after["contractHead"],second["contractHead"]);assert!(after["retainedOriginal"].is_null());
            let guard=session_store::LiveGuard::open(&cfg.state_directory.join("native-check-preparation-v1"),&cfg.expected_binding.root_identity,None).unwrap();assert_eq!(guard.sequence(),10);assert!(guard.outstanding.is_none());
        }));
        let mut file=OpenOptions::new().write(true).create_new(true).open(std::env::var_os("PP_TEST_CHECK_PREPARATION_RECEIPT").expect("proof destination required")).unwrap();file.write_all(&serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();file.sync_all().unwrap();
        if let Err(e)=outcome{std::panic::resume_unwind(e);}
    }
    fn fixture()->(PathBuf,HostConfiguration,CheckPreparationRequest){
        let dir=std::env::temp_dir().join(fresh_id());fs::create_dir(&dir).unwrap();let dir=fs::canonicalize(dir).unwrap();
        let binding=Binding{project_id:project_id(&"a".repeat(64)),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};
        let cfg=HostConfiguration{metadata_executable:dir.join("native.exe"),metadata_digest:"c".repeat(64),registry_root:dir.clone(),state_directory:dir.clone(),workspace_id:"fixture".into(),registry_revision:1,expected_binding:binding,actor:"local-native-user".into(),source:"perfect-planner-native-checks".into(),check_contract:None,check_profile_provision:Some(json!({"profileId":"perfect-planner-checks-v1"})),prepared_check_selection:None};
        let r=CheckPreparationRequest{identity:InspectRequest{schema_version:1,workspace_id:"fixture".into(),registry_revision:1,root_identity:"a".repeat(64),census_digest:"b".repeat(64)},setup_reference:"d".repeat(64),expected:Head{host_revision:1,head_digest:"e".repeat(64)},original_request:OriginalRequest{request_id:"prepare-original-1".into(),expected_revision:0,expected_head_digest:"GENESIS".into()}};
        (dir,cfg,r)
    }
    fn result(r:&CheckPreparationRequest)->Value{json!({"schemaVersion":1,"profileId":"perfect-planner-checks-v1","originalRequestId":r.original_request.request_id,"contractDigest":"a".repeat(64),"policyDigest":"b".repeat(64),"contractHead":{"revision":1,"headDigest":"c".repeat(64)},"idempotent":false,"matchesObservedContractHead":true,"preparationPersisted":true,"observationEvidencePersisted":true,"reviewEnabled":false,"toolchainVerified":false,"candidateVerified":false,"executionAuthorized":false,"registrationLeaseHeld":false})}
    fn proof(reply:Option<Value>)->crate::native_host_supervisor::SupervisorReceipt{crate::native_host_supervisor::SupervisorReceipt{reason:"NATIVE_HOST_REQUEST_FINISHED",reply,stopped:None,request_may_have_committed:true,process_exited:true,descendants_settled:true,io_settled:true,cleanup_complete:true,execution_authorized:false,pre_execution_containment:false,child_exit_code:Some(0)}}
    #[test]fn full_original_precedes_dispatch_and_success_keeps_it(){
        let(dir,cfg,r)=fixture();let value=result(&r);let expected=original(&r);
        let receipt=run_with(&dir,&cfg,&r,|_,_,protocol|{
            let state=dir.join("native-check-preparation-v1");let path=fs::read_dir(&state).unwrap().map(|e|e.unwrap().path()).find(|p|p.to_string_lossy().ends_with(".original.json")).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap(),expected);
            assert_eq!(protocol["command"],"prepare-checks");assert_eq!(protocol["payload"]["request"]["requestId"],"prepare-original-1");
            proof(Some(json!({"ok":true,"result":value})))
        }).unwrap();
        assert_eq!(receipt["cleanupComplete"],true);assert_eq!(receipt["reviewEnabled"],false);
        assert_eq!(receipt["setupReference"],r.setup_reference);assert_eq!(receipt["binding"],json!(cfg.expected_binding));
        assert!(!dir.join(format!("{}.sessions.jsonl",cfg.expected_binding.project_id)).exists());
        let guard=session_store::LiveGuard::open(&dir.join("native-check-preparation-v1"),&cfg.expected_binding.root_identity,None).unwrap();assert!(guard.outstanding.is_none());assert_eq!(guard.sequence(),2);
    }
    #[test]fn lost_business_reply_requires_exact_original_and_successful_retry_clears_it(){
        let(dir,cfg,mut r)=fixture();assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(None)).unwrap_err().request_may_have_committed);
        r.setup_reference="f".repeat(64);let mut called=false;assert!(run_with(&dir,&cfg,&r,|_,_,_|{called=true;proof(None)}).is_err());assert!(!called);
        r.setup_reference="d".repeat(64);let mut value=result(&r);value["idempotent"]=json!(true);
        assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(Some(json!({"ok":true,"result":value})))).is_ok());
        let guard=session_store::LiveGuard::open(&dir.join("native-check-preparation-v1"),&cfg.expected_binding.root_identity,None).unwrap();assert!(guard.outstanding.is_none());assert_eq!(guard.sequence(),4);
    }
    #[test]fn unresolved_process_blocks_even_original_retry(){
        let(dir,cfg,r)=fixture();let e=run_with(&dir,&cfg,&r,|_,_,_|{let mut p=proof(None);p.cleanup_complete=false;p.process_exited=false;p}).unwrap_err();assert!(e.requires_recovery);
        let mut called=false;assert!(run_with(&dir,&cfg,&r,|_,_,_|{called=true;proof(None)}).unwrap_err().requires_recovery);assert!(!called);
    }
    #[test]fn projection_rejects_unauthorized_foreign_and_wrong_revision_results(){
        let(_,cfg,r)=fixture();let good=result(&r);assert!(project_result(good.clone(),&r,&cfg.expected_binding,Some("perfect-planner-checks-v1")).is_ok());
        for(k,v)in [("executionAuthorized",json!(true)),("reviewEnabled",json!(true)),("toolchainVerified",json!(true)),("originalRequestId",json!("different")),("contractHead",json!({"revision":2,"headDigest":"c".repeat(64)})),("path",json!("private"))]{let mut value=good.clone();value[k]=v;assert!(project_result(value,&r,&cfg.expected_binding,Some("perfect-planner-checks-v1")).is_err());}
    }
    #[test]fn mismatched_profile_retains_original_until_matching_reply(){
        let(dir,mut cfg,r)=fixture();cfg.check_profile_provision=Some(json!({"profileId":"npm-project-checks-v1"}));
        let fixed=result(&r);assert!(run_with(&dir,&cfg,&r,|_,_,_|proof(Some(json!({"ok":true,"result":fixed})))).unwrap_err().request_may_have_committed);
        {let guard=session_store::LiveGuard::open(&dir.join("native-check-preparation-v1"),&cfg.expected_binding.root_identity,None).unwrap();assert!(guard.outstanding.is_some());}
        let mut generic=result(&r);generic["profileId"]=json!("npm-project-checks-v1");
        assert!(project_result(generic.clone(),&r,&cfg.expected_binding,None).is_err());
        assert!(project_result(generic.clone(),&r,&cfg.expected_binding,Some("arbitrary-shell")).is_err());
        let receipt=run_with(&dir,&cfg,&r,|_,_,_|proof(Some(json!({"ok":true,"result":generic})))).unwrap();assert_eq!(receipt["profileId"],"npm-project-checks-v1");
        let guard=session_store::LiveGuard::open(&dir.join("native-check-preparation-v1"),&cfg.expected_binding.root_identity,None).unwrap();assert!(guard.outstanding.is_none());
    }
    #[test]fn setup_summary_returns_saved_profile_and_assignments_without_tool_paths(){
        let(dir,mut cfg,r)=fixture();let assignments=json!([{"taskId":"T0001","categories":["build"]}]);
        cfg.check_profile_provision=Some(json!({"profileId":"npm-project-checks-v1","registeredRoot":dir,"npmCli":{"path":dir.join("npm-cli.js"),"sha256":"e".repeat(64)},"assignments":assignments}));
        assert_eq!(setup_summary(&cfg,&r.setup_reference).unwrap(),json!({"setupReference":r.setup_reference,"profileId":"npm-project-checks-v1","assignments":assignments}));
        cfg.check_profile_provision.as_mut().unwrap()["profileId"]=json!("unknown");assert!(setup_summary(&cfg,&r.setup_reference).is_err());
        cfg.check_profile_provision=None;assert!(setup_summary(&cfg,&r.setup_reference).is_err());
    }
    #[test]fn altered_original_is_not_replaced_and_never_dispatched(){
        let(dir,cfg,r)=fixture();let input=original(&r);let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&input).unwrap()));let state=preparation_state(&dir).unwrap();fs::write(state.join(format!("{hash}.original.json")),b"{}").unwrap();
        let mut called=false;assert!(run_with(&dir,&cfg,&r,|_,_,_|{called=true;proof(None)}).is_err());assert!(!called);assert_eq!(fs::read(state.join(format!("{hash}.original.json"))).unwrap(),b"{}");
        let guard=session_store::LiveGuard::open(&state,&cfg.expected_binding.root_identity,None).unwrap();assert!(!guard.begun);assert_eq!(guard.sequence(),1);
    }
    #[test]fn invalid_heads_and_renderer_configuration_refused_before_storage(){
        let(dir,_,mut r)=fixture();r.expected.host_revision=0;assert!(validate_request(&r).is_err());r.expected.host_revision=1;r.setup_reference="../path".into();assert!(validate_request(&r).is_err());
        let mut input=original(&r);input["setupReference"]=json!("a".repeat(64));input["command"]=json!("arbitrary");assert!(serde_json::from_value::<CheckPreparationRequest>(input).is_err());assert!(!dir.join("native-check-preparation-v1").exists());
    }
}

