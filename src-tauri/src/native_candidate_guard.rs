//! Execution-window input protection. This does not bind the earlier Node
//! snapshot or retain custody through durable output acknowledgment. It cannot
//! confer verification authority. Directory oplocks detect namespace changes;
//! they do not prevent additions. Existing regular files deny write/delete.
use std::{ffi::c_void,fs::{self,File,OpenOptions},os::windows::{fs::{OpenOptionsExt,MetadataExt},io::AsRawHandle},path::{Path,PathBuf},ptr,time::{Duration,Instant},sync::atomic::{AtomicBool,Ordering}};
type Handle=*mut c_void;
const UNAVAILABLE:&str="NATIVE_TASK_CANDIDATE_GUARD_UNAVAILABLE";
const CHANGED:&str="NATIVE_TASK_CANDIDATE_CHANGED_DURING_EXECUTION";
#[repr(C)]struct Request{version:u16,length:u16,level:u32,flags:u32}
#[repr(C)]#[derive(Default)]struct Overlapped{internal:usize,internal_high:usize,offset:u32,offset_high:u32,event:Handle}
#[link(name="kernel32")]extern "system"{
 fn CreateEventW(attributes:*const c_void,manual:i32,initial:i32,name:*const u16)->Handle;
 fn CloseHandle(handle:Handle)->i32;
 fn DeviceIoControl(handle:Handle,code:u32,input:*const c_void,input_size:u32,output:*mut c_void,output_size:u32,returned:*mut u32,overlapped:*mut Overlapped)->i32;
 fn GetLastError()->u32;
 fn CancelIoEx(handle:Handle,overlapped:*mut Overlapped)->i32;
 fn GetOverlappedResult(handle:Handle,overlapped:*mut Overlapped,bytes:*mut u32,wait:i32)->i32;
 fn WaitForSingleObject(handle:Handle,milliseconds:u32)->u32;
 fn GetFileInformationByHandle(handle:Handle,info:*mut u32)->i32;
}
struct Directory{file:Option<File>,event:Handle,overlapped:Option<Box<Overlapped>>,output:Option<Box<[u8;24]>>,pending:bool}
impl Directory{
 fn acquire(path:&Path)->Result<Self,&'static str>{
  // Open the reparse point itself, never its target. Deny directory rename.
  let file=OpenOptions::new().read(true).share_mode(3).custom_flags(0x42200000).open(path).map_err(|_|UNAVAILABLE)?;
  let metadata=file.metadata().map_err(|_|UNAVAILABLE)?;
  if !metadata.is_dir()||metadata.file_attributes()&0x400!=0{return Err(UNAVAILABLE);}
  let event=unsafe{CreateEventW(ptr::null(),1,0,ptr::null())};if event.is_null(){return Err(UNAVAILABLE);}
  let mut guard=Self{file:Some(file),event,overlapped:Some(Box::new(Overlapped{event,..Default::default()})),output:Some(Box::new([0;24])),pending:false};
  let request=Request{version:1,length:12,level:1,flags:1};
  let ok=unsafe{DeviceIoControl(guard.file.as_ref().unwrap().as_raw_handle(),0x90240,&request as *const _ as *const c_void,12,guard.output.as_mut().unwrap().as_mut_ptr() as *mut c_void,24,ptr::null_mut(),guard.overlapped.as_mut().unwrap().as_mut())};
  if ok!=0||unsafe{GetLastError()}!=997{return Err(UNAVAILABLE);}
  guard.pending=true;Ok(guard)
 }
 fn validate(&self)->Result<(),&'static str>{match unsafe{WaitForSingleObject(self.event,0)}{258=>Ok(()),0=>Err(CHANGED),_=>Err(UNAVAILABLE)}}
 fn cancel(&mut self){if self.pending{unsafe{CancelIoEx(self.file.as_ref().unwrap().as_raw_handle(),self.overlapped.as_mut().unwrap().as_mut());}}}
 fn settle(&mut self,deadline:Instant)->Result<(),&'static str>{
  if !self.pending{return Ok(());}
  let handle=self.file.as_ref().unwrap().as_raw_handle();let overlap=self.overlapped.as_mut().unwrap().as_mut();
  let remaining=deadline.saturating_duration_since(Instant::now()).as_millis().min(1000) as u32;
  if unsafe{WaitForSingleObject(self.event,remaining)}!=0{return Err(UNAVAILABLE);}
  let mut bytes=0;let ok=unsafe{GetOverlappedResult(handle,overlap,&mut bytes,0)};
  if ok==0&&unsafe{GetLastError()}!=995{return Err(UNAVAILABLE);}
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
  if cancel.load(Ordering::Acquire){return Err("NATIVE_TASK_RUN_UNRESOLVED");}
  crate::native_host_resources::verify_config_directory(root)?;
  let mut guard=Self{directories:Vec::new(),files:Vec::new(),settlement_attempted:false};
  let deadline=Instant::now()+Duration::from_secs(30);let mut bytes=0u64;
  let mut pending=vec![(root.to_path_buf(),0usize)];
  while let Some((directory,depth))=pending.pop(){
   if cancel.load(Ordering::Acquire){return Err("NATIVE_TASK_RUN_UNRESOLVED");}
   if Instant::now()>=deadline||depth>128||guard.directories.len()>=8192{return Err(UNAVAILABLE);}
   // Watch before listing so even an add/remove that restores the listing is
   // remembered. Parent observation covers races while opening descendants.
   guard.directories.push(Directory::acquire(&directory)?);
   for entry in fs::read_dir(&directory).map_err(|_|UNAVAILABLE)?{
    if cancel.load(Ordering::Acquire){return Err("NATIVE_TASK_RUN_UNRESOLVED");}
    if Instant::now()>=deadline{return Err(UNAVAILABLE);}
    let path:PathBuf=entry.map_err(|_|UNAVAILABLE)?.path();
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
  for directory in &mut self.directories{if directory.settle(deadline).is_err(){result=Err(UNAVAILABLE);}}
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
}
