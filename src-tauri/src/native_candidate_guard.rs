//! Execution-window input protection. This does not bind the earlier Node
//! snapshot or retain custody through durable output acknowledgment. It cannot
//! confer verification authority. Directory notifications detect namespace changes;
//! they do not prevent additions. Existing regular files deny write/delete.
use std::{collections::HashSet,ffi::c_void,fs::{self,File,OpenOptions},os::windows::{fs::{OpenOptionsExt,MetadataExt},io::AsRawHandle},path::{Path,PathBuf},ptr,time::{Duration,Instant},sync::atomic::{AtomicBool,Ordering}};
type Handle=*mut c_void;
const UNAVAILABLE:&str="NATIVE_TASK_CANDIDATE_GUARD_UNAVAILABLE";
const CHANGED:&str="NATIVE_TASK_CANDIDATE_CHANGED_DURING_EXECUTION";
#[repr(C)]#[derive(Default)]struct Overlapped{internal:usize,internal_high:usize,offset:u32,offset_high:u32,event:Handle}
#[link(name="kernel32")]extern "system"{
 fn CreateEventW(attributes:*const c_void,manual:i32,initial:i32,name:*const u16)->Handle;
 fn CloseHandle(handle:Handle)->i32;
 fn ReadDirectoryChangesW(handle:Handle,output:*mut c_void,output_size:u32,subtree:i32,filter:u32,returned:*mut u32,overlapped:*mut Overlapped,completion:*const c_void)->i32;
 fn GetLastError()->u32;
 fn CancelIoEx(handle:Handle,overlapped:*mut Overlapped)->i32;
 fn GetOverlappedResult(handle:Handle,overlapped:*mut Overlapped,bytes:*mut u32,wait:i32)->i32;
 fn WaitForSingleObject(handle:Handle,milliseconds:u32)->u32;
 fn GetFileInformationByHandle(handle:Handle,info:*mut u32)->i32;
}
struct Directory{path:PathBuf,file:Option<File>,event:Handle,overlapped:Option<Box<Overlapped>>,output:Option<Box<[u32;1024]>>,pending:bool}
impl Directory{
 fn acquire(path:&Path)->Result<Self,&'static str>{
  // Open the reparse point itself, never its target. Deny directory rename.
  let file=OpenOptions::new().read(true).share_mode(3).custom_flags(0x42200000).open(path).map_err(|_|UNAVAILABLE)?;
  let metadata=file.metadata().map_err(|_|UNAVAILABLE)?;
  if !metadata.is_dir()||metadata.file_attributes()&0x400!=0{return Err(UNAVAILABLE);}
  let event=unsafe{CreateEventW(ptr::null(),1,0,ptr::null())};if event.is_null(){return Err(UNAVAILABLE);}
  Ok(Self{path:path.to_path_buf(),file:Some(file),event,overlapped:Some(Box::new(Overlapped{event,..Default::default()})),output:Some(Box::new([0;1024])),pending:false})
 }
 fn arm(&mut self)->Result<(),&'static str>{
  // Names, attributes, size, write/creation time and security; ordinary access
  // timestamps do not affect input identity. Any completion (including overflow
  // or error) invalidates; never rearm or discard a notification as harmless.
  // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw
  let ok=unsafe{ReadDirectoryChangesW(self.file.as_ref().unwrap().as_raw_handle(),self.output.as_mut().unwrap().as_mut_ptr() as *mut c_void,4096,0,0x15f,ptr::null_mut(),self.overlapped.as_mut().unwrap().as_mut(),ptr::null())};
  if ok==0{return Err(UNAVAILABLE);}
  self.pending=true;Ok(())
 }
 fn validate(&self)->Result<(),&'static str>{if !self.pending{return Err(UNAVAILABLE);}match unsafe{WaitForSingleObject(self.event,0)}{258=>Ok(()),0=>Err(CHANGED),_=>Err(UNAVAILABLE)}}
 fn cancel(&mut self){if self.pending{unsafe{CancelIoEx(self.file.as_ref().unwrap().as_raw_handle(),self.overlapped.as_mut().unwrap().as_mut());}}}
 fn settle(&mut self,deadline:Instant)->Result<(),&'static str>{
  if !self.pending{return Ok(());}
  let handle=self.file.as_ref().unwrap().as_raw_handle();let overlap=self.overlapped.as_mut().unwrap().as_mut();
  let remaining=deadline.saturating_duration_since(Instant::now()).as_millis().min(1000) as u32;
  if unsafe{WaitForSingleObject(self.event,remaining)}!=0{return Err(UNAVAILABLE);}
  let mut bytes=0;let ok=unsafe{GetOverlappedResult(handle,overlap,&mut bytes,0)};
  if ok!=0{self.pending=false;return Err(CHANGED);}
  if unsafe{GetLastError()}!=995{return Err(UNAVAILABLE);}
  self.pending=false;Ok(())
 }
}
impl Drop for Directory{
 fn drop(&mut self){
  self.cancel();
  if self.pending&&self.settle(Instant::now()).is_err(){
   // The single-use stdio host owns these buffers until it exits if the OS
   // cannot confirm cancellation. Never free pending kernel I/O memory.
   if let Some(value)=self.overlapped.take(){std::mem::forget(value);}
   if let Some(value)=self.output.take(){std::mem::forget(value);}
   if let Some(value)=self.file.take(){std::mem::forget(value);}
   return;
  }
  unsafe{CloseHandle(self.event);}
 }
}
pub(crate) struct CandidateGuard{directories:Vec<Directory>,files:Vec<File>,settlement_attempted:bool}
impl CandidateGuard{
 pub(crate) fn acquire(root:&Path,cancel:&AtomicBool)->Result<Self,&'static str>{
  Self::acquire_after_pinning(root,cancel,||{})
 }
 fn acquire_after_pinning(root:&Path,cancel:&AtomicBool,before_watch:impl FnOnce())->Result<Self,&'static str>{
  if cancel.load(Ordering::Acquire){return Err("NATIVE_TASK_RUN_UNRESOLVED");}
  crate::native_host_resources::verify_config_directory(root)?;
  let mut guard=Self{directories:Vec::new(),files:Vec::new(),settlement_attempted:false};
  let deadline=Instant::now()+Duration::from_secs(30);let mut bytes=0u64;
  let mut pending=vec![(root.to_path_buf(),0usize)];let mut inventory=HashSet::new();
  while let Some((directory,depth))=pending.pop(){
   if cancel.load(Ordering::Acquire){return Err("NATIVE_TASK_RUN_UNRESOLVED");}
   if Instant::now()>=deadline||depth>128||guard.directories.len()>=8192{return Err(UNAVAILABLE);}
   // First pin names and contents. No execution or snapshot authority exists
   // during acquisition. Watching starts only after every input handle exists.
   guard.directories.push(Directory::acquire(&directory)?);
   for entry in fs::read_dir(&directory).map_err(|_|UNAVAILABLE)?{
    if cancel.load(Ordering::Acquire){return Err("NATIVE_TASK_RUN_UNRESOLVED");}
    if Instant::now()>=deadline{return Err(UNAVAILABLE);}
    let path:PathBuf=entry.map_err(|_|UNAVAILABLE)?.path();
    if !inventory.insert(path.clone()){return Err(UNAVAILABLE);}
    let metadata=fs::symlink_metadata(&path).map_err(|_|UNAVAILABLE)?;
    if metadata.file_attributes()&0x400!=0{return Err(UNAVAILABLE);}
    if metadata.is_dir(){if pending.len()+guard.directories.len()>=8192{return Err(UNAVAILABLE);}pending.push((path,depth+1));continue;}
    if !metadata.is_file()||guard.files.len()>=100000{return Err(UNAVAILABLE);}
    let file=OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(&path).map_err(|_|UNAVAILABLE)?;
    let held=file.metadata().map_err(|_|UNAVAILABLE)?;
    if !held.is_file()||held.file_attributes()&0x400!=0{return Err(UNAVAILABLE);}
    let mut info=[0u32;13];
    if unsafe{GetFileInformationByHandle(file.as_raw_handle(),info.as_mut_ptr())}==0||info[10]!=1{return Err(UNAVAILABLE);}
    bytes=bytes.checked_add(held.len()).ok_or(UNAVAILABLE)?;if bytes>2*1024*1024*1024{return Err(UNAVAILABLE);}
    guard.files.push(file);
   }
  }
  before_watch();
  for directory in &mut guard.directories{
   if Instant::now()>=deadline||cancel.load(Ordering::Acquire){return Err(UNAVAILABLE);}
   directory.arm()?;
  }
  // Close the enumeration-to-watch gap: under active notifications, require
  // exactly the pinned inventory. New entries cannot become unheld inputs.
  let mut observed=HashSet::new();
  for directory in &guard.directories{
   if Instant::now()>=deadline||cancel.load(Ordering::Acquire){return Err(UNAVAILABLE);}
   for entry in fs::read_dir(&directory.path).map_err(|_|UNAVAILABLE)?{
    if Instant::now()>=deadline||cancel.load(Ordering::Acquire){return Err(UNAVAILABLE);}
    let path=entry.map_err(|_|UNAVAILABLE)?.path();
    if !inventory.contains(&path)||!observed.insert(path){return Err(CHANGED);}
   }
  }
  if observed!=inventory{return Err(CHANGED);}
  guard.validate()?;Ok(guard)
 }
 pub(crate) fn validate(&self)->Result<(),&'static str>{for directory in &self.directories{directory.validate()?;}Ok(())}
 pub(crate) fn finish(mut self)->Result<(),&'static str>{
  self.validate()?;
  self.settle_all()
 }
 fn settle_all(&mut self)->Result<(),&'static str>{
  self.settlement_attempted=true;
  // Cancel together, then use one deadline for the entire tree, not one wait
  // per directory. Individual Drop never waits after this shared budget.
  for directory in &mut self.directories{directory.cancel();}
  let deadline=Instant::now()+Duration::from_secs(1);let mut result=Ok(());
  for directory in &mut self.directories{if let Err(error)=directory.settle(deadline){if result.is_ok(){result=Err(error);}}}
  result
 }
}
impl Drop for CandidateGuard{fn drop(&mut self){if !self.settlement_attempted{let _=self.settle_all();}}}

#[cfg(test)]mod tests{
 use super::*;
 fn root(name:&str)->PathBuf{
  assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
  let root=PathBuf::from(std::env::var_os("PP_CUSTODY_PROBE_ROOT").expect("disposable root required")).join(name);fs::create_dir(&root).unwrap();root
 }
 #[test]fn hardlinked_input_is_refused(){
  let root=root("hardlink");fs::write(root.join("input"),b"input").unwrap();fs::hard_link(root.join("input"),root.join("alias")).unwrap();
  assert!(CandidateGuard::acquire(&root,&AtomicBool::new(false)).is_err());
  fs::write(root.join("input"),b"released").unwrap();
 }
 #[test]fn cancellation_refuses_acquisition_before_filesystem_access(){
  let root=root("cancelled").join("does-not-exist");
  assert!(matches!(CandidateGuard::acquire(&root,&AtomicBool::new(true)),Err("NATIVE_TASK_RUN_UNRESOLVED")));
 }
 #[test]fn whole_tree_teardown_releases_files_and_directory_names(){
  let root=root("teardown");
  for index in 0..128{let directory=root.join(index.to_string());fs::create_dir(&directory).unwrap();fs::write(directory.join("input"),b"input").unwrap();}
  let guard=CandidateGuard::acquire(&root,&AtomicBool::new(false)).unwrap();
  assert!(fs::rename(root.join("0"),root.join("renamed")).is_err());
  let start=Instant::now();guard.finish().unwrap();assert!(start.elapsed()<Duration::from_secs(3));
  fs::rename(root.join("0"),root.join("renamed")).unwrap();fs::write(root.join("renamed/input"),b"released").unwrap();
 }
 #[test]fn late_notification_cannot_be_discarded_by_watch_cancellation(){
  let root=root("late-change");let mut guard=CandidateGuard::acquire(&root,&AtomicBool::new(false)).unwrap();
  guard.validate().unwrap();
  fs::write(root.join("late-input"),b"changed after validation").unwrap();
  assert_eq!(guard.settle_all(),Err(CHANGED));
 }
 #[test]fn existing_writable_mapping_refuses_candidate_acquisition(){
  let root=root("mapped-input");let file=root.join("input");fs::write(&file,b"original").unwrap();
  let writer=OpenOptions::new().read(true).write(true).share_mode(7).open(&file).unwrap();
  let mapping=crate::candidate_custody_probe::WritableMapping::open(&writer);drop(writer);
  mapping.write(b"changed!");mapping.write(b"original");
  assert!(matches!(CandidateGuard::acquire(&root,&AtomicBool::new(false)),Err(UNAVAILABLE)));
  drop(mapping);assert_eq!(fs::read(file).unwrap(),b"original");
 }
 #[test]fn new_unheld_input_between_pinning_and_watches_is_refused(){
  let root=root("acquisition-change");fs::write(root.join("original"),b"input").unwrap();
  let result=CandidateGuard::acquire_after_pinning(&root,&AtomicBool::new(false),||{
   fs::write(root.join("unheld"),b"new input").unwrap();
  });
  assert!(matches!(result,Err(CHANGED)));assert_eq!(fs::read(root.join("unheld")).unwrap(),b"new input");
  fs::write(root.join("original"),b"pins released").unwrap();
 }
}
