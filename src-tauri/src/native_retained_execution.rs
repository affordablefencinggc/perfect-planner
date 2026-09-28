//! Private single-use Node execution over retained inputs. The caller supplies
//! admitted bindings and owner-only retention callbacks. No public command,
//! renderer path selection, npm translation or execution authority lives here.
#![allow(dead_code)]
use crate::{native_app_container::AppContainer,native_candidate_archive::{ArchiveBinding,RetainedInputs},native_candidate_guard::CandidateGuard,native_host_resources::{pin_directory_names,pin_task_files},native_task_containment::{CapturedRun,run_captured_isolated_after_retention}};
use serde_json::json;
use sha2::{Digest,Sha256};
use std::{ffi::OsStr,fs::{self,File,OpenOptions},io::{Read,Write,Seek},os::windows::fs::OpenOptionsExt,path::{Path,PathBuf},sync::atomic::{AtomicBool,Ordering},time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
type Result<T>=std::result::Result<T,&'static str>;
const INVALID:&str="NATIVE_RETAINED_EXECUTION_INVALID";
const UNRESOLVED:&str="NATIVE_RETAINED_EXECUTION_UNRESOLVED";
const LIMIT:usize=32*1024*1024;

pub(crate) struct NodeSpec{
 pub binding:ArchiveBinding,pub source:PathBuf,pub cwd:String,pub script:String,pub args:Vec<String>,
 pub node:PathBuf,pub node_digest:String,pub owner_directory:PathBuf,pub expires_at_ms:u64,
 pub timeout:Duration,pub stdout_limit:usize,pub stderr_limit:usize,pub combined_limit:usize,
}

#[cfg(test)]mod tests{
 use super::*;
 fn root(label:&str)->PathBuf{
  assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");let base=PathBuf::from(std::env::var_os("PP_RETAINED_EXECUTION_FIXTURE_ROOT").expect("fresh explicit DANS1 fixture"));let root=base.join(label);fs::create_dir(&root).unwrap();root
 }
 fn spec(root:&Path,run:&str,answer:u32)->NodeSpec{
  let source=root.join(format!("source-{run}"));fs::create_dir(&source).unwrap();fs::write(source.join("value.cjs"),format!("module.exports={answer};")).unwrap();
  fs::write(source.join("check.cjs"),br#"const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');a.throws(()=>fs.writeFileSync(p.join(__dirname,'value.cjs'),'changed'));a.throws(()=>fs.writeFileSync(p.join(__dirname,'new-file'),'changed'));const answer=require('./value.cjs');fs.writeFileSync(p.join(process.env.PP_TASK_OUTPUT,'result.json'),JSON.stringify({answer}));console.log('answer='+answer);process.exitCode=answer===42?0:7;"#).unwrap();
  let owner_directory=root.join(format!("owner-{run}"));fs::create_dir(&owner_directory).unwrap();let node=PathBuf::from(std::env::var_os("PP_TEST_AGENT_NODE").unwrap());let node_digest=file_hash(&node).unwrap().1;
  NodeSpec{binding:ArchiveBinding{run_id:run.into(),root_identity:"a".repeat(64),candidate_digest:hash(&fs::read(source.join("value.cjs")).unwrap()),intent_digest:hash(run.as_bytes())},source,cwd:"".into(),script:"check.cjs".into(),args:vec![],node,node_digest,owner_directory,expires_at_ms:(SystemTime::now().duration_since(UNIX_EPOCH).unwrap()+Duration::from_secs(60)).as_millis()as u64,timeout:Duration::from_secs(10),stdout_limit:8192,stderr_limit:8192,combined_limit:16384}
 }
 fn retain(path:&Path,bytes:&[u8])->String{let mut file=OpenOptions::new().write(true).create_new(true).open(path).unwrap();file.write_all(bytes).unwrap();file.sync_all().unwrap();drop(file);assert_eq!(fs::read(path).unwrap(),bytes);hash(bytes)}
 #[test]#[ignore="DANS1 interactive session and real Node required"]fn failed_check_fresh_retry_retain_distinct_inputs_and_results(){
  let base=root("retry");let mut digests=Vec::new();
  for (name,answer,exit)in[("first",41,7),("retry",42,0)]{
   let spec=spec(&base,name,answer);let cancel=AtomicBool::new(false);let mut phases=Vec::new();let mut artifact=None;
   let outcome=execute(&spec,&cancel,||{assert_eq!(hash(&fs::read(spec.source.join("value.cjs")).unwrap()),spec.binding.candidate_digest);Ok(())},|value|{
    phases.push("inputs");let bytes=fs::read(&value.path).unwrap();assert_eq!(hash(&bytes),value.digest);assert_eq!(bytes.len(),value.bytes);let record:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
    assert!(!Path::new(record["outputDirectory"].as_str().unwrap()).join("result.json").exists());assert!(fs::write(spec.source.join("value.cjs"),b"changed").is_err());assert!(fs::write(&value.path,b"changed").is_err());
    let acknowledged=retain(&spec.owner_directory.join("owner-retained.json"),&bytes);artifact=Some(record);Ok(acknowledged)
   },|run,digest|{
    assert_eq!(run.settlement.exit_code,Some(exit));assert_eq!(String::from_utf8(run.stdout.clone()).unwrap().trim(),format!("answer={answer}"));assert!(fs::write(spec.source.join("value.cjs"),b"changed").is_err());
    let result=json!({"state":"retained-provisional","executionAuthorized":false,"inputArtifactDigest":digest,"exit":run.settlement.exit_code,"stdout":String::from_utf8(run.stdout.clone()).unwrap(),"processExited":run.settlement.process_exited,"jobEmpty":run.settlement.job_empty_observed,"descendantsSettled":run.settlement.descendants_settled,"ioSettled":run.io_settled});
    Ok(retain(&spec.owner_directory.join("owner-provisional-result.json"),&serde_json::to_vec(&result).unwrap()))
   }).unwrap();
   assert_eq!(phases,vec!["inputs"]);assert_eq!(outcome.run.settlement.exit_code,Some(exit));let record=artifact.unwrap();
   let archive_bytes=serde_json::to_vec(&record["archive"]).unwrap();
   // Value reserialization has a different key order. Restore the strongly
   // typed archive's exact wire order, without changing its retained values.
   let manifest:crate::native_candidate_archive::ArchiveManifest=serde_json::from_slice(&archive_bytes).unwrap();let archive_bytes=serde_json::to_vec(&manifest).unwrap();
   let reopened=RetainedInputs::reopen(&archive_bytes,record["archiveDigest"].as_str().unwrap(),&spec.binding,&cancel).unwrap();reopened.validate(&cancel).unwrap();
   assert_eq!(fs::read(reopened.member("value.cjs",false).unwrap()).unwrap(),format!("module.exports={answer};").as_bytes());
   let output:serde_json::Value=serde_json::from_slice(&fs::read(outcome.output_directory.join("result.json")).unwrap()).unwrap();assert_eq!(output["answer"],answer);
   digests.push((outcome.input_artifact_digest,outcome.result_artifact_digest));
  }
  assert_ne!(digests[0].0,digests[1].0);assert_ne!(digests[0].1,digests[1].1);fs::write(base.join("digests.json"),serde_json::to_vec_pretty(&digests).unwrap()).unwrap();
 }
 #[test]#[ignore="DANS1 interactive session and real Node required"]fn refused_or_cancelled_input_ack_never_runs_the_child(){
  let base=root("refusals");
  for mode in ["missing","lost","mismatch","cancel","source-change"]{
   let spec=spec(&base,mode,42);let cancel=AtomicBool::new(false);let mut output=None;let mut result_called=false;
   let result=execute(&spec,&cancel,||Ok(()),|artifact|{
    let record:serde_json::Value=serde_json::from_slice(&fs::read(&artifact.path).unwrap()).unwrap();output=Some(PathBuf::from(record["outputDirectory"].as_str().unwrap()));
    if mode!="missing"{retain(&spec.owner_directory.join("owner-retained.json"),&fs::read(&artifact.path).unwrap());}
    match mode{"missing"=>Err("FIXTURE_ACK_MISSING"),"lost"=>Err("FIXTURE_ACK_LOST"),"mismatch"=>Ok("0".repeat(64)),"cancel"=>{cancel.store(true,Ordering::Release);Ok(artifact.digest.clone())},_=>{fs::write(spec.source.join("transient"),b"unapproved").unwrap();Ok(artifact.digest.clone())}}
   },|_,_|{result_called=true;Ok("d".repeat(64))});
   let expected=match mode{"missing"=>"FIXTURE_ACK_MISSING","lost"=>"FIXTURE_ACK_LOST","mismatch"=>"NATIVE_RETAINED_INPUT_ACK_MISMATCH","cancel"=>"NATIVE_RETAINED_EXECUTION_CANCELLED",_=>"NATIVE_TASK_CANDIDATE_CHANGED_DURING_EXECUTION"};
   // Returning this original refusal requires confirmed prepared-child
   // settlement in the runner; unknown cleanup returns a different error.
   assert_eq!(result.as_ref().err(),Some(&expected));assert!(!result_called);let output=output.expect("actual suspended preparation reached owner acknowledgment");assert!(!output.join("result.json").exists());assert_eq!(spec.owner_directory.join("owner-retained.json").exists(),mode!="missing");
   assert!(fs::write(spec.source.join("value.cjs"),b"must remain held on runner error").is_err());
   fs::write(spec.owner_directory.join("refusal.txt"),result.err().unwrap()).unwrap();
  }
 }
 #[test]#[ignore="DANS1 interactive session and real Node required"]fn late_change_keeps_provisional_result_without_finalization(){
  let base=root("late-change");let spec=spec(&base,"late-change",42);let cancel=AtomicBool::new(false);let provisional=spec.owner_directory.join("owner-provisional-result.json");
  let result=execute(&spec,&cancel,||Ok(()),|artifact|Ok(retain(&spec.owner_directory.join("owner-retained.json"),&fs::read(&artifact.path).unwrap())),|run,digest|{
   assert_eq!(run.settlement.exit_code,Some(0));let bytes=serde_json::to_vec(&json!({"state":"retained-provisional","executionAuthorized":false,"inputArtifactDigest":digest,"stdout":String::from_utf8(run.stdout.clone()).unwrap()})).unwrap();let receipt=retain(&provisional,&bytes);
   fs::write(spec.source.join("late-change"),b"changed during owner retention").unwrap();Ok(receipt)
  });
  assert!(matches!(result,Err("NATIVE_TASK_CANDIDATE_CHANGED_DURING_EXECUTION")));let record:serde_json::Value=serde_json::from_slice(&fs::read(provisional).unwrap()).unwrap();assert_eq!(record["state"],"retained-provisional");assert_eq!(record["executionAuthorized"],false);
  assert!(!spec.owner_directory.join("finalized.json").exists());
 }
}
pub(crate) struct OwnerArtifact{pub path:PathBuf,pub digest:String,pub bytes:usize}
pub(crate) struct NodeOutcome{pub run:CapturedRun,pub input_artifact_digest:String,pub result_artifact_digest:String,pub output_directory:PathBuf}
fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn hex(value:&str)->bool{value.len()==64&&value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn available(spec:&NodeSpec,cancel:&AtomicBool)->Result<()>{
 if cancel.load(Ordering::Acquire){return Err("NATIVE_RETAINED_EXECUTION_CANCELLED");}
 if SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|INVALID)?.as_millis()>=spec.expires_at_ms as u128{return Err("NATIVE_RETAINED_EXECUTION_EXPIRED");}Ok(())
}
fn file_hash(file:&Path)->Result<(u64,String)>{
 let mut file=OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(file).map_err(|_|UNRESOLVED)?;
 let bytes=file.metadata().map_err(|_|UNRESOLVED)?.len();if bytes==0||bytes>256*1024*1024{return Err(INVALID);}
 let mut hasher=Sha256::new();let mut count=0;let mut buffer=[0u8;65536];
 loop{let n=file.read(&mut buffer).map_err(|_|UNRESOLVED)?;if n==0{break;}count+=n as u64;if count>bytes{return Err(UNRESOLVED);}hasher.update(&buffer[..n]);}
 if count!=bytes{return Err(UNRESOLVED);}Ok((bytes,format!("{:x}",hasher.finalize())))
}
fn runtime_matches(runtime:&Path,node:&Path,bytes:u64,digest:&str,policy:&[String;3])->Result<()>{
 let names:Vec<_>=fs::read_dir(runtime).map_err(|_|UNRESOLVED)?.map(|e|e.map(|e|e.file_name())).collect::<std::io::Result<_>>().map_err(|_|UNRESOLVED)?;
 if names!=vec![std::ffi::OsString::from("node.exe")]||file_hash(node)?!=(bytes,digest.into())||AppContainer::descriptor(runtime).map_err(|_|UNRESOLVED)?!=policy[0]||AppContainer::descriptor(node).map_err(|_|UNRESOLVED)?!=policy[2]{return Err("NATIVE_RETAINED_RUNTIME_CHANGED");}Ok(())
}
fn persist(file:&Path,bytes:&[u8])->Result<File>{
 if bytes.is_empty()||bytes.len()>LIMIT{return Err(INVALID);}
 let mut held=OpenOptions::new().read(true).write(true).create_new(true).share_mode(1).custom_flags(0x00200000).open(file).map_err(|_|UNRESOLVED)?;
 held.write_all(bytes).and_then(|_|held.sync_all()).and_then(|_|held.rewind()).map_err(|_|UNRESOLVED)?;
 let mut read=Vec::new();(&mut held).take((LIMIT+1)as u64).read_to_end(&mut read).map_err(|_|UNRESOLVED)?;if read!=bytes{return Err(UNRESOLVED);}Ok(held)
}

// Retention callbacks must themselves authenticate the admitted owner context.
// Returning the expected digest is an acknowledgment, never proof of identity.
// Result retention is PROVISIONAL: any later guard failure leaves it unresolved.
// The containing owner protocol may finalize only after successful guard return
// AND contained host closure. Output directory files are not captured evidence.
pub(crate) fn execute(spec:&NodeSpec,cancel:&AtomicBool,mut confirm_candidate:impl FnMut()->Result<()>,mut retain_inputs:impl FnMut(&OwnerArtifact)->Result<String>,mut retain_provisional_result:impl FnMut(&CapturedRun,&str)->Result<String>)->Result<NodeOutcome>{
 available(spec,cancel)?;
 if !hex(&spec.node_digest)||!spec.source.is_absolute()||!spec.node.is_absolute()||!spec.owner_directory.is_absolute()||spec.args.len()>64||spec.args.iter().map(String::len).sum::<usize>()>32768||spec.args.iter().any(|a|a.chars().any(char::is_control))||spec.timeout.is_zero()||spec.timeout>Duration::from_secs(300)||[spec.stdout_limit,spec.stderr_limit,spec.combined_limit].iter().any(|n|*n==0||*n>2*1024*1024)||spec.combined_limit>spec.stdout_limit+spec.stderr_limit{return Err(INVALID);}
 let owner_pins=pin_directory_names(&spec.owner_directory)?;let source_pins=pin_directory_names(&spec.source)?;
 let source_canonical=fs::canonicalize(&spec.source).map_err(|_|INVALID)?;let owner_canonical=fs::canonicalize(&spec.owner_directory).map_err(|_|INVALID)?;
 if owner_canonical.starts_with(&source_canonical)||source_canonical.starts_with(&owner_canonical){return Err(INVALID);}
 let original_pins=pin_task_files(&spec.node,&spec.node_digest,&spec.source,&spec.source)?;let source_guard=CandidateGuard::acquire(&spec.source,cancel)?;
 confirm_candidate()?;source_guard.validate()?;available(spec,cancel)?;
 // One remaining retention budget includes the admitted task time. Archive
 // creation and every later validation share it; callbacks never renew it.
 // The outer contained transport remains the hard wall-clock backstop.
 let retention_deadline=Instant::now()+spec.timeout+Duration::from_secs(120);
 let name=format!("perfect-planner.execution.{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|INVALID)?.as_nanos());let profile=AppContainer::create_fresh(&name).map_err(|_|UNRESOLVED)?;
 let archive=RetainedInputs::create_until(&spec.source,&profile,spec.binding.clone(),cancel,retention_deadline)?;let cwd=archive.member(&spec.cwd,true)?;let script=archive.member(&spec.script,false)?;
 let runtime=profile.create_readonly_directory("runtime").map_err(|_|UNRESOLVED)?;let runtime_pins=pin_directory_names(&runtime)?;let node=runtime.join("node.exe");
 let mut original=OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(&spec.node).map_err(|_|UNRESOLVED)?;
 let mut destination=OpenOptions::new().write(true).create_new(true).share_mode(0).custom_flags(0x00200000).open(&node).map_err(|_|UNRESOLVED)?;
 let bytes=std::io::copy(&mut original,&mut destination).map_err(|_|UNRESOLVED)?;destination.sync_all().map_err(|_|UNRESOLVED)?;drop(destination);drop(original);
 let node_pins=pin_task_files(&node,&spec.node_digest,profile.folder(),&cwd)?;let policy=profile.readonly_descriptors().map_err(|_|UNRESOLVED)?;runtime_matches(&runtime,&node,bytes,&spec.node_digest,&policy)?;
 let output=profile.folder().join("output");fs::create_dir(&output).map_err(|_|UNRESOLVED)?;let temp=profile.folder().join("Temp");fs::create_dir_all(&temp).map_err(|_|UNRESOLVED)?;
 let system=std::env::var("SystemRoot").map_err(|_|INVALID)?;
 let environment=[("SystemRoot",system.as_str()),("WINDIR",system.as_str()),("LOCALAPPDATA",profile.folder().to_str().ok_or(INVALID)?),("TEMP",temp.to_str().ok_or(INVALID)?),("TMP",temp.to_str().ok_or(INVALID)?),("PP_TASK_OUTPUT",output.to_str().ok_or(INVALID)?)];
 let mut args=vec![OsStr::new("--preserve-symlinks"),OsStr::new("--preserve-symlinks-main"),script.as_os_str()];args.extend(spec.args.iter().map(OsStr::new));
 let record=json!({"schemaVersion":1,"kind":"NATIVE_RETAINED_NODE_INPUTS","binding":spec.binding,"archive":archive.manifest,"archiveDigest":archive.digest,"runtime":{"root":runtime,"node":node,"bytes":bytes,"sha256":spec.node_digest,"rootDescriptor":policy[0],"nodeDescriptor":policy[2]},"invocation":{"sourceNode":spec.node,"sourceRoot":spec.source,"cwd":cwd,"script":script,"args":args.iter().map(|s|s.to_str().ok_or(INVALID)).collect::<Result<Vec<_>>>()?,"timeoutMs":spec.timeout.as_millis(),"outputLimits":{"stdoutBytes":spec.stdout_limit,"stderrBytes":spec.stderr_limit,"combinedBytes":spec.combined_limit}},"outputDirectory":output,"executionAuthorized":false});
 let record_bytes=serde_json::to_vec(&record).map_err(|_|INVALID)?;if record_bytes.len()>LIMIT{return Err(INVALID);}let artifact=OwnerArtifact{path:spec.owner_directory.join("retained-node-inputs.json"),digest:hash(&record_bytes),bytes:record_bytes.len()};
 let mut runtime_guard=None;let mut retained_file=None;let mut callback_error=None;
 let run=run_captured_isolated_after_retention(&node,&args,&cwd,&environment,spec.timeout,spec.stdout_limit,spec.stderr_limit,spec.combined_limit,Duration::from_secs(120),cancel,&profile,||{
  let result=(||{
   runtime_guard=Some(CandidateGuard::acquire(&runtime,cancel)?);
   runtime_matches(&runtime,&node,bytes,&spec.node_digest,&policy)?;source_guard.validate()?;archive.validate(cancel)?;available(spec,cancel)?;
   retained_file=Some(persist(&artifact.path,&record_bytes)?);
   if retain_inputs(&artifact)?!=artifact.digest{return Err("NATIVE_RETAINED_INPUT_ACK_MISMATCH");}
   available(spec,cancel)?;source_guard.validate()?;archive.validate(cancel)?;runtime_guard.as_ref().ok_or(UNRESOLVED)?.validate()?;runtime_matches(&runtime,&node,bytes,&spec.node_digest,&policy)?;Ok(())
  })();
  result.map_err(|error|{callback_error=Some(error);std::io::Error::new(std::io::ErrorKind::PermissionDenied,error)})
 });
 let settled_refusal=run.as_ref().err().is_some_and(crate::native_task_containment::preparation_refusal_settled);
 let run=match run{Ok(run)if run.settlement.process_exited&&run.settlement.job_empty_observed&&run.settlement.descendants_settled&&run.io_settled&&!run.io_failed=>run,_=>{
  // Any runner error lacks a returned settlement receipt. This single-use host
  // retains every input/executable/manifest handle until its enclosing exit.
  std::mem::forget((source_guard,source_pins,original_pins,archive,runtime_guard,runtime_pins,node_pins,owner_pins,retained_file));return Err(if settled_refusal{callback_error.unwrap_or(UNRESOLVED)}else{UNRESOLVED});
 }};
 source_guard.validate()?;archive.validate(&AtomicBool::new(false))?;runtime_guard.as_ref().ok_or(UNRESOLVED)?.validate()?;runtime_matches(&runtime,&node,bytes,&spec.node_digest,&policy)?;
 let result_digest=retain_provisional_result(&run,&artifact.digest)?;if !hex(&result_digest){return Err("NATIVE_RETAINED_RESULT_ACK_INVALID");}
 // Check again after owner retention; no child or asynchronous output survives.
 source_guard.finish()?;archive.finish(&AtomicBool::new(false))?;runtime_guard.take().ok_or(UNRESOLVED)?.finish()?;
 Ok(NodeOutcome{run,input_artifact_digest:artifact.digest,result_artifact_digest:result_digest,output_directory:output})
}
