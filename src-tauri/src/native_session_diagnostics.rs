//! Bounded active diagnostic writes, with immutable legacy evidence retained.
use super::*;
const MAX_LEGACY_BYTES:u64=2*1024*1024;
const MAX_IMPORT_BYTES:u64=256*1024;

#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct LegacyFile{path:String,bytes:u64,sha256:String}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct LegacyImport{schema_version:u32,project_id:String,root_identity:String,files:Vec<LegacyFile>}

fn directory(path:&Path)->Result<(),DraftError>{
 safe(path.parent().ok_or_else(||error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"))?)?;
 match fs::create_dir(path){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))}
 safe(path)?;if !path.is_dir(){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}Ok(())
}
fn read_bounded(path:&Path,limit:u64)->Result<Vec<u8>,DraftError>{
 safe(path)?;let mut file=File::open(path).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;let before=stamp(&file)?;
 if before.0==0||before.0>limit{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"));}
 let mut bytes=Vec::new();(&mut file).take(limit+1).read_to_end(&mut bytes).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;
 safe(path)?;let current=File::open(path).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;
 if bytes.len()as u64!=before.0||stamp(&file)?!=before||stamp(&current)?!=before{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_CHANGED"));}Ok(bytes)
}
fn legacy_name(name:&str)->bool{
 [".intent.json",".supervisor.json"].iter().any(|suffix|name.strip_suffix(suffix).is_some_and(|session|token(session,96)))
}
fn retain_legacy_inventory(state:&Path,root:&Path,binding:&Binding)->Result<(),DraftError>{
 let manifest=root.join("legacy-import.json");
 if !manifest.try_exists().map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?{
  if fs::read_dir(root).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?.next().is_some(){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
  // Existing evidence is inventoried once, under the same project owner lock.
  // Routine admission subsequently reads this bounded inventory, not history.
  let legacy=state.join(format!("{}.diagnostics",binding.project_id));let mut files=Vec::new();let mut total=0u64;
  if legacy.try_exists().map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?{
   safe(&legacy)?;
   for entry in fs::read_dir(&legacy).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?{
    let path=entry.map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?.path();
    let name=path.file_name().and_then(|v|v.to_str()).ok_or_else(||error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"))?;
    if files.len()>=512||!legacy_name(name){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
    let bytes=read_bounded(&path,4096)?;total+=bytes.len()as u64;if total>MAX_LEGACY_BYTES{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"));}
    files.push(LegacyFile{path:name.into(),bytes:bytes.len()as u64,sha256:format!("{:x}",Sha256::digest(bytes))});
   }
  }
  files.sort_by(|a,b|a.path.cmp(&b.path));
  let value=LegacyImport{schema_version:2,project_id:binding.project_id.clone(),root_identity:binding.root_identity.clone(),files};
  let bytes=serde_json::to_vec(&value).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"))?;
  if bytes.len()as u64>MAX_IMPORT_BYTES{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"));}
  let mut file=OpenOptions::new().write(true).create_new(true).open(&manifest).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;
  safe(&manifest)?;let id=identity(&file)?;
  file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;
  if read_bounded(&manifest,MAX_IMPORT_BYTES)?!=bytes||identity(&File::open(&manifest).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?)?!=id{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_CHANGED"));}
 }
 let bytes=read_bounded(&manifest,MAX_IMPORT_BYTES)?;
 let imported:LegacyImport=serde_json::from_slice(&bytes).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"))?;
 if imported.schema_version!=2||imported.project_id!=binding.project_id||imported.root_identity!=binding.root_identity||imported.files.len()>512||serde_json::to_vec(&imported).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"))?!=bytes{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
 let mut total=0u64;let mut previous=None;
 for file in &imported.files{
  if !legacy_name(&file.path)||file.bytes==0||file.bytes>4096||!digest(&file.sha256)||previous.is_some_and(|p:&str|p>=file.path.as_str()){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
  total+=file.bytes;previous=Some(file.path.as_str());
 }
 if total>MAX_LEGACY_BYTES{return Err(error("NATIVE_DRAFT_DIAGNOSTIC_LIMIT"));}Ok(())
}

pub(super) fn prepare(state:&Path,guard:&session_store::LiveGuard,binding:&Binding,submitted:bool,original:Option<(&str,&str)>,command:&str)->Result<DiagnosticSession,DraftError>{
 if guard.begun||binding.root_identity!=guard.root_identity()||binding.project_id!=project_id(guard.root_identity())
  ||!matches!(command,"execute-check"|"recover-check-execution"|"execute-task"|"recover-task-execution"|"review-proposal"|"recover-original-request"|"inspect-proposal"|"submit-draft"|"read-proposal-snapshot"|"prepare-checks"|"inspect-checks"|"inspect-task-result"|"list-task-results"|"read-task-result-page")
  ||submitted!=matches!(command,"execute-check"|"recover-check-execution"|"execute-task"|"recover-task-execution"|"review-proposal"|"recover-original-request"|"submit-draft"|"prepare-checks")||submitted!=original.is_some()
  ||original.is_some_and(|(id,hash)|!request_token(id)||!digest(hash)){return Err(error("NATIVE_DRAFT_DIAGNOSTIC_INVALID"));}
 let root=state.join(format!("{}.diagnostics-v2",binding.project_id));directory(&root)?;
 retain_legacy_inventory(state,&root,binding)?;
 let shard=root.join(format!("{:016x}",guard.sequence()/256));directory(&shard)?;
 let directory=shard.join(&guard.session);
 // Unique session: never adopt a previous session's evidence directory.
 fs::create_dir(&directory).map_err(|_|error("NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE"))?;safe(&directory)?;
 session_store::reserve(&directory.join(format!("{}.supervisor.reserve",guard.session)))?;
 let diagnostic=DiagnosticSession{directory,session:guard.session.clone(),reserved_supervisor:true};
 diagnostic.write("intent",&json!({"schemaVersion":1,"sessionId":guard.session,"binding":binding,"command":command,"originalRequestId":original.map(|v|v.0),"originalObligationDigest":original.map(|v|v.1),"priorOutstandingRequestId":guard.outstanding,"priorOutstandingObligationDigest":guard.outstanding_digest,"executionAuthorized":false,"recoveryAuthorized":false}))?;
 Ok(diagnostic)
}

#[cfg(test)]mod tests{
 use super::*;
 fn fixture()->(PathBuf,Binding){let root=std::env::temp_dir().join(format!("pp-live-diagnostics-{}",fresh_id()));fs::create_dir(&root).unwrap();let identity="a".repeat(64);let binding=Binding{project_id:project_id(&identity),root_identity:identity,census_digest:"b".repeat(64)};(root,binding)}
 #[test]fn supervisor_bytes_are_allocated_before_begin_and_receipts_are_immutable(){
  let(root,binding)=fixture();let mut guard=session_store::LiveGuard::open(&root,&binding.root_identity,None).unwrap();
  let diagnostic=prepare_live_diagnostics(&mut guard,&root,&binding,false,None,"inspect-task-result").unwrap();
  let reserve=diagnostic.directory.join(format!("{}.supervisor.reserve",guard.session));assert_eq!(fs::read(&reserve).unwrap(),vec![0u8;4096]);
  let intent=diagnostic.directory.join(format!("{}.intent.json",guard.session));let before=fs::read(&intent).unwrap();assert!(!guard.begun);
  guard.append("BEGIN").unwrap();diagnostic.write("supervisor",&json!({"schemaVersion":1,"executionAuthorized":false})).unwrap();
  assert!(!reserve.exists());assert!(diagnostic.write("supervisor",&json!({"replacement":true})).is_err());assert_eq!(fs::read(intent).unwrap(),before);
  drop(guard);assert!(session_store::LiveGuard::open(&root,&binding.root_identity,None).err().unwrap().requires_recovery);
 }
 #[test]fn failed_supervisor_publication_never_settles_a_started_operation(){
  let(root,binding)=fixture();let mut guard=session_store::LiveGuard::open(&root,&binding.root_identity,None).unwrap();
  let diagnostic=prepare_live_diagnostics(&mut guard,&root,&binding,false,None,"inspect-task-result").unwrap();guard.append("BEGIN").unwrap();
  fs::write(diagnostic.directory.join(format!("{}.supervisor.reserve",guard.session)),b"damaged").unwrap();
  assert!(diagnostic.write("supervisor",&json!({"schemaVersion":1})).is_err());drop(guard);
  assert!(session_store::LiveGuard::open(&root,&binding.root_identity,None).err().unwrap().requires_recovery);
 }
 #[test]fn foreign_binding_is_refused_before_diagnostic_creation(){
  let(root,mut binding)=fixture();let guard=session_store::LiveGuard::open(&root,&binding.root_identity,None).unwrap();binding.root_identity="c".repeat(64);
  assert!(prepare(&root,&guard,&binding,false,None,"inspect-task-result").is_err());assert!(!root.join(format!("{}.diagnostics-v2",binding.project_id)).exists());
 }
 #[test]fn missing_import_cannot_reset_existing_diagnostic_history(){
  let(root,binding)=fixture();let mut guard=session_store::LiveGuard::open(&root,&binding.root_identity,None).unwrap();let diagnostic=prepare_live_diagnostics(&mut guard,&root,&binding,false,None,"inspect-task-result").unwrap();
  let manifest=root.join(format!("{}.diagnostics-v2/legacy-import.json",binding.project_id));fs::rename(&manifest,root.join("preserved-diagnostic-import.json")).unwrap();
  let intent=diagnostic.directory.join(format!("{}.intent.json",guard.session));let before=fs::read(&intent).unwrap();drop(guard);
  let mut next=session_store::LiveGuard::open(&root,&binding.root_identity,None).unwrap();assert!(prepare_live_diagnostics(&mut next,&root,&binding,false,None,"inspect-task-result").is_err());assert!(!manifest.exists());assert_eq!(fs::read(intent).unwrap(),before);
 }
 #[test]fn oversized_legacy_evidence_is_preserved_and_blocks_dispatch_preparation(){
  let(root,binding)=fixture();let legacy=root.join(format!("{}.diagnostics",binding.project_id));fs::create_dir(&legacy).unwrap();let path=legacy.join("legacy-session.intent.json");let bytes=vec![b'x';4097];fs::write(&path,&bytes).unwrap();
  let mut guard=session_store::LiveGuard::open(&root,&binding.root_identity,None).unwrap();assert!(prepare_live_diagnostics(&mut guard,&root,&binding,false,None,"inspect-task-result").is_err());assert!(!guard.begun);drop(guard);assert_eq!(fs::read(path).unwrap(),bytes);
 }
}

