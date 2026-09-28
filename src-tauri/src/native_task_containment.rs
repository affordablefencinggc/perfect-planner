//! Private Windows process-lifetime primitive. No IPC, admission or task-success authority.
//! JOB_LIST binds containment during creation, including the host-crash window.
//! Default launches retain user permissions. The explicit AppContainer path
//! verifies its restricted token before resume; it never falls back to default.
#![cfg(windows)]
#![allow(dead_code)] // Intentionally not exposed until host admission/custody is connected.

use std::{ffi::{c_void, OsStr}, io, mem::{size_of, zeroed}, os::windows::ffi::OsStrExt,
    path::Path, ptr::{null, null_mut}, time::{Duration, Instant}};
use std::sync::atomic::{AtomicBool,Ordering};
use std::{cell::{Cell,RefCell},collections::HashMap};
use crate::native_app_container::{AppContainer,SecurityCapabilities};
type Handle = *mut c_void;
#[repr(C)] #[derive(Default)]
struct Basic { process_time:i64, job_time:i64, flags:u32, minimum:usize, maximum:usize,
    active:u32, affinity:usize, priority:u32, scheduling:u32 }
#[repr(C)] #[derive(Default)]
struct Extended { basic:Basic, io:[u64;6], process_memory:usize, job_memory:usize,
    peak_process:usize, peak_job:usize }
#[repr(C)] #[derive(Default)]
struct Accounting { user:i64, kernel:i64, period_user:i64, period_kernel:i64,
    faults:u32, total:u32, active:u32, terminated:u32 }
#[repr(C)]
struct Startup { cb:u32, reserved:*mut u16, desktop:*mut u16, title:*mut u16,
    x:u32,y:u32,width:u32,height:u32,chars_x:u32,chars_y:u32,fill:u32,flags:u32,
    show:u16,reserved_len:u16,reserved_bytes:*mut u8,input:Handle,output:Handle,error:Handle }
#[repr(C)] struct StartupEx { base:Startup, attributes:*mut c_void }
#[repr(C)] struct ProcessInfo { process:Handle, thread:Handle, pid:u32, tid:u32 }
#[repr(C)] struct Security {length:u32,descriptor:*mut c_void,inherit:i32}
#[link(name="kernel32")] extern "system" {
    fn CreateJobObjectW(security:Handle,name:*const u16)->Handle;
    fn SetInformationJobObject(job:Handle,class:i32,info:*const c_void,len:u32)->i32;
    fn QueryInformationJobObject(job:Handle,class:i32,info:*mut c_void,len:u32,returned:*mut u32)->i32;
    fn TerminateJobObject(job:Handle,code:u32)->i32;
    fn IsProcessInJob(process:Handle,job:Handle,result:*mut i32)->i32;
    fn CloseHandle(handle:Handle)->i32;
    fn OpenProcess(access:u32,inherit:i32,pid:u32)->Handle;
    fn GetProcessTimes(process:Handle,created:*mut u64,exited:*mut u64,kernel:*mut u64,user:*mut u64)->i32;
    fn InitializeProcThreadAttributeList(list:*mut c_void,count:u32,flags:u32,size:*mut usize)->i32;
    fn UpdateProcThreadAttribute(list:*mut c_void,flags:u32,attribute:usize,value:*mut c_void,
        size:usize,previous:*mut c_void,returned:*mut usize)->i32;
    fn DeleteProcThreadAttributeList(list:*mut c_void);
    fn CreateProcessW(app:*const u16,line:*mut u16,process_security:Handle,thread_security:Handle,
        inherit:i32,flags:u32,env:*const c_void,cwd:*const u16,startup:*const Startup,info:*mut ProcessInfo)->i32;
    fn ResumeThread(thread:Handle)->u32;
    fn WaitForSingleObject(handle:Handle,millis:u32)->u32;
    fn GetExitCodeProcess(process:Handle,code:*mut u32)->i32;
    fn CreatePipe(read:*mut Handle,write:*mut Handle,security:*const Security,size:u32)->i32;
    fn SetHandleInformation(handle:Handle,mask:u32,flags:u32)->i32;
    fn PeekNamedPipe(pipe:Handle,buffer:*mut c_void,size:u32,read:*mut u32,available:*mut u32,left:*mut u32)->i32;
    fn ReadFile(file:Handle,buffer:*mut c_void,size:u32,read:*mut u32,overlapped:*mut c_void)->i32;
}
struct Owned(Handle);
impl Drop for Owned { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
struct Attributes(Vec<usize>);
impl Attributes {
    fn for_job(job:&mut Handle,handles:Option<&mut [Handle;3]>,security:Option<&mut SecurityCapabilities>)->io::Result<Self> { unsafe {
        let count=1+u32::from(handles.is_some())+u32::from(security.is_some());
        let mut bytes=0;
        InitializeProcThreadAttributeList(null_mut(),count,0,&mut bytes);
        if bytes==0 || bytes>65536 { return Err(invalid("attribute allocation")); }
        let mut data=vec![0usize;(bytes+size_of::<usize>()-1)/size_of::<usize>()];
        let ptr=data.as_mut_ptr().cast();
        if InitializeProcThreadAttributeList(ptr,count,0,&mut bytes)==0 { return Err(io::Error::last_os_error()); }
        let result=Self(data);
        // PROC_THREAD_ATTRIBUTE_JOB_LIST = input attribute 13.
        if UpdateProcThreadAttribute(ptr,0,0x0002000d,job as *mut _ as *mut c_void,
            size_of::<Handle>(),null_mut(),null_mut())==0 { return Err(io::Error::last_os_error()); }
        if let Some(handles)=handles {
            if UpdateProcThreadAttribute(ptr,0,0x00020002,handles.as_mut_ptr().cast(),
                size_of::<[Handle;3]>(),null_mut(),null_mut())==0 {return Err(io::Error::last_os_error());}
        }
        if let Some(security)=security{
            // SECURITY_CAPABILITIES remains alive until CreateProcess returns.
            if UpdateProcThreadAttribute(ptr,0,0x00020009,security as *mut _ as *mut c_void,
                size_of::<SecurityCapabilities>(),null_mut(),null_mut())==0{return Err(io::Error::last_os_error());}
        }
        Ok(result)
    }}
    fn ptr(&mut self)->*mut c_void { self.0.as_mut_ptr().cast() }
}
impl Drop for Attributes { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.ptr()); } } }
fn invalid(message:&str)->io::Error { io::Error::new(io::ErrorKind::InvalidInput,message) }
fn wide(value:&OsStr)->io::Result<Vec<u16>> {
    let mut value:Vec<u16>=value.encode_wide().collect();
    if value.contains(&0) { return Err(invalid("embedded null")); }
    value.push(0); Ok(value)
}
// Windows CRT argument quoting; no shell invocation or command expansion.
fn quoted(value:&OsStr)->io::Result<Vec<u16>> {
    let raw=wide(value)?; let mut out=vec![34]; let mut slashes=0;
    for &ch in &raw[..raw.len()-1] {
        if ch==92 { slashes+=1; continue; }
        out.extend(std::iter::repeat(92).take(if ch==34 {slashes*2+1} else {slashes}));
        out.push(ch); slashes=0;
    }
    out.extend(std::iter::repeat(92).take(slashes*2)); out.push(34); Ok(out)
}
// Job accounting can reach zero before a descendant handle becomes signalled.
// This observation is not an all-descendants/I/O cleanup certificate.
#[derive(Debug)] pub(crate) struct Settlement {
    pub process_exited:bool, pub job_empty_observed:bool, pub exit_code:Option<u32>,
    pub descendants_settled:bool,
}
// Owned by one host run, never serializable or constructible by a renderer request.
pub(crate) struct SuspendedTask {
    job:Owned, process:Owned, thread:Owned, resumed:bool,
    members:RefCell<HashMap<(u32,u64),Owned>>, membership_observed:Cell<bool>,
}
impl SuspendedTask {
    pub(crate) fn create(executable:&Path,args:&[&OsStr],cwd:&Path,
        environment:&[(&str,&str)],max_processes:u32,memory_bytes:usize)->io::Result<Self> {
        Self::create_inner(executable,args,cwd,environment,max_processes,memory_bytes,Duration::from_secs(120),None,None)
    }
    fn create_inner(executable:&Path,args:&[&OsStr],cwd:&Path,
        environment:&[(&str,&str)],max_processes:u32,memory_bytes:usize,cpu_time:Duration,mut stdio:Option<[Handle;3]>,isolation:Option<&AppContainer>)->io::Result<Self> {
        if !executable.is_absolute() || !cwd.is_absolute() || !(1..=64).contains(&max_processes)
            || !(16*1024*1024..=4usize*1024*1024*1024).contains(&memory_bytes)
            ||cpu_time<Duration::from_millis(1)||cpu_time>Duration::from_secs(120) {
            return Err(invalid("bounded absolute launch inputs required"));
        }
        let app=wide(executable.as_os_str())?; let directory=wide(cwd.as_os_str())?;
        let mut line=quoted(executable.as_os_str())?;
        for arg in args { line.push(32); line.extend(quoted(arg)?); }
        line.push(0); if line.len()>32767 { return Err(invalid("command line limit")); }
        let mut vars=environment.to_vec();vars.sort_by_key(|(k,_)|k.to_ascii_uppercase());
        let mut env=Vec::new(); let mut previous=None;
        for (key,value) in vars {
            let normalized=key.to_ascii_uppercase();
            if key.is_empty() || !key.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_')
                || previous.as_ref()==Some(&normalized) { return Err(invalid("environment key")); }
            env.extend(wide(OsStr::new(&format!("{key}={value}")))?);previous=Some(normalized);
        }
        env.push(0); if env.len()==1 {env.push(0);}
        if env.len()>32767 {return Err(invalid("environment limit"));}
        unsafe {
            let handle=CreateJobObjectW(null_mut(),null());
            if handle.is_null() { return Err(io::Error::last_os_error()); }
            let job=Owned(handle);let mut limit=Extended::default();
            // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS | JOB_MEMORY | JOB_TIME.
            // Native Job time is USER time; the runner also observes user+kernel.
            limit.basic.flags=0x2000|0x8|0x200|0x4;limit.basic.active=max_processes;limit.job_memory=memory_bytes;
            limit.basic.job_time=(cpu_time.as_millis()as i64)*10000;
            if SetInformationJobObject(job.0,9,&limit as *const _ as *const c_void,size_of::<Extended>()as u32)==0 {
                return Err(io::Error::last_os_error());
            }
            let mut job_handle=job.0;let mut security=isolation.map(AppContainer::capabilities);
            let mut attributes=Attributes::for_job(&mut job_handle,stdio.as_mut(),security.as_mut())?;
            let mut startup:StartupEx=zeroed();startup.base.cb=size_of::<StartupEx>()as u32;
            startup.attributes=attributes.ptr(); let mut info:ProcessInfo=zeroed();
            if let Some(handles)=stdio {startup.base.flags=0x100;startup.base.input=handles[0];startup.base.output=handles[1];startup.base.error=handles[2];}
            // Suspended + Unicode environment + extended startup + no console.
            // Captured mode inherits ONLY its three explicit pipe handles via HANDLE_LIST.
            // Otherwise inheritance is FALSE. Explicit environment in either mode.
            if CreateProcessW(app.as_ptr(),line.as_mut_ptr(),null_mut(),null_mut(),i32::from(stdio.is_some()),
                0x4|0x400|0x80000|0x08000000,env.as_ptr().cast(),directory.as_ptr(),&startup.base,&mut info)==0 {
                return Err(io::Error::last_os_error());
            }
            let result=Self{job,process:Owned(info.process),thread:Owned(info.thread),resumed:false,
                members:RefCell::new(HashMap::new()),membership_observed:Cell::new(true)};
            let mut inside=0;
            if IsProcessInJob(result.process.0,result.job.0,&mut inside)==0 || inside!=1 {
                return Err(io::Error::new(io::ErrorKind::Other,"containment observation failed"));
            }
            if let Some(profile)=isolation{profile.verify_process(result.process.0)?;}
            #[cfg(test)]if let Some(root)=std::env::var_os("PP_ISOLATION_DIAGNOSTIC_ROOT"){
                let data=serde_json::json!({"parent":crate::native_app_container::diagnostic_token(-1isize as Handle)?,"thread":crate::native_app_container::diagnostic_thread()?,"child":crate::native_app_container::diagnostic_token(result.process.0)?,"isolatedRequested":isolation.is_some()});
                std::fs::write(std::path::PathBuf::from(root).join(format!("token-{}.json",info.pid)),serde_json::to_vec_pretty(&data)?)?;
            }
            result.observe_members();
            Ok(result)
        }
    }
    pub(crate) fn resume(&mut self)->io::Result<()> {
        if self.resumed {return Err(invalid("already resumed"));}
        // An unexpected suspend count is uncertainty, not a safe retry.
        self.resumed=true;
        if unsafe {ResumeThread(self.thread.0)}!=1 {
            unsafe {TerminateJobObject(self.job.0,1);}
            return Err(io::Error::new(io::ErrorKind::Other,"resume uncertain"));
        } Ok(())
    }
    pub(crate) fn wait(&self,timeout:Duration)->io::Result<bool> {
        if timeout>Duration::from_secs(30) {return Err(invalid("bounded wait required"));}
        match unsafe{WaitForSingleObject(self.process.0,timeout.as_millis()as u32)} {
            0=>Ok(true),258=>Ok(false),_=>Err(io::Error::last_os_error())
        }
    }
    fn accounting(&self)->Option<Accounting> {unsafe {
        let mut a=Accounting::default();
        if QueryInformationJobObject(self.job.0,1,&mut a as *mut _ as *mut c_void,
            size_of::<Accounting>()as u32,null_mut())==0 {None} else {Some(a)}
    }}
    fn active(&self)->Option<u32> {self.accounting().map(|value|value.active)}
    // Hold a handle to every observed member. PID reuse cannot satisfy an old
    // member because each handle is keyed by its process creation time.
    // A process that exits between inventory and OpenProcess is uncertainty,
    // even if accounting already says the job is empty.
    fn observe_members(&self) {unsafe {
        let mut buffer=[0usize;66];
        if QueryInformationJobObject(self.job.0,3,buffer.as_mut_ptr().cast(),
            size_of::<[usize;66]>() as u32,null_mut())==0 {
            self.membership_observed.set(false);return;
        }
        let header=buffer.as_ptr().cast::<u32>();
        let assigned=*header as usize;let count=*header.add(1) as usize;
        if assigned!=count||count>64 {self.membership_observed.set(false);return;}
        let pids=buffer.as_ptr().cast::<u8>().add(8).cast::<usize>();
        for index in 0..count {
            let raw=*pids.add(index);
            if raw==0||raw>u32::MAX as usize {self.membership_observed.set(false);continue;}
            let pid=raw as u32;
            let handle=OpenProcess(0x00101000,0,pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
            if handle.is_null(){self.membership_observed.set(false);continue;}
            let handle=Owned(handle);let mut inside=0;
            let(mut created,mut exited,mut kernel,mut user)=(0u64,0u64,0u64,0u64);
            if IsProcessInJob(handle.0,self.job.0,&mut inside)==0||inside!=1
                ||GetProcessTimes(handle.0,&mut created,&mut exited,&mut kernel,&mut user)==0 {
                self.membership_observed.set(false);continue;
            }
            let mut members=self.members.borrow_mut();
            if !members.contains_key(&(pid,created)) {
                if members.len()>=4096{self.membership_observed.set(false);continue;}
                members.insert((pid,created),handle);
            }
        }
    }}
    fn descendants_settled(&self)->bool {
        if !self.membership_observed.get(){return false;}
        let members=self.members.borrow();
        let Some(accounting)=self.accounting() else{return false;};
        accounting.active==0&&accounting.total as usize==members.len()
            &&members.values().all(|handle|unsafe{WaitForSingleObject(handle.0,0)}==0)
    }
    pub(crate) fn stop_and_observe(&self)->Settlement {
        self.observe_members();
        unsafe {TerminateJobObject(self.job.0,1);}
        let deadline=Instant::now()+Duration::from_secs(3);
        loop {
            let process_exited=self.wait(Duration::ZERO).unwrap_or(false);
            let job_empty_observed=self.active()==Some(0);
            self.observe_members();
            let descendants_settled=self.descendants_settled();
            let coverage_missing=!self.membership_observed.get()
                ||self.accounting().map(|a|a.total as usize!=self.members.borrow().len()).unwrap_or(true);
            if (process_exited&&job_empty_observed&&(descendants_settled||coverage_missing))||Instant::now()>=deadline {
                let mut code=0;
                let exit_code=if process_exited&&unsafe{GetExitCodeProcess(self.process.0,&mut code)}!=0 {Some(code)} else {None};
                return Settlement{process_exited,job_empty_observed,exit_code,descendants_settled};
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for SuspendedTask {fn drop(&mut self){unsafe{TerminateJobObject(self.job.0,1);}}}

fn pipe(parent_reads:bool)->io::Result<(Owned,Owned)> {unsafe {
    let mut read=null_mut();let mut write=null_mut();
    let security=Security{length:size_of::<Security>()as u32,descriptor:null_mut(),inherit:1};
    if CreatePipe(&mut read,&mut write,&security,0)==0 {return Err(io::Error::last_os_error());}
    let read=Owned(read);let write=Owned(write);
    if SetHandleInformation(if parent_reads{read.0}else{write.0},1,0)==0 {return Err(io::Error::last_os_error());}
    Ok((read,write))
}}
struct Capture {read:Owned,bytes:Vec<u8>,observed:u64,eof:bool}
impl Capture {
    fn poll(&mut self,limit:usize,remaining:&mut usize)->io::Result<bool> {unsafe {
        if self.eof{return Ok(false);}
        let mut available=0;
        if PeekNamedPipe(self.read.0,null_mut(),0,null_mut(),&mut available,null_mut())==0 {
            let error=io::Error::last_os_error();
            if error.raw_os_error()==Some(109){self.eof=true;return Ok(false);}
            return Err(error);
        }
        if available==0{return Ok(false);}
        let mut buffer=[0u8;8192];let mut read=0;
        if ReadFile(self.read.0,buffer.as_mut_ptr().cast(),available.min(buffer.len()as u32),&mut read,null_mut())==0 {
            return Err(io::Error::last_os_error());
        }
        self.observed=self.observed.saturating_add(read as u64);
        let accepted=(read as usize).min(limit.saturating_sub(self.bytes.len())).min(*remaining);
        self.bytes.extend_from_slice(&buffer[..accepted]);*remaining-=accepted;
        Ok(accepted<read as usize)
    }}
}
#[derive(Debug)] pub(crate) struct CapturedRun {
    pub stdout:Vec<u8>,pub stderr:Vec<u8>,pub stdout_observed:u64,pub stderr_observed:u64,
    pub timed_out:bool,pub output_truncated:bool,pub io_settled:bool,pub io_failed:bool,
    pub cancel_observed:bool,pub cpu_time_exceeded:bool,pub cpu_observation_failed:bool,
    pub cpu_ticks_observed:Option<u64>,
    pub settlement:Settlement,
}
// Host-only runner. Not an admission API, and still no full cleanup or success certificate.
pub(crate) fn run_captured(executable:&Path,args:&[&OsStr],cwd:&Path,environment:&[(&str,&str)],
    timeout:Duration,stream_limit:usize,combined_limit:usize)->io::Result<CapturedRun> {
    run_captured_controlled(executable,args,cwd,environment,timeout,stream_limit,combined_limit,
        Duration::from_secs(120),&AtomicBool::new(false))
}
pub(crate) fn run_captured_controlled(executable:&Path,args:&[&OsStr],cwd:&Path,environment:&[(&str,&str)],
    timeout:Duration,stream_limit:usize,combined_limit:usize,cpu_time:Duration,cancel:&AtomicBool)->io::Result<CapturedRun> {
    run_captured_limits(executable,args,cwd,environment,timeout,stream_limit,stream_limit,combined_limit,cpu_time,cancel)
}
// The reviewed contract owns each stream's limit independently. Applying the
// larger limit to both streams would allow output beyond the approved budget.
pub(crate) fn run_captured_limits(executable:&Path,args:&[&OsStr],cwd:&Path,environment:&[(&str,&str)],
    timeout:Duration,stdout_limit:usize,stderr_limit:usize,combined_limit:usize,cpu_time:Duration,cancel:&AtomicBool)->io::Result<CapturedRun> {
    run_captured_inner(executable,args,cwd,environment,timeout,stdout_limit,stderr_limit,combined_limit,cpu_time,cancel,None)
}
pub(crate) fn run_captured_isolated(executable:&Path,args:&[&OsStr],cwd:&Path,environment:&[(&str,&str)],
    timeout:Duration,stdout_limit:usize,stderr_limit:usize,combined_limit:usize,cpu_time:Duration,cancel:&AtomicBool,profile:&AppContainer)->io::Result<CapturedRun> {
    run_captured_inner(executable,args,cwd,environment,timeout,stdout_limit,stderr_limit,combined_limit,cpu_time,cancel,Some(profile))
}
fn run_captured_inner(executable:&Path,args:&[&OsStr],cwd:&Path,environment:&[(&str,&str)],
    timeout:Duration,stdout_limit:usize,stderr_limit:usize,combined_limit:usize,cpu_time:Duration,cancel:&AtomicBool,isolation:Option<&AppContainer>)->io::Result<CapturedRun> {
    if timeout.is_zero()||timeout>Duration::from_secs(300)||stdout_limit==0||stdout_limit>2*1024*1024
        ||stderr_limit==0||stderr_limit>2*1024*1024||combined_limit==0||combined_limit>2*1024*1024
        ||combined_limit>stdout_limit+stderr_limit{return Err(invalid("run limits"));}
    if cancel.load(Ordering::Acquire){return Err(io::Error::new(io::ErrorKind::Interrupted,"cancelled before native start"));}
    let (input,input_writer)=pipe(false)?;drop(input_writer); // Closed stdin, never an interactive prompt.
    let (out_read,out_write)=pipe(true)?;let (err_read,err_write)=pipe(true)?;
    let child=SuspendedTask::create_inner(executable,args,cwd,environment,16,512*1024*1024,cpu_time,
        Some([input.0,out_write.0,err_write.0]),isolation)?;
    drop(input);drop(out_write);drop(err_write);
    let stdout=Capture{read:out_read,bytes:Vec::new(),observed:0,eof:false};
    let stderr=Capture{read:err_read,bytes:Vec::new(),observed:0,eof:false};
    capture_prepared(child,stdout,stderr,timeout,stdout_limit,stderr_limit,combined_limit,cpu_time,cancel)
}
// Consumes an already suspended, Job-bound task and its explicit output pipes.
// Caller retains any input/runtime custody until the returned settlement is checked.
fn capture_prepared(mut child:SuspendedTask,mut stdout:Capture,mut stderr:Capture,
    timeout:Duration,stdout_limit:usize,stderr_limit:usize,combined_limit:usize,cpu_time:Duration,cancel:&AtomicBool)->io::Result<CapturedRun>{
    let mut remaining=combined_limit;let mut output_truncated=false;let mut io_failed=false;
    // A child exists now: cancellation must observe termination and drain its
    // pipes instead of returning through a Drop that merely requests a kill.
    let mut cancel_observed=cancel.load(Ordering::Acquire);let mut cpu_time_exceeded=false;let mut cpu_observation_failed=false;let mut cpu_ticks_observed=None;
    let started=Instant::now();if !cancel_observed{child.resume()?;}let mut timed_out=false;
    while !cancel_observed {
        for (capture,limit) in [(&mut stdout,stdout_limit),(&mut stderr,stderr_limit)] {
            match capture.poll(limit,&mut remaining){Ok(overflow)=>output_truncated|=overflow,Err(_)=>io_failed=true}
        }
        match child.accounting(){
            Some(a) if a.user>=0&&a.kernel>=0=>{
                let ticks=(a.user as u64).saturating_add(a.kernel as u64);cpu_ticks_observed=Some(ticks);
                cpu_time_exceeded=ticks>=cpu_time.as_millis()as u64*10000;
            },_=>cpu_observation_failed=true,
        }
        child.observe_members();
        if cancel.load(Ordering::Acquire){cancel_observed=true;break;}
        if cpu_time_exceeded||cpu_observation_failed{break;}
        // Test elapsed time even under continuous output. Exit alone never drains descendants.
        if started.elapsed()>=timeout{timed_out=true;break;}
        if output_truncated||io_failed||child.wait(Duration::ZERO)?{break;}
        std::thread::sleep(Duration::from_millis(2));
    }
    let settlement=child.stop_and_observe();
    // Re-read final accounting: native quota termination can race the last poll.
    match child.accounting(){
        Some(a) if a.user>=0&&a.kernel>=0=>{
            let ticks=(a.user as u64).saturating_add(a.kernel as u64).max(cpu_ticks_observed.unwrap_or(0));
            cpu_ticks_observed=Some(ticks);cpu_time_exceeded|=ticks>=cpu_time.as_millis()as u64*10000;
        },_=>cpu_observation_failed=true,
    }
    let deadline=Instant::now()+Duration::from_secs(3);
    while !(stdout.eof&&stderr.eof)&&Instant::now()<deadline&&!io_failed {
        for (capture,limit) in [(&mut stdout,stdout_limit),(&mut stderr,stderr_limit)] {
            match capture.poll(limit,&mut remaining){Ok(overflow)=>output_truncated|=overflow,Err(_)=>io_failed=true}
        }
        if !(stdout.eof&&stderr.eof){std::thread::sleep(Duration::from_millis(2));}
    }
    Ok(CapturedRun{stdout:stdout.bytes,stderr:stderr.bytes,stdout_observed:stdout.observed,
        stderr_observed:stderr.observed,timed_out,output_truncated,io_settled:stdout.eof&&stderr.eof&&!io_failed,
        io_failed,settlement,cancel_observed,cpu_time_exceeded,cpu_observation_failed,cpu_ticks_observed})
}

#[cfg(test)] mod tests {
    use super::*;
    fn host(){assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");}
    fn root()->std::path::PathBuf {host();std::env::var_os("PP_CONTAINMENT_FIXTURE_ROOT").expect("explicit fresh fixture root").into()}
    fn fixture_name()->&'static str {concat!(module_path!(),"::fixture").split_once("::").unwrap().1}
    fn captured(mode:&str,timeout:Duration,stream:usize,total:usize)->CapturedRun {
        let root=root();let system=std::env::var("SystemRoot").unwrap();
        run_captured(&std::env::current_exe().unwrap(),&[OsStr::new("--ignored"),OsStr::new("--exact"),OsStr::new(fixture_name()),OsStr::new("--nocapture")],
            &root,&[("SystemRoot",&system),("PP_FIXTURE_MODE",mode),("PP_CONTAINMENT_FIXTURE_ROOT",root.to_str().unwrap())],timeout,stream,total).unwrap()
    }
    fn controlled(mode:&str,cpu:Duration,cancel:&AtomicBool)->io::Result<CapturedRun>{
        let root=root();let system=std::env::var("SystemRoot").unwrap();
        run_captured_controlled(&std::env::current_exe().unwrap(),&[OsStr::new("--ignored"),OsStr::new("--exact"),OsStr::new(fixture_name()),OsStr::new("--nocapture")],
            &root,&[("SystemRoot",&system),("PP_FIXTURE_MODE",mode),("PP_CONTAINMENT_FIXTURE_ROOT",root.to_str().unwrap())],Duration::from_secs(5),8192,16384,cpu,cancel)
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn cancellation_before_start_runs_no_fixture(){
        let marker=root().join("never-started");assert!(!marker.exists());
        let error=controlled("never-started",Duration::from_secs(2),&AtomicBool::new(true)).unwrap_err();
        assert_eq!(error.kind(),io::ErrorKind::Interrupted);assert!(!marker.exists());
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn cancellation_after_preparation_settles_without_resume(){
        let root=root();let marker=root.join("never-started");assert!(!marker.exists());let system=std::env::var("SystemRoot").unwrap();
        let (stdin,writer)=pipe(false).unwrap();drop(writer);let (out,ow)=pipe(true).unwrap();let (err,ew)=pipe(true).unwrap();
        let child=SuspendedTask::create_inner(&std::env::current_exe().unwrap(),&[OsStr::new("--ignored"),OsStr::new("--exact"),OsStr::new(fixture_name()),OsStr::new("--nocapture")],&root,
            &[("SystemRoot",&system),("PP_FIXTURE_MODE","never-started"),("PP_CONTAINMENT_FIXTURE_ROOT",root.to_str().unwrap())],4,128*1024*1024,Duration::from_secs(2),Some([stdin.0,ow.0,ew.0]),None).unwrap();
        assert!(!child.resumed);drop(stdin);drop(ow);drop(ew);
        let capture=|read|Capture{read,bytes:Vec::new(),observed:0,eof:false};
        let run=capture_prepared(child,capture(out),capture(err),Duration::from_secs(5),8192,8192,16384,Duration::from_secs(2),&AtomicBool::new(true)).unwrap();
        assert!(run.cancel_observed&&!run.timed_out&&!run.io_failed&&run.io_settled);
        assert!(run.settlement.process_exited&&run.settlement.job_empty_observed&&run.settlement.descendants_settled);
        assert_ne!(run.settlement.exit_code,Some(0));assert!(run.stdout.is_empty()&&run.stderr.is_empty());assert!(!marker.exists());
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn cancellation_after_start_observes_exit_and_pipes(){
        let marker=root().join("cancel-ready");assert!(!marker.exists());let cancel=AtomicBool::new(false);
        let run=std::thread::scope(|scope|{
            let observer=scope.spawn(||{let deadline=Instant::now()+Duration::from_secs(4);
                while !marker.exists()&&Instant::now()<deadline{std::thread::sleep(Duration::from_millis(2));}
                let ready=marker.exists();cancel.store(true,Ordering::Release);assert!(ready);
            });
            let run=controlled("cancel-wait",Duration::from_secs(2),&cancel).unwrap();observer.join().unwrap();run
        });
        assert!(run.cancel_observed&&!run.timed_out&&!run.io_failed&&run.io_settled);
        assert!(run.settlement.process_exited&&run.settlement.job_empty_observed);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn cpu_budget_stops_busy_child_before_wall_deadline(){
        let run=controlled("busy",Duration::from_millis(50),&AtomicBool::new(false)).unwrap();
        assert!(!run.timed_out&&!run.cancel_observed&&!run.cpu_observation_failed);
        assert!(run.cpu_time_exceeded);assert!(run.cpu_ticks_observed.unwrap()>=500000);
        assert!(run.settlement.process_exited&&run.settlement.job_empty_observed&&run.io_settled);
        assert_ne!(run.settlement.exit_code,Some(0));
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn captured_output_and_stdin_eof(){
        let run=captured("output",Duration::from_secs(5),8192,16384);
        assert!(String::from_utf8_lossy(&run.stdout).contains("fixture-out"));
        assert!(String::from_utf8_lossy(&run.stderr).contains("fixture-error"));
        assert!(!run.timed_out&&!run.output_truncated&&!run.io_failed&&run.io_settled);assert_eq!(run.settlement.exit_code,Some(0));
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn asymmetric_reviewed_output_budgets_are_enforced(){
        for (out,err) in [(512,4096),(4096,512)] {
            let root=root();let system=std::env::var("SystemRoot").unwrap();
            let run=run_captured_limits(&std::env::current_exe().unwrap(),&[OsStr::new("--ignored"),OsStr::new("--exact"),OsStr::new(fixture_name()),OsStr::new("--nocapture")],
                &root,&[("SystemRoot",&system),("PP_FIXTURE_MODE","both-streams"),("PP_CONTAINMENT_FIXTURE_ROOT",root.to_str().unwrap())],Duration::from_secs(5),out,err,out+err,Duration::from_secs(2),&AtomicBool::new(false)).unwrap();
            assert!(run.stdout.len()<=out&&run.stderr.len()<=err);
            if out==512{assert_eq!(run.stdout.len(),512);}else{assert_eq!(run.stderr.len(),512);}
            assert!(run.output_truncated&&run.io_settled&&!run.io_failed);
            assert!(run.settlement.process_exited&&run.settlement.job_empty_observed);
        }
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn maximum_reviewed_limits_admit_a_short_child(){
        let run=captured("output",Duration::from_secs(300),2*1024*1024,2*1024*1024);
        assert_eq!(run.settlement.exit_code,Some(0));assert!(run.io_settled&&!run.output_truncated&&!run.timed_out);
        assert!(run.settlement.process_exited&&run.settlement.job_empty_observed);
    }
    #[test] fn invalid_reviewed_limits_refuse_before_process_creation(){
        host();
        for (ms,out,err,total) in [(300001,1,1,2),(0,1,1,2),(1,0,1,1),(1,1,0,1),(1,2097153,1,1),(1,1,2097153,1),(1,1,1,3),(1,1,1,0)]{
            let error=run_captured_limits(Path::new("absent.exe"),&[],Path::new("."),&[],Duration::from_millis(ms),out,err,total,Duration::from_secs(1),&AtomicBool::new(false)).unwrap_err();
            assert_eq!(error.to_string(),"run limits");
        }
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn noisy_output_is_bounded_and_settled(){
        let run=captured("noisy",Duration::from_secs(5),1024,1536);
        assert!(run.output_truncated&&run.io_settled);assert!(run.stdout.len()<=1024&&run.stderr.len()<=1024);
        assert!(run.stdout.len()+run.stderr.len()<=1536);assert!(run.settlement.process_exited&&run.settlement.job_empty_observed);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn captured_timeout_closes_descendant_output(){
        let run=captured("inherited-output",Duration::from_millis(500),8192,16384);
        assert!(run.timed_out&&run.io_settled&&!run.io_failed);assert!(run.settlement.process_exited&&run.settlement.job_empty_observed);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn parent_exit_cleans_inherited_output(){
        let run=captured("orphan-output",Duration::from_secs(5),8192,16384);
        assert!(!run.timed_out&&run.io_settled&&!run.io_failed);
        assert!(String::from_utf8_lossy(&run.stdout).contains("descendant-started"));
        assert_eq!(run.settlement.exit_code,Some(0));assert!(run.settlement.job_empty_observed);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn failed_exit_is_not_replaced_by_cleanup_code(){
        let run=captured("failed-exit",Duration::from_secs(5),8192,16384);
        assert_eq!(run.settlement.exit_code,Some(7));assert!(!run.timed_out&&!run.io_failed&&run.io_settled);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn combined_output_cap_is_independent(){
        let run=captured("noisy",Duration::from_secs(5),8192,300);
        assert!(run.output_truncated&&run.io_settled);
        assert_eq!(run.stdout.len()+run.stderr.len(),300);
    }
    fn child(mode:&str,processes:u32)->SuspendedTask {
        child_limited(mode,processes,256*1024*1024)
    }
    fn child_limited(mode:&str,processes:u32,memory:usize)->SuspendedTask {
        let root=root();let executable=std::env::current_exe().unwrap();
        let system=std::env::var("SystemRoot").unwrap();
        SuspendedTask::create(&executable,&[OsStr::new("--ignored"),OsStr::new("--exact"),OsStr::new(fixture_name())],
            &root,&[("SystemRoot",&system),("PP_FIXTURE_MODE",mode),("PP_CONTAINMENT_FIXTURE_ROOT",root.to_str().unwrap())],
            processes,memory).unwrap()
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn memory_cap_refuses_large_commit(){
        let mut c=child_limited("memory",4,32*1024*1024);
        let mut limit=Extended::default();
        assert_ne!(unsafe{QueryInformationJobObject(c.job.0,9,&mut limit as *mut _ as *mut c_void,size_of::<Extended>()as u32,null_mut())},0);
        assert_eq!(limit.job_memory,32*1024*1024);assert_ne!(limit.basic.flags&0x200,0);
        c.resume().unwrap();assert!(c.wait(Duration::from_secs(5)).unwrap());
        let settled=c.stop_and_observe();assert!(settled.process_exited&&settled.job_empty_observed);assert_eq!(settled.exit_code,Some(0));
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn suspended_until_resume_and_one_shot(){
        let marker=root().join("entered-marker");assert!(!marker.exists());
        let mut c=child("marker",4);assert_eq!(c.active(),Some(1));
        assert!(!c.wait(Duration::from_millis(100)).unwrap());assert!(!marker.exists());
        c.resume().unwrap();assert!(c.resume().is_err());assert!(c.wait(Duration::from_secs(10)).unwrap());
        assert_eq!(std::fs::read_to_string(marker).unwrap(),"entered");
        let s=c.stop_and_observe();assert!(s.process_exited&&s.job_empty_observed);assert_eq!(s.exit_code,Some(0));
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn timeout_settles_contained_descendants(){
        let mut c=child("descendant",4);c.resume().unwrap();
        let deadline=Instant::now()+Duration::from_secs(10);
        while c.active()!=Some(2)&&Instant::now()<deadline {std::thread::sleep(Duration::from_millis(5));}
        assert_eq!(c.active(),Some(2));assert!(!c.wait(Duration::from_millis(20)).unwrap());
        let s=c.stop_and_observe();assert!(s.process_exited&&s.job_empty_observed);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn parent_exit_does_not_mean_descendants_settled(){
        let mut c=child("orphan",4);c.resume().unwrap();assert!(c.wait(Duration::from_secs(10)).unwrap());
        let pid:u32=std::fs::read_to_string(root().join("orphan-pid")).unwrap().parse().unwrap();
        #[link(name="kernel32")] extern "system" {fn OpenProcess(access:u32,inherit:i32,pid:u32)->Handle;}
        let descendant=Owned(unsafe{OpenProcess(0x00100000,0,pid)});
        assert!(!descendant.0.is_null());assert_eq!(unsafe{WaitForSingleObject(descendant.0,0)},258);
        assert!(c.active().unwrap()>0);let s=c.stop_and_observe();
        assert!(s.process_exited&&s.job_empty_observed);assert_eq!(s.exit_code,Some(0));
        assert!(s.descendants_settled);
        assert_eq!(unsafe{WaitForSingleObject(descendant.0,0)},0);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn unobserved_short_lived_descendant_is_not_certified(){
        let mut c=child("brief-parent",4);c.resume().unwrap();
        assert!(c.wait(Duration::from_secs(10)).unwrap());
        assert_eq!(c.members.borrow().len(),1);
        assert!(c.accounting().unwrap().total>1,"The real child must leave unobserved membership");
        let settled=c.stop_and_observe();
        assert!(settled.process_exited&&settled.job_empty_observed);
        assert!(!settled.descendants_settled);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn observed_root_handle_settles_without_turning_failure_into_success(){
        let mut c=child("failed-exit",4);c.resume().unwrap();
        assert!(c.wait(Duration::from_secs(10)).unwrap());
        let settled=c.stop_and_observe();
        assert_eq!(settled.exit_code,Some(7));assert!(settled.descendants_settled);
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn process_cap_prevents_descendant(){
        let mut c=child("cap",1);c.resume().unwrap();assert!(c.wait(Duration::from_secs(10)).unwrap());
        let s=c.stop_and_observe();assert!(s.process_exited&&s.job_empty_observed);assert_eq!(s.exit_code,Some(0));
    }
    #[test] #[ignore="Requires explicit fresh DANS1 containment fixture"] fn invalid_launch_is_refused(){
        let root=root();assert!(SuspendedTask::create(Path::new("relative.exe"),&[],&root,&[],1,32*1024*1024).is_err());
        assert!(SuspendedTask::create(&root.join("absent.exe"),&[],&root,&[],1,32*1024*1024).is_err());
        assert!(SuspendedTask::create(&std::env::current_exe().unwrap(),&[],&root,&[("A","1"),("a","2")],1,32*1024*1024).is_err());
    }
    #[test] #[ignore="Requires explicit fresh DANS1 isolation fixture"] fn isolated_check_cannot_read_or_modify_owner_evidence(){
        let owner=root();let name=format!("perfect-planner.execution.{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        std::fs::write(owner.join("profile-name.txt"),&name).unwrap();
        let profile=AppContainer::create_fresh(&name).unwrap();
        std::fs::write(owner.join("profile.json"),serde_json::to_vec_pretty(&serde_json::json!({"name":profile.name(),"sid":profile.sid_text(),"folder":profile.folder(),"retained":true})).unwrap()).unwrap();
        assert!(AppContainer::create_fresh(&name).is_err());
        let work=profile.folder().join("work");std::fs::create_dir(&work).unwrap();
        let executable=work.join("isolation-probe.exe");std::fs::copy(std::env::current_exe().unwrap(),&executable).unwrap();
        let evidence=owner.join("owner-evidence.txt");std::fs::write(&evidence,b"retained-owner-evidence").unwrap();
        std::fs::write(work.join("input.txt"),b"allowed-input").unwrap();
        let system=std::env::var("SystemRoot").unwrap();let pid=std::process::id().to_string();
        // Windows may create Temp with the fresh profile. Inspect either case.
        let temp=profile.folder().join("Temp");std::fs::create_dir_all(&temp).unwrap();
        use std::os::windows::fs::MetadataExt;
        let metadata=std::fs::symlink_metadata(&temp).unwrap();assert!(metadata.is_dir()&&metadata.file_attributes()&0x400==0);
        let path=Path::new(&system).join("System32");let comspec=path.join("cmd.exe");
        let environment=[("SystemRoot",system.as_str()),("WINDIR",system.as_str()),("ComSpec",comspec.to_str().unwrap()),
            ("PATH",path.to_str().unwrap()),("PATHEXT",".COM;.EXE;.BAT;.CMD"),("LOCALAPPDATA",profile.folder().to_str().unwrap()),
            ("TEMP",temp.to_str().unwrap()),("TMP",temp.to_str().unwrap()),
            ("PP_FIXTURE_MODE","isolation-probe"),("PP_CONTAINMENT_FIXTURE_ROOT",work.to_str().unwrap()),("PP_OWNER_EVIDENCE",evidence.to_str().unwrap()),("PP_OWNER_PROCESS",pid.as_str())];
        std::fs::write(owner.join("launch-environment.json"),serde_json::to_vec_pretty(&environment).unwrap()).unwrap();
        let run=run_captured_isolated(&executable,&[OsStr::new("--ignored"),OsStr::new("--exact"),OsStr::new(fixture_name()),OsStr::new("--nocapture")],
            &work,&environment,Duration::from_secs(10),8192,8192,16384,Duration::from_secs(2),&AtomicBool::new(false),&profile).unwrap();
        assert_eq!(run.settlement.exit_code,Some(0));assert!(run.settlement.descendants_settled&&run.io_settled&&!run.io_failed);
        let stdout=String::from_utf8(run.stdout).unwrap();std::fs::write(owner.join("isolation-child-output.txt"),&stdout).unwrap();
        assert!(stdout.contains("own-input=true;own-output=true;deny-read=true;deny-write=true;deny-process=true"),"{stdout}");
        assert_eq!(std::fs::read(&evidence).unwrap(),b"retained-owner-evidence");
        assert_eq!(std::fs::read(work.join("output.txt")).unwrap(),b"allowed-output");
    }
    #[test] #[ignore="Requires independently compiled DANS1 diagnostic helper"] fn standalone_isolated_check_denies_owner_access(){
        let owner=root();let source=std::path::PathBuf::from(std::env::var_os("PP_TEST_ISOLATION_PROBE").expect("explicit standalone helper required"));
        assert!(source.is_absolute()&&source.is_file());
        let name=format!("perfect-planner.execution.{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        std::fs::write(owner.join("profile-name.txt"),&name).unwrap();let profile=AppContainer::create_fresh(&name).unwrap();
        assert!(AppContainer::create_fresh(&name).is_err());
        std::fs::write(owner.join("profile.json"),serde_json::to_vec_pretty(&serde_json::json!({"name":profile.name(),"sid":profile.sid_text(),"folder":profile.folder(),"retained":true})).unwrap()).unwrap();
        let work=profile.folder().join("work");std::fs::create_dir(&work).unwrap();
        let executable=work.join("isolation-probe.exe");std::fs::copy(&source,&executable).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(),std::fs::read(&executable).unwrap());
        let temp=profile.folder().join("Temp");std::fs::create_dir_all(&temp).unwrap();
        use std::os::windows::fs::MetadataExt;
        let metadata=std::fs::symlink_metadata(&temp).unwrap();assert!(metadata.is_dir()&&metadata.file_attributes()&0x400==0);
        let system=std::env::var("SystemRoot").unwrap();let pid=std::process::id().to_string();
        let path=Path::new(&system).join("System32");let comspec=path.join("cmd.exe");
        let evidence=owner.join("owner-evidence.txt");std::fs::write(&evidence,b"retained-owner-evidence").unwrap();
        std::fs::write(work.join("input.txt"),b"allowed-input").unwrap();
        let environment=[("SystemRoot",system.as_str()),("WINDIR",system.as_str()),("ComSpec",comspec.to_str().unwrap()),
            ("PATH",path.to_str().unwrap()),("PATHEXT",".COM;.EXE;.BAT;.CMD"),("LOCALAPPDATA",profile.folder().to_str().unwrap()),("TEMP",temp.to_str().unwrap()),("TMP",temp.to_str().unwrap()),
            ("PP_CONTAINMENT_FIXTURE_ROOT",work.to_str().unwrap()),("PP_OWNER_EVIDENCE",evidence.to_str().unwrap()),("PP_OWNER_PROCESS",pid.as_str())];
        std::fs::write(owner.join("launch-environment.json"),serde_json::to_vec_pretty(&environment).unwrap()).unwrap();
        // Identical bytes, cwd, environment and Job settings. The ordinary image
        // stays in the owner fixture: the profile copy's low label lowers its
        // process integrity even without an AppContainer launch attribute.
        std::fs::write(owner.join("image-paths.json"),serde_json::to_vec_pretty(&serde_json::json!({"ordinary":source,"isolated":executable,"sameBytes":true})).unwrap()).unwrap();
        let ordinary=run_captured_limits(&source,&[],&work,&environment,Duration::from_secs(10),8192,8192,16384,Duration::from_secs(2),&AtomicBool::new(false)).unwrap();
        std::fs::write(owner.join("ordinary-output.txt"),&ordinary.stdout).unwrap();
        std::fs::write(owner.join("ordinary-error.txt"),&ordinary.stderr).unwrap();
        assert_eq!(ordinary.settlement.exit_code,Some(0));assert!(ordinary.settlement.descendants_settled&&ordinary.io_settled&&!ordinary.io_failed);
        assert!(String::from_utf8(ordinary.stdout).unwrap().contains("own-input=true;own-output=true;deny-read=false;deny-write=false;deny-process=false"));
        assert_eq!(std::fs::read(&evidence).unwrap(),b"tampered-fixture-evidence");
        std::fs::write(&evidence,b"retained-owner-evidence").unwrap();std::fs::write(work.join("output.txt"),b"reset-control-output").unwrap();
        let isolated=run_captured_isolated(&executable,&[],&work,&environment,Duration::from_secs(10),8192,8192,16384,Duration::from_secs(2),&AtomicBool::new(false),&profile).unwrap();
        std::fs::write(owner.join("isolated-output.txt"),&isolated.stdout).unwrap();std::fs::write(owner.join("isolated-error.txt"),&isolated.stderr).unwrap();
        assert_eq!(isolated.settlement.exit_code,Some(0));assert!(isolated.settlement.descendants_settled&&isolated.io_settled&&!isolated.io_failed);
        assert!(String::from_utf8(isolated.stdout).unwrap().contains("own-input=true;own-output=true;deny-read=true;deny-write=true;deny-process=true"));
        assert_eq!(std::fs::read(&evidence).unwrap(),b"retained-owner-evidence");assert_eq!(std::fs::read(work.join("output.txt")).unwrap(),b"allowed-output");
        assert!(!isolated.timed_out&&!isolated.output_truncated&&!isolated.cancel_observed&&!isolated.cpu_time_exceeded&&!isolated.cpu_observation_failed);
        // Token mismatch cannot be accepted merely because some AppContainer exists.
        assert!(profile.verify_process(-1isize as Handle).is_err());
        let other=AppContainer::create_fresh(&format!("{name}-other")).unwrap();
        std::fs::write(owner.join("other-profile.json"),serde_json::to_vec_pretty(&serde_json::json!({"name":other.name(),"sid":other.sid_text(),"folder":other.folder(),"retained":true})).unwrap()).unwrap();
        let suspended=SuspendedTask::create_inner(&executable,&[],&work,&environment,4,128*1024*1024,Duration::from_secs(2),None,Some(&profile)).unwrap();
        assert!(profile.verify_process(suspended.process.0).is_ok());assert!(other.verify_process(suspended.process.0).is_err());
        let settled=suspended.stop_and_observe();assert!(settled.process_exited&&settled.job_empty_observed&&settled.descendants_settled);
        let stopped=run_captured_isolated(&executable,&[],&work,&environment,Duration::from_secs(10),8192,8192,16384,Duration::from_secs(2),&AtomicBool::new(true),&profile).unwrap_err();
        assert_eq!(stopped.kind(),io::ErrorKind::Interrupted);
        let marker=work.join("cancel-ready");let cancel=AtomicBool::new(false);let mut waiting=environment.to_vec();waiting.push(("PP_PROBE_MODE","wait"));
        let cancelled=std::thread::scope(|scope|{
            let observer=scope.spawn(||{let deadline=Instant::now()+Duration::from_secs(4);while !marker.exists()&&Instant::now()<deadline{std::thread::sleep(Duration::from_millis(2));}let ready=marker.exists();cancel.store(true,Ordering::Release);assert!(ready);});
            let run=run_captured_isolated(&executable,&[],&work,&waiting,Duration::from_secs(8),8192,8192,16384,Duration::from_secs(2),&cancel,&profile).unwrap();observer.join().unwrap();run
        });
        std::fs::write(owner.join("cancelled.txt"),format!("{cancelled:?}")).unwrap();
        assert!(cancelled.cancel_observed&&!cancelled.timed_out&&!cancelled.io_failed&&cancelled.io_settled&&cancelled.settlement.descendants_settled);
        let mut descendants=environment.to_vec();descendants.push(("PP_PROBE_MODE","descendant"));
        let timed=run_captured_isolated(&executable,&[],&work,&descendants,Duration::from_secs(2),8192,8192,16384,Duration::from_secs(2),&AtomicBool::new(false),&profile).unwrap();
        std::fs::write(owner.join("descendant-timeout.txt"),format!("{timed:?}")).unwrap();
        assert!(timed.timed_out&&!timed.io_failed&&timed.io_settled&&timed.settlement.descendants_settled);
        assert!(String::from_utf8(timed.stdout).unwrap().contains("descendant-isolated=true"));
        assert_eq!(std::fs::read(&evidence).unwrap(),b"retained-owner-evidence");
    }
    #[test] #[ignore="Requires fresh DANS1 runtime metadata diagnostic"] fn suspended_runtime_metadata_is_observed_without_execution(){
        use sha2::{Digest,Sha256};
        use std::os::windows::{fs::OpenOptionsExt,io::AsRawHandle};
        #[repr(C)] #[derive(Default)] struct FileBasic {created:i64,accessed:i64,written:i64,changed:i64,attributes:u32}
        #[link(name="kernel32")] extern "system" {fn GetFileInformationByHandleEx(file:Handle,class:i32,info:*mut c_void,size:u32)->i32;}
        let owner=root();let name=format!("perfect-planner.execution.{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let profile=AppContainer::create_fresh(&name).unwrap();
        std::fs::write(owner.join("profile.json"),serde_json::to_vec_pretty(&serde_json::json!({"name":profile.name(),"sid":profile.sid_text(),"folder":profile.folder(),"retained":true})).unwrap()).unwrap();
        let runtime=profile.create_readonly_directory("runtime").unwrap();let input=profile.create_readonly_directory("inputs").unwrap();
        let node=runtime.join("node.exe");let source=std::path::PathBuf::from(std::env::var_os("PP_TEST_AGENT_NODE").unwrap());std::fs::copy(&source,&node).unwrap();
        let digest=format!("{:x}",Sha256::digest(std::fs::read(&source).unwrap()));
        let _pins=crate::native_host_resources::pin_task_files(&node,&digest,profile.folder(),&input).unwrap();
        let cancel=AtomicBool::new(false);let guard=crate::native_candidate_guard::CandidateGuard::acquire(&runtime,&cancel).unwrap();
        let temp=profile.folder().join("Temp");std::fs::create_dir_all(&temp).unwrap();let marker=profile.folder().join("must-not-execute.txt");
        let system=std::env::var("SystemRoot").unwrap();let sys32=Path::new(&system).join("System32");let comspec=sys32.join("cmd.exe");
        let snapshot=|label:&str|{
            let file=std::fs::OpenOptions::new().read(true).share_mode(7).open(&node).unwrap();let mut basic=FileBasic::default();
            assert_ne!(unsafe{GetFileInformationByHandleEx(file.as_raw_handle(),0,&mut basic as *mut _ as *mut c_void,size_of::<FileBasic>()as u32)},0);
            let ea=std::process::Command::new(sys32.join("fsutil.exe")).args([OsStr::new("file"),OsStr::new("queryEA"),node.as_os_str()]).output().unwrap();
            let report=serde_json::json!({"node":node,"sha256":format!("{:x}",Sha256::digest(std::fs::read(&node).unwrap())),"created":basic.created,"accessed":basic.accessed,"written":basic.written,"changed":basic.changed,"attributes":basic.attributes,"eaExit":ea.status.code(),"ea":String::from_utf8_lossy(&ea.stdout),"eaError":String::from_utf8_lossy(&ea.stderr),"eaOutputHash":format!("{:x}",Sha256::digest(&ea.stdout)),"notifications":guard.diagnostic_notifications(),"markerExists":marker.exists()});
            std::fs::write(owner.join(format!("suspended-{label}.json")),serde_json::to_vec_pretty(&report).unwrap()).unwrap();report
        };
        let before=snapshot("before");
        let environment=[("SystemRoot",system.as_str()),("WINDIR",system.as_str()),("ComSpec",comspec.to_str().unwrap()),("PATH",sys32.to_str().unwrap()),("LOCALAPPDATA",profile.folder().to_str().unwrap()),("TEMP",temp.to_str().unwrap()),("TMP",temp.to_str().unwrap()),("PP_TEST_MARKER",marker.to_str().unwrap())];
        let task=SuspendedTask::create_inner(&node,&[OsStr::new("-e"),OsStr::new("require('node:fs').writeFileSync(process.env.PP_TEST_MARKER,'unexpected')")],&input,&environment,2,256*1024*1024,Duration::from_secs(10),None,Some(&profile)).unwrap();
        let after=snapshot("created");assert!(!task.resumed);assert!(!marker.exists());assert_eq!(before["sha256"],after["sha256"]);assert_eq!(after["sha256"],digest);
        let settled=task.stop_and_observe();assert!(settled.process_exited&&settled.job_empty_observed&&settled.descendants_settled);assert!(!marker.exists());
        snapshot("stopped");
        std::fs::write(owner.join("diagnostic-scope.txt"),"Suspended metadata observation only. No resume, no runtime guard success claimed, no product authority.").unwrap();
    }
    #[test] #[ignore="Requires real copied Node runtime on DANS1"] fn node_runtime_protects_inputs_and_separates_outputs(){
        use sha2::{Digest,Sha256};
        let owner=root();let name=format!("perfect-planner.execution.{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        std::fs::write(owner.join("profile-name.txt"),&name).unwrap();let profile=AppContainer::create_fresh(&name).unwrap();
        std::fs::write(owner.join("profile.json"),serde_json::to_vec_pretty(&serde_json::json!({"name":profile.name(),"sid":profile.sid_text(),"folder":profile.folder(),"retained":true})).unwrap()).unwrap();
        let input=profile.create_readonly_directory("inputs").unwrap();let runtime=profile.create_readonly_directory("runtime").unwrap();
        assert!(profile.create_readonly_directory("inputs").is_err());assert!(profile.create_readonly_directory("../foreign").is_err());
        let output=profile.folder().join("output");std::fs::create_dir(&output).unwrap();let temp=profile.folder().join("Temp");std::fs::create_dir_all(&temp).unwrap();
        std::fs::create_dir(input.join("nested")).unwrap();std::fs::write(input.join("nested/input.txt"),b"allowed-input").unwrap();
        std::fs::write(input.join("nested/dependency.cjs"),b"module.exports=41;").unwrap();
        let node=runtime.join("node.exe");let source=std::path::PathBuf::from(std::env::var_os("PP_TEST_AGENT_NODE").unwrap());assert!(source.is_absolute());std::fs::copy(&source,&node).unwrap();
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),Sha256::digest(std::fs::read(&node).unwrap()));
        let helper=runtime.join("permission-probe.exe");std::fs::copy(std::env::var_os("PP_TEST_ISOLATION_PROBE").unwrap(),&helper).unwrap();
        let script=runtime.join("probe.cjs");std::fs::write(&script,include_str!("../tests/fixtures/isolation_probe.cjs")).unwrap();
        let benign_script=runtime.join("benign.cjs");std::fs::write(&benign_script,b"const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');a.equal(fs.readFileSync(p.join(process.env.PP_NODE_INPUT,'nested/input.txt'),'utf8'),'allowed-input');a.equal(require(p.join(process.env.PP_NODE_INPUT,'nested/dependency.cjs')),41);fs.writeFileSync(p.join(process.env.PP_NODE_OUTPUT,'benign.txt'),'benign-output');console.log('benign-node-complete');").unwrap();
        let paths=vec![input.clone(),input.join("nested"),input.join("nested/input.txt"),input.join("nested/dependency.cjs"),runtime.clone(),node.clone(),helper.clone(),script.clone(),benign_script.clone()];
        let descriptors=||paths.iter().map(|path|serde_json::json!({"path":path,"descriptor":AppContainer::descriptor(path).unwrap(),"sha256":if path.is_file(){Some(format!("{:x}",Sha256::digest(std::fs::read(path).unwrap())))}else{None}})).collect::<Vec<_>>();
        let metadata=||{use std::os::windows::fs::MetadataExt;paths.iter().map(|path|{let m=std::fs::metadata(path).unwrap();serde_json::json!({"path":path,"attributes":m.file_attributes(),"created":m.creation_time(),"written":m.last_write_time(),"accessed":m.last_access_time(),"bytes":m.file_size()})}).collect::<Vec<_>>()};
        std::fs::write(owner.join("metadata-before.json"),serde_json::to_vec_pretty(&metadata()).unwrap()).unwrap();
        let before=descriptors();std::fs::write(owner.join("protected-before.json"),serde_json::to_vec_pretty(&before).unwrap()).unwrap();
        let node_digest=format!("{:x}",Sha256::digest(std::fs::read(&node).unwrap()));
        let _ancestor_pins=crate::native_host_resources::pin_task_files(&node,&node_digest,profile.folder(),&input).unwrap();
        let cancel=AtomicBool::new(false);let inputs_guard=crate::native_candidate_guard::CandidateGuard::acquire(&input,&cancel).unwrap();let runtime_guard=crate::native_candidate_guard::CandidateGuard::acquire(&runtime,&cancel).unwrap();
        let phase=|name:&str|{std::fs::write(owner.join(format!("notifications-{name}.json")),serde_json::to_vec_pretty(&serde_json::json!({"input":inputs_guard.diagnostic_notifications(),"runtime":runtime_guard.diagnostic_notifications(),"metadata":metadata()})).unwrap()).unwrap();};
        phase("before");
        let system=std::env::var("SystemRoot").unwrap();let path=Path::new(&system).join("System32");let comspec=path.join("cmd.exe");
        let evidence=owner.join("owner-evidence.txt");std::fs::write(&evidence,b"retained-owner-evidence").unwrap();
        let environment=[("SystemRoot",system.as_str()),("WINDIR",system.as_str()),("ComSpec",comspec.to_str().unwrap()),("PATH",path.to_str().unwrap()),("PATHEXT",".COM;.EXE;.BAT;.CMD"),
            ("LOCALAPPDATA",profile.folder().to_str().unwrap()),("TEMP",temp.to_str().unwrap()),("TMP",temp.to_str().unwrap()),("PP_NODE_INPUT",input.to_str().unwrap()),("PP_NODE_RUNTIME",runtime.to_str().unwrap()),("PP_NODE_OUTPUT",output.to_str().unwrap()),("PP_OWNER_EVIDENCE",evidence.to_str().unwrap()),("PP_CONTAINMENT_FIXTURE_ROOT",input.to_str().unwrap())];
        std::fs::write(owner.join("launch-environment.json"),serde_json::to_vec_pretty(&environment).unwrap()).unwrap();
        // These flags are part of this qualified invocation. Link/reparse
        // refusal and held guards precede use; no global drive grants are added.
        let args=[OsStr::new("--preserve-symlinks"),OsStr::new("--preserve-symlinks-main"),script.as_os_str()];
        std::fs::write(owner.join("node-args.json"),serde_json::to_vec_pretty(&args.iter().map(|a|a.to_str().unwrap()).collect::<Vec<_>>()).unwrap()).unwrap();
        let benign=run_captured_isolated(&node,&[args[0],args[1],benign_script.as_os_str()],&input,&environment,Duration::from_secs(10),8192,8192,16384,Duration::from_secs(3),&cancel,&profile).unwrap();
        std::fs::write(owner.join("benign-output.txt"),&benign.stdout).unwrap();std::fs::write(owner.join("benign-error.txt"),&benign.stderr).unwrap();
        phase("after-benign");assert_eq!(benign.settlement.exit_code,Some(0));assert!(benign.settlement.descendants_settled&&benign.io_settled&&!benign.io_failed);
        assert_eq!(std::fs::read(output.join("benign.txt")).unwrap(),b"benign-output");inputs_guard.validate().unwrap();runtime_guard.validate().unwrap();
        let run=run_captured_isolated(&node,&args,&input,&environment,Duration::from_secs(10),8192,8192,16384,Duration::from_secs(3),&cancel,&profile).unwrap();
        std::fs::write(owner.join("node-output.txt"),&run.stdout).unwrap();std::fs::write(owner.join("node-error.txt"),&run.stderr).unwrap();
        std::fs::write(owner.join("node-settlement.txt"),format!("{run:?}")).unwrap();
        phase("after-node");
        assert_eq!(run.settlement.exit_code,Some(0));assert!(run.settlement.descendants_settled&&run.io_settled&&!run.io_failed&&!run.timed_out&&!run.output_truncated);
        let result:serde_json::Value=serde_json::from_slice(&run.stdout).unwrap();assert_eq!(result["denied"].as_array().unwrap().len(),14);
        let mut permissions=environment.to_vec();permissions.push(("PP_PROBE_MODE","permissions"));
        let acl=run_captured_isolated(&helper,&[],&input,&permissions,Duration::from_secs(10),8192,8192,16384,Duration::from_secs(3),&cancel,&profile).unwrap();
        std::fs::write(owner.join("permission-output.txt"),&acl.stdout).unwrap();std::fs::write(owner.join("permission-error.txt"),&acl.stderr).unwrap();
        phase("after-permissions");
        assert_eq!(acl.settlement.exit_code,Some(0));assert!(acl.settlement.descendants_settled&&acl.io_settled&&!acl.io_failed);
        assert!(String::from_utf8(acl.stdout).unwrap().contains("permission-probes=5;write-retry-denied=true"));
        assert_eq!(std::fs::read(&evidence).unwrap(),b"retained-owner-evidence");assert_eq!(std::fs::read(output.join("output.txt")).unwrap(),b"allowed-output");
        let after=descriptors();std::fs::write(owner.join("protected-after.json"),serde_json::to_vec_pretty(&after).unwrap()).unwrap();assert_eq!(before,after);
        phase("after-descriptors");
        inputs_guard.finish().unwrap();runtime_guard.finish().unwrap();
    }
    #[test] #[ignore="Requires real copied Node runtime on DANS1"] fn prepared_node_runtime_protects_inputs_and_separates_outputs(){
        use sha2::{Digest,Sha256};
        let owner=root();let name=format!("perfect-planner.execution.{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        std::fs::write(owner.join("profile-name.txt"),&name).unwrap();let profile=AppContainer::create_fresh(&name).unwrap();
        std::fs::write(owner.join("profile.json"),serde_json::to_vec_pretty(&serde_json::json!({"name":profile.name(),"sid":profile.sid_text(),"folder":profile.folder(),"retained":true})).unwrap()).unwrap();
        let input=profile.create_readonly_directory("inputs").unwrap();let runtime=profile.create_readonly_directory("runtime").unwrap();
        assert!(profile.create_readonly_directory("inputs").is_err());assert!(profile.create_readonly_directory("../foreign").is_err());
        let output=profile.folder().join("output");std::fs::create_dir(&output).unwrap();let temp=profile.folder().join("Temp");std::fs::create_dir_all(&temp).unwrap();
        std::fs::create_dir(input.join("nested")).unwrap();std::fs::write(input.join("nested/input.txt"),b"allowed-input").unwrap();
        std::fs::write(input.join("nested/dependency.cjs"),b"module.exports=41;").unwrap();
        let node=runtime.join("node.exe");let source=std::path::PathBuf::from(std::env::var_os("PP_TEST_AGENT_NODE").unwrap());assert!(source.is_absolute());std::fs::copy(&source,&node).unwrap();
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),Sha256::digest(std::fs::read(&node).unwrap()));
        let helper=runtime.join("permission-probe.exe");std::fs::copy(std::env::var_os("PP_TEST_ISOLATION_PROBE").unwrap(),&helper).unwrap();
        let script=runtime.join("probe.cjs");std::fs::write(&script,include_str!("../tests/fixtures/isolation_probe.cjs")).unwrap();
        let benign_script=runtime.join("benign.cjs");std::fs::write(&benign_script,b"const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');a.equal(fs.readFileSync(p.join(process.env.PP_NODE_INPUT,'nested/input.txt'),'utf8'),'allowed-input');a.equal(require(p.join(process.env.PP_NODE_INPUT,'nested/dependency.cjs')),41);fs.writeFileSync(p.join(process.env.PP_NODE_OUTPUT,'benign.txt'),'benign-output');console.log('benign-node-complete');").unwrap();
        let paths=vec![input.clone(),input.join("nested"),input.join("nested/input.txt"),input.join("nested/dependency.cjs"),runtime.clone(),node.clone(),helper.clone(),script.clone(),benign_script.clone()];
        let descriptors=||paths.iter().map(|path|serde_json::json!({"path":path,"descriptor":AppContainer::descriptor(path).unwrap(),"sha256":if path.is_file(){Some(format!("{:x}",Sha256::digest(std::fs::read(path).unwrap())))}else{None}})).collect::<Vec<_>>();
        let metadata=||{use std::os::windows::fs::MetadataExt;paths.iter().map(|path|{let m=std::fs::metadata(path).unwrap();serde_json::json!({"path":path,"attributes":m.file_attributes(),"created":m.creation_time(),"written":m.last_write_time(),"accessed":m.last_access_time(),"bytes":m.file_size()})}).collect::<Vec<_>>()};
        std::fs::write(owner.join("metadata-before.json"),serde_json::to_vec_pretty(&metadata()).unwrap()).unwrap();
        let before=descriptors();std::fs::write(owner.join("protected-before.json"),serde_json::to_vec_pretty(&before).unwrap()).unwrap();
        let node_digest=format!("{:x}",Sha256::digest(std::fs::read(&node).unwrap()));
        let _ancestor_pins=crate::native_host_resources::pin_task_files(&node,&node_digest,profile.folder(),&input).unwrap();
        let cancel=AtomicBool::new(false);let inputs_guard=crate::native_candidate_guard::CandidateGuard::acquire(&input,&cancel).unwrap();
        let system=std::env::var("SystemRoot").unwrap();let path=Path::new(&system).join("System32");let comspec=path.join("cmd.exe");
        let evidence=owner.join("owner-evidence.txt");std::fs::write(&evidence,b"retained-owner-evidence").unwrap();
        let environment=[("SystemRoot",system.as_str()),("WINDIR",system.as_str()),("ComSpec",comspec.to_str().unwrap()),("PATH",path.to_str().unwrap()),("PATHEXT",".COM;.EXE;.BAT;.CMD"),
            ("LOCALAPPDATA",profile.folder().to_str().unwrap()),("TEMP",temp.to_str().unwrap()),("TMP",temp.to_str().unwrap()),("PP_NODE_INPUT",input.to_str().unwrap()),("PP_NODE_RUNTIME",runtime.to_str().unwrap()),("PP_NODE_OUTPUT",output.to_str().unwrap()),("PP_OWNER_EVIDENCE",evidence.to_str().unwrap()),("PP_CONTAINMENT_FIXTURE_ROOT",input.to_str().unwrap())];
        std::fs::write(owner.join("launch-environment.json"),serde_json::to_vec_pretty(&environment).unwrap()).unwrap();
        // These flags are part of this qualified invocation. Link/reparse
        // refusal and held guards precede use; no global drive grants are added.
        let args=[OsStr::new("--preserve-symlinks"),OsStr::new("--preserve-symlinks-main"),script.as_os_str()];
        std::fs::write(owner.join("node-args.json"),serde_json::to_vec_pretty(&args.iter().map(|a|a.to_str().unwrap()).collect::<Vec<_>>()).unwrap()).unwrap();
        let helper_digest=format!("{:x}",Sha256::digest(std::fs::read(&helper).unwrap()));
        let _helper_pins=crate::native_host_resources::pin_task_files(&helper,&helper_digest,profile.folder(),&input).unwrap();
        let mut permissions=environment.to_vec();permissions.push(("PP_PROBE_MODE","permissions"));
        let prepare=|exe:&Path,arguments:&[&OsStr],env:&[(&str,&str)]|{
            let (stdin,writer)=pipe(false).unwrap();drop(writer);let (out,ow)=pipe(true).unwrap();let (err,ew)=pipe(true).unwrap();
            let child=SuspendedTask::create_inner(exe,arguments,&input,env,16,512*1024*1024,Duration::from_secs(3),Some([stdin.0,ow.0,ew.0]),Some(&profile)).unwrap();
            drop(stdin);drop(ow);drop(ew);
            (child,Capture{read:out,bytes:Vec::new(),observed:0,eof:false},Capture{read:err,bytes:Vec::new(),observed:0,eof:false})
        };
        // All actual child processes remain suspended during OS image preparation.
        // No runtime notifications are discarded: the execution epoch begins below.
        let benign_pending=prepare(&node,&[args[0],args[1],benign_script.as_os_str()],&environment);
        let attack_pending=prepare(&node,&args,&environment);
        let permissions_pending=prepare(&helper,&[],&permissions);
        assert!(!output.join("benign.txt").exists()&&!output.join("output.txt").exists());
        let runtime_guard=crate::native_candidate_guard::CandidateGuard::acquire(&runtime,&cancel).unwrap();
        assert_eq!(before,descriptors());inputs_guard.validate().unwrap();runtime_guard.validate().unwrap();
        profile.verify_process(benign_pending.0.process.0).unwrap();profile.verify_process(attack_pending.0.process.0).unwrap();profile.verify_process(permissions_pending.0.process.0).unwrap();
        let execute=|(child,out,err)|capture_prepared(child,out,err,Duration::from_secs(10),8192,8192,16384,Duration::from_secs(3),&cancel).unwrap();
        let phase=|name:&str|{std::fs::write(owner.join(format!("notifications-{name}.json")),serde_json::to_vec_pretty(&serde_json::json!({"input":inputs_guard.diagnostic_notifications(),"runtime":runtime_guard.diagnostic_notifications(),"metadata":metadata()})).unwrap()).unwrap();};
        phase("before");
        let benign=execute(benign_pending);
        std::fs::write(owner.join("benign-output.txt"),&benign.stdout).unwrap();std::fs::write(owner.join("benign-error.txt"),&benign.stderr).unwrap();
        phase("after-benign");assert_eq!(benign.settlement.exit_code,Some(0));assert!(benign.settlement.descendants_settled&&benign.io_settled&&!benign.io_failed);
        assert_eq!(std::fs::read(output.join("benign.txt")).unwrap(),b"benign-output");inputs_guard.validate().unwrap();runtime_guard.validate().unwrap();
        let run=execute(attack_pending);
        std::fs::write(owner.join("node-output.txt"),&run.stdout).unwrap();std::fs::write(owner.join("node-error.txt"),&run.stderr).unwrap();
        std::fs::write(owner.join("node-settlement.txt"),format!("{run:?}")).unwrap();
        phase("after-node");
        assert_eq!(run.settlement.exit_code,Some(0));assert!(run.settlement.descendants_settled&&run.io_settled&&!run.io_failed&&!run.timed_out&&!run.output_truncated);
        let result:serde_json::Value=serde_json::from_slice(&run.stdout).unwrap();assert_eq!(result["denied"].as_array().unwrap().len(),14);
        let acl=execute(permissions_pending);
        std::fs::write(owner.join("permission-output.txt"),&acl.stdout).unwrap();std::fs::write(owner.join("permission-error.txt"),&acl.stderr).unwrap();
        phase("after-permissions");
        assert_eq!(acl.settlement.exit_code,Some(0));assert!(acl.settlement.descendants_settled&&acl.io_settled&&!acl.io_failed);
        assert!(String::from_utf8(acl.stdout).unwrap().contains("permission-probes=5;write-retry-denied=true"));
        assert_eq!(std::fs::read(&evidence).unwrap(),b"retained-owner-evidence");assert_eq!(std::fs::read(output.join("output.txt")).unwrap(),b"allowed-output");
        let after=descriptors();std::fs::write(owner.join("protected-after.json"),serde_json::to_vec_pretty(&after).unwrap()).unwrap();assert_eq!(before,after);
        phase("after-descriptors");
        inputs_guard.finish().unwrap();runtime_guard.finish().unwrap();
    }
    #[test] #[ignore="inert child entry; launched only inside the tested Job"] fn fixture(){
        let mode=std::env::var("PP_FIXTURE_MODE").unwrap();
        let root=std::path::PathBuf::from(std::env::var_os("PP_CONTAINMENT_FIXTURE_ROOT").unwrap());
        if mode=="isolation-probe"{
            let evidence=std::env::var_os("PP_OWNER_EVIDENCE").unwrap();let pid=std::env::var("PP_OWNER_PROCESS").unwrap().parse().unwrap();
            let own_input=std::fs::read(root.join("input.txt")).unwrap()==b"allowed-input";
            let own_output=std::fs::write(root.join("output.txt"),b"allowed-output").is_ok();
            let deny_read=std::fs::read(&evidence).err().is_some_and(|e|e.kind()==io::ErrorKind::PermissionDenied);
            let deny_write=std::fs::write(&evidence,b"tampered-fixture-evidence").err().is_some_and(|e|e.kind()==io::ErrorKind::PermissionDenied);
            let process=unsafe{OpenProcess(0x28,0,pid)};let deny_process=process.is_null()&&io::Error::last_os_error().raw_os_error()==Some(5);
            if !process.is_null(){unsafe{CloseHandle(process);}}
            println!("own-input={own_input};own-output={own_output};deny-read={deny_read};deny-write={deny_write};deny-process={deny_process}");return;
        }
        if mode=="memory"{
            #[link(name="kernel32")] extern "system"{
                fn VirtualAlloc(address:*mut c_void,bytes:usize,kind:u32,protection:u32)->*mut c_void;
                fn VirtualFree(address:*mut c_void,bytes:usize,kind:u32)->i32;
            }
            unsafe{
                let small=VirtualAlloc(null_mut(),65536,0x3000,4);assert!(!small.is_null());assert_ne!(VirtualFree(small,0,0x8000),0);
                let large=VirtualAlloc(null_mut(),96*1024*1024,0x3000,4);
                if !large.is_null(){VirtualFree(large,0,0x8000);panic!("commit exceeded owned Job memory cap");}
            }return;
        }
        if mode=="never-started"{std::fs::write(root.join("never-started"),"unexpected execution").unwrap();return;}
        if mode=="cancel-wait"{std::fs::write(root.join("cancel-ready"),"ready").unwrap();std::thread::sleep(Duration::from_secs(20));return;}
        if mode=="busy"{let mut value=1u64;loop{value=std::hint::black_box(value.wrapping_mul(1664525).wrapping_add(1013904223));}}
        if mode=="output"{
            use std::io::Read;let mut input=String::new();std::io::stdin().read_to_string(&mut input).unwrap();assert!(input.is_empty());
            println!("fixture-out");eprintln!("fixture-error");return;
        }
        if mode=="noisy"{use std::io::Write;let bytes=[b'x';8192];loop{if std::io::stdout().write_all(&bytes).is_err(){return;}}}
        if mode=="both-streams"{use std::io::Write;std::io::stderr().write_all(&[b'e';2048]).unwrap();std::io::stdout().write_all(&[b'o';2048]).unwrap();return;}
        if mode=="failed-exit"{std::process::exit(7);}
        if mode=="inherited-output"||mode=="orphan-output"{
            use std::os::windows::process::CommandExt;
            let _child=std::process::Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact",fixture_name()])
                .env("PP_FIXTURE_MODE","sleep").creation_flags(0x08000000).spawn().unwrap();
            println!("descendant-started");
            if mode=="orphan-output"{return;}
            std::thread::sleep(Duration::from_secs(20));return;
        }
        if mode=="brief-exit"{return;}
        if mode=="brief-parent"{
            use std::os::windows::process::CommandExt;
            let status=std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored","--exact",fixture_name()]).env("PP_FIXTURE_MODE","brief-exit")
                .creation_flags(0x08000000).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null()).status().unwrap();
            assert!(status.success());return;
        }
        if mode=="marker"{std::fs::write(root.join("entered-marker"),"entered").unwrap();return;}
        if mode=="sleep"{std::thread::sleep(Duration::from_secs(20));return;}
        use std::os::windows::process::CommandExt;
        let spawned=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored","--exact",fixture_name()]).env("PP_FIXTURE_MODE","sleep")
            .creation_flags(0x08000000).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()).spawn();
        if mode=="cap"{assert!(spawned.is_err());return;}
        let descendant=spawned.unwrap();
        if mode=="orphan"{std::fs::write(root.join("orphan-pid"),descendant.id().to_string()).unwrap();return;}
        std::thread::sleep(Duration::from_secs(20));
    }
}
