//! Private installed-host transport, not a renderer command or execution grant.
//! Resource verification is an observation, not a filesystem lease. The Job is
//! attached after spawn; initialization is withheld until attachment succeeds.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Binding { pub project_id:String, pub root_identity:String, pub census_digest:String }

// Construct only from native-owned installation and registered project state.
// Intentionally not Deserialize: never forward a webview/MCP config object here.
pub(crate) struct HostConfiguration {
    pub metadata_executable:PathBuf, pub metadata_digest:String,
    pub registry_root:PathBuf, pub state_directory:PathBuf,
    pub workspace_id:String, pub registry_revision:u32,
    pub expected_binding:Binding, pub actor:String, pub source:String,
    pub check_contract:Option<Value>,
    pub check_profile_provision:Option<Value>, pub prepared_check_selection:Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct SupervisorReceipt {
    // Private evidence only: result values are not a renderer/MCP response model.
    // Any later IPC endpoint must project/redact a command-specific public shape.
    pub reason:&'static str, pub reply:Option<Value>, pub stopped:Option<Value>,
    pub request_may_have_committed:bool, pub process_exited:bool,
    pub descendants_settled:bool, pub io_settled:bool, pub cleanup_complete:bool,
    pub execution_authorized:bool, pub pre_execution_containment:bool,
    pub child_exit_code:Option<i32>,
}
fn receipt(reason:&'static str)->SupervisorReceipt { SupervisorReceipt {reason,reply:None,stopped:None,request_may_have_committed:false,process_exited:false,descendants_settled:false,io_settled:false,cleanup_complete:false,execution_authorized:false,pre_execution_containment:false,child_exit_code:None} }
const REQUEST_LIMIT:usize=1024*1024+4096;
const OUTPUT_LIMIT:usize=128*1024;
enum Event{Line(Vec<u8>),OutEnd,ReadError,OutputInvalid}
#[derive(Clone,Copy)]enum FrameStage{Ready,Reply,Stopped}
fn frame_event(stage:FrameStage,event:Result<Event,std::sync::mpsc::RecvTimeoutError>)->Result<Vec<u8>,&'static str>{
    use std::sync::mpsc::RecvTimeoutError;
    let category=match event{Ok(Event::Line(bytes))=>return Ok(bytes),Ok(Event::OutEnd)=>0,Ok(Event::ReadError)=>1,Ok(Event::OutputInvalid)=>2,Err(RecvTimeoutError::Timeout)=>3,Err(RecvTimeoutError::Disconnected)=>4};
    Err(match (stage,category){
        (FrameStage::Ready,0)=>"NATIVE_HOST_READY_EOF",(FrameStage::Ready,1)=>"NATIVE_HOST_READY_READ_ERROR",(FrameStage::Ready,2)=>"NATIVE_HOST_READY_OUTPUT_INVALID",(FrameStage::Ready,3)=>"NATIVE_HOST_READY_TIMEOUT",(FrameStage::Ready,_)=>"NATIVE_HOST_READY_CHANNEL_CLOSED",
        (FrameStage::Reply,0)=>"NATIVE_HOST_REPLY_EOF",(FrameStage::Reply,1)=>"NATIVE_HOST_REPLY_READ_ERROR",(FrameStage::Reply,2)=>"NATIVE_HOST_REPLY_OUTPUT_INVALID",(FrameStage::Reply,3)=>"NATIVE_HOST_REPLY_TIMEOUT",(FrameStage::Reply,_)=>"NATIVE_HOST_REPLY_CHANNEL_CLOSED",
        (FrameStage::Stopped,0)=>"NATIVE_HOST_STOPPED_EOF",(FrameStage::Stopped,1)=>"NATIVE_HOST_STOPPED_READ_ERROR",(FrameStage::Stopped,2)=>"NATIVE_HOST_STOPPED_OUTPUT_INVALID",(FrameStage::Stopped,3)=>"NATIVE_HOST_STOPPED_TIMEOUT",(FrameStage::Stopped,_)=>"NATIVE_HOST_STOPPED_CHANNEL_CLOSED",
    })
}
fn hash(s:&str)->bool{s.len()==64&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn token(s:&str)->bool{!s.is_empty()&&s.len()<=160&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b"._:-".contains(&b))}
fn exact(v:&Value,keys:&[&str])->bool{v.as_object().map(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k))).unwrap_or(false)}
fn saved_head(v:&Value,revision:&str)->bool{
    exact(v,&[revision,"headDigest"])&&v[revision].as_u64().is_some_and(|n|n>0&&n<=9_007_199_254_740_991)&&v["headDigest"].as_str().is_some_and(hash)
}
pub(crate) fn check_configuration(legacy:Option<&Value>,provision:Option<&Value>,selection:Option<&Value>)->Result<Value,&'static str>{
    let invalid="NATIVE_HOST_CONFIGURATION_INVALID";
    if legacy.is_some()&&provision.is_some()||selection.is_some()&&provision.is_none(){return Err(invalid);}
    let mut output=json!({});
    if let Some(value)=legacy{output["checkContract"]=value.clone();}
    if let Some(value)=provision{
        let absolute=|v:&Value|v.as_str().is_some_and(|s|!s.contains('\0')&&Path::new(s).is_absolute());
        if !exact(value,&["profileId","registeredRoot","npmCli","assignments"])||!value["profileId"].as_str().is_some_and(|p|matches!(p,"perfect-planner-checks-v1"|"npm-project-checks-v1"))||!absolute(&value["registeredRoot"])||!exact(&value["npmCli"],&["path","sha256"])||!absolute(&value["npmCli"]["path"])||!value["npmCli"]["sha256"].as_str().is_some_and(hash){return Err(invalid);}
        let Some(assignments)=value["assignments"].as_array()else{return Err(invalid);};
        if assignments.is_empty()||assignments.len()>256{return Err(invalid);}
        let mut ids=std::collections::HashSet::new();
        for item in assignments{
            if !exact(item,&["taskId","categories"]){return Err(invalid);}
            let Some(id)=item["taskId"].as_str()else{return Err(invalid);};
            if !(5..=7).contains(&id.len())||!id.starts_with('T')||!id.as_bytes()[1..].iter().all(u8::is_ascii_digit)||!ids.insert(id){return Err(invalid);}
            let Some(categories)=item["categories"].as_array()else{return Err(invalid);};
            let mut seen=std::collections::HashSet::new();
            if categories.is_empty()||categories.len()>3||categories.iter().any(|c|!matches!(c.as_str(),Some("tests"|"build"|"secrets"))||!seen.insert(c.as_str())){return Err(invalid);}
        }
        output["checkProfileProvision"]=value.clone();
    }
    if let Some(value)=selection{
        if !exact(value,&["expected","contractHead"])||!saved_head(&value["expected"],"hostRevision")||!saved_head(&value["contractHead"],"revision"){return Err(invalid);}
        output["preparedCheckSelection"]=value.clone();
    }
    Ok(output)
}
fn proposal_read_payload(command:&str,p:&Value)->bool{
    let offset=||p["offset"].as_u64().filter(|n|*n<=1024*1024);
    let digest=||p["expectedHeadDigest"].as_str().is_some_and(hash);
    match command{
        "read-proposal-snapshot"=>exact(p,&["offset","expectedHeadDigest"])&&offset().is_some_and(|n|n<1024*1024)&&(digest()||p["expectedHeadDigest"]=="GENESIS"||(p["offset"]==0&&p["expectedHeadDigest"].is_null())),
        "read-proposal-brief"=>exact(p,&["offset","expectedHeadDigest"])&&offset().is_some_and(|n|n<=500)&&(digest()||p["expectedHeadDigest"]=="GENESIS"||(p["offset"]==0&&p["expectedHeadDigest"].is_null())),
        "read-proposal-task"=>exact(p,&["taskId","offset","expectedHeadDigest"])&&offset().is_some()&&digest()&&p["taskId"].as_str().is_some_and(|id|(5..=7).contains(&id.len())&&id.starts_with('T')&&id.as_bytes()[1..].iter().all(u8::is_ascii_digit)),
        "read-proposal-request"=>exact(p,&["requestId"])&&p["requestId"].as_str().is_some_and(|id|id.len()<=128&&token(id)&&id.as_bytes()[0].is_ascii_alphanumeric()),
        _=>false,
    }
}
fn review_payload(command:&str,p:&Value)->bool{
    let id=|key:&str|p[key].as_str().is_some_and(|s|!s.is_empty()&&s.len()<=128&&token(s)&&s.as_bytes()[0].is_ascii_alphanumeric());
    match command{
        "review-original-request"|"recover-original-request"=>exact(p,&["expected","originalDigest"] )&&saved_head(&p["expected"],"hostRevision")&&p["originalDigest"].as_str().is_some_and(hash),
        "review-proposal"=>exact(p,&["expected"])&&saved_head(&p["expected"],"hostRevision"),
        "recover-interrupted-request"=>exact(p,&["expected","confirmationId"])&&saved_head(&p["expected"],"hostRevision")&&id("confirmationId"),
        "inspect-recovery"|"recover-presentation"=>exact(p,&[]),
        "cancel-review"=>exact(p,&["reviewRequestId"])&&id("reviewRequestId"),
        _=>false,
    }
}
fn selected_review_request(selection:Option<&Value>,request:&Value)->Result<(),&'static str>{
    if matches!(request["command"].as_str(),Some("execute-check"|"recover-check-execution")){
        let selected=selection.ok_or("NATIVE_HOST_EXECUTION_SELECTION_MISMATCH")?;
        if !exact(selected,&["expected","contractHead"])||!saved_head(&selected["expected"],"hostRevision")||!saved_head(&selected["contractHead"],"revision")||request["payload"]["expected"]!=selected["expected"]||request["payload"]["contractHead"]!=selected["contractHead"]{return Err("NATIVE_HOST_EXECUTION_SELECTION_MISMATCH");}
    }
    // Selection is native-owned configuration. Caller heads may only name that
    // exact prepared proposal; the helper rechecks contract custody and files.
    if matches!(request["command"].as_str(),Some("review-proposal"|"recover-interrupted-request"|"review-original-request"|"recover-original-request")){
        if let Some(selected)=selection{
            if !exact(selected,&["expected","contractHead"])||!saved_head(&selected["expected"],"hostRevision")||!saved_head(&selected["contractHead"],"revision")||request["payload"]["expected"]!=selected["expected"]{return Err("NATIVE_HOST_REVIEW_SELECTION_MISMATCH");}
        }
    }
    Ok(())
}
fn request_line(request:&Value)->Result<Vec<u8>,&'static str>{
    let command=request["command"].as_str().unwrap_or("");
    let executing=matches!(command,"execute-check"|"recover-check-execution");
    if executing&&!execution_payload(&request["payload"]){return Err("NATIVE_HOST_REQUEST_INVALID");}
    let read=matches!(command,"read-proposal-snapshot"|"read-proposal-brief"|"read-proposal-task"|"read-proposal-request");
    if matches!(command,"review-original-request"|"recover-original-request"|"review-proposal"|"recover-interrupted-request"|"inspect-recovery"|"recover-presentation"|"cancel-review")&&!review_payload(command,&request["payload"]){return Err("NATIVE_HOST_REQUEST_INVALID");}
    let preparing=command=="prepare-checks";
    let inspecting_checks=command=="inspect-checks";
    let inspecting_result=command=="inspect-task-result";
    let result_index=matches!(command,"list-task-results"|"read-task-result-page");
    if result_index{let p=&request["payload"];if !exact(p,&["offset","expectedHeadDigest"])||!p["offset"].as_u64().is_some_and(|n|n<=2048)||!(p["expectedHeadDigest"].as_str().is_some_and(hash)||p["expectedHeadDigest"]=="GENESIS"||(p["offset"]==0&&p["expectedHeadDigest"].is_null())){return Err("NATIVE_HOST_REQUEST_INVALID");}}
    if inspecting_result&&(!exact(&request["payload"],&["grantId"])||!request["payload"]["grantId"].as_str().is_some_and(|id|id.len()==36&&id.bytes().enumerate().all(|(i,b)|if [8,13,18,23].contains(&i){b==b'-'}else{b.is_ascii_digit()||(b'a'..=b'f').contains(&b)}))){return Err("NATIVE_HOST_REQUEST_INVALID");}
    if inspecting_checks&&(!exact(&request["payload"],&["requestId"])||!(request["payload"]["requestId"].is_null()||request["payload"]["requestId"].as_str().is_some_and(|id|id.len()<=128&&token(id)&&id.as_bytes()[0].is_ascii_alphanumeric()))){return Err("NATIVE_HOST_REQUEST_INVALID");}
    if preparing{
        let p=&request["payload"];let r=&p["request"];
        let revision=r["expectedRevision"].as_u64();
        if !exact(p,&["expected","request"])||!saved_head(&p["expected"],"hostRevision")||!exact(r,&["requestId","expectedRevision","expectedHeadDigest"])||!r["requestId"].as_str().is_some_and(|id|id.len()<=128&&token(id)&&id.as_bytes()[0].is_ascii_alphanumeric())||!revision.is_some_and(|n|n<=9_007_199_254_740_991)||(if revision==Some(0){r["expectedHeadDigest"]!="GENESIS"}else{!r["expectedHeadDigest"].as_str().is_some_and(hash)}){return Err("NATIVE_HOST_REQUEST_INVALID");}
    }
    if !exact(request,&["version","requestId","command","payload"])||request["version"]!=1||!request["requestId"].as_str().map(token).unwrap_or(false)||!request["payload"].is_object()||!(executing||preparing||inspecting_checks||inspecting_result||result_index||read||matches!(command,"inspect-proposal"|"submit-draft"|"inspect-recovery"|"review-original-request"|"recover-original-request"|"review-proposal"|"recover-presentation"|"recover-interrupted-request"|"cancel-review"))||(read&&!proposal_read_payload(command,&request["payload"])){return Err("NATIVE_HOST_REQUEST_INVALID");}
    let mut bytes=serde_json::to_vec(request).map_err(|_|"NATIVE_HOST_REQUEST_INVALID")?;
    if bytes.len()>REQUEST_LIMIT{return Err("NATIVE_HOST_REQUEST_TOO_LARGE");}bytes.push(b'\n');Ok(bytes)
}
fn execution_payload(p:&Value)->bool{
    let id=|key:&str|p[key].as_str().is_some_and(|s|token(s)&&s.len()<=128&&s.as_bytes()[0].is_ascii_alphanumeric());
    let task=p["taskId"].as_str().is_some_and(|s|{
        if !(5..=7).contains(&s.len())||!s.starts_with('T')||!s.as_bytes()[1..].iter().all(u8::is_ascii_digit){return false;}
        s[1..].parse::<u32>().ok().is_some_and(|n|n>0&&format!("T{n:04}")==s)
    });
    exact(p,&["requestId","expected","contractHead","confirmationId","taskId","checkId","attemptId","attemptNumber"])&&["requestId","confirmationId","checkId","attemptId"].iter().all(|k|id(k))&&task&&saved_head(&p["expected"],"hostRevision")&&saved_head(&p["contractHead"],"revision")&&p["attemptNumber"].as_u64().is_some_and(|n|n>0&&n<=9_007_199_254_740_991)
}
fn request_timeout(request:&Value)->Duration{
    // Three admission captures (360s), guarded conversation (555s, including
    // its fourth capture), and 60s admission/settlement. No grant extension.
    Duration::from_secs(if request["command"]=="execute-check"{975}else{150})
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Ready{version:u32,kind:String,binding:Binding,package_manifest_digest:String,execution_authorized:bool}
fn ready(line:&[u8],binding:&Binding,pin:&str)->bool{serde_json::from_slice::<Ready>(line).map(|r|r.version==1&&r.kind=="NATIVE_REVIEW_HOST_READY"&&r.binding==*binding&&r.package_manifest_digest==pin&&!r.execution_authorized).unwrap_or(false)}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Stopped{version:u32,kind:String,reason:String,startup_settled:bool,dispatches_settled:bool,shutdown_settled:bool,output_settled:bool,cleanup_complete:bool,dialog_closed:Option<bool>,execution_authorized:bool}
fn stopped(line:&[u8])->Result<(Value,bool),&'static str>{
    let value:Value=serde_json::from_slice(line).map_err(|_|"NATIVE_HOST_STOPPED_INVALID")?;
    if !exact(&value,&["version","kind","reason","startupSettled","dispatchesSettled","shutdownSettled","outputSettled","cleanupComplete","dialogClosed","executionAuthorized"]){return Err("NATIVE_HOST_STOPPED_INVALID");}
    let s:Stopped=serde_json::from_slice(line).map_err(|_|"NATIVE_HOST_STOPPED_INVALID")?;
    if s.version!=1||s.kind!="NATIVE_REVIEW_HOST_STOPPED"||s.execution_authorized||s.dialog_closed.is_some()||s.reason.len()>128{return Err("NATIVE_HOST_STOPPED_INVALID");}
    let clean=s.reason=="STREAM_EOF"&&s.startup_settled&&s.dispatches_settled&&s.shutdown_settled&&s.output_settled&&s.cleanup_complete;
    Ok((value,clean))
}
fn reply(line:&[u8],id:&Value)->Result<Value,&'static str>{
    #[derive(Deserialize)]
    #[serde(rename_all="camelCase",deny_unknown_fields)]
    struct Envelope{version:u32,request_id:String,ok:bool,result:Option<Value>,error:Option<Value>,cleanup_complete:Option<bool>,execution_authorized:bool,native_gesture_verified:bool}
    let envelope:Envelope=serde_json::from_slice(line).map_err(|_|"NATIVE_HOST_REPLY_INVALID")?;
    if envelope.version!=1||envelope.execution_authorized||envelope.native_gesture_verified||id.as_str()!=Some(envelope.request_id.as_str())||envelope.cleanup_complete==Some(true)||envelope.ok&&envelope.error.is_some()||!envelope.ok&&envelope.result.is_some(){return Err("NATIVE_HOST_REPLY_INVALID");}
    let v:Value=serde_json::from_slice(line).map_err(|_|"NATIVE_HOST_REPLY_INVALID")?;
    let mut keys=if v["ok"]==true{vec!["version","requestId","ok","result","executionAuthorized","nativeGestureVerified"]}else{vec!["version","requestId","ok","error","executionAuthorized","nativeGestureVerified"]};
    if v.get("cleanupComplete").is_some(){if v["ok"]!=false||v["error"]["code"]!="NATIVE_REVIEW_CLEANUP_UNCERTAIN"||v["cleanupComplete"]!=false{return Err("NATIVE_HOST_REPLY_INVALID");}keys.push("cleanupComplete");}
    if !exact(&v,&keys)||v["version"]!=1||&v["requestId"]!=id||!v["ok"].is_boolean()||v["executionAuthorized"]!=false||v["nativeGestureVerified"]!=false{return Err("NATIVE_HOST_REPLY_INVALID");}Ok(v)
}

// The owning native integration must serialize sessions and retain a durable
// uncertainty latch across calls/restarts. This single-request primitive never
// retries; its return is not permission to open a replacement review window.
pub(crate) fn run_single(resource_directory:&Path,config:&HostConfiguration,request:&Value)->SupervisorReceipt{
    let request_bytes=match request_line(request){Ok(v)=>v,Err(e)=>return receipt(e)};
    if let Err(e)=selected_review_request(config.prepared_check_selection.as_ref(),request){return receipt(e);}
    if !hash(&config.metadata_digest)||!hash(&config.expected_binding.root_identity)||!hash(&config.expected_binding.census_digest)||!token(&config.expected_binding.project_id)||!token(&config.workspace_id)||config.registry_revision==0||[&config.actor,&config.source].iter().any(|v|v.trim().is_empty()||v.len()>256)||[&config.metadata_executable,&config.registry_root,&config.state_directory].iter().any(|p|!p.is_absolute()){return receipt("NATIVE_HOST_CONFIGURATION_INVALID");}
    let installed=match crate::native_host_resources::verify_installed(resource_directory){Ok(v)=>v,Err(e)=>return receipt(e)};
    let mut cfg=json!({"packageConfig":{"packageRoot":installed.package_root,"manifestDigest":installed.manifest_digest},"metadataConfig":{"executable":config.metadata_executable,"executableDigest":config.metadata_digest,"registryRoot":config.registry_root,"workspaceId":config.workspace_id,"registryRevision":config.registry_revision,"rootIdentity":config.expected_binding.root_identity},"stateDirectory":config.state_directory,"actor":config.actor,"source":config.source});
    let checks=match check_configuration(config.check_contract.as_ref(),config.check_profile_provision.as_ref(),config.prepared_check_selection.as_ref()){Ok(value)=>value,Err(e)=>return receipt(e)};
    cfg.as_object_mut().unwrap().extend(checks.as_object().unwrap().clone());
    let mut init=match serde_json::to_vec(&json!({"version":1,"kind":"INITIALIZE_NATIVE_REVIEW_HOST","config":cfg})){Ok(v)=>v,Err(_)=>return receipt("NATIVE_HOST_CONFIGURATION_INVALID")};
    if init.len()>64*1024{return receipt("NATIVE_HOST_CONFIGURATION_TOO_LARGE");}init.push(b'\n');
    #[cfg(windows)]{transport(&installed,config,request,init,request_bytes)}
    #[cfg(not(windows))]{let _=(installed,init,request_bytes);receipt("NATIVE_HOST_PLATFORM_UNSUPPORTED")}
}

#[cfg(windows)]
fn transport(installed:&crate::native_host_resources::VerifiedNativeHost,config:&HostConfiguration,request:&Value,init:Vec<u8>,request_bytes:Vec<u8>)->SupervisorReceipt{
    use std::io::{Read,Write};
    use std::process::{Command,Stdio};
    use std::sync::mpsc::{self,Receiver};
    use std::os::windows::process::CommandExt;
    enum WriteAction{Bytes(Vec<u8>),End}
    let mut result=receipt("NATIVE_HOST_START_FAILED");
    let mut command=Command::new(&installed.node_executable);
    command.arg(&installed.bootstrap_script).current_dir(&installed.package_root).env_clear().creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for name in ["SystemRoot","WINDIR"]{if let Some(value)=std::env::var_os(name){command.env(name,value);}}
    let mut child=match command.spawn(){Ok(v)=>v,Err(_)=>return result};
    let job=match containment::Job::attach(&child){Ok(v)=>v,Err(_)=>{let _=child.kill();let deadline=Instant::now()+Duration::from_secs(3);while Instant::now()<deadline{if let Some(status)=child.try_wait().ok().flatten(){result.process_exited=true;result.child_exit_code=status.code();break;}std::thread::sleep(Duration::from_millis(10));}result.reason="NATIVE_HOST_CONTAINMENT_FAILED";return result;}};
    let mut input=child.stdin.take().unwrap();let mut output=child.stdout.take().unwrap();let mut errors=child.stderr.take().unwrap();
    let (tx,rx)=mpsc::sync_channel(8);let errtx=tx.clone();
    // Only the private snapshot reply may carry a complete 1 MiB ledger.
    // Initialization, request validation, frame count and cleanup stay bounded.
    let reply_limit=if request["command"]=="read-proposal-snapshot"{3*1024*1024}else{65536};
    let output_limit=if request["command"]=="read-proposal-snapshot"{reply_limit+OUTPUT_LIMIT}else{OUTPUT_LIMIT};
    let stdout=std::thread::spawn(move||{let mut count=0;let mut line=Vec::new();let mut buf=[0u8;4096];let mut frames=0;loop{match output.read(&mut buf){Ok(0)=>{let _=tx.send(if line.is_empty(){Event::OutEnd}else{Event::OutputInvalid});break;},Ok(n)=>{count+=n;if count>output_limit{let _=tx.send(Event::OutputInvalid);break;}for b in &buf[..n]{if *b==b'\n'{frames+=1;if frames>3||line.len()>if frames==2{reply_limit}else{65536}||line.is_empty(){let _=tx.send(Event::OutputInvalid);return;}if tx.send(Event::Line(std::mem::take(&mut line))).is_err(){return;}}else{line.push(*b);if line.len()>if frames==1{reply_limit}else{65536}{let _=tx.send(Event::OutputInvalid);return;}}}},Err(_)=>{let _=tx.send(Event::ReadError);break;}}}});
    let stderr=std::thread::spawn(move||{let mut total=0;let mut buf=[0u8;4096];loop{match errors.read(&mut buf){Ok(0)=>return,Ok(n)=>{total+=n;if total>16384{let _=errtx.send(Event::OutputInvalid);return;}},Err(_)=>{let _=errtx.send(Event::ReadError);return;}}}});
    let (writes,write_rx)=mpsc::sync_channel(1);let (acks,ack_rx)=mpsc::sync_channel(1);
    let writer=std::thread::spawn(move||{while let Ok(action)=write_rx.recv(){match action{WriteAction::Bytes(bytes)=>{let ok=input.write_all(&bytes).and_then(|_|input.flush()).is_ok();if acks.send(ok).is_err()||!ok{return;}},WriteAction::End=>{drop(input);let _=acks.send(true);return;}}}});
    let deadline=Instant::now()+request_timeout(request);
    fn line(rx:&Receiver<Event>,deadline:Instant,stage:FrameStage)->Result<Vec<u8>,&'static str>{frame_event(stage,rx.recv_timeout(deadline.saturating_duration_since(Instant::now())))}
    let mut clean_stop=false;
    let outcome=(||->Result<(),&'static str>{
        let write=|bytes:WriteAction|->Result<(),&'static str>{writes.try_send(bytes).map_err(|_|"NATIVE_HOST_WRITE_FAILED")?;if ack_rx.recv_timeout(Duration::from_secs(5)).ok()!=Some(true){return Err("NATIVE_HOST_WRITE_FAILED");}Ok(())};
        write(WriteAction::Bytes(init))?;
        let ready_line=line(&rx,Instant::now()+Duration::from_secs(20),FrameStage::Ready)?;
        if !ready(&ready_line,&config.expected_binding,&installed.manifest_digest){
            #[cfg(test)] eprintln!("Supervisor READY diagnostic: {}",String::from_utf8_lossy(&ready_line));
            return Err("NATIVE_HOST_READY_MISMATCH");
        }
        // From this point a partial write or lost response may have persisted a
        // proposal. The caller must inspect durable state, never auto-retry.
        result.request_may_have_committed=true;
        write(WriteAction::Bytes(request_bytes))?;
        result.reply=Some(reply(&line(&rx,deadline,FrameStage::Reply)?,&request["requestId"])?);
        write(WriteAction::End)?;
        let (frame,clean)=stopped(&line(&rx,deadline,FrameStage::Stopped)?)?;result.stopped=Some(frame);clean_stop=clean;
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())){Ok(Event::OutEnd)=>{},_=>return Err("NATIVE_HOST_OUTPUT_UNSETTLED")}
        while Instant::now()<deadline{match child.try_wait(){Ok(Some(status))=>{result.process_exited=true;result.child_exit_code=status.code();if !status.success(){return Err("NATIVE_HOST_EXIT_FAILED");}return Ok(());},Ok(None)=>std::thread::sleep(Duration::from_millis(10)),Err(_)=>return Err("NATIVE_HOST_EXIT_UNSETTLED")}}
        Err("NATIVE_HOST_TIMEOUT")
    })();
    result.reason=match outcome{Ok(())=>"NATIVE_HOST_REQUEST_FINISHED",Err(e)=>e};
    // Observe natural exit before requesting cleanup; a later observed code may
    // instead be the Job termination code and is not a claimed startup cause.
    if let Some(status)=child.try_wait().ok().flatten(){result.process_exited=true;result.child_exit_code=status.code();}
    drop(writes);job.stop();let cleanup=Instant::now()+Duration::from_secs(3);
    while Instant::now()<cleanup{if let Some(status)=child.try_wait().ok().flatten(){result.process_exited=true;result.child_exit_code=status.code();}result.descendants_settled=job.empty();result.io_settled=stdout.is_finished()&&stderr.is_finished()&&writer.is_finished();if result.process_exited&&result.descendants_settled&&result.io_settled{break;}std::thread::sleep(Duration::from_millis(10));}
    // Finished handles join without blocking; unresolved handles remain explicitly
    // uncertain and are never represented as proof that a native window closed.
    if stdout.is_finished(){let _=stdout.join();}if stderr.is_finished(){let _=stderr.join();}if writer.is_finished(){let _=writer.join();}
    result.cleanup_complete=clean_stop&&result.reply.as_ref().map(|v|v.get("cleanupComplete")!=Some(&Value::Bool(false))).unwrap_or(false)&&result.process_exited&&result.descendants_settled&&result.io_settled&&result.reason=="NATIVE_HOST_REQUEST_FINISHED";
    result
}

#[cfg(windows)]
mod containment{
    use std::ffi::c_void;use std::os::windows::io::AsRawHandle;
    type Handle=*mut c_void;
    #[repr(C)]#[derive(Default)]struct Basic{process_time:i64,job_time:i64,flags:u32,minimum:usize,maximum:usize,active:u32,affinity:usize,priority:u32,scheduling:u32}
    #[repr(C)]#[derive(Default)]struct Extended{basic:Basic,io:[u64;6],process_memory:usize,job_memory:usize,peak_process:usize,peak_job:usize}
    #[repr(C)]#[derive(Default)]struct Accounting{user:i64,kernel:i64,period_user:i64,period_kernel:i64,faults:u32,total:u32,active:u32,terminated:u32}
    #[link(name="kernel32")]extern "system"{fn CreateJobObjectW(security:Handle,name:*const u16)->Handle;fn SetInformationJobObject(job:Handle,class:i32,info:*const c_void,len:u32)->i32;fn AssignProcessToJobObject(job:Handle,process:Handle)->i32;fn QueryInformationJobObject(job:Handle,class:i32,info:*mut c_void,len:u32,returned:*mut u32)->i32;fn TerminateJobObject(job:Handle,code:u32)->i32;fn CloseHandle(handle:Handle)->i32;}
    pub struct Job(Handle);
    impl Job{
        pub fn attach(child:&std::process::Child)->Result<Self,()>{unsafe{let h=CreateJobObjectW(std::ptr::null_mut(),std::ptr::null());if h.is_null(){return Err(());}let job=Self(h);let mut limit=Extended::default();limit.basic.flags=0x2000;if SetInformationJobObject(h,9,&limit as *const _ as *const c_void,std::mem::size_of::<Extended>()as u32)==0||AssignProcessToJobObject(h,child.as_raw_handle())==0{return Err(());}Ok(job)}}
        pub fn empty(&self)->bool{unsafe{let mut a=Accounting::default();QueryInformationJobObject(self.0,1,&mut a as *mut _ as *mut c_void,std::mem::size_of::<Accounting>()as u32,std::ptr::null_mut())!=0&&a.active==0}}
        pub fn stop(&self){unsafe{TerminateJobObject(self.0,1);}}
    }
    impl Drop for Job{fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn frame_failure_categories_preserve_stage_without_raw_output(){
        use std::sync::mpsc::RecvTimeoutError;
        for (stage,prefix) in [(FrameStage::Ready,"NATIVE_HOST_READY"),(FrameStage::Reply,"NATIVE_HOST_REPLY"),(FrameStage::Stopped,"NATIVE_HOST_STOPPED")]{
            for (event,suffix) in [(Ok(Event::OutEnd),"EOF"),(Ok(Event::ReadError),"READ_ERROR"),(Ok(Event::OutputInvalid),"OUTPUT_INVALID"),(Err(RecvTimeoutError::Timeout),"TIMEOUT"),(Err(RecvTimeoutError::Disconnected),"CHANNEL_CLOSED")]{assert_eq!(frame_event(stage,event).unwrap_err(),format!("{prefix}_{suffix}"));}
            assert_eq!(frame_event(stage,Ok(Event::Line(vec![1,2,3]))).unwrap(),vec![1,2,3]);
        }
        assert_eq!(receipt("NATIVE_HOST_START_FAILED").child_exit_code,None);
    }
    #[test]fn review_requests_refuse_payload_authority_and_malformed_heads(){
        let expected=json!({"hostRevision":2,"headDigest":"a".repeat(64)});
        let cases=[("review-original-request",json!({"expected":expected,"originalDigest":"c".repeat(64)})),("recover-original-request",json!({"expected":expected,"originalDigest":"c".repeat(64)})),("review-proposal",json!({"expected":expected})),("recover-interrupted-request",json!({"expected":expected,"confirmationId":"confirmation-1"})),("inspect-recovery",json!({})),("recover-presentation",json!({})),("cancel-review",json!({"reviewRequestId":"review-1"}))];
        for (command,payload) in cases{
            let request=json!({"version":1,"requestId":"transport-1","command":command,"payload":payload});
            assert!(request_line(&request).is_ok());
            for key in ["actor","stateDirectory","executable","executionAuthorized","nativeGestureVerified","checkContract"]{let mut bad=request.clone();bad["payload"][key]=json!(true);assert!(request_line(&bad).is_err(),"accepted {command} override {key}");}
        }
        for expected in [json!({"hostRevision":0,"headDigest":"GENESIS"}),json!({"hostRevision":9007199254740992u64,"headDigest":"a".repeat(64)}),json!({"hostRevision":2,"headDigest":"bad"}),json!({"hostRevision":2,"headDigest":"a".repeat(64),"actor":"caller"})]{assert!(request_line(&json!({"version":1,"requestId":"transport-1","command":"review-proposal","payload":{"expected":expected}})).is_err());}
        for id in ["", "../foreign", "_not-a-token"]{assert!(request_line(&json!({"version":1,"requestId":"transport-1","command":"cancel-review","payload":{"reviewRequestId":id}})).is_err());}
    }
    #[test]fn prepared_review_request_is_bound_before_resource_access(){
        let expected=json!({"hostRevision":2,"headDigest":"a".repeat(64)});
        let selection=json!({"expected":expected,"contractHead":{"revision":3,"headDigest":"b".repeat(64)}});
        let root=std::env::current_dir().unwrap();
        let cfg=HostConfiguration{metadata_executable:root.join("absent.exe"),metadata_digest:"c".repeat(64),registry_root:root.clone(),state_directory:root.clone(),workspace_id:"fixture".into(),registry_revision:1,expected_binding:binding(),actor:"owner".into(),source:"test".into(),check_contract:None,check_profile_provision:None,prepared_check_selection:Some(selection.clone())};
        for command in ["review-proposal","recover-interrupted-request","review-original-request","recover-original-request"]{
            let mut request=json!({"version":1,"requestId":"review-1","command":command,"payload":{"expected":expected}});
            if command=="recover-interrupted-request"{request["payload"]["confirmationId"]=json!("confirmation-1");}
            if command.ends_with("original-request"){request["payload"]["originalDigest"]=json!("c".repeat(64));}
            assert!(selected_review_request(Some(&selection),&request).is_ok());
            for field in ["hostRevision","headDigest"]{
                let mut bad=request.clone();bad["payload"]["expected"][field]=if field=="hostRevision"{json!(3)}else{json!("d".repeat(64))};
                let refused=run_single(&root.join("absent-package"),&cfg,&bad);
                assert_eq!(refused.reason,"NATIVE_HOST_REVIEW_SELECTION_MISMATCH");
                assert!(!refused.request_may_have_committed&&!refused.execution_authorized);assert!(refused.child_exit_code.is_none());
            }
        }
        // Recovery inspection does not silently require a current proposal.
        assert!(selected_review_request(Some(&selection),&json!({"command":"inspect-recovery","payload":{}})).is_ok());
    }
    fn binding()->Binding{Binding{project_id:"project-1".into(),root_identity:"a".repeat(64),census_digest:"b".repeat(64)}}
    #[test]fn proposal_reads_admit_only_bounded_exact_payloads(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let good=[("read-proposal-brief",json!({"offset":0,"expectedHeadDigest":null})),("read-proposal-task",json!({"taskId":"T0001","offset":0,"expectedHeadDigest":"a".repeat(64)})),("read-proposal-request",json!({"requestId":"original-1"}))];
        for (command,payload) in good{
            let request=json!({"version":1,"requestId":"native-read","command":command,"payload":payload});
            assert!(request_line(&request).is_ok());
            for key in ["journalPath","stateDirectory","actor","executionAuthorized"]{let mut bad=request.clone();bad["payload"][key]=json!("injected");assert!(request_line(&bad).is_err());}
        }
        for (command,payload) in [
            ("read-proposal-brief",json!({"offset":1,"expectedHeadDigest":null})),
            ("read-proposal-brief",json!({"offset":501,"expectedHeadDigest":"GENESIS"})),
            ("read-proposal-task",json!({"taskId":"../../file","offset":0,"expectedHeadDigest":"a".repeat(64)})),
            ("read-proposal-task",json!({"taskId":"T0001","offset":-1,"expectedHeadDigest":"a".repeat(64)})),
            ("read-proposal-task",json!({"taskId":"T0001","offset":0,"expectedHeadDigest":null})),
            ("read-proposal-request",json!({"requestId":""})),
        ]{assert!(!proposal_read_payload(command,&payload));}
    }
    #[test]fn snapshot_requests_require_bounded_exact_head_pinned_continuations(){
        let request=|payload|json!({"version":1,"requestId":"snapshot-1","command":"read-proposal-snapshot","payload":payload});
        for payload in [json!({"offset":0,"expectedHeadDigest":null}),json!({"offset":2000,"expectedHeadDigest":"a".repeat(64)})]{assert!(request_line(&request(payload)).is_ok());}
        for payload in [json!({"offset":2000,"expectedHeadDigest":null}),json!({"offset":1048576,"expectedHeadDigest":"a".repeat(64)}),json!({"offset":-1,"expectedHeadDigest":null}),json!({"offset":0,"expectedHeadDigest":null,"path":"C:/foreign"})]{assert!(request_line(&request(payload)).is_err());}
    }
    #[test]fn result_read_request_accepts_only_exact_grant_id(){
        let grant="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
        let request=|payload|json!({"version":1,"requestId":"result-1","command":"inspect-task-result","payload":payload});
        assert!(request_line(&request(json!({"grantId":grant}))).is_ok());
        for payload in [json!({}),json!({"grantId":""}),json!({"grantId":"a".repeat(36)}),json!({"grantId":grant,"path":"C:/other"}),json!({"grantId":grant,"credentials":{}}),json!({"grantId":grant,"executionAuthorized":true})]{assert!(request_line(&request(payload)).is_err());}
    }
    #[test]fn result_index_request_is_bounded_and_head_pinned(){
        let request=|payload|json!({"version":1,"requestId":"index-1","command":"list-task-results","payload":payload});
        for p in [json!({"offset":0,"expectedHeadDigest":null}),json!({"offset":20,"expectedHeadDigest":"a".repeat(64)})]{assert!(request_line(&request(p)).is_ok());}
        for p in [json!({"offset":20,"expectedHeadDigest":null}),json!({"offset":2049,"expectedHeadDigest":"a".repeat(64)}),json!({"offset":0,"expectedHeadDigest":null,"projectId":"other"})]{assert!(request_line(&request(p)).is_err());}
    }
    #[test]
    #[ignore="Requires DANS1 current package and explicit isolated execution fixture"]
    fn actual_full_supervisor_execution_and_replay(){full_supervisor_fixture(false);}
    #[test]
    #[ignore="Requires DANS1 current package and explicit isolated failure/retry fixture"]
    fn actual_full_supervisor_failure_retry_preserves_both_attempts(){full_supervisor_fixture(true);}
    fn full_supervisor_fixture(failing:bool){
        use sha2::{Digest,Sha256};
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let out=PathBuf::from(std::env::var_os("PP_SUPERVISOR_EXECUTION_OUT").expect("fixture output"));
        std::fs::create_dir(&out).unwrap();
        let root=out.join("candidate");let state=out.join("state");let registry=out.join("registry");
        for p in [&root,&state,&registry]{std::fs::create_dir(p).unwrap();}
        std::fs::write(root.join("package.json"),serde_json::to_vec(&json!({"name":"inert-supervisor-fixture","version":"1.0.0","private":true,"scripts":{"test":"node fixture.cjs"}})).unwrap()).unwrap();
        std::fs::write(root.join("package-lock.json"),b"{\"name\":\"inert-supervisor-fixture\",\"version\":\"1.0.0\",\"lockfileVersion\":3,\"packages\":{}}").unwrap();
        std::fs::write(root.join("fixture.cjs"),b"setTimeout(()=>{const value=require('node:fs').readFileSync('input.txt','utf8');console.log('planner-supervisor-fixture:'+value);process.exitCode=value==='pass'?0:7},300);").unwrap();
        std::fs::write(root.join("input.txt"),if failing {b"fail"}else{b"pass"}).unwrap();
        let mut git=std::process::Command::new("C:/Program Files/Git/cmd/git.exe");
        #[cfg(windows)] {use std::os::windows::process::CommandExt;git.creation_flags(0x08000000);}
        assert!(git.args(["init","--quiet"]).current_dir(&root).status().unwrap().success());
        let registration=crate::workspace_census::register_qualification_workspace(&registry,serde_json::from_value(json!({"schemaVersion":1,"workspaceId":"supervisor-fixture","rootPath":root,"explicitUserApproval":true})).unwrap()).unwrap();
        let reg=serde_json::to_value(registration).unwrap();
        crate::workspace_census::census_and_retain(&registry,serde_json::from_value(json!({"schemaVersion":1,"workspaceId":"supervisor-fixture","registryRevision":reg["registryRevision"],"maxFiles":100,"maxFileBytes":1000000})).unwrap()).unwrap();
        let resource=PathBuf::from(std::env::var_os("PP_TEST_NATIVE_HOST_RESOURCE_ROOT").expect("resource"));let installed=crate::native_host_resources::verify_installed(&resource).unwrap();
        let exe=resource.join("perfect-planner-desktop.exe");let exe_digest=format!("{:x}",Sha256::digest(std::fs::read(&exe).unwrap()));
        let npm=PathBuf::from(std::env::var_os("PP_SUPERVISOR_NPM_CLI").expect("npm"));let npm_digest=format!("{:x}",Sha256::digest(std::fs::read(&npm).unwrap()));
        let initial=json!({"packageConfig":{"packageRoot":installed.package_root,"manifestDigest":installed.manifest_digest},"metadataConfig":{"executable":exe,"executableDigest":exe_digest,"registryRoot":registry,"workspaceId":"supervisor-fixture","registryRevision":reg["registryRevision"],"rootIdentity":reg["rootIdentity"]},"stateDirectory":state,"actor":"qualification-runner","source":"scripted-inert-fixture-not-human-consent","checkProfileProvision":{"profileId":"npm-project-checks-v1","registeredRoot":root,"npmCli":{"path":npm,"sha256":npm_digest},"assignments":[{"taskId":"T0001","categories":["tests"]}]}});
        let config_file=out.join("config.json");std::fs::write(&config_file,serde_json::to_vec_pretty(&initial).unwrap()).unwrap();
        let mut node=std::process::Command::new(resource.join("native-review-host/runtime/node.exe"));
        #[cfg(windows)] {use std::os::windows::process::CommandExt;node.creation_flags(0x08000000);}
        let prepared=node.arg(std::env::var_os("PP_SUPERVISOR_PREPARE_SCRIPT").expect("prepare script")).arg(&config_file).output().unwrap();
        std::fs::write(out.join("prepare.out.log"),&prepared.stdout).unwrap();std::fs::write(out.join("prepare.err.log"),&prepared.stderr).unwrap();assert!(prepared.status.success(),"fixture preparation failed");
        let v:Value=serde_json::from_slice(&std::fs::read(&config_file).unwrap()).unwrap();let m=&v["metadataConfig"];let text=|v:&Value|v.as_str().unwrap().to_owned();
        let config=HostConfiguration{metadata_executable:exe,metadata_digest:exe_digest,registry_root:registry,state_directory:state.clone(),workspace_id:"supervisor-fixture".into(),registry_revision:m["registryRevision"].as_u64().unwrap().try_into().unwrap(),expected_binding:serde_json::from_value(v["expectedBinding"].clone()).unwrap(),actor:text(&v["actor"]),source:text(&v["source"]),check_contract:None,check_profile_provision:Some(v["checkProfileProvision"].clone()),prepared_check_selection:Some(v["preparedCheckSelection"].clone())};
        let mut receipts=Vec::new();let mut original=Value::Null;
        for (index,command) in ["execute-check","execute-check","recover-check-execution"].iter().enumerate(){
            let proof=run_single(&resource,&config,&json!({"version":1,"requestId":format!("full-supervisor-{index}"),"command":command,"payload":v["executionRequest"]}));
            receipts.push(serde_json::to_value(&proof).unwrap());std::fs::write(out.join("supervisor-receipts.json"),serde_json::to_vec_pretty(&receipts).unwrap()).unwrap();
            assert_eq!(proof.reason,"NATIVE_HOST_REQUEST_FINISHED","{proof:?}");assert!(proof.cleanup_complete&&proof.process_exited&&proof.descendants_settled&&proof.io_settled);
            let reply=proof.reply.unwrap();assert_eq!(reply["ok"],true,"{reply:?}");assert_eq!(reply["result"]["state"],"result-recorded");
            if index==0 {original=reply["result"].clone();}else{assert_eq!(reply["result"],original);}
        }
        let journal=std::fs::read_to_string(state.join(format!("{}.execution-grants.jsonl",config.expected_binding.project_id))).unwrap();assert_eq!(journal.lines().count(),4);
        let proof=run_single(&resource,&config,&json!({"version":1,"requestId":"full-supervisor-result","command":"inspect-task-result","payload":{"grantId":original["grantId"]}}));
        receipts.push(serde_json::to_value(&proof).unwrap());std::fs::write(out.join("supervisor-receipts.json"),serde_json::to_vec_pretty(&receipts).unwrap()).unwrap();
        assert_eq!(proof.reason,"NATIVE_HOST_REQUEST_FINISHED","{proof:?}");assert!(proof.cleanup_complete);let reply=proof.reply.unwrap();assert_eq!(reply["ok"],true,"{reply:?}");assert_eq!(reply["result"]["exitCode"],if failing {7}else{0},"{reply:?}");assert_eq!(reply["result"]["journalLinked"],true);assert_eq!(reply["result"]["state"],if failing {"failure-observed"}else{"result-unverified"});assert_eq!(reply["result"]["authorityVerified"],false);assert_eq!(reply["result"]["cleanup"],"unknown");assert_eq!(reply["result"]["grantId"],original["grantId"]);assert_eq!(reply["result"]["runId"],original["runId"]);assert_eq!(reply["result"]["artifactDigest"],original["artifactDigest"]);
        if failing {
            std::fs::write(root.join("input.txt"),b"pass").unwrap();
            let mut retry=v["executionRequest"].clone();retry["requestId"]=json!("supervisor-inert-retry");retry["attemptId"]=json!("supervisor-inert-attempt-2");retry["attemptNumber"]=json!(2);
            let mut call=|id:&str,command:&str,payload:Value|{
                let proof=run_single(&resource,&config,&json!({"version":1,"requestId":id,"command":command,"payload":payload}));
                receipts.push(serde_json::to_value(&proof).unwrap());std::fs::write(out.join("supervisor-receipts.json"),serde_json::to_vec_pretty(&receipts).unwrap()).unwrap();
                assert_eq!(proof.reason,"NATIVE_HOST_REQUEST_FINISHED","{proof:?}");assert!(proof.cleanup_complete&&proof.process_exited&&proof.descendants_settled&&proof.io_settled);
                let reply=proof.reply.unwrap();assert_eq!(reply["ok"],true,"{reply:?}");reply["result"].clone()
            };
            let second=call("retry-transport","execute-check",retry.clone());assert_eq!(second["state"],"result-recorded");assert_ne!(second["grantId"],original["grantId"]);assert_ne!(second["runId"],original["runId"]);
            for (id,payload,wanted) in [("replay-first",v["executionRequest"].clone(),original.clone()),("replay-second",retry,second.clone())]{assert_eq!(call(id,"execute-check",payload.clone()),wanted);assert_eq!(call(&format!("recover-{id}"),"recover-check-execution",payload),wanted);}
            let page=call("both-outcomes","read-task-result-page",json!({"offset":0,"expectedHeadDigest":null}));
            let entries=page["page"]["entries"].as_array().unwrap();assert_eq!(entries.len(),2);
            let outcomes=page["outcomes"].as_array().unwrap();assert_eq!(outcomes.len(),2);
            for (receipt,number,exit,status) in [(&original,1,7,"failure-observed"),(&second,2,0,"result-unverified")]{
                let row=outcomes.iter().find(|row|row["grantId"]==receipt["grantId"]).expect("retained attempt");assert_eq!(row["phase"],"ready");let result=&row["value"];
                assert_eq!(result["attemptNumber"],number);assert_eq!(result["exitCode"],exit);assert_eq!(result["state"],status);assert_eq!(result["artifactDigest"],receipt["artifactDigest"]);assert_eq!(result["authorityVerified"],false);
            }
            let after=std::fs::read_to_string(state.join(format!("{}.execution-grants.jsonl",config.expected_binding.project_id))).unwrap();assert!(after.starts_with(&journal));assert_eq!(after.lines().count(),8);
            let records:Vec<Value>=after.lines().map(|line|serde_json::from_str(line).unwrap()).collect();assert_ne!(records[0]["grant"]["binding"]["candidateDigest"],records[4]["grant"]["binding"]["candidateDigest"]);
        }
    }
    #[test]fn execution_budget_covers_all_candidate_observations_and_check(){
        // issue, consume, intent; the conversation includes guarded capture.
        let capture_budget=Duration::from_secs(3*120);
        let check_budget=Duration::from_secs(300+255);
        let settlement_budget=Duration::from_secs(60);
        assert!(request_timeout(&json!({"command":"execute-check"}))>=capture_budget+check_budget+settlement_budget);
        assert_eq!(request_timeout(&json!({"command":"recover-check-execution"})),Duration::from_secs(150));
    }
    #[test]fn execution_requires_exact_selected_heads_and_no_caller_authority(){
        let selection=json!({"expected":{"hostRevision":1,"headDigest":"a".repeat(64)},"contractHead":{"revision":2,"headDigest":"b".repeat(64)}});
        let payload=json!({"requestId":"original-1","expected":selection["expected"],"contractHead":selection["contractHead"],"confirmationId":"approved-1","taskId":"T0001","checkId":"tests","attemptId":"attempt-1","attemptNumber":1});
        for command in ["execute-check","recover-check-execution"]{
            let request=json!({"version":1,"requestId":"transport-1","command":command,"payload":payload});
            assert!(request_line(&request).is_ok());assert!(selected_review_request(Some(&selection),&request).is_ok());assert!(selected_review_request(None,&request).is_err());
            for key in ["expected","contractHead"]{let mut changed=selection.clone();changed[key]["headDigest"]=json!("c".repeat(64));assert!(selected_review_request(Some(&changed),&request).is_err());}
            for key in ["credentials","executable","actor","executionAuthorized","workerId"]{let mut bad=request.clone();bad["payload"][key]=json!("caller");assert!(request_line(&bad).is_err());}
            for id in ["T0000","T00001","T1","T1000000","../foreign"]{let mut bad=request.clone();bad["payload"]["taskId"]=json!(id);assert!(request_line(&bad).is_err());}
            for n in [0u64,9_007_199_254_740_992]{let mut bad=request.clone();bad["payload"]["attemptNumber"]=json!(n);assert!(request_line(&bad).is_err());}
            assert_eq!(request_timeout(&request),Duration::from_secs(if command=="execute-check"{975}else{150}));
        }
        assert_eq!(request_timeout(&json!({"command":"review-proposal"})),Duration::from_secs(150));
    }
    #[test]fn request_refuses_authority_and_unknown_command(){let mut r=json!({"version":1,"requestId":"request-1","command":"inspect-proposal","payload":{}});assert!(request_line(&r).is_ok());r["actor"]=json!("caller");assert!(request_line(&r).is_err());r.as_object_mut().unwrap().remove("actor");r["command"]=json!("execute");assert!(request_line(&r).is_err());}
    #[test]fn prepared_native_configuration_preserves_exact_selection_and_refuses_overrides(){
        let root=std::env::current_dir().unwrap();
        let provision=json!({"profileId":"perfect-planner-checks-v1","registeredRoot":root,"npmCli":{"path":root.join("npm-cli.js"),"sha256":"a".repeat(64)},"assignments":[{"taskId":"T0001","categories":["tests","secrets"]}]});
        let selected=json!({"expected":{"hostRevision":2,"headDigest":"b".repeat(64)},"contractHead":{"revision":3,"headDigest":"c".repeat(64)}});
        let valid=check_configuration(None,Some(&provision),Some(&selected)).unwrap();
        assert_eq!(valid["checkProfileProvision"],provision);assert_eq!(valid["preparedCheckSelection"],selected);
        let mut generic=provision.clone();generic["profileId"]=json!("npm-project-checks-v1");assert_eq!(check_configuration(None,Some(&generic),Some(&selected)).unwrap()["checkProfileProvision"],generic);
        generic["profileId"]=json!("arbitrary-shell");assert!(check_configuration(None,Some(&generic),Some(&selected)).is_err());
        assert!(check_configuration(None,None,Some(&selected)).is_err());
        assert!(check_configuration(Some(&json!({})),Some(&provision),Some(&selected)).is_err());
        for patch in [json!({"expected":{"hostRevision":0,"headDigest":"GENESIS"},"contractHead":selected["contractHead"]}),json!({"expected":selected["expected"],"contractHead":{"revision":3,"headDigest":"bad"}}),json!({"expected":selected["expected"],"contractHead":selected["contractHead"],"executionAuthorized":true})]{assert!(check_configuration(None,Some(&provision),Some(&patch)).is_err());}
        let mut bad=provision.clone();bad["assignments"][0]["categories"]=json!(["deploy"]);assert!(check_configuration(None,Some(&bad),None).is_err());
        bad=provision.clone();bad["registeredRoot"]=json!("relative");assert!(check_configuration(None,Some(&bad),None).is_err());
        bad=provision.clone();bad["actor"]=json!("renderer");assert!(check_configuration(None,Some(&bad),None).is_err());
        assert_eq!(check_configuration(None,None,None).unwrap(),json!({}));
    }
    #[test]fn prepare_request_cannot_provision_paths_or_authority(){
        let mut request=json!({"version":1,"requestId":"transport-1","command":"prepare-checks","payload":{"expected":{"hostRevision":1,"headDigest":"a".repeat(64)},"request":{"requestId":"prepare-1","expectedRevision":0,"expectedHeadDigest":"GENESIS"}}});
        assert!(request_line(&request).is_ok());
        request["payload"]["registeredRoot"]=json!("C:/foreign");assert!(request_line(&request).is_err());request["payload"].as_object_mut().unwrap().remove("registeredRoot");
        request["payload"]["request"]["expectedRevision"]=json!(-1);assert!(request_line(&request).is_err());
    }
    #[test]fn ready_requires_exact_binding_pin_and_no_grant(){let mut v=json!({"version":1,"kind":"NATIVE_REVIEW_HOST_READY","binding":binding(),"packageManifestDigest":"c".repeat(64),"executionAuthorized":false});assert!(ready(&serde_json::to_vec(&v).unwrap(),&binding(),&"c".repeat(64)));v["binding"]["censusDigest"]=json!("d".repeat(64));assert!(!ready(&serde_json::to_vec(&v).unwrap(),&binding(),&"c".repeat(64)));}
    #[test]fn stopped_uncertainty_cannot_be_clean(){let v=json!({"version":1,"kind":"NATIVE_REVIEW_HOST_STOPPED","reason":"STREAM_EOF","startupSettled":true,"dispatchesSettled":false,"shutdownSettled":true,"outputSettled":true,"cleanupComplete":true,"dialogClosed":null,"executionAuthorized":false});assert!(!stopped(&serde_json::to_vec(&v).unwrap()).unwrap().1);}
    #[test]fn stopped_missing_closure_field_is_refused(){let v=json!({"version":1,"kind":"NATIVE_REVIEW_HOST_STOPPED","reason":"STREAM_EOF","startupSettled":true,"dispatchesSettled":true,"shutdownSettled":true,"outputSettled":true,"cleanupComplete":true,"executionAuthorized":false});assert!(stopped(&serde_json::to_vec(&v).unwrap()).is_err());}
    #[test]fn reply_requires_matching_request_and_false_authority(){let mut v=json!({"version":1,"requestId":"r1","ok":true,"result":{},"executionAuthorized":false,"nativeGestureVerified":false});assert!(reply(&serde_json::to_vec(&v).unwrap(),&json!("r1")).is_ok());assert!(reply(&serde_json::to_vec(&v).unwrap(),&json!("r2")).is_err());v["executionAuthorized"]=json!(true);assert!(reply(&serde_json::to_vec(&v).unwrap(),&json!("r1")).is_err());}
    #[test]fn reply_preserves_cleanup_uncertainty(){let v=json!({"version":1,"requestId":"r1","ok":false,"error":{"code":"NATIVE_REVIEW_CLEANUP_UNCERTAIN"},"cleanupComplete":false,"executionAuthorized":false,"nativeGestureVerified":false});assert_eq!(reply(&serde_json::to_vec(&v).unwrap(),&json!("r1")).unwrap()["cleanupComplete"],false);}
    #[test]fn duplicate_reply_envelope_is_refused(){assert!(reply(br#"{"version":1,"version":1,"requestId":"r1","ok":true,"result":{},"executionAuthorized":false,"nativeGestureVerified":false}"#,&json!("r1")).is_err());}
    #[test]
    #[ignore = "Requires fresh DANS1 packaged host, native census and large submitted plan"]
    fn actual_packaged_large_snapshot(){
        use sha2::{Digest,Sha256};
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let bytes=std::fs::read(std::env::var_os("PP_TEST_NATIVE_HOST_SUPERVISOR_CONFIG").expect("explicit fixture required")).unwrap();
        let v:Value=serde_json::from_slice(&bytes).unwrap();let m=&v["metadataConfig"];
        let text=|value:&Value|value.as_str().expect("fixture string").to_owned();
        let config=HostConfiguration{metadata_executable:PathBuf::from(text(&m["executable"])),metadata_digest:text(&m["executableDigest"]),registry_root:PathBuf::from(text(&m["registryRoot"])),state_directory:PathBuf::from(text(&v["stateDirectory"])),workspace_id:text(&m["workspaceId"]),registry_revision:u32::try_from(m["registryRevision"].as_u64().unwrap()).unwrap(),expected_binding:serde_json::from_value(v["expectedBinding"].clone()).unwrap(),actor:text(&v["actor"]),source:text(&v["source"]),check_contract:None,check_profile_provision:None,prepared_check_selection:None};
        let resource=PathBuf::from(std::env::var_os("PP_TEST_NATIVE_HOST_RESOURCE_ROOT").expect("resource required"));
        let expected=std::fs::read(std::env::var_os("PP_TEST_NATIVE_HOST_EXPECTED_LEDGER").expect("expected ledger required")).unwrap();
        assert!(expected.len()>850000&&expected.len()<=1024*1024);
        let proof=run_single(&resource,&config,&json!({"version":1,"requestId":"native-large-snapshot-363","command":"read-proposal-snapshot","payload":{"offset":0,"expectedHeadDigest":null}}));
        let path=std::env::var_os("PP_TEST_NATIVE_HOST_SUPERVISOR_RECEIPT").expect("receipt required");
        use std::io::Write;let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(path).unwrap();file.write_all(&serde_json::to_vec_pretty(&proof).unwrap()).unwrap();file.sync_all().unwrap();
        assert_eq!(proof.reason,"NATIVE_HOST_REQUEST_FINISHED","{proof:?}");
        assert!(proof.process_exited&&proof.descendants_settled&&proof.io_settled&&proof.cleanup_complete);
        let reply=proof.reply.unwrap();assert_eq!(reply["ok"],true);let value=&reply["result"];
        assert_eq!(value["binding"],serde_json::to_value(&config.expected_binding).unwrap());
        assert_eq!(value["nextOffset"],Value::Null);assert_eq!(value["offset"],0);
        let wire=value["chunk"].as_str().unwrap();assert!(wire.as_bytes()==expected.as_slice(),"Snapshot differs from exact canonical submitted ledger");
        assert_eq!(value["snapshotDigest"],format!("{:x}",Sha256::digest(wire.as_bytes())));
        assert_eq!(value["executionAuthorized"],false);assert_eq!(value["approvalState"],"unapproved-proposal");
    }
    #[test] #[ignore="Requires explicit DANS1 installed supervisor fixture"] fn actual_installed_supervisor_fixture(){
        let fixture=std::env::var_os("PP_TEST_NATIVE_HOST_SUPERVISOR_CONFIG").expect("explicit supervisor fixture required");
        let bytes=std::fs::read(fixture).expect("supervisor fixture must be readable");assert!(bytes.len()<=65536);
        let v:Value=serde_json::from_slice(&bytes).expect("supervisor fixture JSON");
        let text=|value:&Value|value.as_str().expect("fixture string").to_owned();
        let m=&v["metadataConfig"];
        let config=HostConfiguration{metadata_executable:PathBuf::from(text(&m["executable"])),metadata_digest:text(&m["executableDigest"]),registry_root:PathBuf::from(text(&m["registryRoot"])),state_directory:PathBuf::from(text(&v["stateDirectory"])),workspace_id:text(&m["workspaceId"]),registry_revision:u32::try_from(m["registryRevision"].as_u64().expect("revision")).expect("bounded revision"),expected_binding:serde_json::from_value(v["expectedBinding"].clone()).expect("expected binding"),actor:text(&v["actor"]),source:text(&v["source"]),check_contract:v.get("checkContract").cloned(),check_profile_provision:v.get("checkProfileProvision").cloned(),prepared_check_selection:v.get("preparedCheckSelection").cloned()};
        let resource=PathBuf::from(std::env::var_os("PP_TEST_NATIVE_HOST_RESOURCE_ROOT").expect("resource fixture required"));
        let proof=run_single(&resource,&config,&json!({"version":1,"requestId":"native-supervisor-inspect-174","command":"inspect-proposal","payload":{}}));
        if let Some(path)=std::env::var_os("PP_TEST_NATIVE_HOST_SUPERVISOR_RECEIPT"){use std::io::Write;let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(path).expect("fresh proof destination");file.write_all(&serde_json::to_vec_pretty(&proof).unwrap()).unwrap();file.sync_all().unwrap();}
        assert_eq!(proof.reason,"NATIVE_HOST_REQUEST_FINISHED","{proof:?}");assert!(proof.process_exited&&proof.descendants_settled&&proof.io_settled&&proof.cleanup_complete,"{proof:?}");assert_eq!(proof.reply.as_ref().unwrap()["ok"],true);assert!(!proof.execution_authorized&&!proof.pre_execution_containment);
    }
    #[test]fn check_inspection_has_exact_read_only_payload(){
        for request_id in [Value::Null,json!("prepare-1")]{assert!(request_line(&json!({"version":1,"requestId":"inspect-1","command":"inspect-checks","payload":{"requestId":request_id}})).is_ok());}
        for payload in [json!({}),json!({"requestId":"../foreign"}),json!({"requestId":null,"path":"private"}),json!({"requestId":4})]{assert!(request_line(&json!({"version":1,"requestId":"inspect-1","command":"inspect-checks","payload":payload})).is_err());}
    }
    #[test]
    #[ignore = "Requires explicit DANS1 prepared-check package fixture"]
    fn actual_prepared_selection_supervisor(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let bytes=std::fs::read(std::env::var_os("PP_TEST_NATIVE_HOST_SUPERVISOR_CONFIG").expect("fixture required")).unwrap();assert!(bytes.len()<=65536);
        let v:Value=serde_json::from_slice(&bytes).unwrap();let m=&v["metadataConfig"];
        let text=|x:&Value|x.as_str().expect("fixture string").to_owned();
        let mut config=HostConfiguration{metadata_executable:PathBuf::from(text(&m["executable"])),metadata_digest:text(&m["executableDigest"]),registry_root:PathBuf::from(text(&m["registryRoot"])),state_directory:PathBuf::from(text(&v["stateDirectory"])),workspace_id:text(&m["workspaceId"]),registry_revision:u32::try_from(m["registryRevision"].as_u64().unwrap()).unwrap(),expected_binding:serde_json::from_value(v["expectedBinding"].clone()).unwrap(),actor:text(&v["actor"]),source:text(&v["source"]),check_contract:None,check_profile_provision:Some(v["checkProfileProvision"].clone()),prepared_check_selection:None};
        let resource=PathBuf::from(std::env::var_os("PP_TEST_NATIVE_HOST_RESOURCE_ROOT").expect("package required"));
        let prepare=run_single(&resource,&config,&json!({"version":1,"requestId":"native-prepare-393","command":"prepare-checks","payload":v["preparePayload"]}));
        let mut proofs=vec![serde_json::to_value(&prepare).unwrap()];
        let result=(||{
            assert_eq!(prepare.reason,"NATIVE_HOST_REQUEST_FINISHED","{prepare:?}");assert!(prepare.cleanup_complete&&prepare.process_exited&&prepare.descendants_settled&&prepare.io_settled);
            let reply=prepare.reply.as_ref().unwrap();assert_eq!(reply["ok"],true,"{reply:?}");assert_eq!(reply["result"]["preparationPersisted"],true);assert_eq!(reply["result"]["reviewEnabled"],false);
            config.prepared_check_selection=Some(json!({"expected":v["preparePayload"]["expected"],"contractHead":reply["result"]["contractHead"]}));
            let inspect=run_single(&resource,&config,&json!({"version":1,"requestId":"native-selected-393","command":"inspect-proposal","payload":{}}));
            proofs.push(serde_json::to_value(&inspect).unwrap());
            assert_eq!(inspect.reason,"NATIVE_HOST_REQUEST_FINISHED","{inspect:?}");assert!(inspect.cleanup_complete&&inspect.process_exited&&inspect.descendants_settled&&inspect.io_settled);
            assert_eq!(inspect.reply.as_ref().unwrap()["ok"],true);assert_eq!(inspect.reply.as_ref().unwrap()["result"]["observedHead"],v["preparePayload"]["expected"]);
            assert!(!prepare.execution_authorized&&!inspect.execution_authorized);
        });
        // Retain failures as evidence before resuming the assertion panic.
        let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(result));
        let output=std::env::var_os("PP_TEST_NATIVE_HOST_SUPERVISOR_RECEIPT").expect("receipt required");
        use std::io::Write;let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(output).unwrap();file.write_all(&serde_json::to_vec_pretty(&proofs).unwrap()).unwrap();file.sync_all().unwrap();
        if let Err(error)=outcome{std::panic::resume_unwind(error);}
    }
}










