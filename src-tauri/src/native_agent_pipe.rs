//! Windows endpoint construction only. No external command dispatch is enabled.
//! OS account isolation is not isolation from hostile code running as that account.
use std::ffi::c_void;
use std::cell::Cell;
use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::fs::OpenOptionsExt;
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
use windows_sys::Win32::{
    Foundation::{GetLastError, LocalFree, INVALID_HANDLE_VALUE, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Security::{Authorization::*, *},
    Storage::FileSystem::{ReadFile, WriteFile, FILE_SHARE_READ, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX, SECURITY_SQOS_PRESENT, SECURITY_IDENTIFICATION},
    System::{IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED}, Pipes::*, Threading::{CreateEventW, GetCurrentProcess, GetProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION, OpenProcessToken, WaitForSingleObject}},
};

struct LocalMemory(*mut c_void);
impl Drop for LocalMemory { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }

fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

pub(crate) fn random_endpoint()->Result<String,&'static str>{
    use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom,BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let mut bytes=[0u8;32];
    if unsafe{BCryptGenRandom(null_mut(),bytes.as_mut_ptr(),32,BCRYPT_USE_SYSTEM_PREFERRED_RNG)}!=0{return Err("AGENT_RANDOM_UNAVAILABLE");}
    Ok(bytes.iter().map(|b|format!("{b:02x}")).collect())
}
/// Exclusive, protected current-user file. Pairing secrets must never be stored
/// here; its metadata/pins are the trusted IDE launch configuration only.
pub(crate) fn write_owner_config(path:&std::path::Path,bytes:&[u8])->Result<(),&'static str>{
    use std::io::Write;
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW,CREATE_NEW,FILE_ATTRIBUTE_NORMAL};
    if !path.is_absolute()||bytes.len()>16384{return Err("AGENT_CONFIG_INVALID");}
    crate::native_host_resources::verify_config_directory(path.parent().ok_or("AGENT_CONFIG_INVALID")?)?;
    let descriptor=owner_descriptor()?;
    let attributes=SECURITY_ATTRIBUTES{nLength:std::mem::size_of::<SECURITY_ATTRIBUTES>()as u32,lpSecurityDescriptor:descriptor.0,bInheritHandle:0};
    let path=wide(path.to_str().ok_or("AGENT_CONFIG_INVALID")?);
    let raw=unsafe{CreateFileW(path.as_ptr(),0x40000000,FILE_SHARE_READ,&attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,null_mut())};
    if raw==INVALID_HANDLE_VALUE{return Err("AGENT_CONFIG_CREATE_FAILED");}
    let handle=unsafe{OwnedHandle::from_raw_handle(raw)};
    let mut file=std::fs::File::from(handle);
    file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|_|"AGENT_CONFIG_WRITE_FAILED")
}

/// Retains a native-owner-launched process object, not an externally asserted PID.
/// The caller must verify the executable/package BEFORE launching this child.
/// This does not prove that a process is uncompromised or authorize any task.
pub(crate) struct PipePeer { process: OwnedHandle, pid: u32, _image:Option<std::fs::File> }
impl PipePeer {
    pub(crate) fn from_child(child: &std::process::Child) -> Result<Self, &'static str> {
        let process=child.as_handle().try_clone_to_owned().map_err(|_|"AGENT_PEER_HANDLE_FAILED")?;
        Self::from_handle(process)
    }
    fn from_handle(process: OwnedHandle) -> Result<Self, &'static str> {
        let pid=unsafe { GetProcessId(process.as_raw_handle()) };
        if pid==0 { return Err("AGENT_PEER_PROCESS_INVALID"); }
        let peer=Self{process,pid,_image:None};peer.live()?;Ok(peer)
    }
    /// Native owner supplies a trusted dedicated-helper path and digest, never
    /// renderer/peer assertions. Observe PID from the connected pipe itself.
    /// Pins the on-disk executable, not its in-memory integrity or script arguments.
    pub(crate) fn from_pipe_client(pipe:&AgentPipe,expected:&std::path::Path,digest:&str)->Result<Self,&'static str>{
        if !pipe.is_connected(){return Err("AGENT_PEER_PIN_INVALID");}
        Self::from_pinned_endpoint(pipe.handle(),false,expected,digest)
    }
    fn from_pinned_endpoint(handle:&impl AsRawHandle,server:bool,expected:&std::path::Path,digest:&str)->Result<Self,&'static str>{
        use std::io::Read;use sha2::{Sha256,Digest};
        if !expected.is_absolute()||digest.len()!=64||!digest.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("AGENT_PEER_PIN_INVALID");}
        let mut pid=0;
        let found=unsafe{if server{GetNamedPipeServerProcessId(handle.as_raw_handle(),&mut pid)}else{GetNamedPipeClientProcessId(handle.as_raw_handle(),&mut pid)}};
        if found==0||pid==0{return Err("AGENT_PIPE_PEER_MISMATCH");}
        // SYNCHRONIZE plus query-limited only: no process write/debug rights.
        let raw=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|0x00100000,0,pid)};
        if raw.is_null(){return Err("AGENT_PEER_OPEN_REFUSED");}
        let mut peer=Self::from_handle(unsafe{OwnedHandle::from_raw_handle(raw)})?;
        if process_user_sid(peer.process.as_raw_handle())?!=current_user_sid()?{return Err("AGENT_PEER_OWNER_MISMATCH");}
        let mut path=vec![0u16;32768];let mut length=path.len() as u32;
        if unsafe{QueryFullProcessImageNameW(peer.process.as_raw_handle(),0,path.as_mut_ptr(),&mut length)}==0||length==0{return Err("AGENT_PEER_IMAGE_UNAVAILABLE");}
        let observed=std::path::PathBuf::from(String::from_utf16(&path[..length as usize]).map_err(|_|"AGENT_PEER_IMAGE_UNAVAILABLE")?);
        let expected=expected.canonicalize().map_err(|_|"AGENT_PEER_IMAGE_UNAVAILABLE")?;
        if observed.canonicalize().map_err(|_|"AGENT_PEER_IMAGE_UNAVAILABLE")?!=expected{return Err("AGENT_PEER_IMAGE_MISMATCH");}
        let mut file=std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&expected).map_err(|_|"AGENT_PEER_IMAGE_UNAVAILABLE")?;
        let mut hash=Sha256::new();let mut buffer=[0u8;65536];let mut total=0u64;
        loop{let size=file.read(&mut buffer).map_err(|_|"AGENT_PEER_IMAGE_UNAVAILABLE")?;if size==0{break;}total+=size as u64;if total>256*1024*1024{return Err("AGENT_PEER_IMAGE_LIMIT");}hash.update(&buffer[..size]);}
        if format!("{:x}",hash.finalize())!=digest{return Err("AGENT_PEER_IMAGE_MISMATCH");}
        peer._image=Some(file);peer.verify(handle,server)?;Ok(peer)
    }
    fn live(&self) -> Result<(), &'static str> {
        if unsafe { WaitForSingleObject(self.process.as_raw_handle(),0) } != WAIT_TIMEOUT {
            return Err("AGENT_PEER_NOT_LIVE");
        }
        Ok(())
    }
    fn verify(&self, pipe: &impl AsRawHandle, server: bool) -> Result<(), &'static str> {
        self.live()?;let mut actual=0;
        let ok=unsafe { if server {GetNamedPipeServerProcessId(pipe.as_raw_handle(),&mut actual)} else {GetNamedPipeClientProcessId(pipe.as_raw_handle(),&mut actual)} };
        if ok==0 || actual!=self.pid { return Err("AGENT_PIPE_PEER_MISMATCH"); }
        self.live() // Refuse if the retained process exited during observation.
    }
    pub(crate) fn verify_server(&self, client: &impl AsRawHandle) -> Result<(), &'static str> { self.verify(client,true) }
}

fn current_user_sid() -> Result<String, &'static str> {
    process_user_sid(unsafe{GetCurrentProcess()})
}
fn process_user_sid(process:*mut c_void) -> Result<String, &'static str> {
    unsafe {
        let mut raw = null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut raw) == 0 {
            return Err("AGENT_PIPE_OWNER_UNAVAILABLE");
        }
        let token = OwnedHandle::from_raw_handle(raw);
        let mut size = 0;
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size);
        if size < std::mem::size_of::<TOKEN_USER>() as u32 || size > 4096 {
            return Err("AGENT_PIPE_OWNER_INVALID");
        }
        // TOKEN_USER contains pointers: ensure allocation alignment, not a byte Vec.
        let words = (size as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
        let mut buffer = vec![0usize; words];
        if GetTokenInformation(token.as_raw_handle(), TokenUser, buffer.as_mut_ptr().cast(), size, &mut size) == 0 {
            return Err("AGENT_PIPE_OWNER_UNAVAILABLE");
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid_text = null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid_text) == 0 {
            return Err("AGENT_PIPE_OWNER_INVALID");
        }
        let memory = LocalMemory(sid_text.cast());
        let mut length = 0;
        while length < 256 && *sid_text.add(length) != 0 { length += 1; }
        if length == 256 { return Err("AGENT_PIPE_OWNER_INVALID"); }
        let sid = String::from_utf16(std::slice::from_raw_parts(sid_text, length)).map_err(|_|"AGENT_PIPE_OWNER_INVALID")?;
        drop(memory);
        if !sid.starts_with("S-1-") || !sid.bytes().all(|b| b.is_ascii_digit() || b"S-".contains(&b)) {
            return Err("AGENT_PIPE_OWNER_INVALID");
        }
        Ok(sid)
    }
}

fn owner_descriptor() -> Result<LocalMemory, &'static str> {
    // Explicit protected DACL. No inherited Everyone, anonymous or network ACE.
    // The same account can still open the pipe: pairing and peer verification are mandatory.
    let sddl = wide(&format!("D:P(A;;GA;;;{})", current_user_sid()?));
    let mut descriptor = null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, null_mut()) } == 0 {
        return Err("AGENT_PIPE_SECURITY_INVALID");
    }
    Ok(LocalMemory(descriptor))
}

pub(crate) struct AgentPipe { handle: Arc<OwnedHandle>, cancelled:Arc<AtomicBool>, connected: Cell<bool>, failed: Cell<bool>, read_limit:usize, write_limit:usize }
pub(crate) struct AgentPipeStop { handle:std::sync::Weak<OwnedHandle>, cancelled:Arc<AtomicBool> }
impl AgentPipeStop {
    pub(crate) fn stop(&self){
        self.cancelled.store(true,Ordering::SeqCst);
        // Cancellation must not keep a finished worker's endpoint open. Upgrade
        // only during cancellation; the running pipe owns its OVERLAPPED handle.
        if let Some(handle)=self.handle.upgrade(){unsafe {CancelIoEx(handle.as_raw_handle(),null());}}
    }
}
/// Native client retains its independently trusted server process handle. The
/// caller must establish executable trust before creating that peer; a pipe name
/// or caller-supplied PID alone is not accepted as authentication.
pub(crate) struct AgentPipeClient { pipe:AgentPipe, server:PipePeer }
impl AgentPipeClient {
    pub(crate) fn stop_handle(&self)->AgentPipeStop{self.pipe.stop_handle()}
    /// Bootstrap for an independently launched helper. Pins come from trusted
    /// installation configuration, never from an MCP request or pipe response.
    pub(crate) fn connect_pinned(endpoint_id:&str,expected:&std::path::Path,digest:&str)->Result<Self,&'static str>{
        let file=Self::open(endpoint_id)?;
        let server=PipePeer::from_pinned_endpoint(&file,true,expected,digest)?;
        Ok(Self::from_verified_file(file,server))
    }
    pub(crate) fn connect(endpoint_id:&str,server:PipePeer)->Result<Self,&'static str>{
        server.live()?;
        let file=Self::open(endpoint_id)?;
        server.verify_server(&file)?;
        Ok(Self::from_verified_file(file,server))
    }
    fn open(endpoint_id:&str)->Result<std::fs::File,&'static str>{
        if endpoint_id.len()!=64||!endpoint_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("AGENT_PIPE_NAME_INVALID");}
        // Local pipe only; do not wait indefinitely for a busy/missing instance.
        // Identification SQOS prevents the server impersonating this client.
        let file=std::fs::OpenOptions::new().read(true).write(true)
            .custom_flags(FILE_FLAG_OVERLAPPED|SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION)
            .open(format!(r"\\.\pipe\PerfectPlanner.Agent.{endpoint_id}"))
            .map_err(|_|"AGENT_PIPE_CONNECT_REFUSED")?;
        Ok(file)
    }
    fn from_verified_file(file:std::fs::File,server:PipePeer)->Self{
        Self{pipe:AgentPipe{handle:Arc::new(file.into()),cancelled:Arc::new(AtomicBool::new(false)),connected:Cell::new(true),failed:Cell::new(false),read_limit:32768,write_limit:70000},server}
    }
    /// Receive private owner bootstrap only after server authentication. The
    /// caller validates its schema/binding before making any session request.
    pub(crate) fn receive_private(&self,timeout:Duration)->Result<Vec<u8>,&'static str>{
        let result=(||{
            self.server.verify_server(self.pipe.handle())?;
            let reply=self.pipe.read_frame(timeout)?;
            self.server.verify_server(self.pipe.handle())?;
            Ok(reply)
        })();
        self.pipe.finish(result)
    }
    pub(crate) fn request(&self,payload:&[u8],timeout:Duration)->Result<Vec<u8>,&'static str>{
        let result=(||{
            self.server.verify_server(self.pipe.handle())?;
            self.pipe.write_frame(payload,timeout)?;
            self.server.verify_server(self.pipe.handle())?;
            let reply=self.pipe.read_frame(timeout)?;
            self.server.verify_server(self.pipe.handle())?;
            Ok(reply)
        })();
        self.pipe.finish(result)
    }
}
impl AgentPipe {
    /// Caller supplies an opaque random endpoint ID, never a user path or project name.
    pub(crate) fn create(endpoint_id: &str) -> Result<Self, &'static str> {
        if endpoint_id.len() != 64 || !endpoint_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err("AGENT_PIPE_NAME_INVALID");
        }
        let name = wide(&format!(r"\\.\pipe\PerfectPlanner.Agent.{endpoint_id}"));
        let descriptor = owner_descriptor()?;
        let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: 0 };
        let raw = unsafe { CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1, 32768, 16384, 5000, &attributes) };
        if raw == INVALID_HANDLE_VALUE { return Err("AGENT_PIPE_CREATE_REFUSED"); }
        Ok(Self { handle: Arc::new(unsafe { OwnedHandle::from_raw_handle(raw) }),cancelled:Arc::new(AtomicBool::new(false)), connected: Cell::new(false), failed: Cell::new(false),read_limit:70000,write_limit:32768 })
    }
    pub(crate) fn handle(&self) -> &OwnedHandle { &self.handle }
    pub(crate) fn is_connected(&self)->bool{self.connected.get()&&!self.failed.get()&&!self.cancelled.load(Ordering::SeqCst)}
    pub(crate) fn stop_handle(&self)->AgentPipeStop{AgentPipeStop{handle:Arc::downgrade(&self.handle),cancelled:Arc::clone(&self.cancelled)}}
    pub(crate) fn verify_client(&self, peer: &PipePeer) -> Result<(), &'static str> {
        if self.failed.get() || !self.connected.get() { return Err("AGENT_PIPE_STATE_INVALID"); }
        self.finish(peer.verify(self.handle(),false))
    }
    fn finish<T>(&self, result: Result<T, &'static str>) -> Result<T, &'static str> {
        if result.is_err() { self.failed.set(true); } result
    }

    fn deadline(timeout: Duration) -> Result<Instant, &'static str> {
        if timeout.is_zero() || timeout > Duration::from_secs(30) { return Err("AGENT_PIPE_DEADLINE_INVALID"); }
        Instant::now().checked_add(timeout).ok_or("AGENT_PIPE_DEADLINE_INVALID")
    }
    fn operation(&self, deadline: Instant, start: impl FnOnce(*mut OVERLAPPED) -> i32, connect: bool) -> Result<u32, &'static str> {
        if self.cancelled.load(Ordering::SeqCst){return Err("AGENT_PIPE_STOPPED");}
        unsafe {
            let raw = CreateEventW(null(), 1, 0, null());
            if raw.is_null() { return Err("AGENT_PIPE_EVENT_FAILED"); }
            let event = OwnedHandle::from_raw_handle(raw);
            let mut overlapped: OVERLAPPED = std::mem::zeroed(); overlapped.hEvent = event.as_raw_handle();
            let begun = start(&mut overlapped);
            let start_error=if begun==0{GetLastError()}else{0};
            if self.cancelled.load(Ordering::SeqCst){
                if begun!=0||start_error==ERROR_IO_PENDING{
                    CancelIoEx(self.handle.as_raw_handle(),&overlapped);
                    let mut bytes=0;GetOverlappedResult(self.handle.as_raw_handle(),&overlapped,&mut bytes,1);
                }
                return Err("AGENT_PIPE_STOPPED");
            }
            if begun == 0 {
                let error = start_error;
                if connect && error == ERROR_PIPE_CONNECTED { return Ok(0); }
                if error != ERROR_IO_PENDING { return Err("AGENT_PIPE_IO_FAILED"); }
                let remaining = deadline.saturating_duration_since(Instant::now()).as_millis().min(30000) as u32;
                if WaitForSingleObject(event.as_raw_handle(), remaining) != WAIT_OBJECT_0 {
                    CancelIoEx(self.handle.as_raw_handle(), &overlapped);
                    // Keep buffer, event and OVERLAPPED alive until the kernel acknowledges cancellation.
                    // This is local NPFS I/O, not a promise about arbitrary device-driver cancellation.
                    let mut bytes = 0; GetOverlappedResult(self.handle.as_raw_handle(), &overlapped, &mut bytes, 1);
                    return Err("AGENT_PIPE_DEADLINE");
                }
            }
            let mut bytes = 0;
            if GetOverlappedResult(self.handle.as_raw_handle(), &overlapped, &mut bytes, 0) == 0 { return Err("AGENT_PIPE_IO_FAILED"); }
            Ok(bytes)
        }
    }
    pub(crate) fn accept(&self, timeout: Duration) -> Result<(), &'static str> {
        if self.failed.get() || self.connected.get() { return Err("AGENT_PIPE_STATE_INVALID"); }
        let deadline = Self::deadline(timeout)?;
        let result=self.operation(deadline, |overlapped| unsafe { ConnectNamedPipe(self.handle.as_raw_handle(), overlapped) }, true).map(|_|());
        if result.is_ok() { self.connected.set(true); } self.finish(result)
    }
    fn read_exact(&self, buffer: &mut [u8], deadline: Instant) -> Result<(), &'static str> {
        let mut offset = 0;
        while offset < buffer.len() {
            if Instant::now() >= deadline { return Err("AGENT_PIPE_DEADLINE"); }
            let bytes = self.operation(deadline, |overlapped| unsafe { ReadFile(self.handle.as_raw_handle(), buffer[offset..].as_mut_ptr(), (buffer.len()-offset) as u32, null_mut(), overlapped) }, false)? as usize;
            if bytes == 0 || bytes > buffer.len()-offset { return Err("AGENT_PIPE_IO_FAILED"); }
            offset += bytes;
        }
        Ok(())
    }
    pub(crate) fn read_frame(&self, timeout: Duration) -> Result<Vec<u8>, &'static str> {
        if self.failed.get() || !self.connected.get() { return Err("AGENT_PIPE_STATE_INVALID"); }
        self.finish(self.read_frame_inner(timeout))
    }
    fn read_frame_inner(&self, timeout: Duration) -> Result<Vec<u8>, &'static str> {
        let deadline = Self::deadline(timeout)?; let mut prefix = [0u8;4];
        self.read_exact(&mut prefix, deadline)?;
        let length = u32::from_be_bytes(prefix) as usize;
        if length == 0 || length > self.read_limit { return Err("AGENT_PIPE_FRAME_LIMIT"); }
        let mut payload = vec![0; length]; self.read_exact(&mut payload, deadline)?;
        std::str::from_utf8(&payload).map_err(|_|"AGENT_PIPE_FRAME_ENCODING")?;
        Ok(payload)
    }
    pub(crate) fn write_frame(&self, payload: &[u8], timeout: Duration) -> Result<(), &'static str> {
        if self.failed.get() || !self.connected.get() { return Err("AGENT_PIPE_STATE_INVALID"); }
        self.finish(self.write_frame_inner(payload, timeout))
    }
    fn write_frame_inner(&self, payload: &[u8], timeout: Duration) -> Result<(), &'static str> {
        let deadline = Self::deadline(timeout)?;
        if payload.is_empty() || payload.len()>self.write_limit { return Err("AGENT_PIPE_FRAME_LIMIT"); }
        std::str::from_utf8(payload).map_err(|_|"AGENT_PIPE_FRAME_ENCODING")?;
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec(); frame.extend_from_slice(payload);
        let mut offset = 0;
        while offset < frame.len() {
            if Instant::now()>=deadline { return Err("AGENT_PIPE_DEADLINE"); }
            let bytes=self.operation(deadline, |overlapped| unsafe { WriteFile(self.handle.as_raw_handle(), frame[offset..].as_ptr(), (frame.len()-offset) as u32, null_mut(), overlapped) }, false)? as usize;
            if bytes==0 || bytes>frame.len()-offset { return Err("AGENT_PIPE_IO_FAILED"); } offset+=bytes;
        }
        Ok(())
    }
}

#[cfg(test)] mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
    fn host() { }
    fn id() -> String {
        // Test-only namespace: Windows clock granularity cannot guarantee uniqueness across test threads.
        static NEXT: std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(1);
        format!("{:032x}{:032x}",std::process::id(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed))
    }
    fn current_peer() -> PipePeer {
        use std::os::windows::io::BorrowedHandle;
        let handle=unsafe { BorrowedHandle::borrow_raw(GetCurrentProcess()) }.try_clone_to_owned().unwrap();
        PipePeer::from_handle(handle).unwrap()
    }
    struct TestChild(std::process::Child);
    impl Drop for TestChild { fn drop(&mut self) { let _=self.0.kill();let _=self.0.wait(); } }
    #[test]fn pinned_client_observes_separate_server_process_before_exchange(){
        use std::io::Read;use std::os::windows::process::CommandExt;use sha2::{Sha256,Digest};
        host();let node=std::env::var("PP_TEST_AGENT_NODE").unwrap();let name=id();
        // Test-only Node server, not the production native endpoint or ACL.
        // The peer lives until the test drops it (stdin closes, or TestChild kills it), not for a fixed
        // wall-clock span: the hashes of the Node binary below are CPU-bound and, in an unoptimized
        // test build under parallel load, outlasted the old 15 s self-exit, so the liveness check
        // then saw AGENT_PEER_NOT_LIVE.
        let script=r#"const net=require('node:net');process.stdin.on('end',()=>process.exit(2));process.stdin.resume();net.createServer(s=>{s.on('error',()=>{});s.on('data',b=>s.write(b));}).listen(process.argv[1],()=>process.stdout.write('R'));"#;
        let mut child=TestChild(std::process::Command::new(&node).args(["-e",script,&format!(r"\\.\pipe\PerfectPlanner.Agent.{name}")])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).creation_flags(0x08000000).spawn().unwrap());
        let mut output=child.0.stdout.take().unwrap();let (tx,rx)=std::sync::mpsc::channel();
        let reader=std::thread::spawn(move||{let mut byte=[0];let result=output.read_exact(&mut byte);let _=tx.send(result.map(|_|byte));});
        let ready=rx.recv_timeout(Duration::from_secs(5));
        if ready.is_err(){let _=child.0.kill();}reader.join().unwrap();assert_eq!(ready.unwrap().unwrap(),[b'R']);
        let hash=format!("{:x}",Sha256::digest(std::fs::read(&node).unwrap()));
        assert!(matches!(AgentPipeClient::connect_pinned(&name,std::path::Path::new(&node),&"0".repeat(64)),Err("AGENT_PEER_IMAGE_MISMATCH")));
        let client=AgentPipeClient::connect_pinned(&name,std::path::Path::new(&node),&hash).unwrap();
        assert_eq!(client.request(b"{}",Duration::from_secs(3)).unwrap(),b"{}");
        child.0.kill().unwrap();child.0.wait().unwrap();assert!(client.request(b"{}",Duration::from_secs(1)).is_err());
    }
    #[test]fn owner_stop_cancels_pending_accept_without_waiting_for_deadline(){
        host();let pipe=AgentPipe::create(&id()).unwrap();let stop=pipe.stop_handle();
        let (tx,rx)=std::sync::mpsc::channel();
        let worker=std::thread::spawn(move||{tx.send(()).unwrap();pipe.accept(Duration::from_secs(30))});
        rx.recv_timeout(Duration::from_secs(2)).unwrap();let start=Instant::now();stop.stop();
        assert!(worker.join().unwrap().is_err());assert!(start.elapsed()<Duration::from_secs(2));
    }
    #[test]fn cancellation_handle_does_not_keep_a_finished_endpoint_alive(){
        host();let pipe=AgentPipe::create(&id()).unwrap();let stop=pipe.stop_handle();
        assert!(stop.handle.upgrade().is_some());
        drop(pipe);
        assert!(stop.handle.upgrade().is_none());
        stop.stop(); // Safe even after completion; never targets a reused handle.
    }
    #[test]
    #[ignore="Requires explicit DANS1 pinned broker fixture"]
    fn owner_worker_pairs_then_stop_revokes_idle_session(){
        use serde_json::{json,Value};
        host();let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let owners=crate::native_agent_registry::AgentBrokers::default();let key=fixture["binding"].to_string();
        let broker=owners.get_or_start(&key,std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap();
        let name=id();let pipe=AgentPipe::create(&name).unwrap();
        let client=AgentPipeClient::connect(&name,current_peer()).unwrap();
        owners.attach_pairing(fixture["binding"].clone(),&broker,pipe,current_peer()).unwrap();
        let (mut session,_)=crate::native_agent_session::NativeAgentSession::pair_from_owner(client,fixture["binding"].clone()).unwrap();
        assert_eq!(session.heartbeat().unwrap()["sequence"],2);
        let started=Instant::now();owners.stop(&key).unwrap();assert!(started.elapsed()<Duration::from_secs(3));
        let disconnected=Instant::now();assert!(session.heartbeat().is_err());assert!(disconnected.elapsed()<Duration::from_secs(2));
        drop(AgentPipe::create(&name).unwrap());
        assert!(broker.lock().unwrap().request("owner.inspect",json!({"binding":fixture["binding"]})).is_err());
        let replacement=owners.get_or_start(&key,std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap();
        assert_eq!(replacement.lock().unwrap().request("owner.inspect",json!({"binding":fixture["binding"]})).unwrap()["result"],json!([]));
        owners.stop(&key).unwrap();
    }
    #[test]
    #[ignore="Requires explicit DANS1 pinned broker fixture"]
    fn native_session_pairs_heartbeats_and_revokes_through_actual_channel(){
        use serde_json::{json,Value};
        use crate::native_agent_session::NativeAgentSession;
        host();let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let broker=std::sync::Arc::new(std::sync::Mutex::new(crate::native_agent_broker::AgentBroker::start(std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap()));
        let pair=broker.lock().unwrap().request("owner.pair",json!({"binding":fixture["binding"]})).unwrap();assert_eq!(pair["ok"],true);
        let name=id();let pipe=AgentPipe::create(&name).unwrap();
        let client=AgentPipeClient::connect(&name,current_peer()).unwrap();
        pipe.accept(Duration::from_secs(3)).unwrap();
        let peer=current_peer();let binding=fixture["binding"].clone();let shared=std::sync::Arc::clone(&broker);
        let (tx,rx)=std::sync::mpsc::channel();
        let worker=std::thread::spawn(move||{
            pipe.verify_client(&peer).unwrap();
            let bootstrap=json!({"schemaVersion":1,"binding":binding,"pairingId":pair["result"]["pairingId"],"secret":pair["result"]["secret"],"expiresAt":pair["result"]["expiresAt"]});
            pipe.write_frame(&serde_json::to_vec(&bootstrap).unwrap(),Duration::from_secs(3)).unwrap();
            let mut channel=crate::native_agent_channel::NativeAgentChannel::open(shared,&pipe,&peer,binding).unwrap();
            channel.exchange(&pipe,&peer,Duration::from_secs(12)).unwrap();
            channel.exchange(&pipe,&peer,Duration::from_secs(12)).unwrap();
            rx.recv_timeout(Duration::from_secs(12)).unwrap();channel.close().unwrap();
        });
        let result=NativeAgentSession::pair_from_owner(client,fixture["binding"].clone());
        let (mut session,opened)=result.unwrap();assert_eq!(opened["sequence"],1);assert!(opened.get("secret").is_none());
        let heartbeat=session.heartbeat();tx.send(()).unwrap();worker.join().unwrap();
        let heartbeat=heartbeat.unwrap();assert_eq!(heartbeat["sequence"],2);assert_eq!(heartbeat["workVerified"],false);assert!(heartbeat.get("secret").is_none());
        let view=broker.lock().unwrap().request("owner.inspect",json!({"binding":fixture["binding"]})).unwrap();
        assert_eq!(view["result"],json!([]));assert!(session.heartbeat().is_err());assert!(session.heartbeat().is_err());
        broker.lock().unwrap().stop();
    }
    #[test]
    #[ignore="Requires explicit DANS1 pinned broker fixture"]
    fn unused_channel_pairing_is_cancelled_on_close(){
        use serde_json::{json,Value};
        host();let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let broker=std::sync::Arc::new(std::sync::Mutex::new(crate::native_agent_broker::AgentBroker::start(std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap()));
        let name=id();let pipe=AgentPipe::create(&name).unwrap();let client=AgentPipeClient::connect(&name,current_peer()).unwrap();
        pipe.accept(Duration::from_secs(3)).unwrap();let peer=current_peer();
        let mut channel=crate::native_agent_channel::NativeAgentChannel::open(broker.clone(),&pipe,&peer,fixture["binding"].clone()).unwrap();
        channel.send_pairing(&pipe,&peer).unwrap();
        let value:Value=serde_json::from_slice(&client.receive_private(Duration::from_secs(3)).unwrap()).unwrap();
        assert_eq!(value["binding"],fixture["binding"]);
        assert_eq!(channel.send_pairing(&pipe,&peer).unwrap_err(),"AGENT_CHANNEL_STATE_INVALID");
        channel.close().unwrap();channel.close().unwrap();
        let reply=broker.lock().unwrap().request("client.connect",json!({"pairingId":value["pairingId"],"secret":value["secret"]})).unwrap();
        assert_eq!(reply["ok"],false);broker.lock().unwrap().stop();
    }
    #[test] fn native_client_checks_server_and_receives_large_bounded_reply(){
        host();let name=id();let pipe=AgentPipe::create(&name).unwrap();
        let client=AgentPipeClient::connect(&name,current_peer()).unwrap();
        let server=std::thread::spawn(move||{
            pipe.accept(Duration::from_secs(3)).unwrap();
            assert_eq!(pipe.read_frame(Duration::from_secs(3)).unwrap(),b"request");
            pipe.write_frame(&vec![b'a';20000],Duration::from_secs(3)).unwrap();
        });
        let reply=client.request(b"request",Duration::from_secs(3));
        server.join().unwrap();assert_eq!(reply.unwrap(),vec![b'a';20000]);
    }
    #[test] fn native_client_rejects_oversized_request_and_poisons_retry(){
        host();let name=id();let pipe=AgentPipe::create(&name).unwrap();
        let client=AgentPipeClient::connect(&name,current_peer()).unwrap();
        pipe.accept(Duration::from_secs(1)).unwrap();
        assert_eq!(client.request(&vec![b'a';70001],Duration::from_secs(1)).unwrap_err(),"AGENT_PIPE_FRAME_LIMIT");
        assert_eq!(client.request(b"retry",Duration::from_secs(1)).unwrap_err(),"AGENT_PIPE_STATE_INVALID");
        assert_eq!(pipe.read_frame(Duration::from_millis(40)).unwrap_err(),"AGENT_PIPE_DEADLINE");
    }
    #[test] fn native_client_refuses_wrong_live_server_before_request(){
        use std::os::windows::process::CommandExt;
        host();let name=id();let _pipe=AgentPipe::create(&name).unwrap();
        let mut child=TestChild(std::process::Command::new(std::env::var("PP_TEST_AGENT_NODE").unwrap())
            .args(["-e","process.stdin.resume()"])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .creation_flags(0x08000000).spawn().unwrap());
        let result=AgentPipeClient::connect(&name,PipePeer::from_child(&child.0).unwrap());
        child.0.kill().unwrap();child.0.wait().unwrap();
        assert!(matches!(result,Err("AGENT_PIPE_PEER_MISMATCH")));
    }
    #[test]
    #[ignore = "requires explicit DANS1 pinned broker package and private client fixture"]
    fn real_pipe_routes_to_pinned_broker_and_revokes_channel() {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        use serde_json::{json,Value};
        host();
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let broker=std::sync::Arc::new(std::sync::Mutex::new(crate::native_agent_broker::AgentBroker::start(std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap()));
        let pair=broker.lock().unwrap().request("owner.pair",json!({"binding":fixture["binding"]})).unwrap();assert_eq!(pair["ok"],true);
        let name=id();let pipe=AgentPipe::create(&name).unwrap();
        let script=r#"const net=require('node:net');const timer=setTimeout(()=>process.exit(2),15000);
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
const pair=JSON.parse(input);input='';const socket=net.connect(process.argv[1]);let buffer=Buffer.alloc(0),stage=0;
const send=(id,method,params)=>{const b=Buffer.from(JSON.stringify({version:1,id,method,params}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);socket.write(Buffer.concat([h,b]));};
socket.on('error',()=>process.exit(3));socket.on('connect',()=>send(1,'owner.pair',{}));
socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>32772)process.exit(4);
if(buffer.length<4||buffer.length<4+buffer.readUInt32BE(0))return;
const r=JSON.parse(buffer.subarray(4));buffer=Buffer.alloc(0);
if(stage===0){if(r.ok!==false)process.exit(5);stage=1;send(1,'client.connect',pair);pair.secret='';}
else if(stage===1){if(r.result?.ok!==true)process.exit(6);stage=2;const s=r.result.result;send(2,'client.heartbeat',{sessionId:s.sessionId,secret:s.secret,expectedSequence:1});}
else {if(r.result?.result?.sequence!==2)process.exit(7);stage=3;socket.end();}});
socket.on('close',()=>{clearTimeout(timer);process.exit(stage===3?0:8);});});"#;
        let mut child=TestChild(std::process::Command::new(std::env::var("PP_TEST_AGENT_NODE").unwrap())
            .args(["-e",script,&format!(r"\\.\pipe\PerfectPlanner.Agent.{name}")]).creation_flags(0x08000000)
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap());
        let peer=PipePeer::from_child(&child.0).unwrap();
        // Test pairing material travels only through this owner's inherited private stdin.
        let mut stdin=child.0.stdin.take().unwrap();stdin.write_all(&serde_json::to_vec(&json!({"pairingId":pair["result"]["pairingId"],"secret":pair["result"]["secret"]})).unwrap()).unwrap();drop(stdin);
        pipe.accept(Duration::from_secs(3)).unwrap();
        let mut channel=crate::native_agent_channel::NativeAgentChannel::open(broker.clone(),&pipe,&peer,fixture["binding"].clone()).unwrap();
        for _ in 0..3 {
            channel.exchange(&pipe,&peer,Duration::from_secs(3)).unwrap();
        }
        assert!(child.0.wait().unwrap().success());
        channel.close().unwrap();
        assert_eq!(broker.lock().unwrap().request("owner.inspect",json!({"binding":fixture["binding"]})).unwrap()["result"],json!([]));
        broker.lock().unwrap().stop();
    }
    #[test] fn separate_client_process_passes_peer_check_and_exchanges_frames() {
        use std::os::windows::process::CommandExt;
        use sha2::{Sha256,Digest};
        host();let node=std::env::var("PP_TEST_AGENT_NODE").expect("Explicit remote Node fixture required");
        let name=id();let pipe=AgentPipe::create(&name).unwrap();
        // Public test endpoint name only; no credentials or source content in argv.
        // Lifetime is tied to the test (stdin), not a wall-clock self-exit; see the pinned-client test.
        let script=r#"const net=require('node:net');process.stdin.on('end',()=>process.exit(2));process.stdin.resume();
const socket=net.connect(process.argv[1]);let bytes=Buffer.alloc(0);
socket.on('error',()=>process.exit(3));socket.on('connect',()=>socket.write(Buffer.from([0,0,0,2,123,125])));
socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>6)process.exit(4);
if(bytes.length===6){if(!bytes.equals(Buffer.from([0,0,0,2,111,107])))process.exit(5);socket.end();}});
socket.on('close',()=>process.exit(bytes.length===6?0:6));"#;
        let mut child=TestChild(std::process::Command::new(&node).args(["-e",script,&format!(r"\\.\pipe\PerfectPlanner.Agent.{name}")])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).creation_flags(0x08000000).spawn().unwrap());
        let peer=PipePeer::from_child(&child.0).unwrap();
        pipe.accept(Duration::from_secs(3)).unwrap();pipe.verify_client(&peer).unwrap();
        let hash=format!("{:x}",Sha256::digest(std::fs::read(&node).unwrap()));
        assert!(matches!(PipePeer::from_pipe_client(&pipe,std::path::Path::new(&node),&"0".repeat(64)),Err("AGENT_PEER_IMAGE_MISMATCH")));
        assert!(matches!(PipePeer::from_pipe_client(&pipe,&std::env::current_exe().unwrap(),&hash),Err("AGENT_PEER_IMAGE_MISMATCH")));
        let observed_peer=PipePeer::from_pipe_client(&pipe,std::path::Path::new(&node),&hash).unwrap();
        pipe.verify_client(&observed_peer).unwrap();
        assert_eq!(pipe.read_frame(Duration::from_secs(3)).unwrap(),b"{}");
        // Re-observe the authorized child immediately before returning a response.
        pipe.verify_client(&peer).unwrap();pipe.write_frame(b"ok",Duration::from_secs(3)).unwrap();
        assert!(child.0.wait().unwrap().success());
        assert_eq!(pipe.verify_client(&peer).unwrap_err(),"AGENT_PEER_NOT_LIVE");
    }
    #[test] fn verifies_both_actual_pipe_endpoint_processes() {
        host();let name=id();let pipe=AgentPipe::create(&name).unwrap();
        let client=std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\PerfectPlanner.Agent.{name}")).unwrap();
        pipe.accept(Duration::from_secs(2)).unwrap();let peer=current_peer();
        peer.verify_server(&client).unwrap();pipe.verify_client(&peer).unwrap();
    }
    #[test] fn different_live_process_and_exited_process_are_refused() {
        use std::os::windows::process::CommandExt;
        host();let node=std::env::var("PP_TEST_AGENT_NODE").expect("Explicit remote Node fixture required");
        let mut child=TestChild(std::process::Command::new(node).args(["-e","process.stdin.resume()"])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).creation_flags(0x08000000).spawn().unwrap());
        let peer=PipePeer::from_child(&child.0).unwrap();
        let name=id();let pipe=AgentPipe::create(&name).unwrap();
        let client=std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\PerfectPlanner.Agent.{name}")).unwrap();
        pipe.accept(Duration::from_secs(2)).unwrap();
        let wrong_server=peer.verify_server(&client);let wrong_client=pipe.verify_client(&peer);
        child.0.kill().unwrap();child.0.wait().unwrap();
        assert_eq!(wrong_server.unwrap_err(),"AGENT_PIPE_PEER_MISMATCH");
        assert_eq!(wrong_client.unwrap_err(),"AGENT_PIPE_PEER_MISMATCH");
        assert_eq!(peer.verify_server(&client).unwrap_err(),"AGENT_PEER_NOT_LIVE");
        assert_eq!(pipe.read_frame(Duration::from_millis(10)).unwrap_err(),"AGENT_PIPE_STATE_INVALID");
    }
    #[test] fn pending_accept_is_cancelled_at_deadline() {
        host(); let pipe=AgentPipe::create(&id()).unwrap(); let started=Instant::now();
        assert_eq!(pipe.accept(Duration::from_millis(40)).unwrap_err(),"AGENT_PIPE_DEADLINE");
        assert!(started.elapsed()<Duration::from_secs(2));
    }
    #[test] fn framed_round_trip_then_incomplete_frame_times_out() {
        use std::io::{Read,Write};
        host(); let name=id(); let pipe=AgentPipe::create(&name).unwrap();
        let mut client=std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\PerfectPlanner.Agent.{name}")).unwrap();
        pipe.accept(Duration::from_secs(2)).unwrap();
        client.write_all(&[0,0,0,2,b'{',b'}']).unwrap();
        assert_eq!(pipe.read_frame(Duration::from_secs(2)).unwrap(),b"{}");
        pipe.write_frame(b"ok",Duration::from_secs(2)).unwrap(); let mut reply=[0;6]; client.read_exact(&mut reply).unwrap(); assert_eq!(reply,[0,0,0,2,b'o',b'k']);
        client.write_all(&[0,0,0,4,b'a']).unwrap();
        assert_eq!(pipe.read_frame(Duration::from_millis(40)).unwrap_err(),"AGENT_PIPE_DEADLINE");
        assert_eq!(pipe.read_frame(Duration::from_secs(1)).unwrap_err(),"AGENT_PIPE_STATE_INVALID");
        assert_eq!(pipe.write_frame(b"retry",Duration::from_secs(1)).unwrap_err(),"AGENT_PIPE_STATE_INVALID");
    }
    #[test] fn oversized_frame_is_rejected_before_payload_allocation() {
        use std::io::Write;
        host(); let name=id(); let pipe=AgentPipe::create(&name).unwrap();
        let mut client=std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\PerfectPlanner.Agent.{name}")).unwrap();
        pipe.accept(Duration::from_secs(2)).unwrap(); client.write_all(&u32::MAX.to_be_bytes()).unwrap();
        assert_eq!(pipe.read_frame(Duration::from_secs(2)).unwrap_err(),"AGENT_PIPE_FRAME_LIMIT");
        assert_eq!(pipe.read_frame(Duration::from_secs(2)).unwrap_err(),"AGENT_PIPE_STATE_INVALID");
    }
    #[test] fn rejects_untrusted_endpoint_spellings() {
        host(); for name in ["", "../other", "\\\\server\\pipe\\x", "aaaaaaaa", &"A".repeat(64)] { assert!(AgentPipe::create(name).is_err()); }
    }
    #[test] fn pipe_is_exclusive_noninheritable_and_closes_on_drop() {
        host(); let name = id(); let pipe = AgentPipe::create(&name).unwrap();
        assert!(AgentPipe::create(&name).is_err(), "a second server must not join or replace the endpoint");
        let mut flags = 0;
        assert_ne!(unsafe { GetHandleInformation(pipe.handle().as_raw_handle(), &mut flags) }, 0);
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        drop(pipe);
        let replacement = AgentPipe::create(&name).unwrap(); drop(replacement);
    }
    #[test] fn actual_pipe_dacl_is_protected_and_has_only_the_current_user() {
        host(); let pipe = AgentPipe::create(&id()).unwrap();
        unsafe {
            let mut descriptor = null_mut(); let mut acl = null_mut();
            assert_eq!(GetSecurityInfo(pipe.handle().as_raw_handle(), SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut acl, null_mut(), &mut descriptor), 0);
            let memory = LocalMemory(descriptor);
            assert!(!acl.is_null()); assert_eq!((*acl).AceCount, 1);
            let mut control = 0; let mut revision = 0;
            assert_ne!(GetSecurityDescriptorControl(descriptor, &mut control, &mut revision), 0);
            assert_ne!(control & SE_DACL_PROTECTED, 0);
            let mut ace = null_mut(); assert_ne!(GetAce(acl, 0, &mut ace), 0);
            let allowed = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            assert_eq!(allowed.Header.AceType, 0); assert_eq!(allowed.Header.AceFlags, 0);
            let mut text = null_mut();
            assert_ne!(ConvertSidToStringSidW((&allowed.SidStart as *const u32).cast_mut().cast(), &mut text), 0);
            let text_memory = LocalMemory(text.cast()); let mut length = 0;
            while length < 256 && *text.add(length) != 0 { length += 1; }
            assert!(length < 256);
            assert_eq!(String::from_utf16(std::slice::from_raw_parts(text, length)).unwrap(), current_user_sid().unwrap());
            drop(text_memory); drop(memory);
        }
    }
}
