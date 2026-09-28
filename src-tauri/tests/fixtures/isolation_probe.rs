//! Standalone diagnostic: compile directly with rustc, without the desktop library.
#![cfg(windows)]
use std::{ffi::c_void,io,path::PathBuf};
#[link(name="kernel32")]extern "system"{
    fn OpenProcess(access:u32,inherit:i32,pid:u32)->*mut c_void;
    fn CloseHandle(handle:*mut c_void)->i32;
    fn GetCurrentProcess()->*mut c_void;
}
#[link(name="advapi32")]extern "system"{
    fn OpenProcessToken(process:*mut c_void,access:u32,token:*mut *mut c_void)->i32;
    fn GetTokenInformation(token:*mut c_void,class:u32,data:*mut c_void,length:u32,returned:*mut u32)->i32;
}
fn main(){
    let root=PathBuf::from(std::env::var_os("PP_CONTAINMENT_FIXTURE_ROOT").expect("fixture root"));
    if std::env::var("PP_PROBE_MODE").as_deref()==Ok("permissions"){
        use std::os::windows::fs::OpenOptionsExt;
        #[link(name="advapi32")]extern "system"{fn SetNamedSecurityInfoW(path:*mut u16,kind:u32,info:u32,owner:*mut c_void,group:*mut c_void,dacl:*mut c_void,sacl:*mut c_void)->u32;}
        let runtime=PathBuf::from(std::env::var_os("PP_NODE_RUNTIME").unwrap());
        for path in [root.clone(),root.join("nested"),root.join("nested/input.txt"),runtime.clone(),runtime.join("node.exe")]{
            for access in [0x40000,0x80000]{
                let error=std::fs::OpenOptions::new().access_mode(access).share_mode(7).custom_flags(0x02000000).open(&path).err();
                assert!(error.is_some_and(|e|e.kind()==io::ErrorKind::PermissionDenied),"permission handle allowed: {}",path.display());
            }
            let mut text:Vec<u16>=path.to_str().unwrap().encode_utf16().chain(Some(0)).collect();
            let denied=unsafe{SetNamedSecurityInfoW(text.as_mut_ptr(),1,4,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut())};
            assert_eq!(denied,5,"DACL rewrite was not denied: {}",path.display());
            println!("permission-rewrite-denied={}",path.display());
        }
        assert!(std::fs::write(root.join("nested/input.txt"),b"tampered-after-acl").is_err());
        assert!(std::fs::write(runtime.join("node.exe"),b"tampered-runtime-after-acl").is_err());
        println!("permission-probes=5;write-retry-denied=true");return;
    }
    let evidence=std::env::var_os("PP_OWNER_EVIDENCE").expect("fixture evidence");
    let pid=std::env::var("PP_OWNER_PROCESS").unwrap().parse().unwrap();
    let mode=std::env::var("PP_PROBE_MODE").unwrap_or_default();let app_container;
    unsafe{
        let mut token=std::ptr::null_mut();assert_ne!(OpenProcessToken(GetCurrentProcess(),8,&mut token),0);
        let mut flag=0u32;let mut returned=0;assert_ne!(GetTokenInformation(token,29,(&mut flag as *mut u32).cast(),4,&mut returned),0);
        app_container=flag;eprintln!("diagnostic appcontainer={flag}; root={}",root.display());CloseHandle(token);
    }
    let input=std::fs::read(root.join("input.txt"));eprintln!("diagnostic input={:?}",input.as_ref().map(|bytes|bytes.len()));
    let own_input=input.unwrap()==b"allowed-input";
    let own_output=std::fs::write(root.join("output.txt"),b"allowed-output").is_ok();
    let deny_read=std::fs::read(&evidence).err().is_some_and(|e|e.kind()==io::ErrorKind::PermissionDenied);
    let deny_write=std::fs::write(&evidence,b"tampered-fixture-evidence").err().is_some_and(|e|e.kind()==io::ErrorKind::PermissionDenied);
    let process=unsafe{OpenProcess(0x28,0,pid)};let deny_process=process.is_null()&&io::Error::last_os_error().raw_os_error()==Some(5);
    if !process.is_null(){unsafe{CloseHandle(process);}}
    println!("own-input={own_input};own-output={own_output};deny-read={deny_read};deny-write={deny_write};deny-process={deny_process}");
    assert!(own_input&&own_output);
    if mode=="child"{assert_eq!(app_container,1);assert!(deny_read&&deny_write&&deny_process);println!("descendant-isolated=true");std::thread::sleep(std::time::Duration::from_secs(30));}
    if mode=="wait"{std::fs::write(root.join("cancel-ready"),b"ready").unwrap();std::thread::sleep(std::time::Duration::from_secs(30));}
    if mode=="descendant"{
        use std::os::windows::process::CommandExt;
        let _child=std::process::Command::new(std::env::current_exe().unwrap()).env("PP_PROBE_MODE","child").creation_flags(0x08000000).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
}
