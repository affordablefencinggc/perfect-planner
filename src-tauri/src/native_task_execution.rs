//! Private adapter after durable host admission. No renderer/MCP endpoint and
//! no independent grant authority. Candidate observation remains the host's job.
#![allow(dead_code)]
use serde::Deserialize;
use serde_json::{json,Value};
use std::{ffi::OsStr,path::PathBuf,sync::atomic::AtomicBool,time::Duration};

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Limits{stdout_bytes:usize,stderr_bytes:usize,combined_bytes:usize}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Spec{
    run_id:String,intent_digest:String,registered_root:PathBuf,cwd:PathBuf,
    executable_path:PathBuf,executable_digest:String,args:Vec<String>,timeout_ms:u64,
    output_limits:Limits,candidate_digest:String,check_contract_digest:String,
}
fn digest(s:&str)->bool{s.len()==64&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn parse(value:&Value)->Result<Spec,&'static str>{
    if serde_json::to_vec(value).map_err(|_|"NATIVE_TASK_SPEC_INVALID")?.len()>65536{return Err("NATIVE_TASK_SPEC_INVALID");}
    let s:Spec=serde_json::from_value(value.clone()).map_err(|_|"NATIVE_TASK_SPEC_INVALID")?;
    let l=&s.output_limits;
    if s.run_id.is_empty()||s.run_id.len()>128||!s.run_id.bytes().all(|b|b.is_ascii_alphanumeric()||b"._:-".contains(&b))
        ||![&s.intent_digest,&s.executable_digest,&s.candidate_digest,&s.check_contract_digest].iter().all(|s|digest(s))
        ||s.timeout_ms==0||s.timeout_ms>300000||[l.stdout_bytes,l.stderr_bytes,l.combined_bytes].iter().any(|n|*n==0||*n>2*1024*1024)
        ||l.combined_bytes>l.stdout_bytes+l.stderr_bytes||s.args.len()>64||s.args.iter().map(|a|a.len()).sum::<usize>()>32768
        ||s.args.iter().any(|a|a.len()>16384||a.chars().any(|c|c.is_control()))
        ||[&s.registered_root,&s.cwd,&s.executable_path].iter().any(|p|!p.is_absolute()||p.as_os_str().len()>4096){return Err("NATIVE_TASK_SPEC_INVALID");}
    Ok(s)
}
// Local process plumbing for the installed host, not an authenticated public
// endpoint. The caller owns approval, enrollment and the durable first intent.
// Bounded parent containment owns disconnect/cancellation of this whole tree.
pub fn run_stdio_if_requested()->Option<i32>{
    use std::io::{Read,Write};
    let args:Vec<_>=std::env::args_os().collect();
    if args.get(1).and_then(|s|s.to_str())==Some("--planner-task-custody-stdio"){return Some(if args.len()==2&&run_custody_stdio().is_ok(){0}else{2});}
    if args.get(1).and_then(|s|s.to_str())!=Some("--planner-task-stdio"){return None;}
    if args.len()!=2{return Some(2);}
    let result=(||{
        let mut bytes=Vec::new();std::io::stdin().take(65537).read_to_end(&mut bytes).map_err(|_|())?;
        if bytes.is_empty()||bytes.len()>65536{return Err(());}
        #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
        struct Envelope{schema_version:u32,execution_spec:Value,expires_at_ms:u64}
        let envelope:Envelope=serde_json::from_slice(&bytes).map_err(|_|())?;
        if envelope.schema_version!=1||envelope.expires_at_ms>9_007_199_254_740_991{return Err(());}
        let value=envelope.execution_spec;let spec=parse(&value).map_err(|_|())?;
        let system=std::env::var("SystemRoot").map_err(|_|())?;
        let path=format!("{};{}\\System32",spec.executable_path.parent().and_then(|p|p.to_str()).ok_or(())?,system);
        let mut environment=vec![("SystemRoot".to_owned(),system.clone()),("WINDIR".to_owned(),system),("PATH".to_owned(),path)];
        for key in ["TEMP","TMP"]{if let Ok(value)=std::env::var(key){environment.push((key.to_owned(),value));}}
        let borrowed:Vec<(&str,&str)>=environment.iter().map(|(k,v)|(k.as_str(),v.as_str())).collect();
        let observation=execute_until(&value,&borrowed,&AtomicBool::new(false),Some(envelope.expires_at_ms)).map_err(|_|())?;
        let mut output=serde_json::to_vec(&observation).map_err(|_|())?;output.push(b'\n');
        std::io::stdout().write_all(&output).and_then(|_|std::io::stdout().flush()).map_err(|_|())
    })();
    Some(if result.is_ok(){0}else{2})
}
pub(crate) fn execute(value:&Value,environment:&[(&str,&str)],cancel:&AtomicBool)->Result<Value,&'static str>{
    execute_until(value,environment,cancel,None)
}
fn execute_until(value:&Value,environment:&[(&str,&str)],cancel:&AtomicBool,expires_at:Option<u64>)->Result<Value,&'static str>{
    execute_with_custody(value,environment,cancel,expires_at,None)
}
type Exchange<'a>=dyn FnMut(&str,&Value)->Result<Option<String>,&'static str>+'a;
fn execute_with_custody(value:&Value,environment:&[(&str,&str)],cancel:&AtomicBool,expires_at:Option<u64>,mut exchange:Option<&mut Exchange<'_>>)->Result<Value,&'static str>{
    let s=parse(value)?;
    let _pins=crate::native_host_resources::pin_task_files(&s.executable_path,&s.executable_digest,&s.registered_root,&s.cwd)?;
    let candidate=crate::native_candidate_guard::CandidateGuard::acquire(&s.registered_root,cancel)?;
    if let Some(exchange)=exchange.as_mut(){exchange("ready",&Value::Null)?;candidate.validate()?;}
    if let Some(deadline)=expires_at{
        let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"NATIVE_TASK_CLOCK_INVALID")?.as_millis();
        if now>=deadline as u128{return Err("NATIVE_TASK_GRANT_EXPIRED");}
    }
    let args:Vec<&OsStr>=s.args.iter().map(|s|OsStr::new(s)).collect();
    let run=crate::native_task_containment::run_captured_limits(&s.executable_path,&args,&s.cwd,environment,
        Duration::from_millis(s.timeout_ms),s.output_limits.stdout_bytes,s.output_limits.stderr_bytes,s.output_limits.combined_bytes,
        Duration::from_secs(120),cancel).map_err(|_|"NATIVE_TASK_RUN_UNRESOLVED")?;
    if !run.settlement.process_exited||!run.settlement.job_empty_observed||!run.settlement.descendants_settled||!run.io_settled||run.io_failed{
        // Single-use stdio host: retain protection until host termination and
        // enclosing Job cleanup when descendant/I/O settlement is unknown.
        std::mem::forget(candidate);return Err("NATIVE_TASK_RUN_UNRESOLVED");
    }
    // Refuse undecodable output rather than silently rewriting evidence or
    // expanding replacement characters beyond the reviewed byte budget.
    let stdout=String::from_utf8(run.stdout).map_err(|_|"NATIVE_TASK_OUTPUT_ENCODING_INVALID")?;
    let stderr=String::from_utf8(run.stderr).map_err(|_|"NATIVE_TASK_OUTPUT_ENCODING_INVALID")?;
    let observation=json!({"schemaVersion":2,"kind":"NATIVE_TASK_OBSERVATION","runId":s.run_id,"exitCode":run.settlement.exit_code,
        "timedOut":run.timed_out,"cancelObserved":run.cancel_observed,"outputTruncated":run.output_truncated,
        "cpuTimeExceeded":run.cpu_time_exceeded,"cpuObservationFailed":run.cpu_observation_failed,
        "descendantsSettled":run.settlement.descendants_settled,"processExited":run.settlement.process_exited,"jobEmptyObserved":run.settlement.job_empty_observed,
        "ioSettled":run.io_settled,"ioFailed":run.io_failed,"stdout":stdout,"stderr":stderr});
    let artifact=if let Some(exchange)=exchange.as_mut(){candidate.validate()?;Some(exchange("observation",&observation)?.ok_or("NATIVE_TASK_RETAINED_ACK_INVALID")?)}else{None};
    candidate.finish()?;
    if let (Some(exchange),Some(artifact))=(exchange.as_mut(),artifact){exchange("finalized",&json!(artifact))?;}
    Ok(observation)
}

// The bounded parent owns deadlines and kill-on-close containment for this
// single-use process. No check starts until the guarded snapshot is confirmed.
fn run_custody_stdio()->Result<(),&'static str>{
 use std::io::{BufRead,Read,Write};
 fn frame(reader:&mut impl BufRead)->Result<Value,&'static str>{
  let mut bytes=Vec::new();
  loop{let available=reader.fill_buf().map_err(|_|"NATIVE_TASK_PROTOCOL_IO")?;if available.is_empty(){return Err("NATIVE_TASK_PROTOCOL_EOF");}
   let n=available.iter().position(|b|*b==b'\n').map(|i|i+1).unwrap_or(available.len());
   if bytes.len()+n>65536{return Err("NATIVE_TASK_PROTOCOL_LIMIT");}bytes.extend_from_slice(&available[..n]);reader.consume(n);if bytes.last()==Some(&b'\n'){break;}
  }
  serde_json::from_slice(&bytes).map_err(|_|"NATIVE_TASK_PROTOCOL_INVALID")
 }
 fn send(value:&Value)->Result<(),&'static str>{let mut bytes=serde_json::to_vec(value).map_err(|_|"NATIVE_TASK_PROTOCOL_INVALID")?;bytes.push(b'\n');std::io::stdout().write_all(&bytes).and_then(|_|std::io::stdout().flush()).map_err(|_|"NATIVE_TASK_PROTOCOL_IO")}
 #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
 struct Envelope{schema_version:u32,execution_spec:Value,expires_at_ms:u64}
 let mut reader=std::io::BufReader::new(std::io::stdin());
 let envelope:Envelope=serde_json::from_value(frame(&mut reader)?).map_err(|_|"NATIVE_TASK_PROTOCOL_INVALID")?;
 if envelope.schema_version!=2||envelope.expires_at_ms>9_007_199_254_740_991{return Err("NATIVE_TASK_PROTOCOL_INVALID");}
 let spec=parse(&envelope.execution_spec)?;
 let base=json!({"schemaVersion":2,"runId":spec.run_id,"intentDigest":spec.intent_digest,"candidateDigest":spec.candidate_digest,"checkContractDigest":spec.check_contract_digest,"executionAuthorized":false});
 let system=std::env::var("SystemRoot").map_err(|_|"NATIVE_TASK_ENVIRONMENT_INVALID")?;
 let search=format!("{};{}\\System32",spec.executable_path.parent().and_then(|p|p.to_str()).ok_or("NATIVE_TASK_ENVIRONMENT_INVALID")?,system);
 let mut environment=vec![("SystemRoot".to_owned(),system.clone()),("WINDIR".to_owned(),system),("PATH".to_owned(),search)];
 for key in ["TEMP","TMP"]{if let Ok(value)=std::env::var(key){environment.push((key.to_owned(),value));}}
 let borrowed:Vec<(&str,&str)>=environment.iter().map(|(k,v)|(k.as_str(),v.as_str())).collect();
 let mut exchange=|phase:&str,payload:&Value|{
  let mut outgoing=base.clone();outgoing["kind"]=json!(match phase{"ready"=>"NATIVE_TASK_GUARD_READY","observation"=>"NATIVE_TASK_OBSERVATION_READY",_=>"NATIVE_TASK_GUARD_FINALIZED"});
  if phase=="observation"{outgoing["observation"]=payload.clone();}if phase=="finalized"{outgoing["artifactDigest"]=payload.clone();}
  send(&outgoing)?;if phase=="finalized"{return Ok(None);}
  let reply=frame(&mut reader)?;let mut expected=base.clone();expected["kind"]=json!(if phase=="ready"{"NATIVE_TASK_CANDIDATE_CONFIRMED"}else{"NATIVE_TASK_OUTPUT_RETAINED"});
  let artifact=if phase=="observation"{let artifact=reply["artifactDigest"].as_str().filter(|v|digest(v)).ok_or("NATIVE_TASK_RETAINED_ACK_INVALID")?.to_owned();expected["artifactDigest"]=json!(artifact);Some(artifact)}else{None};
  if reply!=expected{return Err("NATIVE_TASK_PROTOCOL_BINDING");}Ok(artifact)
 };
 execute_with_custody(&envelope.execution_spec,&borrowed,&AtomicBool::new(false),Some(envelope.expires_at_ms),Some(&mut exchange))?;
 let mut extra=[0u8;1];if reader.read(&mut extra).map_err(|_|"NATIVE_TASK_PROTOCOL_IO")?!=0{return Err("NATIVE_TASK_PROTOCOL_EXTRA");}Ok(())
}

#[cfg(test)]mod tests{
 use super::*;use sha2::{Digest,Sha256};use std::fs;
 fn fixture()->(PathBuf,Value){
  assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
  let root=std::env::temp_dir().join(format!("pp-execution-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir(&root).unwrap();
  let exe=std::env::current_exe().unwrap();let pin=format!("{:x}",Sha256::digest(fs::read(&exe).unwrap()));
  let name=concat!(module_path!(),"::child").split_once("::").unwrap().1;
  let spec=json!({"runId":"native-execution-1","intentDigest":"a".repeat(64),"registeredRoot":root,"cwd":root,"executablePath":exe,"executableDigest":pin,
    "args":["--ignored","--exact",name,"--nocapture"],"timeoutMs":5000,"outputLimits":{"stdoutBytes":8192,"stderrBytes":2048,"combinedBytes":10000},"candidateDigest":"b".repeat(64),"checkContractDigest":"c".repeat(64)});(root,spec)
 }
 #[test]fn actual_native_observation_uses_reviewed_spec_and_reports_cleanup(){
  let(_,spec)=fixture();let system=std::env::var("SystemRoot").unwrap();let result=execute(&spec,&[("SystemRoot",&system)],&AtomicBool::new(false)).unwrap();
  assert_eq!(result["exitCode"],0);assert!(result["stdout"].as_str().unwrap().contains("native-adapter-child"));
  for key in ["processExited","jobEmptyObserved","ioSettled","descendantsSettled"]{assert_eq!(result[key],true);}
  assert_eq!(result["runId"],spec["runId"]);assert_eq!(result.as_object().unwrap().len(),16);
 }
 #[test]fn foreign_executable_cwd_and_extra_authority_are_refused(){
  let(root,spec)=fixture();let mut changed=spec.clone();changed["executableDigest"]=json!("f".repeat(64));assert!(execute(&changed,&[],&AtomicBool::new(false)).is_err());
  changed=spec.clone();changed["cwd"]=json!(root.parent().unwrap());assert!(execute(&changed,&[],&AtomicBool::new(false)).is_err());
  changed=spec;changed["executionAuthorized"]=json!(true);assert!(parse(&changed).is_err());
 }
 #[test]fn actual_failed_exit_is_preserved_and_bad_encoding_is_not_rewritten(){
  let(_,spec)=fixture();let system=std::env::var("SystemRoot").unwrap();
  let result=execute(&spec,&[("SystemRoot",&system),("PP_ADAPTER_CHILD","fail")],&AtomicBool::new(false)).unwrap();
  assert_eq!(result["exitCode"],7);assert_eq!(result["processExited"],true);assert_eq!(result["jobEmptyObserved"],true);assert_eq!(result["ioSettled"],true);
  assert_eq!(execute(&spec,&[("SystemRoot",&system),("PP_ADAPTER_CHILD","invalid-utf8")],&AtomicBool::new(false)).unwrap_err(),"NATIVE_TASK_OUTPUT_ENCODING_INVALID");
 }
 #[test]fn malformed_spec_and_prelaunch_cancellation_are_refused(){
  let(_,spec)=fixture();
  for (key,value) in [("timeoutMs",json!(300001)),("intentDigest",json!("wrong")),("args",json!(["nul\u{0}argument"]))]{let mut bad=spec.clone();bad[key]=value;assert!(parse(&bad).is_err());}
  assert_eq!(execute(&spec,&[],&AtomicBool::new(true)).unwrap_err(),"NATIVE_TASK_RUN_UNRESOLVED");
  assert_eq!(execute_until(&spec,&[],&AtomicBool::new(false),Some(0)).unwrap_err(),"NATIVE_TASK_GRANT_EXPIRED");
 }
 #[test]fn executable_pin_prevents_write_and_delete_until_released(){
  let(root,_)=fixture();let file=root.join("pinned.exe");fs::write(&file,b"controlled bytes").unwrap();let pin=format!("{:x}",Sha256::digest(b"controlled bytes"));
  let locked=crate::native_host_resources::pin_task_files(&file,&pin,&root,&root).unwrap();
  assert!(fs::write(&file,b"changed").is_err());assert!(fs::remove_file(&file).is_err());assert!(fs::rename(&root,root.with_extension("moved")).is_err());
  drop(locked);fs::write(&file,b"changed").unwrap();
 }
 #[test]fn transient_nested_candidate_change_refuses_an_observation(){
  let(root,spec)=fixture();fs::create_dir(root.join("nested")).unwrap();
  let system=std::env::var("SystemRoot").unwrap();
  let observed=execute(&spec,&[("SystemRoot",&system),("PP_ADAPTER_CHILD","transient-candidate")],&AtomicBool::new(false));
  assert_eq!(fs::read_dir(root.join("nested")).unwrap().count(),0);
  assert_eq!(observed.unwrap_err(),"NATIVE_TASK_CANDIDATE_CHANGED_DURING_EXECUTION");
 }
 #[test]fn native_child_cannot_overwrite_an_existing_candidate_input(){
  let(root,spec)=fixture();fs::create_dir(root.join("nested")).unwrap();fs::write(root.join("nested/input.txt"),b"original").unwrap();
  let system=std::env::var("SystemRoot").unwrap();
  let observed=execute(&spec,&[("SystemRoot",&system),("PP_ADAPTER_CHILD","input-write-denied")],&AtomicBool::new(false)).unwrap();
  assert_eq!(observed["exitCode"],0);assert_eq!(fs::read(root.join("nested/input.txt")).unwrap(),b"original");
  fs::write(root.join("nested/input.txt"),b"released after settlement").unwrap();
 }
 #[test]#[ignore="inert child invoked only by adapter test"]fn child(){
  match std::env::var("PP_ADAPTER_CHILD").as_deref(){Ok("fail")=>std::process::exit(7),Ok("invalid-utf8")=>{use std::io::Write;std::io::stdout().write_all(&[0xff]).unwrap();},Ok("transient-candidate")=>{let file=std::env::current_dir().unwrap().join("nested/transient.txt");fs::write(&file,b"changed during check").unwrap();fs::remove_file(file).unwrap();},Ok("input-write-denied")=>{assert!(fs::write(std::env::current_dir().unwrap().join("nested/input.txt"),b"corrupted").is_err());},_=>println!("native-adapter-child")}
 }
 #[test]fn custody_exchange_holds_inputs_until_output_acknowledgment(){
  let(root,spec)=fixture();let input=root.join("input.txt");fs::write(&input,b"original").unwrap();
  let system=std::env::var("SystemRoot").unwrap();let mut phases=Vec::new();
  let mut exchange=|phase:&str,payload:&Value|{phases.push(phase.to_owned());
   if phase!="finalized"{assert!(fs::write(&input,b"illegal mutation").is_err());}else{assert_eq!(payload,&json!("d".repeat(64)));fs::write(&input,b"released").unwrap();}
   Ok(if phase=="observation"{assert_eq!(payload["exitCode"],0);Some("d".repeat(64))}else{None})
  };
  execute_with_custody(&spec,&[("SystemRoot",&system)],&AtomicBool::new(false),None,Some(&mut exchange)).unwrap();
  assert_eq!(phases,vec!["ready","observation","finalized"]);assert_eq!(fs::read(&input).unwrap(),b"released");
 }
 #[test]fn mutation_during_output_retention_refuses_guard_finalization(){
  let(root,spec)=fixture();let system=std::env::var("SystemRoot").unwrap();let mut finalized=false;
  let mut exchange=|phase:&str,_:&Value|{if phase=="observation"{let file=root.join("transient.txt");fs::write(&file,b"mutation").unwrap();fs::remove_file(file).unwrap();return Ok(Some("d".repeat(64)));}if phase=="finalized"{finalized=true;}Ok(None)};
  assert_eq!(execute_with_custody(&spec,&[("SystemRoot",&system)],&AtomicBool::new(false),None,Some(&mut exchange)).unwrap_err(),"NATIVE_TASK_CANDIDATE_CHANGED_DURING_EXECUTION");assert!(!finalized);
 }
}
