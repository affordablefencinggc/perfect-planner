//! Narrow native draft persistence. No review, execution, renderer configuration,
//! or implicit retry. A durable BEGIN without SETTLED requires explicit recovery.
use fs2::FileExt;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::fs::{self,File,OpenOptions};
use std::io::{Read,Write};
use std::path::{Path,PathBuf,Component};
use std::sync::atomic::{AtomicU64,AtomicUsize,Ordering};
use std::time::{SystemTime,UNIX_EPOCH};
use tauri::Manager;
use crate::native_host_supervisor::{Binding,HostConfiguration};
#[path="native_check_setup.rs"]
mod check_setup;
#[path="native_check_review.rs"]
mod check_review;
pub use check_review::ReviewRequest;
#[path="native_check_execution.rs"]
mod check_execution;
pub use check_execution::ExecutionRequest;
#[tauri::command]
pub async fn execute_native_check(app:tauri::AppHandle,request:ExecutionRequest)->Result<Value,DraftError>{
    let admission=Admission::acquire()?;
    tauri::async_runtime::spawn_blocking(move||{let _admission=admission;check_execution::perform(app,request,false)}).await.map_err(|_|uncertain(true))?
}
#[tauri::command]
pub async fn recover_native_check_execution(app:tauri::AppHandle,request:ExecutionRequest)->Result<Value,DraftError>{
    let admission=Admission::acquire()?;
    tauri::async_runtime::spawn_blocking(move||{let _admission=admission;check_execution::perform(app,request,true)}).await.map_err(|_|uncertain(true))?
}
#[tauri::command]
pub async fn review_native_checks(app:tauri::AppHandle,request:ReviewRequest)->Result<Value,DraftError>{
    let admission=Admission::acquire()?;
    tauri::async_runtime::spawn_blocking(move||{let _admission=admission;check_review::perform(app,request)}).await.map_err(|_|uncertain(true))?
}
#[tauri::command]
pub async fn recover_native_check_review(app:tauri::AppHandle,request:ReviewRequest)->Result<Value,DraftError>{
    let admission=Admission::acquire()?;
    tauri::async_runtime::spawn_blocking(move||{let _admission=admission;check_review::recover(app,request)}).await.map_err(|_|uncertain(true))?
}
#[path="native_check_preparation.rs"]
mod check_preparation;
#[path="native_task_result_commands.rs"]
mod task_results;
#[path="native_session_store.rs"]
mod session_store;
#[path="native_session_diagnostics.rs"]
mod session_diagnostics;
pub use task_results::{TaskResultRequest,TaskResultIndexRequest};
#[tauri::command]
pub async fn list_native_task_results(app:tauri::AppHandle,request:TaskResultIndexRequest)->Result<Value,DraftError>{task_results::list_native_task_results(app,request).await}
#[tauri::command]
pub async fn read_native_task_result_page(app:tauri::AppHandle,request:TaskResultIndexRequest)->Result<Value,DraftError>{task_results::read_native_task_result_page(app,request).await}
#[tauri::command]
pub async fn inspect_native_task_result(app:tauri::AppHandle,request:TaskResultRequest)->Result<Value,DraftError>{task_results::inspect_native_task_result(app,request).await}

#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct InspectRequest{schema_version:u32,workspace_id:String,registry_revision:u32,root_identity:String,census_digest:String}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CheckAssignment{task_id:String,categories:Vec<String>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CheckSetupRequest{identity:InspectRequest,assignments:Vec<CheckAssignment>,#[serde(default="default_check_profile")]profile_id:String}

fn default_check_profile()->String{"perfect-planner-checks-v1".into()}
fn valid_check_profile(profile:&str)->bool{matches!(profile,"perfect-planner-checks-v1"|"npm-project-checks-v1")}

fn validate_check_assignments(assignments:&[CheckAssignment])->Result<(),DraftError>{
    if assignments.is_empty()||assignments.len()>256{return Err(error("NATIVE_CHECK_ASSIGNMENTS_INVALID"));}
    let mut ids=std::collections::HashSet::new();
    for item in assignments{
        let id=&item.task_id;let mut categories=std::collections::HashSet::new();
        if !(5..=7).contains(&id.len())||!id.starts_with('T')||!id.as_bytes()[1..].iter().all(u8::is_ascii_digit)||!ids.insert(id)
            ||item.categories.is_empty()||item.categories.len()>3||item.categories.iter().any(|c|!matches!(c.as_str(),"tests"|"build"|"secrets")||!categories.insert(c)){
            return Err(error("NATIVE_CHECK_ASSIGNMENTS_INVALID"));
        }
    }
    Ok(())
}
fn check_setup_root(registry:&Path,request:&InspectRequest)->Result<PathBuf,DraftError>{
    validate(request)?;
    let root=crate::workspace_census::registered_git_root(registry,&request.workspace_id,request.registry_revision,&request.root_identity).map_err(|_|error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))?;
    let observation=crate::workspace_census::retained_census_binding(registry,&request.workspace_id,request.registry_revision,&request.root_identity).map_err(|_|error("NATIVE_DRAFT_CENSUS_UNAVAILABLE"))?;
    if observation["censusDigest"]!=request.census_digest||observation["retainedObservation"]!=true||observation["executionAuthorized"]!=false||observation["liveFilesystemVerified"]!=false{return Err(error("NATIVE_DRAFT_CENSUS_MISMATCH"));}
    safe(&root)?;Ok(root)
}
fn save_picked_check_setup<F:FnMut()->Result<PathBuf,DraftError>>(state:&Path,binding:&Binding,assignments:&[CheckAssignment],selected:&Path,mut current_root:F)->Result<Value,DraftError>{
    save_picked_profile_setup(state,binding,assignments,selected,"perfect-planner-checks-v1",&mut current_root)
}
fn save_picked_profile_setup<F:FnMut()->Result<PathBuf,DraftError>>(state:&Path,binding:&Binding,assignments:&[CheckAssignment],selected:&Path,profile:&str,mut current_root:F)->Result<Value,DraftError>{
    if !valid_check_profile(profile){return Err(error("NATIVE_CHECK_SETUP_INVALID"));}
    validate_check_assignments(assignments)?;
    let root=current_root()?;let tool_digest=check_setup::observe_tool(selected)?;
    let final_root=current_root()?;
    if spelling(&root)?!=spelling(&final_root)?{return Err(error("NATIVE_CHECK_SETUP_ROOT_MISMATCH"));}
    let provision=json!({"profileId":profile,"registeredRoot":root,"npmCli":{"path":selected,"sha256":tool_digest},"assignments":assignments});
    let reference=check_setup::save(state,binding,&root,provision)?;
    Ok(json!({"schemaVersion":1,"binding":binding,"selectionState":"saved","setupReference":reference,"toolName":"npm-cli.js","toolDigest":tool_digest,"profileId":profile,"assignments":assignments,"setupPersisted":true,"toolchainVerified":false,"executionAuthorized":false}))
}

#[tauri::command]
pub async fn choose_native_check_setup(app:tauri::AppHandle,request:CheckSetupRequest)->Result<Value,DraftError>{
    validate(&request.identity)?;validate_check_assignments(&request.assignments)?;
    if !valid_check_profile(&request.profile_id){return Err(error("NATIVE_CHECK_SETUP_INVALID"));}
    let _admission=Admission::acquire()?;
    let registry=crate::workspace_census::app_registry_root(&app).map_err(|_|error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))?;
    let identity=request.identity.clone();let initial_registry=registry.clone();
    tauri::async_runtime::spawn_blocking(move||check_setup_root(&initial_registry,&identity)).await.map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))??;
    let binding=Binding{project_id:project_id(&request.identity.root_identity),root_identity:request.identity.root_identity.clone(),census_digest:request.identity.census_digest.clone()};
    let selected=rfd::AsyncFileDialog::new().set_title("Choose npm-cli.js — save a check setup only; nothing will run").add_filter("npm JavaScript entry",&["js"]).pick_file().await;
    let Some(selected)=selected else{return Ok(json!({"schemaVersion":1,"binding":binding,"selectionState":"cancelled","setupReference":null,"setupPersisted":false,"executionAuthorized":false}));};
    let path=selected.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move||{
        let data=app.path().app_data_dir().map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?;
        let state=state_directory(&data)?;
        save_picked_profile_setup(&state,&binding,&request.assignments,&path,&request.profile_id,||check_setup_root(&registry,&request.identity))
    }).await.map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SnapshotRequest{identity:InspectRequest,offset:u32,expected_head_digest:Option<String>}
enum DraftOperationResult{Draft(DraftReceipt),Snapshot(Value)}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct OriginalRequest{request_id:String,expected_revision:u64,expected_head_digest:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CheckPreparationRequest{identity:InspectRequest,setup_reference:String,expected:Head,original_request:OriginalRequest}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CheckStateRequest{identity:InspectRequest,setup_reference:String}

#[tauri::command]
pub async fn inspect_native_checks(app:tauri::AppHandle,request:CheckStateRequest)->Result<Value,DraftError>{
    validate(&request.identity)?;if !digest(&request.setup_reference){return Err(error("NATIVE_CHECK_PREPARATION_INVALID"));}
    let admission=Admission::acquire()?;
    tauri::async_runtime::spawn_blocking(move||{let _admission=admission;check_preparation::inspect(app,request)}).await.map_err(|_|uncertain(false))?
}

#[tauri::command]
pub async fn prepare_native_checks(app:tauri::AppHandle,request:CheckPreparationRequest)->Result<Value,DraftError>{
    check_preparation::validate_request(&request)?;let admission=Admission::acquire()?;
    tauri::async_runtime::spawn_blocking(move||{let _admission=admission;check_preparation::perform(app,request)}).await.map_err(|_|uncertain(true))?
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SubmitRequest{schema_version:u32,workspace_id:String,registry_revision:u32,root_identity:String,census_digest:String,ledger:Value,original_request:OriginalRequest}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct DraftError{code:&'static str,requires_recovery:bool,request_may_have_committed:bool,original_request_id:Option<String>,execution_authorized:bool}
fn error(code:&'static str)->DraftError{DraftError{code,requires_recovery:false,request_may_have_committed:false,original_request_id:None,execution_authorized:false}}
fn uncertain(committed:bool)->DraftError{DraftError{code:"NATIVE_DRAFT_SESSION_UNRESOLVED",requires_recovery:true,request_may_have_committed:committed,original_request_id:None,execution_authorized:false}}
fn unknown(original:&str)->DraftError{DraftError{code:"NATIVE_DRAFT_OUTCOME_UNKNOWN",requires_recovery:false,request_may_have_committed:true,original_request_id:Some(original.to_owned()),execution_authorized:false}}
static ACTIVE:AtomicUsize=AtomicUsize::new(0);
struct Admission;
impl Admission{fn acquire()->Result<Self,DraftError>{ACTIVE.fetch_update(Ordering::SeqCst,Ordering::SeqCst,|n|if n<2{Some(n+1)}else{None}).map(|_|Self).map_err(|_|error("NATIVE_DRAFT_BUSY"))}}
impl Drop for Admission{fn drop(&mut self){ACTIVE.fetch_sub(1,Ordering::SeqCst);}}
#[derive(Debug,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Head{host_revision:u64,head_digest:String}
#[derive(Debug,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Submitted{host_revision:u64,head_digest:String,ledger_digest:String}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Submission{record:Submitted,submission_persisted:bool,idempotent:bool,submitted_matches_observed_head:bool}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct DraftReceipt{schema_version:u32,binding:Binding,observed_head:Head,submission:Option<Submission>,registration_current:bool,registration_lease_held:bool,approval_state:&'static str,execution_authorized:bool,cleanup_complete:bool}

fn digest(s:&str)->bool{s.len()==64&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn token(s:&str,max:usize)->bool{!s.is_empty()&&s.len()<=max&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b))}
fn request_token(s:&str)->bool{!s.is_empty()&&s.len()<=128&&s.as_bytes()[0].is_ascii_alphanumeric()&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b"._:-".contains(&b))}
fn validate(request:&InspectRequest)->Result<(),DraftError>{if request.schema_version!=1||request.workspace_id.len()<3||!token(&request.workspace_id,64)||request.registry_revision==0||!digest(&request.root_identity)||!digest(&request.census_digest){Err(error("NATIVE_DRAFT_REQUEST_INVALID"))}else{Ok(())}}
fn validate_submission(ledger:&Value,original:&OriginalRequest)->Result<(),DraftError>{
    struct Limit(usize);impl Write for Limit{fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{if bytes.len()>1024*1024-self.0{return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"input limit"));}self.0+=bytes.len();Ok(bytes.len())}fn flush(&mut self)->std::io::Result<()>{Ok(())}}
    if !request_token(&original.request_id)||original.expected_revision>9_007_199_254_740_991||(if original.expected_revision==0{original.expected_head_digest!="GENESIS"}else{!digest(&original.expected_head_digest)})||!ledger.is_object()||serde_json::to_writer(&mut Limit(0),ledger).is_err(){return Err(error("NATIVE_DRAFT_REQUEST_INVALID"));}Ok(())
}
fn draft_request_digest(ledger:&Value,original:&OriginalRequest)->Result<String,DraftError>{
    // serde_json::Value uses sorted maps in this build (preserve_order disabled).
    // Hash the complete validated obligation, never only its caller-supplied ID.
    let canonical=json!({"ledger":ledger,"originalRequest":{"requestId":original.request_id,"expectedRevision":original.expected_revision,"expectedHeadDigest":original.expected_head_digest}});
    let bytes=serde_json::to_vec(&canonical).map_err(|_|error("NATIVE_DRAFT_REQUEST_INVALID"))?;
    Ok(format!("{:x}",Sha256::digest(&bytes)))
}
fn project_id(root:&str)->String{let mut n=0xcbf29ce484222325u64;for byte in root.bytes(){n^=byte as u64;n=n.wrapping_mul(0x100000001b3);}let mut base=Vec::new();loop{base.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n%36)as usize]);n/=36;if n==0{break;}}while base.len()<13{base.push(b'0');}base.reverse();format!("pp_{}_{}",&root[..16],std::str::from_utf8(&base[..8]).unwrap())}
fn spelling(path:&Path)->Result<String,DraftError>{let s=path.to_str().ok_or_else(||error("NATIVE_DRAFT_PATH_INVALID"))?;#[cfg(windows)]{let s=s.replace('/',"\\").to_lowercase();Ok(if let Some(v)=s.strip_prefix("\\\\?\\unc\\"){format!("\\\\{v}")}else{s.strip_prefix("\\\\?\\").unwrap_or(&s).to_owned()})}#[cfg(not(windows))]{Ok(s.to_owned())}}
fn safe(path:&Path)->Result<(),DraftError>{
    if !path.is_absolute()||path.components().any(|p|matches!(p,Component::ParentDir|Component::CurDir)){return Err(error("NATIVE_DRAFT_PATH_INVALID"));}
    for part in path.ancestors(){let m=fs::symlink_metadata(part).map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;if m.file_type().is_symlink(){return Err(error("NATIVE_DRAFT_STORAGE_REDIRECTED"));}#[cfg(windows)]{use std::os::windows::fs::MetadataExt;if m.file_attributes()&0x400!=0{return Err(error("NATIVE_DRAFT_STORAGE_REDIRECTED"));}}if spelling(part)?!=spelling(&fs::canonicalize(part).map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?)?{return Err(error("NATIVE_DRAFT_PATH_INVALID"));}}Ok(())
}
fn identity(file:&File)->Result<(u64,u64),DraftError>{
    #[cfg(windows)]{use std::os::windows::io::AsRawHandle;#[link(name="kernel32")]extern "system"{fn GetFileInformationByHandle(handle:*mut std::ffi::c_void,info:*mut u32)->i32;}let mut data=[0u32;13];if unsafe{GetFileInformationByHandle(file.as_raw_handle(),data.as_mut_ptr())}==0||data[10]!=1{return Err(error("NATIVE_DRAFT_FILE_IDENTITY_INVALID"));}Ok((data[7]as u64,((data[11]as u64)<<32)|data[12]as u64))}
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;let m=file.metadata().map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;if m.nlink()!=1{return Err(error("NATIVE_DRAFT_FILE_IDENTITY_INVALID"));}Ok((m.dev(),m.ino()))}
    #[cfg(not(any(windows,unix)))]{Err(error("NATIVE_DRAFT_PLATFORM_UNSUPPORTED"))}
}
fn stamp(file:&File)->Result<(u64,SystemTime,(u64,u64)),DraftError>{let m=file.metadata().map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;if !m.is_file(){return Err(error("NATIVE_DRAFT_STORAGE_INVALID"));}Ok((m.len(),m.modified().map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?,identity(file)?))}
fn self_executable()->Result<(PathBuf,String),DraftError>{
    let exe=std::env::current_exe().map_err(|_|error("NATIVE_DRAFT_SELF_UNAVAILABLE"))?;safe(&exe)?;let mut file=File::open(&exe).map_err(|_|error("NATIVE_DRAFT_SELF_UNAVAILABLE"))?;let before=stamp(&file)?;if before.0>128*1024*1024{return Err(error("NATIVE_DRAFT_SELF_TOO_LARGE"));}
    let mut hash=Sha256::new();let mut buffer=[0u8;65536];let mut size=0u64;loop{let n=file.read(&mut buffer).map_err(|_|error("NATIVE_DRAFT_SELF_UNAVAILABLE"))?;if n==0{break;}size+=n as u64;if size>before.0{return Err(error("NATIVE_DRAFT_SELF_CHANGED"));}hash.update(&buffer[..n]);}
    safe(&exe)?;let current=File::open(&exe).map_err(|_|error("NATIVE_DRAFT_SELF_CHANGED"))?;if size!=before.0||stamp(&file)?!=before||stamp(&current)?!=before{return Err(error("NATIVE_DRAFT_SELF_CHANGED"));}Ok((exe,format!("{:x}",hash.finalize())))
}
fn state_directory(app_data:&Path)->Result<PathBuf,DraftError>{safe(app_data)?;if !app_data.is_dir(){return Err(error("NATIVE_DRAFT_STORAGE_INVALID"));}let directory=app_data.join("native-draft-host-v1");match fs::create_dir(&directory){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))}safe(&directory)?;if !directory.is_dir(){return Err(error("NATIVE_DRAFT_STORAGE_INVALID"));}Ok(directory)}

#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct SessionRecord{schema_version:u32,sequence:u32,session_id:String,state:String,outcome_request_id:Option<String>,outcome_ledger_request_digest:Option<String>}
struct Guard{file:File,path:PathBuf,id:(u64,u64),sequence:u32,session:String,begun:bool,outstanding:Option<String>,outstanding_digest:Option<String>}
impl Guard{
    fn open(directory:&Path,project:&str,original:Option<(&str,&str)>)->Result<Self,DraftError>{
        if original.map(|(id,hash)|!request_token(id)||!digest(hash)).unwrap_or(false){return Err(error("NATIVE_DRAFT_REQUEST_INVALID"));}
        safe(directory)?;let path=directory.join(format!("{project}.sessions.jsonl"));
        let mut entries=0;for item in fs::read_dir(directory).map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?{item.map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;entries+=1;if entries>512{return Err(error("NATIVE_DRAFT_STORAGE_LIMIT"));}}
        let (mut file,new)=match OpenOptions::new().read(true).append(true).create_new(true).open(&path){Ok(file)=>(file,true),Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>(OpenOptions::new().read(true).append(true).open(&path).map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?,false),Err(_)=>return Err(error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))};
        safe(&path)?;let before=stamp(&file)?;file.try_lock_exclusive().map_err(|_|error("NATIVE_DRAFT_BUSY"))?;
        if before.0>256*1024||(!new&&before.0==0){return Err(uncertain(false));}
        let mut bytes=Vec::new();(&mut file).take(256*1024+1).read_to_end(&mut bytes).map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;if bytes.len()as u64!=before.0||stamp(&file)?!=before||(!bytes.is_empty()&&bytes.last()!=Some(&b'\n')){return Err(uncertain(false));}
        let mut sequence=0;let mut pending:Option<String>=None;let mut outstanding:Option<String>=None;let mut outstanding_digest:Option<String>=None;
        let records=if bytes.is_empty(){&bytes[..]}else{&bytes[..bytes.len()-1]};
        for line in records.split(|b|*b==b'\n').filter(|_|!records.is_empty()){
            if line.is_empty()||line.len()>1024{return Err(uncertain(false));}let value:Value=serde_json::from_slice(line).map_err(|_|uncertain(false))?;if value.get("outcomeRequestId").is_none()||value.get("outcomeLedgerRequestDigest").is_none(){return Err(uncertain(false));}let record:SessionRecord=serde_json::from_slice(line).map_err(|_|uncertain(false))?;
            if record.schema_version!=1||record.sequence!=sequence+1||!token(&record.session_id,96){return Err(uncertain(false));}sequence=record.sequence;
            if record.outcome_request_id.as_deref().map(|id|!request_token(id)).unwrap_or(false)||record.outcome_ledger_request_digest.as_deref().map(|hash|!digest(hash)).unwrap_or(false)||record.outcome_request_id.is_some()!=record.outcome_ledger_request_digest.is_some(){return Err(uncertain(false));}
            match record.state.as_str(){"BEGIN" if pending.is_none()&&record.outcome_request_id==outstanding&&record.outcome_ledger_request_digest==outstanding_digest=>pending=Some(record.session_id),"SETTLED" if pending.as_deref()==Some(&record.session_id)=>{pending=None;outstanding=record.outcome_request_id;outstanding_digest=record.outcome_ledger_request_digest;},"PRE_DISPATCH_REFUSED" if pending.is_none()&&record.outcome_request_id==outstanding&&record.outcome_ledger_request_digest==outstanding_digest=>{},_=>return Err(uncertain(false))}
        }
        if pending.is_some(){return Err(uncertain(true));}if sequence>=510{return Err(error("NATIVE_DRAFT_SESSION_LIMIT"));}
        if let(Some((wanted,wanted_digest)),Some(outstanding))=(original,outstanding.as_deref()){if wanted!=outstanding||Some(wanted_digest)!=outstanding_digest.as_deref(){return Err(unknown(outstanding));}}
        Ok(Self{file,path,id:before.2,sequence,session:fresh_id(),begun:false,outstanding,outstanding_digest})
    }
    fn append(&mut self,state:&str)->Result<(),DraftError>{
        if !matches!((state,self.begun),("BEGIN",false)|("SETTLED",true)|("PRE_DISPATCH_REFUSED",false)){return Err(uncertain(true));}
        if self.outstanding.is_some()!=self.outstanding_digest.is_some()||self.outstanding_digest.as_deref().map(|hash|!digest(hash)).unwrap_or(false){return Err(uncertain(true));}
        safe(&self.path)?;let current=File::open(&self.path).map_err(|_|uncertain(true))?;if identity(&current)?!=self.id||identity(&self.file)?!=self.id{return Err(uncertain(true));}
        let record=SessionRecord{schema_version:1,sequence:self.sequence+1,session_id:self.session.clone(),state:state.to_owned(),outcome_request_id:self.outstanding.clone(),outcome_ledger_request_digest:self.outstanding_digest.clone()};let mut bytes=serde_json::to_vec(&record).map_err(|_|uncertain(true))?;bytes.push(b'\n');self.file.write_all(&bytes).and_then(|_|self.file.sync_all()).map_err(|_|uncertain(true))?;self.sequence+=1;self.begun=state=="BEGIN";Ok(())
    }
}
fn fresh_id()->String{static NEXT:AtomicU64=AtomicU64::new(1);format!("native-{}-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(),NEXT.fetch_add(1,Ordering::Relaxed))}

// Diagnostic evidence is never a session disposition or recovery permission.
// Reserve two immutable bounded records while the project session lock is held.
struct DiagnosticSession{directory:PathBuf,session:String,reserved_supervisor:bool}
fn prepare_live_diagnostics(guard:&mut session_store::LiveGuard,state:&Path,binding:&Binding,submitted:bool,original:Option<(&str,&str)>,command:&str)->Result<DiagnosticSession,DraftError>{
    if guard.begun{return Err(uncertain(true));}
    let prepared=guard.reserve_terminal().and_then(|_|session_diagnostics::prepare(state,guard,binding,submitted,original,command));
    match prepared{Ok(value)=>Ok(value),Err(failure)=>{guard.append("PRE_DISPATCH_REFUSED")?;Err(failure)}}
}
// Only called before BEGIN and before the supervisor can be invoked. A durable
// refusal avoids leaving a newly created empty journal, but never closes BEGIN.
fn prepare_diagnostics<F>(guard:&mut Guard,prepare:F)->Result<DiagnosticSession,DraftError>
where F:FnOnce(&Guard)->Result<DiagnosticSession,DraftError>{
    if guard.begun{return Err(uncertain(true));}
    match prepare(guard){Ok(value)=>Ok(value),Err(failure)=>{guard.append("PRE_DISPATCH_REFUSED")?;Err(failure)}}
}
impl DiagnosticSession{
    fn prepare(state:&Path,guard:&Guard,binding:&Binding,submitted:bool,original:Option<(&str,&str)>)->Result<Self,DraftError>{
        Self::prepare_named(state,guard,binding,submitted,original,if submitted{"submit-draft"}else{"inspect-proposal"})
    }
    fn prepare_named(state:&Path,guard:&Guard,binding:&Binding,submitted:bool,original:Option<(&str,&str)>,command:&str)->Result<Self,DraftError>{
        if !matches!(command,"inspect-proposal"|"submit-draft"|"read-proposal-snapshot"|"prepare-checks"|"inspect-checks"|"inspect-task-result"|"list-task-results"|"read-task-result-page")||submitted!=matches!(command,"submit-draft"|"prepare-checks"){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
        if !token(&guard.session,96)||original.map(|(id,hash)|!request_token(id)||!digest(hash)).unwrap_or(false)||submitted!=original.is_some(){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
        let directory=state.join(format!("{}.diagnostics",binding.project_id));
        safe(state)?;match fs::create_dir(&directory){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))}
        safe(&directory)?;if !directory.is_dir(){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
        let mut count=0;let mut total=0u64;
        for entry in fs::read_dir(&directory).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?{
            let path=entry.map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?.path();safe(&path)?;
            let file=File::open(&path).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;let observed=stamp(&file)?;
            if observed.0>4096{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"));}count+=1;total+=observed.0;
            if count>510||total>2*1024*1024-8192{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"));}
        }
        let diagnostic=Self{directory,session:guard.session.clone(),reserved_supervisor:false};
        diagnostic.write("intent",&json!({"schemaVersion":1,"sessionId":guard.session,"binding":binding,"command":command,"originalRequestId":original.map(|v|v.0),"originalObligationDigest":original.map(|v|v.1),"priorOutstandingRequestId":guard.outstanding,"priorOutstandingObligationDigest":guard.outstanding_digest,"executionAuthorized":false,"recoveryAuthorized":false}))?;
        Ok(diagnostic)
    }
    fn write(&self,kind:&str,value:&Value)->Result<(),DraftError>{
        if !matches!(kind,"intent"|"supervisor"){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
        let bytes=serde_json::to_vec(value).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"))?;if bytes.len()>4096{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"));}
        safe(&self.directory)?;let path=self.directory.join(format!("{}.{}.json",self.session,kind));
        if self.reserved_supervisor&&kind=="supervisor"{
            return session_store::publish_reserved(&self.directory.join(format!("{}.supervisor.reserve",self.session)),&path,&bytes);
        }
        let mut file=OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;safe(&path)?;let id=identity(&file)?;
        file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;
        safe(&path)?;let current=File::open(&path).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;
        if identity(&current)?!=id||identity(&file)?!=id||stamp(&current)?.0!=bytes.len()as u64{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"));}Ok(())
    }
    fn supervisor(&self,proof:&crate::native_host_supervisor::SupervisorReceipt)->Result<(),DraftError>{
        let reason=match proof.reason{
            "NATIVE_HOST_REQUEST_INVALID"|"NATIVE_HOST_REQUEST_TOO_LARGE"|"NATIVE_HOST_CONFIGURATION_INVALID"|"NATIVE_HOST_CONFIGURATION_TOO_LARGE"|"NATIVE_HOST_PLATFORM_UNSUPPORTED"|"NATIVE_HOST_START_FAILED"|"NATIVE_HOST_CONTAINMENT_FAILED"|"NATIVE_HOST_TRANSPORT_FAILED"|"NATIVE_HOST_WRITE_FAILED"|"NATIVE_HOST_READY_MISMATCH"|"NATIVE_HOST_REPLY_INVALID"|"NATIVE_HOST_STOPPED_INVALID"|"NATIVE_HOST_OUTPUT_UNSETTLED"|"NATIVE_HOST_EXIT_FAILED"|"NATIVE_HOST_EXIT_UNSETTLED"|"NATIVE_HOST_TIMEOUT"|"NATIVE_HOST_REQUEST_FINISHED"|"NATIVE_HOST_MANIFEST_INVALID"|"NATIVE_HOST_NOT_CONFIGURED"|"NATIVE_HOST_RESOURCE_CHANGED"|"NATIVE_HOST_RESOURCE_IDENTITY_INVALID"|"NATIVE_HOST_RESOURCE_NONCANONICAL"|"NATIVE_HOST_RESOURCE_NOT_FILE"|"NATIVE_HOST_RESOURCE_PATH_INVALID"|"NATIVE_HOST_RESOURCE_PIN_MISMATCH"|"NATIVE_HOST_RESOURCE_PLATFORM_UNSUPPORTED"|"NATIVE_HOST_RESOURCE_READ_FAILED"|"NATIVE_HOST_RESOURCE_REDIRECTED"|"NATIVE_HOST_RESOURCE_SIZE_INVALID"|"NATIVE_HOST_RESOURCE_TIMESTAMP_UNAVAILABLE"|"NATIVE_HOST_RESOURCE_UNAVAILABLE"=>proof.reason,
            "NATIVE_HOST_READY_EOF"|"NATIVE_HOST_READY_READ_ERROR"|"NATIVE_HOST_READY_OUTPUT_INVALID"|"NATIVE_HOST_READY_TIMEOUT"|"NATIVE_HOST_READY_CHANNEL_CLOSED"|"NATIVE_HOST_REPLY_EOF"|"NATIVE_HOST_REPLY_READ_ERROR"|"NATIVE_HOST_REPLY_OUTPUT_INVALID"|"NATIVE_HOST_REPLY_TIMEOUT"|"NATIVE_HOST_REPLY_CHANNEL_CLOSED"|"NATIVE_HOST_STOPPED_EOF"|"NATIVE_HOST_STOPPED_READ_ERROR"|"NATIVE_HOST_STOPPED_OUTPUT_INVALID"|"NATIVE_HOST_STOPPED_TIMEOUT"|"NATIVE_HOST_STOPPED_CHANNEL_CLOSED"=>proof.reason,
            _=>"NATIVE_HOST_REASON_UNAVAILABLE",
        };
        self.write("supervisor",&json!({"schemaVersion":1,"sessionId":self.session,"reason":reason,"childExitCode":proof.child_exit_code,"requestMayHaveCommitted":proof.request_may_have_committed,"processExited":proof.process_exited,"descendantsSettled":proof.descendants_settled,"ioSettled":proof.io_settled,"cleanupComplete":proof.cleanup_complete,"executionAuthorizationObserved":proof.execution_authorized,"executionAuthorized":false,"recoveryAuthorized":false}))
    }
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct InspectResult{schema_version:u32,observed_head:Head,registration_current:bool,registration_lease_held:bool,approval_state:String,execution_authorized:bool}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct SubmitResult{schema_version:u32,observed_head:Head,registration_current:bool,registration_lease_held:bool,approval_state:String,execution_authorized:bool,submitted:Submitted,submission_persisted:bool,idempotent:bool,submitted_matches_observed_head:bool}
fn head_valid(head:&Head)->bool{head.host_revision<=9_007_199_254_740_991&&(if head.host_revision==0{head.head_digest=="GENESIS"}else{digest(&head.head_digest)})}
fn project_result(value:Value,submitted:bool,binding:Binding)->Result<DraftReceipt,DraftError>{
    let (base,submission)=if submitted{let s:SubmitResult=serde_json::from_value(value).map_err(|_|uncertain(true))?;
        if s.submitted.host_revision==0||s.submitted.host_revision>9_007_199_254_740_991||s.observed_head.host_revision<s.submitted.host_revision||!digest(&s.submitted.head_digest)||!digest(&s.submitted.ledger_digest)||!s.submission_persisted||s.submitted_matches_observed_head!=(s.observed_head.host_revision==s.submitted.host_revision&&s.observed_head.head_digest==s.submitted.head_digest){return Err(uncertain(true));}
        (InspectResult{schema_version:s.schema_version,observed_head:s.observed_head,registration_current:s.registration_current,registration_lease_held:s.registration_lease_held,approval_state:s.approval_state,execution_authorized:s.execution_authorized},Some(Submission{record:s.submitted,submission_persisted:true,idempotent:s.idempotent,submitted_matches_observed_head:s.submitted_matches_observed_head}))
    }else{(serde_json::from_value::<InspectResult>(value).map_err(|_|uncertain(false))?,None)};
    if base.schema_version!=1||!head_valid(&base.observed_head)||base.registration_lease_held||base.execution_authorized||base.approval_state!="unapproved-proposal"{return Err(uncertain(submitted));}
    Ok(DraftReceipt{schema_version:1,binding,observed_head:base.observed_head,submission,registration_current:base.registration_current,registration_lease_held:false,approval_state:"unapproved-proposal",execution_authorized:false,cleanup_complete:true})
}
fn host_error(value:&Value)->Option<&'static str>{if value.as_object()?.len()!=1{return None;}match value["code"].as_str()?{"TASK_LEDGER_STALE_HEAD"=>Some("TASK_LEDGER_STALE_HEAD"),"TASK_LEDGER_REQUEST_CONFLICT"=>Some("TASK_LEDGER_REQUEST_CONFLICT"),"DRAFT_REGISTRATION_UNAVAILABLE"=>Some("DRAFT_REGISTRATION_UNAVAILABLE"),"DRAFT_REGISTRATION_FOREIGN"=>Some("DRAFT_REGISTRATION_FOREIGN"),"DRAFT_SUBMISSION_BINDING_MISMATCH"=>Some("DRAFT_SUBMISSION_BINDING_MISMATCH"),"NATIVE_REVIEW_HOST_FAILURE"=>Some("NATIVE_DRAFT_HOST_REFUSED"),"PROTOCOL_INVALID_REQUEST"=>Some("NATIVE_DRAFT_REQUEST_INVALID"),_=>None}}

// Native-owner read configuration reuses the exact draft state directory and
// executable verification. It is never accepted as renderer/MCP input.
pub(crate) fn agent_read_configuration(app:&tauri::AppHandle,workspace_id:&str,registry_revision:u32,root_identity:&str,census_digest:&str)->Result<(PathBuf,PathBuf,Value),&'static str>{
    let request=InspectRequest{schema_version:1,workspace_id:workspace_id.into(),registry_revision,root_identity:root_identity.into(),census_digest:census_digest.into()};
    validate(&request).map_err(|_|"AGENT_PLAN_REQUEST_INVALID")?;
    let registry=crate::workspace_census::app_registry_root(app).map_err(|_|"AGENT_PLAN_REGISTRY_UNAVAILABLE")?;
    crate::workspace_census::registered_metadata(&registry,workspace_id,registry_revision,root_identity).map_err(|_|"AGENT_PLAN_REGISTRATION_CHANGED")?;
    let observation=crate::workspace_census::retained_census_binding(&registry,workspace_id,registry_revision,root_identity).map_err(|_|"AGENT_PLAN_CENSUS_UNAVAILABLE")?;
    if observation["censusDigest"]!=census_digest||observation["retainedObservation"]!=true||observation["liveFilesystemVerified"]!=false||observation["executionAuthorized"]!=false{return Err("AGENT_PLAN_CENSUS_CHANGED");}
    let resources=app.path().resource_dir().map_err(|_|"AGENT_PLAN_PACKAGE_UNAVAILABLE")?;
    let installed=crate::native_host_resources::verify_installed(&resources)?;
    let(executable,pin)=self_executable().map_err(|_|"AGENT_PLAN_EXECUTABLE_UNAVAILABLE")?;
    let data=app.path().app_data_dir().map_err(|_|"AGENT_PLAN_STATE_UNAVAILABLE")?;
    let state=state_directory(&data).map_err(|_|"AGENT_PLAN_STATE_UNAVAILABLE")?;
    let config=json!({"packageConfig":{"packageRoot":installed.package_root,"manifestDigest":installed.manifest_digest},"metadataConfig":{"executable":executable,"executableDigest":pin,"registryRoot":registry,"workspaceId":workspace_id,"registryRevision":registry_revision,"rootIdentity":root_identity},"stateDirectory":state,"actor":"local-native-user","source":"perfect-planner-agent-plan-read"});
    Ok((resources,registry,config))
}

fn perform(app:tauri::AppHandle,request:InspectRequest,submission:Option<(Value,OriginalRequest)>)->Result<DraftReceipt,DraftError>{
    match perform_operation(app,request,submission,None)?{DraftOperationResult::Draft(receipt)=>Ok(receipt),_=>Err(error("NATIVE_DRAFT_RESULT_INVALID"))}
}
fn perform_operation(app:tauri::AppHandle,request:InspectRequest,submission:Option<(Value,OriginalRequest)>,snapshot:Option<Value>)->Result<DraftOperationResult,DraftError>{
    validate(&request)?;
    let registry=crate::workspace_census::app_registry_root(&app).map_err(|_|error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))?;
    crate::workspace_census::registered_metadata(&registry,&request.workspace_id,request.registry_revision,&request.root_identity).map_err(|_|error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))?;
    let observation=crate::workspace_census::retained_census_binding(&registry,&request.workspace_id,request.registry_revision,&request.root_identity).map_err(|_|error("NATIVE_DRAFT_CENSUS_UNAVAILABLE"))?;
    if observation["censusDigest"]!=request.census_digest||observation["retainedObservation"]!=true||observation["liveFilesystemVerified"]!=false||observation["executionAuthorized"]!=false{return Err(error("NATIVE_DRAFT_CENSUS_MISMATCH"));}
    let binding=Binding{project_id:project_id(&request.root_identity),root_identity:request.root_identity.clone(),census_digest:request.census_digest.clone()};
    let resources=app.path().resource_dir().map_err(|_|error("NATIVE_DRAFT_RESOURCES_UNAVAILABLE"))?;
    // Refuse unavailable installations before creating a pending session.
    crate::native_host_resources::verify_installed(&resources).map_err(|_|error("NATIVE_DRAFT_HOST_NOT_AVAILABLE"))?;
    let (executable,pin)=self_executable()?;
    let data=app.path().app_data_dir().map_err(|_|error("NATIVE_DRAFT_STORAGE_UNAVAILABLE"))?;let state=state_directory(&data)?;
    let submitted=submission.is_some();let original_id=submission.as_ref().map(|(_,r)|r.request_id.clone());let original_digest=match submission.as_ref(){Some((ledger,original))=>Some(draft_request_digest(ledger,original)?),None=>None};let payload=match submission{Some((ledger,original))=>json!({"ledger":ledger,"request":{"requestId":original.request_id,"expectedRevision":original.expected_revision,"expectedHeadDigest":original.expected_head_digest}}),None=>json!({})};
    let mut guard=session_store::LiveGuard::open(&state,&binding.root_identity,original_id.as_deref().zip(original_digest.as_deref()))?;
    let command=if snapshot.is_some(){"read-proposal-snapshot"}else if submitted{"submit-draft"}else{"inspect-proposal"};
    let diagnostics=prepare_live_diagnostics(&mut guard,&state,&binding,submitted,original_id.as_deref().zip(original_digest.as_deref()),command)?;
    guard.append("BEGIN")?;
    let cfg=HostConfiguration{metadata_executable:executable,metadata_digest:pin,registry_root:registry,state_directory:state,workspace_id:request.workspace_id,registry_revision:request.registry_revision,expected_binding:binding.clone(),actor:"local-native-user".into(),source:"perfect-planner-native-draft".into(),check_contract:None,check_profile_provision:None,prepared_check_selection:None};
    let protocol=json!({"version":1,"requestId":guard.session,"command":command,"payload":snapshot.as_ref().unwrap_or(&payload)});
    let proof=crate::native_host_supervisor::run_single(&resources,&cfg,&protocol);
    if diagnostics.supervisor(&proof).is_err(){let mut failure=uncertain(proof.request_may_have_committed);failure.code="NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE";failure.original_request_id=original_id;return Err(failure);}
    if !proof.cleanup_complete||!proof.process_exited||!proof.descendants_settled||!proof.io_settled||proof.execution_authorized{let mut failure=uncertain(proof.request_may_have_committed);failure.original_request_id=original_id;return Err(failure);}
    let reply=proof.reply.ok_or_else(||uncertain(proof.request_may_have_committed))?;
    let mut projected=if reply["ok"]==true{if let Some(input)=snapshot.as_ref(){project_snapshot(reply["result"].clone(),&binding,input).map(DraftOperationResult::Snapshot)}else{project_result(reply["result"].clone(),submitted,binding).map(DraftOperationResult::Draft)}}else if submitted&&reply["error"]["code"]=="NATIVE_REVIEW_HOST_FAILURE"{Err(unknown(original_id.as_deref().unwrap()))}else{host_error(&reply["error"]).map(|code|Err(error(code))).unwrap_or_else(||Err(uncertain(proof.request_may_have_committed)))};
    if projected.as_ref().err().map(|e|e.requires_recovery||e.code=="NATIVE_DRAFT_OUTCOME_UNKNOWN").unwrap_or(false){
        // Transport closure is proven separately. A missing/invalid business
        // outcome must preserve possible persistence without inventing an open
        // process. Only the original submission can reconcile this obligation.
        projected=if let Some(original)=original_id.as_deref(){guard.outstanding=Some(original.to_owned());guard.outstanding_digest=original_digest.clone();Err(unknown(original))}else{Err(error("NATIVE_DRAFT_RESULT_INVALID"))};
    }
    if submitted&&projected.is_ok(){guard.outstanding=None;guard.outstanding_digest=None;}
    if let(Err(failure),Some(outstanding))=(&mut projected,guard.outstanding.as_ref()){failure.request_may_have_committed=true;failure.original_request_id=Some(outstanding.clone());}
    guard.append("SETTLED")?;projected
}

#[tauri::command]
pub async fn read_native_draft_snapshot(app:tauri::AppHandle,request:SnapshotRequest)->Result<Value,DraftError>{
    validate(&request.identity)?;
    if request.offset>=1024*1024||!match request.expected_head_digest.as_deref(){Some("GENESIS")=>true,Some(v)=>digest(v),None=>request.offset==0}{return Err(error("NATIVE_DRAFT_REQUEST_INVALID"));}
    let admission=Admission::acquire()?;
    tauri::async_runtime::spawn_blocking(move||{let _admission=admission;match perform_operation(app,request.identity,None,Some(json!({"offset":request.offset,"expectedHeadDigest":request.expected_head_digest})))?{DraftOperationResult::Snapshot(value)=>Ok(value),_=>Err(error("NATIVE_DRAFT_RESULT_INVALID"))}}).await.map_err(|_|uncertain(false))?
}
fn project_snapshot(mut value:Value,binding:&Binding,input:&Value)->Result<Value,DraftError>{
    let keys=["schemaVersion","binding","observedHead","ledgerDigest","snapshotDigest","encoding","offset","totalLength","nextOffset","chunk","approvalState","executionAuthorized"];
    let valid=value.as_object().is_some_and(|v|v.len()==keys.len()&&keys.iter().all(|k|v.contains_key(*k)));
    let offset=value["offset"].as_u64();let total=value["totalLength"].as_u64();let chunk=value["chunk"].as_str();
    if !valid||value["schemaVersion"]!=1||value["binding"]!=serde_json::to_value(binding).map_err(|_|error("NATIVE_DRAFT_RESULT_INVALID"))?||value["executionAuthorized"]!=false||value["approvalState"]!="unapproved-proposal"||offset!=input["offset"].as_u64()||!total.is_some_and(|n|n>0&&n<=1024*1024)||!chunk.is_some_and(|s|s.encode_utf16().count()>0&&s.encode_utf16().count()<=1024*1024)||!value["snapshotDigest"].as_str().is_some_and(digest)||!(value["ledgerDigest"].is_null()||value["ledgerDigest"].as_str().is_some_and(digest)){return Err(error("NATIVE_DRAFT_RESULT_INVALID"));}
    let head:Head=serde_json::from_value(value["observedHead"].clone()).map_err(|_|error("NATIVE_DRAFT_RESULT_INVALID"))?;
    if head.host_revision>9_007_199_254_740_991||(if head.host_revision==0{head.head_digest!="GENESIS"}else{!digest(&head.head_digest)})||(!input["expectedHeadDigest"].is_null()&&value["observedHead"]["headDigest"]!=input["expectedHeadDigest"]){return Err(error("NATIVE_DRAFT_RESULT_INVALID"));}
    let end=offset.unwrap()+chunk.unwrap().encode_utf16().count() as u64;
    if end>total.unwrap()||value["nextOffset"]!=if end<total.unwrap(){json!(end)}else{Value::Null}||value["encoding"]!="json; offsets in UTF-16 code units; concatenate all chunks before parsing"{return Err(error("NATIVE_DRAFT_RESULT_INVALID"));}
    value.as_object_mut().unwrap().insert("cleanupComplete".into(),json!(true));Ok(value)
}
#[tauri::command]
pub async fn inspect_native_draft_proposal(app:tauri::AppHandle,request:InspectRequest)->Result<DraftReceipt,DraftError>{validate(&request)?;let admission=Admission::acquire()?;tauri::async_runtime::spawn_blocking(move||{let _admission=admission;perform(app,request,None)}).await.map_err(|_|uncertain(false))?}
#[tauri::command]
pub async fn submit_native_draft_proposal(app:tauri::AppHandle,request:SubmitRequest)->Result<DraftReceipt,DraftError>{
    let identity=InspectRequest{schema_version:request.schema_version,workspace_id:request.workspace_id,registry_revision:request.registry_revision,root_identity:request.root_identity,census_digest:request.census_digest};validate(&identity)?;
    let admission=Admission::acquire()?;validate_submission(&request.ledger,&request.original_request)?;
    tauri::async_runtime::spawn_blocking(move||{let _admission=admission;perform(app,identity,Some((request.ledger,request.original_request)))}).await.map_err(|_|uncertain(true))?
}

#[cfg(test)]mod tests{
    #[test]fn check_setup_request_never_accepts_renderer_tool_or_configuration(){
        let identity=json!({"schemaVersion":1,"workspaceId":"fixture","registryRevision":1,"rootIdentity":"a".repeat(64),"censusDigest":"b".repeat(64)});
        let request=json!({"identity":identity,"assignments":[{"taskId":"T0001","categories":["tests"]}]});
        assert!(serde_json::from_value::<CheckSetupRequest>(request.clone()).is_ok());
        for key in ["path","npmCli","actor","command","registeredRoot","setupReference"]{let mut altered=request.clone();altered[key]=json!("injected");assert!(serde_json::from_value::<CheckSetupRequest>(altered).is_err());}
        for categories in [json!([]),json!(["tests","tests"]),json!(["shell"])]{let mut changed=request.clone();changed["assignments"][0]["categories"]=categories;let r:CheckSetupRequest=serde_json::from_value(changed).unwrap();assert!(validate_check_assignments(&r.assignments).is_err());}
        let mut changed=request;changed["assignments"][0]["taskId"]=json!("../../file");let r:CheckSetupRequest=serde_json::from_value(changed).unwrap();assert!(validate_check_assignments(&r.assignments).is_err());
    }
    #[test]fn selected_check_setup_returns_only_bound_receipt_without_paths_or_authority(){
        let dir=temp();let selected=dir.join("npm-cli.js");fs::write(&selected,b"never run this").unwrap();
        let b=Binding{project_id:project_id(&"a".repeat(64)),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};
        let assignments=vec![CheckAssignment{task_id:"T0001".into(),categories:vec!["tests".into()]}];let mut reads=0;
        let receipt=save_picked_check_setup(&dir,&b,&assignments,&selected,||{reads+=1;Ok(dir.clone())}).unwrap();assert_eq!(reads,2);
        assert_eq!(receipt["binding"],json!(b));assert_eq!(receipt["executionAuthorized"],false);assert_eq!(receipt["toolchainVerified"],false);assert_eq!(receipt["setupPersisted"],true);
        assert!(!serde_json::to_string(&receipt).unwrap().contains(&dir.to_string_lossy().to_string()));
        assert!(check_setup::resolve(&dir,&b,&dir,receipt["setupReference"].as_str().unwrap()).is_ok());
        assert!(!dir.join(format!("{}.sessions.jsonl",b.project_id)).exists());
    }
    #[test]fn repository_profile_is_bound_to_immutable_setup_and_unknown_profiles_do_not_observe_root(){
        let dir=temp();let selected=dir.join("npm-cli.js");fs::write(&selected,b"never run this").unwrap();
        let b=Binding{project_id:project_id(&"a".repeat(64)),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};
        let assignments=vec![CheckAssignment{task_id:"T0001".into(),categories:vec!["tests".into()]}];
        let fixed=save_picked_check_setup(&dir,&b,&assignments,&selected,||Ok(dir.clone())).unwrap();
        let generic=save_picked_profile_setup(&dir,&b,&assignments,&selected,"npm-project-checks-v1",||Ok(dir.clone())).unwrap();
        assert_ne!(fixed["setupReference"],generic["setupReference"]);
        for receipt in [fixed,generic]{let saved=check_setup::resolve(&dir,&b,&dir,receipt["setupReference"].as_str().unwrap()).unwrap();assert_eq!(saved["profileId"],receipt["profileId"]);assert_eq!(receipt["executionAuthorized"],false);}
        let mut observed=false;assert!(save_picked_profile_setup(&dir,&b,&assignments,&selected,"arbitrary-shell",||{observed=true;Ok(dir.clone())}).is_err());assert!(!observed);
    }
    #[test]fn registration_change_while_selecting_never_saves_setup(){
        let dir=temp();let selected=dir.join("npm-cli.js");fs::write(&selected,b"never run this").unwrap();
        let b=Binding{project_id:project_id(&"a".repeat(64)),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};
        let assignments=vec![CheckAssignment{task_id:"T0001".into(),categories:vec!["tests".into()]}];let mut reads=0;
        assert!(save_picked_check_setup(&dir,&b,&assignments,&selected,||{reads+=1;if reads==1{Ok(dir.clone())}else{Err(error("NATIVE_DRAFT_REGISTRATION_UNAVAILABLE"))}}).is_err());
        assert_eq!(reads,2);assert!(!dir.join("native-check-setups-v1").exists());
    }
    #[test]fn snapshot_projection_rejects_foreign_authority_and_broken_chunk_continuity(){
        let binding=Binding{project_id:"pp_snapshot".into(),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};
        let input=json!({"offset":0,"expectedHeadDigest":"c".repeat(64)});
        let good=json!({"schemaVersion":1,"binding":binding,"observedHead":{"hostRevision":2,"headDigest":"c".repeat(64)},"ledgerDigest":"d".repeat(64),"snapshotDigest":"e".repeat(64),"encoding":"json; offsets in UTF-16 code units; concatenate all chunks before parsing","offset":0,"totalLength":4,"nextOffset":null,"chunk":"null","approvalState":"unapproved-proposal","executionAuthorized":false});
        assert_eq!(project_snapshot(good.clone(),&binding,&input).unwrap()["cleanupComplete"],true);
        let patches=[("executionAuthorized",json!(true)),("approvalState",json!("approved")),("offset",json!(1)),("totalLength",json!(3)),("totalLength",json!(1048577)),("nextOffset",json!(4)),("chunk",json!("")),("snapshotDigest",json!("invalid")),("encoding",json!("base64")),("binding",json!({"projectId":"pp_foreign","rootIdentity":"a".repeat(64),"censusDigest":"b".repeat(64)})),("observedHead",json!({"hostRevision":2,"headDigest":"f".repeat(64)}))];
        for(key,value)in patches{let mut altered=good.clone();altered[key]=value;assert!(project_snapshot(altered,&binding,&input).is_err(),"accepted {key}");}
        let mut extra=good.clone();extra["path"]=json!("C:/foreign");assert!(project_snapshot(extra,&binding,&input).is_err());
        let mut unicode=good;unicode["chunk"]=json!("😀");unicode["totalLength"]=json!(2);assert!(project_snapshot(unicode,&binding,&input).is_ok());
    }
    #[test]fn snapshot_diagnostic_keeps_read_identity_without_clearing_prior_original(){
        let dir=temp();let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();let hash="c".repeat(64);
        guard.outstanding=Some("original-1".into());guard.outstanding_digest=Some(hash.clone());
        let diagnostic=DiagnosticSession::prepare_named(&dir,&guard,&diagnostic_binding(),false,None,"read-proposal-snapshot").unwrap();
        let value:Value=serde_json::from_slice(&fs::read(diagnostic.directory.join(format!("{}.intent.json",guard.session))).unwrap()).unwrap();
        assert_eq!(value["command"],"read-proposal-snapshot");assert_eq!(value["priorOutstandingRequestId"],"original-1");assert_eq!(guard.outstanding_digest,Some(hash));assert_eq!(value["executionAuthorized"],false);
    }
    use super::*;
    fn temp()->PathBuf{let root=std::env::temp_dir().join(fresh_id());fs::create_dir(&root).unwrap();fs::canonicalize(root).unwrap()}
    fn diagnostic_binding()->Binding{Binding{project_id:"pp_fixture".into(),root_identity:"a".repeat(64),census_digest:"b".repeat(64)}}
    fn failed_proof()->crate::native_host_supervisor::SupervisorReceipt{crate::native_host_supervisor::SupervisorReceipt{reason:"NATIVE_HOST_READY_MISMATCH",reply:Some(json!({"secret":"do-not-retain-payload"})),stopped:Some(json!({"secret":"do-not-retain-stderr"})),request_may_have_committed:false,process_exited:true,descendants_settled:true,io_settled:true,cleanup_complete:false,execution_authorized:false,pre_execution_containment:false,child_exit_code:Some(3)}}
    #[test]fn preparation_failure_records_refusal_without_dispatch_and_next_open_works(){let dir=temp();let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();let mut dispatched=false;let outcome=prepare_diagnostics(&mut guard,|_|Err(error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE")));if outcome.is_ok(){dispatched=true;}assert!(!dispatched);assert_eq!(outcome.err().unwrap().code,"NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE");assert_eq!(guard.sequence,1);assert!(!guard.begun);drop(guard);let next=Guard::open(&dir,"pp_fixture",None).unwrap();assert_eq!(next.sequence,1);drop(next);let text=fs::read_to_string(dir.join("pp_fixture.sessions.jsonl")).unwrap();assert!(text.contains("PRE_DISPATCH_REFUSED")&&!text.contains("BEGIN"));}
    #[test]fn preparation_failure_preserves_prior_unknown_original(){let dir=temp();let hash="c".repeat(64);let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();guard.append("BEGIN").unwrap();guard.outstanding=Some("original-1".into());guard.outstanding_digest=Some(hash.clone());guard.append("SETTLED").unwrap();drop(guard);let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();assert!(prepare_diagnostics(&mut guard,|_|Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"))).is_err());drop(guard);let retry=Guard::open(&dir,"pp_fixture",Some(("original-1",&hash))).unwrap();assert_eq!(retry.outstanding.as_deref(),Some("original-1"));assert_eq!(retry.outstanding_digest.as_deref(),Some(hash.as_str()));drop(retry);assert_eq!(Guard::open(&dir,"pp_fixture",Some(("replacement",&hash))).err().unwrap().code,"NATIVE_DRAFT_OUTCOME_UNKNOWN");}
    #[test]fn refusal_cannot_close_pending_begin_in_memory_or_history(){let dir=temp();let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();guard.append("BEGIN").unwrap();let mut called=false;assert!(prepare_diagnostics(&mut guard,|_|{called=true;Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"))}).is_err());assert!(!called);assert!(guard.append("PRE_DISPATCH_REFUSED").is_err());let forged=SessionRecord{schema_version:1,sequence:2,session_id:guard.session.clone(),state:"PRE_DISPATCH_REFUSED".into(),outcome_request_id:None,outcome_ledger_request_digest:None};let path=guard.path.clone();drop(guard);let mut file=OpenOptions::new().append(true).open(path).unwrap();writeln!(file,"{}",serde_json::to_string(&forged).unwrap()).unwrap();drop(file);assert!(Guard::open(&dir,"pp_fixture",None).err().unwrap().requires_recovery);}
    #[test]fn refusal_cannot_change_prior_outstanding(){let dir=temp();let record=SessionRecord{schema_version:1,sequence:1,session_id:"native-forged".into(),state:"PRE_DISPATCH_REFUSED".into(),outcome_request_id:Some("invented".into()),outcome_ledger_request_digest:Some("c".repeat(64))};fs::write(dir.join("pp_fixture.sessions.jsonl"),format!("{}\n",serde_json::to_string(&record).unwrap())).unwrap();assert!(Guard::open(&dir,"pp_fixture",None).err().unwrap().requires_recovery);}
    #[test]fn diagnostic_intent_precedes_begin_and_preserves_current_original(){let dir=temp();let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();let hash="c".repeat(64);let diagnostic=DiagnosticSession::prepare(&dir,&guard,&diagnostic_binding(),true,Some(("original-1",&hash))).unwrap();assert_eq!(guard.sequence,0);let value:Value=serde_json::from_slice(&fs::read(diagnostic.directory.join(format!("{}.intent.json",guard.session))).unwrap()).unwrap();assert_eq!(value["originalRequestId"],"original-1");assert_eq!(value["originalObligationDigest"],hash);assert!(value["priorOutstandingRequestId"].is_null());guard.append("BEGIN").unwrap();diagnostic.supervisor(&failed_proof()).unwrap();drop(guard);assert!(Guard::open(&dir,"pp_fixture",None).err().unwrap().requires_recovery);}
    #[test]fn diagnostic_receipt_is_redacted_immutable_and_not_a_disposition(){let dir=temp();let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();let diagnostic=DiagnosticSession::prepare(&dir,&guard,&diagnostic_binding(),false,None).unwrap();guard.append("BEGIN").unwrap();diagnostic.supervisor(&failed_proof()).unwrap();assert!(diagnostic.supervisor(&failed_proof()).is_err());let bytes=fs::read_to_string(diagnostic.directory.join(format!("{}.supervisor.json",guard.session))).unwrap();assert!(!bytes.contains("secret")&&!bytes.contains("do-not-retain"));let value:Value=serde_json::from_str(&bytes).unwrap();assert_eq!(value["reason"],"NATIVE_HOST_READY_MISMATCH");assert_eq!(value["recoveryAuthorized"],false);assert_eq!(value["cleanupComplete"],false);assert_eq!(guard.sequence,1);}
    #[test]fn diagnostic_unknown_reason_is_not_retained(){let dir=temp();let guard=Guard::open(&dir,"pp_fixture",None).unwrap();let diagnostic=DiagnosticSession::prepare(&dir,&guard,&diagnostic_binding(),false,None).unwrap();let mut proof=failed_proof();proof.reason="private path and token";diagnostic.supervisor(&proof).unwrap();let text=fs::read_to_string(diagnostic.directory.join(format!("{}.supervisor.json",guard.session))).unwrap();assert!(text.contains("NATIVE_HOST_REASON_UNAVAILABLE"));assert!(!text.contains("private path"));}
    #[test]fn diagnostics_reserve_capacity_and_refuse_oversized_existing_records(){for oversized in [true,false]{let dir=temp();let guard=Guard::open(&dir,"pp_fixture",None).unwrap();let path=dir.join("pp_fixture.diagnostics");fs::create_dir(&path).unwrap();if oversized{fs::write(path.join("oversized.json"),vec![b'x';4097]).unwrap();}else{for n in 0..511{fs::write(path.join(format!("{n}.json")),b"{}").unwrap();}}assert!(DiagnosticSession::prepare(&dir,&guard,&diagnostic_binding(),false,None).is_err());assert_eq!(guard.sequence,0);}}
    #[test]fn missing_diagnostic_never_unlocks_legacy_pending_session(){let dir=temp();let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();guard.append("BEGIN").unwrap();drop(guard);assert!(!dir.join("pp_fixture.diagnostics").exists());assert!(Guard::open(&dir,"pp_fixture",None).err().unwrap().requires_recovery);}
    #[test]fn imported_identity_is_stable_and_root_specific(){let a=project_id(&"a".repeat(64));assert!(a.starts_with("pp_aaaaaaaaaaaaaaaa_"));assert_eq!(a.len(),28);assert_eq!(a,project_id(&"a".repeat(64)));assert_ne!(a,project_id(&"b".repeat(64)));}
    #[test]fn imported_identity_matches_dans1_javascript_receipt(){assert_eq!(project_id("d30df78744354efcaefe48b91c09e751d2dfa2f31b10070ee97789f27eeb170a"),"pp_d30df78744354efc_16ybs20s");}
    #[test]fn unfinished_session_blocks_replacement(){let dir=temp();let mut g=Guard::open(&dir,"pp_fixture",None).unwrap();g.append("BEGIN").unwrap();drop(g);assert!(Guard::open(&dir,"pp_fixture",None).err().unwrap().requires_recovery);}
    #[test]fn settled_session_retains_history_and_allows_next(){let dir=temp();let mut g=Guard::open(&dir,"pp_fixture",None).unwrap();g.append("BEGIN").unwrap();g.append("SETTLED").unwrap();drop(g);let mut next=Guard::open(&dir,"pp_fixture",None).unwrap();assert_eq!(next.sequence,2);next.append("BEGIN").unwrap();next.append("SETTLED").unwrap();drop(next);assert_eq!(fs::read_to_string(dir.join("pp_fixture.sessions.jsonl")).unwrap().lines().count(),4);}
    #[test]fn partial_and_existing_empty_history_refused(){for bytes in [b"".as_slice(),b"{\"schemaVersion\":1".as_slice()]{let dir=temp();fs::write(dir.join("pp_fixture.sessions.jsonl"),bytes).unwrap();assert!(Guard::open(&dir,"pp_fixture",None).err().unwrap().requires_recovery);}}
    #[test]fn concurrent_same_project_is_busy(){let dir=temp();let mut first=Guard::open(&dir,"pp_fixture",None).unwrap();first.append("BEGIN").unwrap();let second=Guard::open(&dir,"pp_fixture",None).err().unwrap();assert_eq!(second.code,"NATIVE_DRAFT_BUSY");}
    #[test]fn blank_interior_history_refused(){let dir=temp();let path=dir.join("pp_fixture.sessions.jsonl");let mut guard=Guard::open(&dir,"pp_fixture",None).unwrap();guard.append("BEGIN").unwrap();guard.append("SETTLED").unwrap();drop(guard);let text=fs::read_to_string(&path).unwrap();fs::write(&path,text.replacen('\n',"\n\n",1)).unwrap();assert!(Guard::open(&dir,"pp_fixture",None).err().unwrap().requires_recovery);}
    #[test]fn clean_unknown_outcome_preserves_original_id_and_digest_across_inspection(){
        let dir=temp();let hash="a".repeat(64);let other="b".repeat(64);
        let mut g=Guard::open(&dir,"pp_fixture",Some(("original-1",&hash))).unwrap();g.append("BEGIN").unwrap();g.outstanding=Some("original-1".into());g.outstanding_digest=Some(hash.clone());g.append("SETTLED").unwrap();drop(g);
        let mut inspection=Guard::open(&dir,"pp_fixture",None).unwrap();assert_eq!(inspection.outstanding_digest.as_deref(),Some(hash.as_str()));inspection.append("BEGIN").unwrap();inspection.append("SETTLED").unwrap();drop(inspection);
        let failure=Guard::open(&dir,"pp_fixture",Some(("different-2",&hash))).err().unwrap();assert_eq!(failure.code,"NATIVE_DRAFT_OUTCOME_UNKNOWN");assert!(failure.request_may_have_committed&&!failure.requires_recovery);assert_eq!(failure.original_request_id.as_deref(),Some("original-1"));
        let changed=Guard::open(&dir,"pp_fixture",Some(("original-1",&other))).err().unwrap();assert_eq!(changed.code,"NATIVE_DRAFT_OUTCOME_UNKNOWN");
        let mut retry=Guard::open(&dir,"pp_fixture",Some(("original-1",&hash))).unwrap();retry.append("BEGIN").unwrap();retry.outstanding=None;retry.outstanding_digest=None;retry.append("SETTLED").unwrap();drop(retry);assert!(Guard::open(&dir,"pp_fixture",Some(("different-2",&other))).is_ok());
    }
    #[test]fn canonical_obligation_digest_binds_ledger_and_original_cas(){let mut original=OriginalRequest{request_id:"original-1".into(),expected_revision:0,expected_head_digest:"GENESIS".into()};let a:Value=serde_json::from_str(r#"{"b":2,"a":{"x":1}}"#).unwrap();let b:Value=serde_json::from_str(r#"{"a":{"x":1},"b":2}"#).unwrap();let hash=draft_request_digest(&a,&original).unwrap();assert_eq!(hash,draft_request_digest(&b,&original).unwrap());assert_ne!(hash,draft_request_digest(&json!({"b":3,"a":{"x":1}}),&original).unwrap());original.expected_revision=1;original.expected_head_digest="a".repeat(64);assert_ne!(hash,draft_request_digest(&a,&original).unwrap());}
    #[test]fn absent_or_unpaired_outcome_digest_refuses_history(){for missing in [true,false]{let dir=temp();let mut begin=json!({"schemaVersion":1,"sequence":1,"sessionId":"native-fixture","state":"BEGIN","outcomeRequestId":null,"outcomeLedgerRequestDigest":null});if missing{begin.as_object_mut().unwrap().remove("outcomeLedgerRequestDigest");}else{begin["outcomeRequestId"]=json!("original-1");}let line=format!("{}\n",begin);fs::write(dir.join("pp_fixture.sessions.jsonl"),line).unwrap();assert!(Guard::open(&dir,"pp_fixture",None).err().unwrap().requires_recovery);}}
    #[test]fn result_projection_refuses_extra_data_and_authority(){let binding=Binding{project_id:"pp_fixture".into(),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};let mut value=json!({"schemaVersion":1,"observedHead":{"hostRevision":0,"headDigest":"GENESIS"},"registrationCurrent":true,"registrationLeaseHeld":false,"approvalState":"unapproved-proposal","executionAuthorized":false});assert!(project_result(value.clone(),false,binding.clone()).is_ok());value["secret"]=json!("must never reach UI");assert!(project_result(value,false,binding).is_err());}
    #[test]fn renderer_config_and_unknown_fields_refused(){assert!(serde_json::from_value::<InspectRequest>(json!({"schemaVersion":1,"workspaceId":"abc","registryRevision":1,"rootIdentity":"a".repeat(64),"censusDigest":"b".repeat(64),"actor":"caller"})).is_err());}
    #[test]fn submission_projection_preserves_historical_identity_and_refuses_future_submission(){let binding=Binding{project_id:"pp_fixture".into(),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};let mut value=json!({"schemaVersion":1,"observedHead":{"hostRevision":2,"headDigest":"c".repeat(64)},"registrationCurrent":true,"registrationLeaseHeld":false,"approvalState":"unapproved-proposal","executionAuthorized":false,"submitted":{"hostRevision":1,"headDigest":"d".repeat(64),"ledgerDigest":"e".repeat(64)},"submissionPersisted":true,"idempotent":true,"submittedMatchesObservedHead":false});let result=project_result(value.clone(),true,binding.clone()).unwrap();assert_eq!(result.observed_head.host_revision,2);assert_eq!(result.submission.unwrap().record.host_revision,1);value["submitted"]["hostRevision"]=json!(3);assert!(project_result(value,true,binding).is_err());}
    #[test]fn draft_bytes_and_original_cas_are_bounded(){let mut original=OriginalRequest{request_id:"original-1".into(),expected_revision:0,expected_head_digest:"GENESIS".into()};assert!(validate_submission(&json!({}),&original).is_ok());assert!(validate_submission(&json!({"oversize":"x".repeat(1024*1024)}),&original).is_err());original.expected_revision=1;assert!(validate_submission(&json!({}),&original).is_err());}
}


