//! Private broker-owned Windows identity. A retained profile is not an execution
//! grant, a runnable candidate archive or an authenticated result receipt.
//! No renderer/MCP profile selection and no ordinary-process fallback.
#![cfg(windows)]
#![allow(dead_code)]
use std::{ffi::c_void,io,mem::size_of,path::{Path,PathBuf},ptr::null_mut};
type Handle=*mut c_void;
#[repr(C)]pub(crate) struct SecurityCapabilities{sid:Handle,capabilities:Handle,count:u32,reserved:u32}
#[link(name="userenv")]extern "system"{
 fn CreateAppContainerProfile(name:*const u16,display:*const u16,description:*const u16,capabilities:Handle,count:u32,sid:*mut Handle)->i32;
 fn GetAppContainerFolderPath(sid:*const u16,path:*mut *mut u16)->i32;
}
#[link(name="advapi32")]extern "system"{
 fn FreeSid(sid:Handle)->Handle;
 fn ConvertSidToStringSidW(sid:Handle,string:*mut *mut u16)->i32;
 fn OpenProcessToken(process:Handle,access:u32,token:*mut Handle)->i32;
 fn GetTokenInformation(token:Handle,class:u32,information:Handle,length:u32,returned:*mut u32)->i32;
 fn EqualSid(a:Handle,b:Handle)->i32;
 fn GetSidSubAuthorityCount(sid:Handle)->*const u8;
 fn GetSidSubAuthority(sid:Handle,index:u32)->*const u32;
}
#[link(name="kernel32")]extern "system"{fn CloseHandle(handle:Handle)->i32;fn LocalFree(value:Handle)->Handle;}
#[link(name="ole32")]extern "system"{fn CoTaskMemFree(value:Handle);}
fn failure(message:&str)->io::Error{io::Error::new(io::ErrorKind::PermissionDenied,message)}
fn wide(value:&str)->Vec<u16>{value.encode_utf16().chain(Some(0)).collect()}
unsafe fn string(value:*const u16)->io::Result<String>{
 if value.is_null(){return Err(failure("missing native identity string"));}
 let mut length=0;while length<32768&&*value.add(length)!=0{length+=1;}
 if length==32768{return Err(failure("native identity string limit"));}
 String::from_utf16(std::slice::from_raw_parts(value,length)).map_err(|_|failure("native identity encoding"))
}
struct Sid(Handle);impl Drop for Sid{fn drop(&mut self){unsafe{FreeSid(self.0);}}}
struct Token(Handle);impl Drop for Token{fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
fn sid_string(sid:Handle)->io::Result<String>{unsafe{
 let mut value=null_mut();if ConvertSidToStringSidW(sid,&mut value)==0{return Err(io::Error::last_os_error());}
 let result=string(value);LocalFree(value.cast());result
}}
fn token_data(token:Handle,class:u32)->io::Result<Vec<usize>>{unsafe{
 let minimum=match class{1|25=>size_of::<Handle>()+size_of::<u32>(),31=>size_of::<Handle>(),21=>1,12|18|20|29|30=>4,_=>return Err(failure("unsupported token information class"))};
 let mut needed=0;GetTokenInformation(token,class,null_mut(),0,&mut needed);
 if (needed as usize)<minimum||needed>65536{return Err(failure(&format!("token information limit: class={class} required={needed} minimum={minimum}")));}
 // DANS1 reports one byte for TokenHasRestrictions despite the documented
 // DWORD contract. Provide a DWORD-sized zeroed buffer and accept only 1/4.
 if class==21{needed=needed.max(4);}
 let mut values=vec![0usize;(needed as usize+size_of::<usize>()-1)/size_of::<usize>()];let mut returned=0;
 if GetTokenInformation(token,class,values.as_mut_ptr().cast(),needed,&mut returned)==0{return Err(io::Error::last_os_error());}
 if (returned as usize)<minimum||returned>needed||(class==21&&!matches!(returned,1|4)){return Err(failure("token information incomplete"));}Ok(values)
}}
pub(crate) struct AppContainer{sid:Sid,name:String,folder:PathBuf,sid_text:String}
impl AppContainer{
 pub(crate) fn create_fresh(name:&str)->io::Result<Self>{
  if !name.starts_with("perfect-planner.execution.")||name.len()>64||name.len()<30||!name.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'.'||b==b'-'){
   return Err(failure("owner-selected AppContainer name invalid"));
  }
  let text=wide(name);let display=wide("Perfect Planner isolated check");let description=wide("Retained execution fixture or approved check storage");let mut sid=null_mut();
  let status=unsafe{CreateAppContainerProfile(text.as_ptr(),display.as_ptr(),description.as_ptr(),null_mut(),0,&mut sid)};
  // Reusing an existing name is not proof of profile ownership. Never derive
  // and silently adopt an existing profile after ERROR_ALREADY_EXISTS.
  if status<0{return Err(failure(&format!("AppContainer creation refused: {status:#x}")));}
  if sid.is_null(){return Err(failure("AppContainer SID missing"));}let sid=Sid(sid);
  let sid_text=sid_string(sid.0)?;let sid_wide=wide(&sid_text);let mut folder=null_mut();
  let status=unsafe{GetAppContainerFolderPath(sid_wide.as_ptr(),&mut folder)};
  if status<0{return Err(failure("AppContainer folder unavailable"));}
  let value=unsafe{string(folder)};unsafe{CoTaskMemFree(folder.cast());}let folder=PathBuf::from(value?);
  if !folder.is_absolute(){return Err(failure("AppContainer folder is not absolute"));}
  use std::os::windows::fs::MetadataExt;
  for ancestor in folder.ancestors(){let metadata=std::fs::symlink_metadata(ancestor)?;if !metadata.is_dir()||metadata.file_attributes()&0x400!=0{return Err(failure("AppContainer folder redirected"));}}
  Ok(Self{sid,name:name.into(),folder,sid_text})
 }
 pub(crate) fn folder(&self)->&Path{&self.folder}
 pub(crate) fn name(&self)->&str{&self.name}
 pub(crate) fn sid_text(&self)->&str{&self.sid_text}
 pub(crate) fn capabilities(&self)->SecurityCapabilities{SecurityCapabilities{sid:self.sid.0,capabilities:null_mut(),count:0,reserved:0}}
 /// Only new children of this fresh owned profile; never changes existing ACLs.
 /// The caller must retain file/directory guards against writable-parent replacement.
 pub(crate) fn create_readonly_directory(&self,name:&str)->io::Result<PathBuf>{unsafe{
  use windows_sys::Win32::Security::{Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,SECURITY_ATTRIBUTES};
  if !matches!(name,"inputs"|"runtime"){return Err(failure("unsupported protected tree"));}
  let mut token=null_mut();if OpenProcessToken(-1isize as Handle,8,&mut token)==0{return Err(io::Error::last_os_error());}let token=Token(token);
  let user=token_data(token.0,1)?;let owner=sid_string(*user.as_ptr().cast::<Handle>())?;
  let sddl=wide(&format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{owner})(A;OICI;FRFX;;;{})",self.sid_text));
  let mut descriptor=null_mut();if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(),1,&mut descriptor,null_mut())==0{return Err(io::Error::last_os_error());}
  struct Memory(Handle);impl Drop for Memory{fn drop(&mut self){unsafe{LocalFree(self.0);}}}let descriptor=Memory(descriptor);
  let security=SECURITY_ATTRIBUTES{nLength:size_of::<SECURITY_ATTRIBUTES>()as u32,lpSecurityDescriptor:descriptor.0,bInheritHandle:0};
  let path=self.folder.join(name);let encoded=wide(path.to_str().ok_or_else(||failure("protected path encoding"))?);
  #[link(name="kernel32")]extern "system"{fn CreateDirectoryW(path:*const u16,attributes:*const SECURITY_ATTRIBUTES)->i32;}
  if CreateDirectoryW(encoded.as_ptr(),&security)==0{return Err(io::Error::last_os_error());}Ok(path)
 }}
 pub(crate) fn descriptor(path:&Path)->io::Result<String>{unsafe{
  use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW,ConvertSecurityDescriptorToStringSecurityDescriptorW};
  let encoded=wide(path.to_str().ok_or_else(||failure("descriptor path encoding"))?);let mut descriptor=null_mut();
  let status=GetNamedSecurityInfoW(encoded.as_ptr(),1,5,null_mut(),null_mut(),null_mut(),null_mut(),&mut descriptor);
  if status!=0{return Err(io::Error::from_raw_os_error(status as i32));}
  let mut text=null_mut();let ok=ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor,1,5,&mut text,null_mut());let error=io::Error::last_os_error();
  LocalFree(descriptor);if ok==0{return Err(error);}let result=string(text);LocalFree(text.cast());result
 }}
 pub(crate) fn verify_process(&self,process:Handle)->io::Result<()>{unsafe{
  let mut token=null_mut();if OpenProcessToken(process,0x8,&mut token)==0{return Err(io::Error::last_os_error());}let token=Token(token);
  let flag=token_data(token.0,29)?;if *flag.as_ptr().cast::<u32>()!=1{return Err(failure("child is not an AppContainer"));}
  let actual=token_data(token.0,31)?;let actual_sid=*actual.as_ptr().cast::<Handle>();
  if actual_sid.is_null()||EqualSid(self.sid.0,actual_sid)==0{return Err(failure("child AppContainer SID mismatch"));}
  let capabilities=token_data(token.0,30)?;if *capabilities.as_ptr().cast::<u32>()!=0{return Err(failure("unexpected child capabilities"));}
  let integrity=token_data(token.0,25)?;let label=*integrity.as_ptr().cast::<Handle>();
  if label.is_null(){return Err(failure("child integrity missing"));}let count=GetSidSubAuthorityCount(label);
  if count.is_null()||*count==0{return Err(failure("child integrity invalid"));}
  let level=GetSidSubAuthority(label,u32::from(*count)-1);if level.is_null()||*level>4096{return Err(failure("child integrity exceeds low"));}
  Ok(())
 }}
}
// Drop frees the SID allocation only. It deliberately does not delete the
// profile or its files; disposal requires the owner's preserve-first workflow.
#[cfg(test)]pub(crate) fn diagnostic_token(process:Handle)->io::Result<serde_json::Value>{unsafe{
 let mut token=null_mut();if OpenProcessToken(process,8,&mut token)==0{return Err(io::Error::last_os_error());}let token=Token(token);
 diagnostic_token_handle(token.0)
}}
#[cfg(test)]unsafe fn diagnostic_token_handle(token:Handle)->io::Result<serde_json::Value>{
 let user=token_data(token,1)?;let user_sid=*user.as_ptr().cast::<Handle>();
 let integrity=token_data(token,25)?;let label=*integrity.as_ptr().cast::<Handle>();
 let number=|class|->io::Result<u32>{let data=token_data(token,class)?;Ok(*data.as_ptr().cast::<u32>())};
 let restriction=token_data(token,21)?;let restricted=*restriction.as_ptr().cast::<u32>();
 Ok(serde_json::json!({"user":sid_string(user_sid)?,"integrity":sid_string(label)?,"session":number(12)?,"elevationType":number(18)?,"elevated":number(20)?,"restricted":restricted,"appContainer":number(29)?}))
}
#[cfg(test)]pub(crate) fn diagnostic_thread()->io::Result<serde_json::Value>{unsafe{
 #[link(name="kernel32")]extern "system"{fn GetCurrentThread()->Handle;}
 #[link(name="advapi32")]extern "system"{fn OpenThreadToken(thread:Handle,access:u32,self_access:i32,token:*mut Handle)->i32;}
 let mut token=null_mut();if OpenThreadToken(GetCurrentThread(),8,1,&mut token)==0{
  let error=io::Error::last_os_error();if error.raw_os_error()==Some(1008){return Ok(serde_json::json!({"noThreadToken":true}));}return Err(error);
 }let token=Token(token);diagnostic_token_handle(token.0)
}}
#[cfg(test)]mod tests{#[test]fn token_diagnostic_current_is_bounded(){assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");println!("{}",super::diagnostic_token(-1isize as super::Handle).unwrap());}}
