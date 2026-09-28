//! Retained execution inputs, copied from held source handles. No execution,
//! grant, publisher authentication or durable result authority is conferred.
#![allow(dead_code)]
use crate::{native_app_container::AppContainer,native_candidate_guard::CandidateGuard,native_host_resources::{pin_directory_names,PinnedDirectoryNames}};
use serde::{Serialize,Deserialize};
use sha2::{Digest,Sha256};
use std::{collections::{HashSet,HashMap},ffi::c_void,fs::{self,File,OpenOptions},io::{Read,Write,Seek},os::windows::{fs::{OpenOptionsExt,MetadataExt},io::AsRawHandle},path::{Path,PathBuf},sync::atomic::{AtomicBool,Ordering},time::{Duration,Instant}};
type Result<T>=std::result::Result<T,&'static str>;
const INVALID:&str="NATIVE_TASK_ARCHIVE_INVALID";
const CHANGED:&str="NATIVE_TASK_ARCHIVE_CHANGED";
const UNAVAILABLE:&str="NATIVE_TASK_ARCHIVE_UNAVAILABLE";
const LIMIT:&str="NATIVE_TASK_ARCHIVE_LIMIT";
#[link(name="kernel32")]extern "system"{
 fn GetFileInformationByHandle(file:*mut c_void,info:*mut u32)->i32;
 fn GetFileInformationByHandleEx(file:*mut c_void,class:i32,info:*mut c_void,bytes:u32)->i32;
}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct ArchiveBinding{pub run_id:String,pub root_identity:String,pub candidate_digest:String,pub intent_digest:String}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Entry{path:String,kind:String,bytes:u64,sha256:Option<String>,descriptor:String}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct ArchiveManifest{
 schema_version:u32,kind:String,binding:ArchiveBinding,profile_name:String,profile_sid:String,
 root:PathBuf,readonly_policy:String,entries:Vec<Entry>,total_bytes:u64,execution_authorized:bool,
}
// The owner persists this exact manifest alongside its run, then binds the
// digest to the retained observation. A returned value alone is not durable.
pub(crate) struct RetainedInputs{pub manifest:ArchiveManifest,pub digest:String,guard:CandidateGuard,_pins:PinnedDirectoryNames,deadline:Option<Instant>}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkingCopyManifest{
 schema_version:u32,kind:String,binding:ArchiveBinding,archive_digest:String,
 root:PathBuf,policy:String,entries:Vec<Entry>,total_bytes:u64,execution_authorized:bool,
}
pub(crate) struct PreparedWorkingCopy{pub manifest:WorkingCopyManifest,pub digest:String,guard:CandidateGuard,pins:PinnedDirectoryNames,deadline:Instant}
pub(crate) struct WorkingCopy{pub manifest:WorkingCopyManifest,pub digest:String,_pins:PinnedDirectoryNames}
impl PreparedWorkingCopy{
 // Caller releases only immediately before resuming its admitted child. This
 // ends input immutability for the execution COPY, never for the archive.
 pub(crate) fn release(self,cancel:&AtomicBool)->Result<WorkingCopy>{
  check(cancel,self.deadline)?;let(entries,bytes)=inventory(&self.manifest.root,&self.guard,cancel,self.deadline)?;
  if entries!=self.manifest.entries||bytes!=self.manifest.total_bytes{return Err(CHANGED);}
  self.guard.finish()?;check(cancel,self.deadline)?;
  Ok(WorkingCopy{manifest:self.manifest,digest:self.digest,_pins:self.pins})
 }
}
fn hex(value:&str)->bool{value.len()==64&&value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn binding_valid(binding:&ArchiveBinding)->bool{!binding.run_id.is_empty()&&binding.run_id.len()<=128&&binding.run_id.bytes().all(|b|b.is_ascii_alphanumeric()||b"._:-".contains(&b))&&[&binding.root_identity,&binding.candidate_digest,&binding.intent_digest].iter().all(|s|hex(s))}
fn check(cancel:&AtomicBool,deadline:Instant)->Result<()>{if cancel.load(Ordering::Acquire){Err("NATIVE_TASK_ARCHIVE_CANCELLED")}else if Instant::now()>=deadline{Err(LIMIT)}else{Ok(())}}
fn relative(root:&Path,path:&Path)->Result<String>{
 let relative=path.strip_prefix(root).map_err(|_|INVALID)?;let mut parts=Vec::new();
 for part in relative.components(){let std::path::Component::Normal(part)=part else{return Err(INVALID);};let part=part.to_str().ok_or(INVALID)?;
  let upper=part.to_uppercase();let stem=upper.split('.').next().ok_or(INVALID)?;
  let device=matches!(stem,"CON"|"PRN"|"AUX"|"NUL"|"CONIN$"|"CONOUT$")||["COM","LPT"].iter().any(|prefix|stem.strip_prefix(prefix).is_some_and(|n|matches!(n,"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"¹"|"²"|"³")));
  if part.is_empty()||part.ends_with(['.',' '])||part.encode_utf16().count()>255||part.chars().any(|c|c.is_control()||"<>:\"/\\|?*".contains(c))||device{return Err(INVALID);}parts.push(part);
 }
 let value=parts.join("/");if value.encode_utf16().count()>4096{return Err(LIMIT);}Ok(value)
}
fn stamp(file:&File,is_file:bool)->Result<(u64,u64,u64,u64,u64)>{
 let metadata=file.metadata().map_err(|_|UNAVAILABLE)?;let mut info=[0u32;13];
 if metadata.file_attributes()&0x400!=0||metadata.is_file()!=is_file||unsafe{GetFileInformationByHandle(file.as_raw_handle(),info.as_mut_ptr())}==0||(is_file&&info[10]!=1){return Err(INVALID);}
 Ok((info[7]as u64,((info[11]as u64)<<32)|info[12]as u64,metadata.file_size(),metadata.last_write_time(),metadata.creation_time()))
}
// Named streams are inputs too. This first archive schema rejects them instead
// of silently retaining only the default data stream. Unsupported enumeration
// is also refusal. Query the held handle, not a second path lookup.
fn default_stream_only(file:&File,is_file:bool)->Result<()>{
 let mut buffer=vec![0u64;8192];
 let ok=unsafe{GetFileInformationByHandleEx(file.as_raw_handle(),7,buffer.as_mut_ptr().cast(),65536)};
 if ok==0{return if std::io::Error::last_os_error().raw_os_error()==Some(38)&&(!is_file||file.metadata().map_err(|_|UNAVAILABLE)?.len()==0){Ok(())}else{Err(UNAVAILABLE)};}
 let bytes=unsafe{std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(),65536)};
 let u32_at=|start:usize|u32::from_ne_bytes(bytes[start..start+4].try_into().unwrap())as usize;
 let next=u32_at(0);let length=u32_at(4);
 if next!=0||length>65536-24||length%2!=0{return Err(INVALID);}
 let name:Vec<u16>=bytes[24..24+length].chunks_exact(2).map(|v|u16::from_ne_bytes([v[0],v[1]])).collect();
 if String::from_utf16(&name).map_err(|_|INVALID)?!="::$DATA"{return Err(INVALID);}Ok(())
}
fn digest_file(file:&File,cancel:&AtomicBool,deadline:Instant)->Result<(u64,String)>{
 let before=stamp(file,true)?;default_stream_only(file,true)?;let mut held=file;held.rewind().map_err(|_|UNAVAILABLE)?;
 let mut bytes=0u64;let mut hash=Sha256::new();let mut buffer=[0u8;65536];
 loop{check(cancel,deadline)?;let n=held.read(&mut buffer).map_err(|_|UNAVAILABLE)?;if n==0{break;}bytes=bytes.checked_add(n as u64).ok_or(LIMIT)?;if bytes>before.2{return Err(CHANGED);}hash.update(&buffer[..n]);}
 if bytes!=before.2||stamp(file,true)?!=before{return Err(CHANGED);}default_stream_only(file,true)?;Ok((bytes,format!("{:x}",hash.finalize())))
}
fn inventory(root:&Path,guard:&CandidateGuard,cancel:&AtomicBool,deadline:Instant)->Result<(Vec<Entry>,u64)>{
 guard.validate()?;let mut entries=Vec::new();let mut names=HashSet::new();let mut total=0u64;
 for(path,file)in guard.pinned_directories(){check(cancel,deadline)?;stamp(file,false)?;default_stream_only(file,false)?;let name=relative(root,path)?;
  if !names.insert(name.to_uppercase()){return Err(INVALID);}entries.push(Entry{path:name,kind:"directory".into(),bytes:0,sha256:None,descriptor:AppContainer::descriptor(path).map_err(|_|UNAVAILABLE)?});
 }
 for(path,file)in guard.pinned_files(){check(cancel,deadline)?;let name=relative(root,path)?;if name.is_empty()||!names.insert(name.to_uppercase()){return Err(INVALID);}let(bytes,sha256)=digest_file(file,cancel,deadline)?;
  total=total.checked_add(bytes).ok_or(LIMIT)?;if total>2*1024*1024*1024{return Err(LIMIT);}entries.push(Entry{path:name,kind:"file".into(),bytes,sha256:Some(sha256),descriptor:AppContainer::descriptor(path).map_err(|_|UNAVAILABLE)?});
 }
 entries.sort_by(|a,b|a.path.cmp(&b.path));guard.validate()?;Ok((entries,total))
}
impl RetainedInputs{
 // Native-owned fixed destination in the SAME fresh profile. Caller reserves
 // global storage separately; byte_budget is this copy's admitted byte ceiling.
 pub(crate) fn prepare_workspace(&self,profile:&AppContainer,byte_budget:u64,cancel:&AtomicBool,deadline:Instant)->Result<PreparedWorkingCopy>{
  let deadline=self.deadline.map_or(deadline,|d|d.min(deadline));check(cancel,deadline)?;
  if self.manifest.profile_sid!=profile.sid_text()||self.manifest.profile_name!=profile.name(){return Err(INVALID);}
  if byte_budget>2*1024*1024*1024||self.manifest.total_bytes>byte_budget{return Err(LIMIT);}
  let(entries,bytes)=inventory(self.root(),&self.guard,cancel,deadline)?;
  if entries!=self.manifest.entries||bytes!=self.manifest.total_bytes{return Err(CHANGED);}
  let policy=profile.workspace_descriptors().map_err(|_|UNAVAILABLE)?;
  let root=profile.create_workspace_directory().map_err(|_|UNAVAILABLE)?;let pins=pin_directory_names(&root)?;
  let mut construction=Vec::new();let mut directories:Vec<_>=entries.iter().filter(|e|e.kind=="directory"&&!e.path.is_empty()).collect();
  directories.sort_by_key(|e|(e.path.matches('/').count(),e.path.clone()));
  for entry in directories{
   check(cancel,deadline)?;let directory=root.join(entry.path.replace('/',"\\"));fs::create_dir(&directory).map_err(|_|UNAVAILABLE)?;
   let pin=OpenOptions::new().read(true).share_mode(3).custom_flags(0x02200000).open(&directory).map_err(|_|UNAVAILABLE)?;stamp(&pin,false)?;construction.push(pin);
  }
  let index:HashMap<_,_>=entries.iter().map(|e|(e.path.as_str(),e)).collect();
  for(path,file)in self.guard.pinned_files(){
   check(cancel,deadline)?;let name=relative(self.root(),path)?;let expected=index.get(name.as_str()).filter(|e|e.kind=="file").ok_or(INVALID)?;
   let before=stamp(file,true)?;default_stream_only(file,true)?;let mut input=file;input.rewind().map_err(|_|UNAVAILABLE)?;
   let mut output=OpenOptions::new().write(true).create_new(true).share_mode(0).custom_flags(0x00200000).open(root.join(name.replace('/',"\\"))).map_err(|_|UNAVAILABLE)?;
   let mut copied=0u64;let mut hash=Sha256::new();let mut buffer=[0u8;65536];
   loop{check(cancel,deadline)?;let n=input.read(&mut buffer).map_err(|_|UNAVAILABLE)?;if n==0{break;}copied=copied.checked_add(n as u64).ok_or(LIMIT)?;if copied>expected.bytes{return Err(CHANGED);}output.write_all(&buffer[..n]).map_err(|_|UNAVAILABLE)?;hash.update(&buffer[..n]);}
   if copied!=expected.bytes||Some(format!("{:x}",hash.finalize()))!=expected.sha256||stamp(file,true)?!=before{return Err(CHANGED);}default_stream_only(file,true)?;
   output.sync_all().map_err(|_|UNAVAILABLE)?;
  }
  let guard=CandidateGuard::acquire(&root,cancel)?;let(copied,total_bytes)=inventory(&root,&guard,cancel,deadline)?;
  if copied.iter().any(|e|e.descriptor!=policy[if e.path.is_empty(){0}else if e.kind=="directory"{1}else{2}]){return Err("NATIVE_TASK_WORKSPACE_POLICY_CHANGED");}
  if total_bytes!=bytes||copied.len()!=entries.len()||copied.iter().zip(&entries).any(|(a,b)|a.path!=b.path||a.kind!=b.kind||a.bytes!=b.bytes||a.sha256!=b.sha256){return Err(CHANGED);}
  self.guard.validate()?;check(cancel,deadline)?;drop(construction);
  let manifest=WorkingCopyManifest{schema_version:1,kind:"NATIVE_TASK_INITIAL_WORKING_COPY".into(),binding:self.manifest.binding.clone(),archive_digest:self.digest.clone(),root,policy:"appcontainer-writable-copy-v1".into(),entries:copied,total_bytes,execution_authorized:false};
  let bytes=serde_json::to_vec(&manifest).map_err(|_|INVALID)?;if bytes.len()>32*1024*1024{return Err(LIMIT);}let digest=format!("{:x}",Sha256::digest(&bytes));
  Ok(PreparedWorkingCopy{manifest,digest,guard,pins,deadline})
 }
 pub(crate) fn create(source:&Path,profile:&AppContainer,binding:ArchiveBinding,cancel:&AtomicBool)->Result<Self>{Self::create_observed(source,profile,binding,cancel,||{})}
 pub(crate) fn create_until(source:&Path,profile:&AppContainer,binding:ArchiveBinding,cancel:&AtomicBool,deadline:Instant)->Result<Self>{Self::create_observed_until(source,profile,binding,cancel,Some(deadline),||{})}
 fn create_observed(source:&Path,profile:&AppContainer,binding:ArchiveBinding,cancel:&AtomicBool,before_commit:impl FnOnce())->Result<Self>{
  Self::create_observed_until(source,profile,binding,cancel,None,before_commit)
 }
 fn create_observed_until(source:&Path,profile:&AppContainer,binding:ArchiveBinding,cancel:&AtomicBool,shared_deadline:Option<Instant>,before_commit:impl FnOnce())->Result<Self>{
  if !binding_valid(&binding){return Err(INVALID);}let local_deadline=Instant::now()+Duration::from_secs(120);let deadline=shared_deadline.map_or(local_deadline,|d|d.min(local_deadline));check(cancel,deadline)?;
  let _source_pins=pin_directory_names(source)?;let source_guard=CandidateGuard::acquire(source,cancel)?;
  // Inspect all names/streams and hash the pinned population before copying.
  let(source_entries,source_bytes)=inventory(source,&source_guard,cancel,deadline)?;
  let policy=profile.readonly_descriptors().map_err(|_|UNAVAILABLE)?;
  if serde_json::to_vec(&source_entries).map_err(|_|INVALID)?.len()>32*1024*1024{return Err(LIMIT);}
  let source_index:HashMap<_,_>=source_entries.iter().map(|entry|(entry.path.as_str(),entry)).collect();
  let root=profile.create_readonly_directory("inputs").map_err(|_|UNAVAILABLE)?;let pins=pin_directory_names(&root)?;
  let mut construction=Vec::new();
  let mut directories:Vec<_>=source_guard.pinned_directories().map(|(path,_)|relative(source,path)).collect::<Result<Vec<_>>>()?;
  directories.sort_by_key(|path|(path.matches('/').count(),path.clone()));
  for name in directories{check(cancel,deadline)?;if name.is_empty(){continue;}let path=root.join(name.replace('/',"\\"));fs::create_dir(&path).map_err(|_|UNAVAILABLE)?;
   let pin=OpenOptions::new().read(true).share_mode(3).custom_flags(0x02200000).open(&path).map_err(|_|UNAVAILABLE)?;stamp(&pin,false)?;construction.push(pin);
  }
  for(path,file)in source_guard.pinned_files(){
   check(cancel,deadline)?;let name=relative(source,path)?;let expected=source_index.get(name.as_str()).filter(|e|e.kind=="file").ok_or(INVALID)?;
   let before=stamp(file,true)?;default_stream_only(file,true)?;let destination=root.join(name.replace('/',"\\"));
   let mut output=OpenOptions::new().read(true).write(true).create_new(true).share_mode(0).custom_flags(0x00200000).open(&destination).map_err(|_|UNAVAILABLE)?;
   let mut input=file;input.rewind().map_err(|_|UNAVAILABLE)?;let mut copied=0u64;let mut hash=Sha256::new();let mut buffer=[0u8;65536];
   loop{check(cancel,deadline)?;let n=input.read(&mut buffer).map_err(|_|UNAVAILABLE)?;if n==0{break;}copied=copied.checked_add(n as u64).ok_or(LIMIT)?;if copied>expected.bytes{return Err(CHANGED);}output.write_all(&buffer[..n]).map_err(|_|UNAVAILABLE)?;hash.update(&buffer[..n]);}
   if copied!=expected.bytes||Some(format!("{:x}",hash.finalize()))!=expected.sha256||stamp(file,true)?!=before{return Err(CHANGED);}
   output.sync_all().map_err(|_|UNAVAILABLE)?;drop(output);
  }
  before_commit();check(cancel,deadline)?;source_guard.validate()?;
  let guard=CandidateGuard::acquire(&root,cancel)?;let(entries,total_bytes)=inventory(&root,&guard,cancel,deadline)?;
  if entries.iter().any(|entry|entry.descriptor!=policy[if entry.path.is_empty(){0}else if entry.kind=="directory"{1}else{2}]){return Err("NATIVE_TASK_ARCHIVE_POLICY_CHANGED");}
  if total_bytes!=source_bytes||entries.len()!=source_entries.len()||entries.iter().zip(&source_entries).any(|(a,b)|a.path!=b.path||a.kind!=b.kind||a.bytes!=b.bytes||a.sha256!=b.sha256){return Err(CHANGED);}
  source_guard.finish()?;check(cancel,deadline)?;guard.validate()?;drop(construction);
  let manifest=ArchiveManifest{schema_version:1,kind:"NATIVE_TASK_RETAINED_INPUTS".into(),binding,profile_name:profile.name().into(),profile_sid:profile.sid_text().into(),root,readonly_policy:"appcontainer-rx-owner-full-v1".into(),entries,total_bytes,execution_authorized:false};
  let bytes=serde_json::to_vec(&manifest).map_err(|_|INVALID)?;if bytes.len()>32*1024*1024{return Err(LIMIT);}let digest=format!("{:x}",Sha256::digest(&bytes));
  Ok(Self{manifest,digest,guard,_pins:pins,deadline:shared_deadline})
 }
 pub(crate) fn root(&self)->&Path{&self.manifest.root}
 pub(crate) fn member(&self,name:&str,directory:bool)->Result<PathBuf>{
  let candidate=if name.is_empty(){self.root().to_path_buf()}else{self.root().join(name.replace('/',"\\"))};
  if relative(self.root(),&candidate)?!=name||!self.manifest.entries.iter().any(|entry|entry.path==name&&entry.kind==if directory{"directory"}else{"file"}){return Err(INVALID);}
  Ok(candidate)
 }
 pub(crate) fn finish(self,cancel:&AtomicBool)->Result<()>{self.validate(cancel)?;self.guard.finish()}
 pub(crate) fn validate(&self,cancel:&AtomicBool)->Result<()>{
  let local_deadline=Instant::now()+Duration::from_secs(120);let deadline=self.deadline.map_or(local_deadline,|d|d.min(local_deadline));check(cancel,deadline)?;
  let(entries,bytes)=inventory(self.root(),&self.guard,cancel,deadline)?;
  check(cancel,deadline)?;
  if entries!=self.manifest.entries||bytes!=self.manifest.total_bytes{return Err(CHANGED);}Ok(())
 }
 pub(crate) fn reopen(bytes:&[u8],digest:&str,binding:&ArchiveBinding,cancel:&AtomicBool)->Result<Self>{
  if bytes.len()>32*1024*1024||!hex(digest)||format!("{:x}",Sha256::digest(bytes))!=digest{return Err(INVALID);}
  let manifest:ArchiveManifest=serde_json::from_slice(bytes).map_err(|_|INVALID)?;
  if manifest.schema_version!=1||manifest.kind!="NATIVE_TASK_RETAINED_INPUTS"||manifest.readonly_policy!="appcontainer-rx-owner-full-v1"||manifest.execution_authorized||manifest.binding!=*binding||!binding_valid(binding)||serde_json::to_vec(&manifest).map_err(|_|INVALID)?!=bytes{return Err(INVALID);}
  let pins=pin_directory_names(&manifest.root)?;let guard=CandidateGuard::acquire(&manifest.root,cancel)?;
  let retained=Self{manifest,digest:digest.into(),guard,_pins:pins,deadline:None};retained.validate(cancel)?;Ok(retained)
 }
}

#[cfg(test)]mod tests{
 use super::*;
 fn change_descriptor(path:&Path,old_sid:&str){unsafe{
  use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
  #[link(name="advapi32")]extern "system"{fn SetFileSecurityW(path:*const u16,information:u32,descriptor:*mut c_void)->i32;}
  #[link(name="kernel32")]extern "system"{fn LocalFree(value:*mut c_void)->*mut c_void;}
  let before=AppContainer::descriptor(path).unwrap();assert!(before.contains(old_sid));let altered=before.replace(old_sid,"SY");let encoded:Vec<u16>=altered.encode_utf16().chain(Some(0)).collect();let mut descriptor=std::ptr::null_mut();
  assert_ne!(ConvertStringSecurityDescriptorToSecurityDescriptorW(encoded.as_ptr(),1,&mut descriptor,std::ptr::null_mut()),0);
  let path:Vec<u16>=path.to_str().unwrap().encode_utf16().chain(Some(0)).collect();let applied=SetFileSecurityW(path.as_ptr(),4,descriptor);let error=std::io::Error::last_os_error();LocalFree(descriptor);assert_ne!(applied,0,"{error}");
 }}
 fn fixture(label:&str)->(PathBuf,AppContainer,ArchiveBinding){
  assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
  let base=PathBuf::from(std::env::var_os("PP_ARCHIVE_FIXTURE_ROOT").expect("explicit fresh archive fixture required"));let source=base.join(label);fs::create_dir(&source).unwrap();
  let name=format!("perfect-planner.execution.{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());let profile=AppContainer::create_fresh(&name).unwrap();
  let binding=ArchiveBinding{run_id:format!("archive-{label}"),root_identity:"a".repeat(64),candidate_digest:"b".repeat(64),intent_digest:"c".repeat(64)};
  fs::write(base.join(format!("{label}-profile.json")),serde_json::to_vec_pretty(&serde_json::json!({"name":profile.name(),"folder":profile.folder(),"retained":true})).unwrap()).unwrap();
  (source,profile,binding)
 }
 #[test]fn shared_deadline_is_not_renewed_by_validation_or_finalization(){
  let(source,profile,binding)=fixture("shared-deadline");let cancel=AtomicBool::new(false);
  assert!(matches!(RetainedInputs::create_until(&source,&profile,binding.clone(),&cancel,Instant::now()),Err(LIMIT)));
  assert!(!profile.folder().join("inputs").exists());
  let shared=Instant::now()+Duration::from_secs(120);let mut archive=RetainedInputs::create_until(&source,&profile,binding,&cancel,shared).unwrap();
  assert_eq!(archive.deadline,Some(shared));archive.validate(&cancel).unwrap();assert_eq!(archive.deadline,Some(shared));
  // Expire the shared clock without a two-minute test sleep. The real disk
  // archive remains unchanged; validation must not allocate another 120 sec.
  archive.deadline=Some(Instant::now());assert_eq!(archive.validate(&cancel),Err(LIMIT));assert_eq!(archive.finish(&cancel),Err(LIMIT));
 }
 #[test]fn workspace_starts_exact_then_mutates_without_changing_retained_inputs(){
  let(source,profile,binding)=fixture("workspace-copy");fs::create_dir(source.join("empty")).unwrap();fs::write(source.join("input"),b"original").unwrap();let cancel=AtomicBool::new(false);
  let archive=RetainedInputs::create(&source,&profile,binding,&cancel).unwrap();let prepared=archive.prepare_workspace(&profile,8,&cancel,Instant::now()+Duration::from_secs(30)).unwrap();
  assert_eq!(prepared.manifest.archive_digest,archive.digest);assert_eq!(prepared.manifest.total_bytes,8);assert!(prepared.manifest.root.join("empty").is_dir());assert!(!prepared.manifest.execution_authorized);
  assert!(fs::write(prepared.manifest.root.join("input"),b"premature").is_err());
  let working=prepared.release(&cancel).unwrap();fs::write(working.manifest.root.join("input"),b"generated change").unwrap();fs::write(working.manifest.root.join("cache"),b"generated cache").unwrap();
  assert_eq!(fs::read(source.join("input")).unwrap(),b"original");assert_eq!(fs::read(archive.root().join("input")).unwrap(),b"original");archive.validate(&cancel).unwrap();
  assert!(fs::rename(&working.manifest.root,working.manifest.root.with_extension("moved")).is_err());
 }
 #[test]fn workspace_budget_cancel_expiry_and_foreign_profile_refuse_before_creation(){
  for mode in ["budget","cancel","expired","foreign"]{
   let(source,profile,binding)=fixture(&format!("workspace-{mode}"));fs::write(source.join("input"),b"original").unwrap();let cancel=AtomicBool::new(false);let archive=RetainedInputs::create(&source,&profile,binding,&cancel).unwrap();
   if mode=="cancel"{cancel.store(true,Ordering::Release);}let deadline=Instant::now()+if mode=="expired"{Duration::ZERO}else{Duration::from_secs(30)};
   let foreign=if mode=="foreign"{Some(fixture("workspace-other-profile").1)}else{None};let selected=foreign.as_ref().unwrap_or(&profile);
   assert!(archive.prepare_workspace(selected,if mode=="budget"{7}else{8},&cancel,deadline).is_err());assert!(!selected.folder().join("workspace").exists());
  }
 }
 #[test]fn workspace_transient_change_or_expired_release_remains_unresolved(){
  for mode in ["changed","expired"]{
   let(source,profile,binding)=fixture(&format!("workspace-release-{mode}"));fs::write(source.join("input"),b"original").unwrap();let cancel=AtomicBool::new(false);let archive=RetainedInputs::create(&source,&profile,binding,&cancel).unwrap();
   let mut prepared=archive.prepare_workspace(&profile,8,&cancel,Instant::now()+Duration::from_secs(30)).unwrap();let retained=prepared.manifest.root.clone();
   if mode=="changed"{fs::write(retained.join("transient"),b"change").unwrap();fs::remove_file(retained.join("transient")).unwrap();}else{prepared.deadline=Instant::now();}
   assert!(prepared.release(&cancel).is_err());assert_eq!(fs::read(retained.join("input")).unwrap(),b"original");archive.validate(&cancel).unwrap();
  }
 }
 #[test]fn workspace_changed_permissions_prevent_release(){
  let(source,profile,binding)=fixture("workspace-acl");fs::write(source.join("input"),b"original").unwrap();let cancel=AtomicBool::new(false);let archive=RetainedInputs::create(&source,&profile,binding,&cancel).unwrap();
  let prepared=archive.prepare_workspace(&profile,8,&cancel,Instant::now()+Duration::from_secs(30)).unwrap();change_descriptor(&prepared.manifest.root.join("input"),profile.sid_text());assert!(prepared.release(&cancel).is_err());archive.validate(&cancel).unwrap();
 }
 #[test]fn duplicate_workspace_preparation_preserves_first_copy(){
  let(source,profile,binding)=fixture("workspace-duplicate");fs::write(source.join("input"),b"original").unwrap();let cancel=AtomicBool::new(false);let archive=RetainedInputs::create(&source,&profile,binding,&cancel).unwrap();let deadline=Instant::now()+Duration::from_secs(30);
  let prepared=archive.prepare_workspace(&profile,8,&cancel,deadline).unwrap();let manifest=prepared.manifest.clone();let digest=prepared.digest.clone();assert!(archive.prepare_workspace(&profile,8,&cancel,deadline).is_err());
  let released=prepared.release(&cancel).unwrap();assert_eq!(released.manifest,manifest);assert_eq!(released.digest,digest);assert_eq!(fs::read(released.manifest.root.join("input")).unwrap(),b"original");archive.validate(&cancel).unwrap();
 }
 #[test]#[ignore="DANS1 desktop session and actual Node required"]fn actual_isolated_node_writes_only_execution_copy(){
  use std::ffi::OsStr;
  let(source,profile,binding)=fixture("workspace-node");fs::write(source.join("input"),b"original").unwrap();
  fs::write(source.join("check.cjs"),br#"const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');a.equal(fs.readFileSync('input','utf8'),'original');fs.writeFileSync('input','changed by child');fs.mkdirSync('dist');fs.writeFileSync('dist/output','built');a.throws(()=>fs.writeFileSync(p.join(process.env.PP_INPUTS,'input'),'tampered'));a.throws(()=>fs.writeFileSync(p.join(process.env.PP_SOURCE,'input'),'tampered'));console.log('workspace generated; original and archive denied');"#).unwrap();
  let cancel=AtomicBool::new(false);let archive=RetainedInputs::create(&source,&profile,binding,&cancel).unwrap();let prepared=archive.prepare_workspace(&profile,1024*1024,&cancel,Instant::now()+Duration::from_secs(60)).unwrap();let cwd=prepared.manifest.root.clone();
  let runtime=profile.create_readonly_directory("runtime").unwrap();let node=runtime.join("node.exe");fs::copy(std::env::var_os("PP_TEST_AGENT_NODE").unwrap(),&node).unwrap();let script=cwd.join("check.cjs");let system=std::env::var("SystemRoot").unwrap();let mut prepared=Some(prepared);let mut working=None;let mut runtime_guard=None;
  let run=crate::native_task_containment::run_captured_isolated_after_retention(&node,&[OsStr::new("--preserve-symlinks"),OsStr::new("--preserve-symlinks-main"),script.as_os_str()],&cwd,&[("SystemRoot",&system),("WINDIR",&system),("LOCALAPPDATA",profile.folder().to_str().unwrap()),("TEMP",profile.folder().to_str().unwrap()),("TMP",profile.folder().to_str().unwrap()),("PP_INPUTS",archive.root().to_str().unwrap()),("PP_SOURCE",source.to_str().unwrap())],Duration::from_secs(10),8192,8192,16384,Duration::from_secs(120),&cancel,&profile,||{
   runtime_guard=Some(CandidateGuard::acquire(&runtime,&cancel).map_err(std::io::Error::other)?);working=Some(prepared.take().unwrap().release(&cancel).map_err(std::io::Error::other)?);Ok(())
  }).unwrap();
  assert_eq!(run.settlement.exit_code,Some(0),"{}",String::from_utf8_lossy(&run.stderr));assert!(run.settlement.process_exited&&run.settlement.job_empty_observed&&run.settlement.descendants_settled&&run.io_settled&&!run.io_failed);
  assert_eq!(fs::read(cwd.join("input")).unwrap(),b"changed by child");assert_eq!(fs::read(cwd.join("dist/output")).unwrap(),b"built");assert_eq!(fs::read(source.join("input")).unwrap(),b"original");archive.validate(&cancel).unwrap();runtime_guard.unwrap().finish().unwrap();assert!(working.is_some());
 }
 #[test]#[ignore="Explicit disposable DANS1 Boundaries copy and free-space check required"]fn actual_boundaries_archive_and_working_copy(){
  let source=PathBuf::from(std::env::var_os("PP_BOUNDARIES_COPY_SOURCE").expect("explicit disposable source"));
  assert_eq!(source,PathBuf::from(r"C:\Users\danie\Documents\perfect-planner-tests\boundaries-copy-20260927-51\boundary-viewer"));
  let(_,profile,binding)=fixture("boundaries-workspace");let cancel=AtomicBool::new(false);let started=Instant::now();let deadline=started+Duration::from_secs(240);
  let archive=RetainedInputs::create_until(&source,&profile,binding,&cancel,deadline).unwrap();
  eprintln!("Boundaries immutable archive prepared in {} ms",started.elapsed().as_millis());
  assert!(archive.manifest.total_bytes>900_000_000);assert!(archive.manifest.entries.iter().filter(|e|e.kind=="file").count()>50_000);
  let prepared=archive.prepare_workspace(&profile,2*1024*1024*1024,&cancel,deadline).unwrap();eprintln!("Boundaries working copy prepared in {} ms",started.elapsed().as_millis());let working=prepared.release(&cancel).unwrap();
  assert_eq!(archive.manifest.total_bytes,working.manifest.total_bytes);assert_eq!(archive.manifest.entries.len(),working.manifest.entries.len());archive.validate(&cancel).unwrap();
  let evidence=serde_json::json!({"scope":"actual disposable project copy, synthetic binding, no project command executed","source":source,"profile":profile.name(),"archive":archive.root(),"workspace":working.manifest.root,"entries":archive.manifest.entries.len(),"bytes":archive.manifest.total_bytes,"archiveDigest":archive.digest,"initialWorkingCopyDigest":working.digest,"elapsedMs":started.elapsed().as_millis(),"executionAuthorized":false});
  fs::write(PathBuf::from(std::env::var_os("PP_ARCHIVE_FIXTURE_ROOT").unwrap()).join("boundaries-copy-result.json"),serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
 }
 #[test]fn complete_copy_retains_bytes_empty_directories_and_git_metadata(){
  let(source,profile,binding)=fixture("complete");fs::create_dir(source.join("empty")).unwrap();fs::create_dir(source.join(".git")).unwrap();fs::write(source.join(".git/config"),b"inert configuration, never executed").unwrap();fs::write(source.join("input.txt"),b"retained input").unwrap();
  let cancel=AtomicBool::new(false);let archive=RetainedInputs::create(&source,&profile,binding.clone(),&cancel).unwrap();
  assert!(archive.root().join("empty").is_dir());assert_eq!(fs::read(archive.root().join("input.txt")).unwrap(),b"retained input");assert_eq!(archive.manifest.entries.len(),5);assert!(archive.manifest.entries.iter().any(|e|e.path==".git/config"));
  crate::native_host_resources::verify_config_directory(&archive.member("",true).unwrap()).unwrap();
  assert!(archive.member("../outside",false).is_err());assert!(archive.member("input.txt",true).is_err());assert!(archive.member("missing",false).is_err());
  assert!(fs::write(archive.root().join("input.txt"),b"changed").is_err());assert!(fs::rename(archive.root(),archive.root().with_extension("moved")).is_err());archive.validate(&cancel).unwrap();
  let bytes=serde_json::to_vec(&archive.manifest).unwrap();let digest=archive.digest.clone();let file=source.parent().unwrap().join("complete-manifest.json");fs::write(&file,&bytes).unwrap();drop(archive);
  let reopened=RetainedInputs::reopen(&fs::read(file).unwrap(),&digest,&binding,&cancel).unwrap();reopened.validate(&cancel).unwrap();
  let mut wrong=binding.clone();wrong.intent_digest="d".repeat(64);assert!(RetainedInputs::reopen(&bytes,&digest,&wrong,&cancel).is_err());
 }
 #[test]fn alternate_streams_and_hardlinks_are_not_silently_lost(){
  for label in ["stream-file","stream-directory","hardlink"]{
   let(source,profile,binding)=fixture(label);let input=source.join("input");fs::write(&input,b"visible").unwrap();
   if label=="hardlink"{fs::hard_link(&input,source.join("alias")).unwrap();}else{let target=if label=="stream-directory"{&source}else{&input};fs::write(format!("{}:hidden",target.display()),b"hidden input").unwrap();}
   assert!(RetainedInputs::create(&source,&profile,binding,&AtomicBool::new(false)).is_err());
  }
 }
 #[test]fn redirected_source_and_reopened_archive_are_refused(){
  use std::os::windows::process::CommandExt;
  let junction=|link:&Path,target:&Path|{
   let status=std::process::Command::new("cmd.exe").args(["/D","/C","mklink","/J"]).arg(link).arg(target).creation_flags(0x08000000).status().unwrap();
   assert!(status.success(),"actual junction fixture required");
  };
  let(source,profile,binding)=fixture("source-junction");let outside=source.parent().unwrap().join("junction-target");fs::create_dir(&outside).unwrap();fs::write(outside.join("input"),b"outside").unwrap();junction(&source.join("redirect"),&outside);
  assert!(RetainedInputs::create(&source,&profile,binding,&AtomicBool::new(false)).is_err());
  let(source,profile,binding)=fixture("archive-junction");fs::create_dir(source.join("nested")).unwrap();fs::write(source.join("nested/input"),b"original").unwrap();let cancel=AtomicBool::new(false);
  let archive=RetainedInputs::create(&source,&profile,binding.clone(),&cancel).unwrap();let bytes=serde_json::to_vec(&archive.manifest).unwrap();let digest=archive.digest.clone();let root=archive.root().to_path_buf();drop(archive);
  // Preserve the real directory while replacing its old name with a junction.
  fs::rename(root.join("nested"),root.join("retained-nested")).unwrap();junction(&root.join("nested"),&outside);
  assert!(RetainedInputs::reopen(&bytes,&digest,&binding,&cancel).is_err());assert_eq!(fs::read(outside.join("input")).unwrap(),b"outside");
 }
 #[test]fn altered_live_acl_cannot_become_the_initial_archive_policy(){
  let(source,profile,binding)=fixture("policy-before-commit");fs::write(source.join("input"),b"input").unwrap();
  let result=RetainedInputs::create_observed(&source,&profile,binding,&AtomicBool::new(false),||change_descriptor(&profile.folder().join("inputs/input"),profile.sid_text()));
  assert!(result.is_err(),"A descriptor outside the creation policy must not be blessed as a new baseline");
 }
 #[test]fn windows_aliases_are_rejected_before_destination_creation(){
  let root=Path::new("C:\\fixture");for name in ["NUL.txt","COM1.bin","lpt².log","aux","conout$","name.","name ","file:stream","a?b"]{assert!(relative(root,&root.join(name)).is_err(),"{name}");}
  assert!(relative(root,Path::new("C:\\elsewhere\\input")).is_err());assert_eq!(relative(root,&root.join("ordinary/file.txt")).unwrap(),"ordinary/file.txt");
 }
 #[test]fn cancellation_and_destination_change_never_return_a_complete_archive(){
  let(source,profile,binding)=fixture("cancelled");fs::write(source.join("input"),b"input").unwrap();let cancel=AtomicBool::new(false);
  let result=RetainedInputs::create_observed(&source,&profile,binding,&cancel,||cancel.store(true,Ordering::Release));assert!(matches!(result,Err("NATIVE_TASK_ARCHIVE_CANCELLED")));assert_eq!(fs::read(profile.folder().join("inputs/input")).unwrap(),b"input");
  let(source,profile,binding)=fixture("mutated");fs::write(source.join("input"),b"input").unwrap();
  let result=RetainedInputs::create_observed(&source,&profile,binding,&AtomicBool::new(false),||{
   let root=profile.folder().join("inputs");assert!(fs::rename(&root,root.with_extension("moved")).is_err());fs::write(root.join("unexpected"),b"foreign").unwrap();
  });assert!(matches!(result,Err(CHANGED)));
 }
 #[test]fn reopening_rejects_changed_bytes_descriptors_and_extra_entries(){
  for label in ["changed-byte","changed-descriptor","extra-entry"]{
   let(source,profile,binding)=fixture(label);fs::write(source.join("input"),b"input").unwrap();let cancel=AtomicBool::new(false);let archive=RetainedInputs::create(&source,&profile,binding.clone(),&cancel).unwrap();
   let bytes=serde_json::to_vec(&archive.manifest).unwrap();let digest=archive.digest.clone();let root=archive.root().to_path_buf();drop(archive);
   if label=="changed-byte"{fs::write(root.join("input"),b"other").unwrap();}
   else if label=="extra-entry"{fs::write(root.join("extra"),b"extra").unwrap();}
   else{change_descriptor(&root.join("input"),profile.sid_text());}
   assert!(RetainedInputs::reopen(&bytes,&digest,&binding,&cancel).is_err());
  }
 }
}
