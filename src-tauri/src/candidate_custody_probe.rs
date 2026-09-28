//! Native qualification of candidate-change mechanisms, not an execution grant
//! or a complete custody implementation. Directory oplocks are advisory only.
//! https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_request_oplock
use std::{ffi::c_void,fs::{self,File,OpenOptions},os::windows::{fs::OpenOptionsExt,io::AsRawHandle},path::{Path,PathBuf},ptr};

type Handle=*mut c_void;
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
}
struct DirectoryObservation{file:Option<File>,event:Handle,overlapped:Option<Box<Overlapped>>,output:Option<Box<[u8;24]>>,pending:bool}
impl DirectoryObservation{
 fn acquire(path:&Path)->Result<Self,String>{
  let file=OpenOptions::new().read(true).share_mode(7).custom_flags(0x42000000).open(path).map_err(|e|format!("directory open: {e}"))?;
  let event=unsafe{CreateEventW(ptr::null(),1,0,ptr::null())};if event.is_null(){return Err("event creation failed".into());}
  let mut guard=Self{file:Some(file),event,overlapped:Some(Box::new(Overlapped{event,..Default::default()})),output:Some(Box::new([0;24])),pending:false};
  let request=Request{version:1,length:12,level:1,flags:1};
  let ok=unsafe{DeviceIoControl(guard.file.as_ref().unwrap().as_raw_handle(),0x90240,&request as *const _ as *const c_void,12,guard.output.as_mut().unwrap().as_mut_ptr() as *mut c_void,24,ptr::null_mut(),guard.overlapped.as_mut().unwrap().as_mut())};
  let error=unsafe{GetLastError()};
  if ok!=0||error!=997{return Err(format!("oplock not granted: {error}"));}
  guard.pending=true;Ok(guard)
 }
 fn changed(&self)->Result<bool,String>{match unsafe{WaitForSingleObject(self.event,0)}{0=>Ok(true),258=>Ok(false),other=>Err(format!("event read failed: {other}"))}}
 fn wait_changed(&self)->Result<(),String>{if unsafe{WaitForSingleObject(self.event,5000)}==0{Ok(())}else{Err("change signal missing".into())}}
 fn finish(mut self)->Result<(),String>{self.settle()}
 fn settle(&mut self)->Result<(),String>{
  if !self.pending{return Ok(());}
  let handle=self.file.as_ref().unwrap().as_raw_handle();let overlap=self.overlapped.as_mut().unwrap().as_mut();
  unsafe{CancelIoEx(handle,overlap);}
  if unsafe{WaitForSingleObject(self.event,5000)}!=0{return Err("oplock cancellation did not settle".into());}
  let mut bytes=0;let ok=unsafe{GetOverlappedResult(handle,overlap,&mut bytes,0)};let error=unsafe{GetLastError()};
  if ok==0&&error!=995{return Err(format!("oplock completion unavailable: {error}"));}
  self.pending=false;Ok(())
 }
}
impl Drop for DirectoryObservation{
 fn drop(&mut self){
  if self.pending&&self.settle().is_err(){
   // Never free buffers still owned by an overlapped kernel request. A failed
   // probe retains this bounded allocation until its test process exits.
   if let Some(value)=self.overlapped.take(){std::mem::forget(value);}
   if let Some(value)=self.output.take(){std::mem::forget(value);}
   if let Some(value)=self.file.take(){std::mem::forget(value);}
   return;
  }
  unsafe{CloseHandle(self.event);}
 }
}
fn fixture(name:&str)->PathBuf{
 assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
 let parent=PathBuf::from(std::env::var_os("PP_CUSTODY_PROBE_ROOT").expect("explicit disposable probe root"));
 let root=parent.join(name);fs::create_dir(&root).unwrap();root
}
#[test]fn unchanged_directory_read_does_not_invalidate(){
 let root=fixture("unchanged");fs::write(root.join("input.txt"),b"original").unwrap();
 let guard=DirectoryObservation::acquire(&root).unwrap();assert!(!guard.changed().unwrap());
 assert_eq!(fs::read(root.join("input.txt")).unwrap(),b"original");assert!(!guard.changed().unwrap());guard.finish().unwrap();
}
#[test]fn transient_add_delete_invalidates_even_when_inventory_restored(){
 let root=fixture("add-delete");let guard=DirectoryObservation::acquire(&root).unwrap();
 assert!(!guard.changed().unwrap());let added=root.join("transient.txt");fs::write(&added,b"temporary").unwrap();fs::remove_file(added).unwrap();
 assert_eq!(fs::read_dir(&root).unwrap().count(),0);guard.wait_changed().unwrap();assert!(guard.changed().unwrap());guard.finish().unwrap();
}
#[test]fn rename_restore_invalidates_even_when_names_and_bytes_restored(){
 let root=fixture("rename-restore");let original=root.join("input.txt");let renamed=root.join("renamed.txt");fs::write(&original,b"original").unwrap();
 let guard=DirectoryObservation::acquire(&root).unwrap();assert!(!guard.changed().unwrap());fs::rename(&original,&renamed).unwrap();fs::rename(&renamed,&original).unwrap();
 assert_eq!(fs::read(&original).unwrap(),b"original");guard.wait_changed().unwrap();guard.finish().unwrap();
}
#[test]fn held_file_denies_write_and_delete_until_release(){
 let root=fixture("held-file");let file=root.join("input.txt");fs::write(&file,b"original").unwrap();
 let held=OpenOptions::new().read(true).share_mode(1).open(&file).unwrap();
 assert!(fs::write(&file,b"changed").is_err());assert!(fs::remove_file(&file).is_err());assert_eq!(fs::read(&file).unwrap(),b"original");
 drop(held);fs::write(&file,b"released").unwrap();
}
fn child_process(root:&Path,mode:&str){
 use std::{os::windows::process::CommandExt,process::{Command,Stdio},time::{Duration,Instant}};
 let name=concat!(module_path!(),"::mutation_child").split_once("::").unwrap().1;
 let mut child=Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact",name,"--nocapture"])
  .env_clear().env("SystemRoot",std::env::var("SystemRoot").unwrap()).env("PP_CUSTODY_CHILD_ROOT",root).env("PP_CUSTODY_CHILD_MODE",mode)
  .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x08000000).spawn().unwrap();
 let deadline=Instant::now()+Duration::from_secs(5);
 loop{if let Some(status)=child.try_wait().unwrap(){assert!(status.success(),"mutation child failed");break;}
  if Instant::now()>=deadline{child.kill().unwrap();child.wait().unwrap();panic!("mutation child exceeded deadline");}
  std::thread::sleep(Duration::from_millis(10));
 }
}
#[test]fn another_process_cannot_write_a_held_input(){
 let root=fixture("cross-process-held");let file=root.join("input.txt");fs::write(&file,b"original").unwrap();
 let held=OpenOptions::new().read(true).share_mode(1).open(&file).unwrap();child_process(&root,"write-denied");
 assert_eq!(fs::read(&file).unwrap(),b"original");drop(held);
}
#[test]fn another_process_transient_addition_invalidates_directory(){
 let root=fixture("cross-process-transient");let guard=DirectoryObservation::acquire(&root).unwrap();
 assert!(!guard.changed().unwrap());child_process(&root,"add-delete");
 assert_eq!(fs::read_dir(&root).unwrap().count(),0);guard.wait_changed().unwrap();guard.finish().unwrap();
}
#[test]#[ignore="only launched as a bounded inert mutation child"]fn mutation_child(){
 let root=PathBuf::from(std::env::var_os("PP_CUSTODY_CHILD_ROOT").unwrap());
 match std::env::var("PP_CUSTODY_CHILD_MODE").unwrap().as_str(){
  "write-denied"=>assert!(fs::write(root.join("input.txt"),b"changed").is_err()),
  "add-delete"=>{let file=root.join("temporary.txt");fs::write(&file,b"temporary").unwrap();fs::remove_file(file).unwrap();},
  _=>panic!("unknown mutation mode")
 }
}
