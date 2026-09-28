//! Cooperative bounded retained observations. Hash chains detect accidental
//! corruption, not hostile same-user rollback. No live filesystem claim.
use super::*;
use fs2::FileExt;
const BYTES:u64=1024*1024;
const RECORDS:usize=128;
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Body {
    schema_version:u32,sequence:usize,previous_hash:String,workspace_id:String,registry_revision:u32,root_identity:String,
    census_digest:String,generated_epoch_ms:u128,file_count:usize,total_bytes_hashed:u64,skipped_count:usize,
    skipped_digest:String,skip_reasons:BTreeMap<String,usize>,max_files:u32,max_file_bytes:u64,max_total_bytes:u64,
    max_directories:usize,max_entries:usize,max_depth:usize,max_duration_ms:u128,retained_observation:bool,live_filesystem_verified:bool,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Record { body:Body,hash:String }
fn fail()->WorkspaceCensusError{WorkspaceCensusError::new("WORKSPACE_CENSUS_OBSERVATION_UNAVAILABLE","Retained census observation is unavailable, changed, corrupt, or at its storage limit. Existing observations were preserved.")}
fn digest(s:&str)->bool{s.len()==64&&s.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c))}
fn safe(path:&Path)->Result<(),WorkspaceCensusError>{
    if !path.is_absolute(){return Err(fail());}
    for entry in path.ancestors(){let meta=fs::symlink_metadata(entry).map_err(|_|fail())?;if meta.file_type().is_symlink(){return Err(fail());}#[cfg(windows)]{use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return Err(fail());}}}
    Ok(())
}
fn file_id(file:&File)->Result<(u64,u64),WorkspaceCensusError>{
    #[cfg(windows)]{use std::os::windows::io::AsRawHandle;#[link(name="kernel32")]extern "system"{fn GetFileInformationByHandle(handle:*mut std::ffi::c_void,info:*mut u32)->i32;}
        let mut info=[0u32;13];if unsafe{GetFileInformationByHandle(file.as_raw_handle(),info.as_mut_ptr())}==0||info[10]!=1{return Err(fail());}return Ok((info[7] as u64,((info[11] as u64)<<32)|info[12] as u64));}
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;let meta=file.metadata().map_err(|_|fail())?;if meta.nlink()!=1{return Err(fail());}return Ok((meta.dev(),meta.ino()));}
    #[cfg(not(any(windows,unix)))]{Err(fail())}
}
fn stamp(file:&File)->Result<(u64,Option<SystemTime>,(u64,u64)),WorkspaceCensusError>{let meta=file.metadata().map_err(|_|fail())?;if !meta.is_file()||meta.len()>BYTES{return Err(fail());}Ok((meta.len(),meta.modified().ok(),file_id(file)?))}
struct Held(File);impl Drop for Held{fn drop(&mut self){let _=FileExt::unlock(&self.0);}}
pub(super) fn scan(root:&Path,request:CensusWorkspaceRequest,hook:Option<&dyn Fn()>)->Result<WorkspaceCensusReceipt,WorkspaceCensusError>{
    validate_schema(request.schema_version)?;validate_workspace_id(&request.workspace_id)?;
    if request.max_files==0||request.max_files>MAX_FILES_LIMIT||request.max_file_bytes==0||request.max_file_bytes>MAX_FILE_BYTES_LIMIT{return Err(WorkspaceCensusError::new("WORKSPACE_CENSUS_LIMIT_INVALID","census limits exceed the fixed native policy"));}
    safe(root)?;
    // Reject unknown/stale registrations before creating any lock artifact.
    // The actual scan revalidates under the cooperative lock as well.
    let registration=read_registration(root,&request.workspace_id)?;
    if registration.registry_revision!=request.registry_revision{return Err(WorkspaceCensusError::new("WORKSPACE_REGISTRY_REVISION_STALE","registry revision does not match the current workspace identity"));}
    registered_git_root(root,&request.workspace_id,request.registry_revision,&registration.root_identity).map_err(|_|fail())?;
    // Lock the complete scan and append, not just publication. An older scan
    // cannot resume after a later publication and become the apparent latest.
    let path=root.join(format!("{}.census-scan.lock",request.workspace_id));
    let file=match OpenOptions::new().read(true).write(true).create_new(true).open(&path){Ok(file)=>file,Err(error)if error.kind()==std::io::ErrorKind::AlreadyExists=>{safe(&path)?;OpenOptions::new().read(true).write(true).open(&path).map_err(|_|fail())?},Err(_)=>return Err(fail())};
    file.try_lock_exclusive().map_err(|_|WorkspaceCensusError::new("WORKSPACE_CENSUS_BUSY","Another scan for this workspace is active; no new scan was started."))?;
    let held=Held(file);safe(&path)?;
    if stamp(&held.0)?.0!=0||file_id(&held.0)?!=file_id(&File::open(&path).map_err(|_|fail())?)?{return Err(fail());}
    let receipt=census_at_with_policy(root,request.clone(),CensusPolicy::default(),hook)?;
    safe(&path)?;if file_id(&held.0)?!=file_id(&File::open(&path).map_err(|_|fail())?)?{return Err(fail());}
    retain(root,&request,&receipt)?;Ok(receipt)
}
fn open_locked(root:&Path,id:&str,create:bool)->Result<(PathBuf,Held),WorkspaceCensusError>{
    validate_workspace_id(id)?;safe(root)?;
    let destination=root.join(format!("{id}.census-observations.jsonl"));
    let existing=destination.exists();
    let file=if existing{safe(&destination)?;OpenOptions::new().read(true).append(create).open(&destination).map_err(|_|fail())?}else if create{OpenOptions::new().read(true).append(true).create_new(true).open(&destination).map_err(|_|fail())?}else{return Err(fail());};
    let start=Instant::now();loop{if file.try_lock_exclusive().is_ok(){break;}if start.elapsed()>Duration::from_secs(5){return Err(fail());}std::thread::sleep(Duration::from_millis(10));}
    safe(&destination)?;let state=stamp(&file)?;if existing&&state.0==0{return Err(fail());}Ok((destination,Held(file)))
}
fn read(file:&File,path:&Path,id:&str)->Result<Vec<Record>,WorkspaceCensusError>{
    use std::io::{Seek,SeekFrom};let initial=stamp(file)?;safe(path)?;
    if file_id(&File::open(path).map_err(|_|fail())?)?!=initial.2{return Err(fail());}
    let mut reader=file.try_clone().map_err(|_|fail())?;reader.seek(SeekFrom::Start(0)).map_err(|_|fail())?;
    let mut bytes=Vec::new();reader.take(BYTES+1).read_to_end(&mut bytes).map_err(|_|fail())?;
    if bytes.len() as u64!=initial.0||stamp(file)?!=initial||file_id(&File::open(path).map_err(|_|fail())?)?!=initial.2{return Err(fail());}
    if bytes.is_empty(){return Ok(Vec::new());}if bytes.last()!=Some(&b'\n'){return Err(fail());}
    let mut records=Vec::<Record>::new();for line in bytes[..bytes.len()-1].split(|c|*c==b'\n'){
        if records.len()>=RECORDS||line.is_empty()||line.len()>32768{return Err(fail());}
        let record:Record=serde_json::from_slice(line).map_err(|_|fail())?;let body=&record.body;
        let previous=records.last().map(|r|r.hash.as_str()).unwrap_or("GENESIS");
        let skips=body.skip_reasons.values().try_fold(0usize,|sum,value|sum.checked_add(*value));
        if body.schema_version!=1||body.sequence!=records.len()+1||body.previous_hash!=previous||body.workspace_id!=id||body.registry_revision==0||!digest(&body.root_identity)||!digest(&body.census_digest)||!digest(&body.skipped_digest)||!body.retained_observation||body.live_filesystem_verified||body.max_files==0||body.max_files>MAX_FILES_LIMIT||body.max_file_bytes==0||body.max_file_bytes>MAX_FILE_BYTES_LIMIT||!supported_profile(body)||body.file_count>body.max_files as usize||body.total_bytes_hashed>body.max_total_bytes||body.skipped_count>body.max_entries||skips!=Some(body.skipped_count)||record.hash!=sha256_hex(&serde_json::to_vec(body).map_err(|_|fail())?){return Err(fail());}
        records.push(record);
    }safe(path)?;Ok(records)
}
// Historical receipts retain their original bounds and hashes; upgrades cannot
// reinterpret an old observation as permission to scan a wider workspace.
fn supported_profile(body: &Body) -> bool {
    let historical = body.max_files <= 10_000
        && matches!(body.max_total_bytes, 50_000_000 | 500_000_000)
        && body.max_directories == 10_000 && body.max_entries == 50_000
        && body.max_depth == 64 && body.max_duration_ms == 30_000;
    let current = body.max_files <= MAX_FILES_LIMIT && body.max_total_bytes == MAX_TOTAL_BYTES
        && body.max_directories == MAX_DIRECTORIES_LIMIT && body.max_entries == MAX_ENTRIES_LIMIT
        && body.max_depth == MAX_DIRECTORY_DEPTH && body.max_duration_ms == MAX_CENSUS_DURATION.as_millis();
    historical || current
}

pub(super) fn retain(root:&Path,request:&CensusWorkspaceRequest,receipt:&WorkspaceCensusReceipt)->Result<(),WorkspaceCensusError>{
    registered_git_root(root,&receipt.workspace_id,receipt.registry_revision,&receipt.root_identity).map_err(|_|fail())?;
    let (destination,held)=open_locked(root,&receipt.workspace_id,true)?;let mut records=read(&held.0,&destination,&receipt.workspace_id)?;
    if records.len()>=RECORDS{return Err(fail());}
    let mut reasons=BTreeMap::new();for skip in &receipt.skipped{*reasons.entry(skip.reason.to_owned()).or_insert(0)+=1;}
    let body=Body{schema_version:1,sequence:records.len()+1,previous_hash:records.last().map(|r|r.hash.clone()).unwrap_or_else(||"GENESIS".into()),workspace_id:receipt.workspace_id.clone(),registry_revision:receipt.registry_revision,root_identity:receipt.root_identity.clone(),census_digest:receipt.digest.clone(),generated_epoch_ms:receipt.generated_epoch_ms,file_count:receipt.file_count,total_bytes_hashed:receipt.total_bytes_hashed,skipped_count:receipt.skipped.len(),skipped_digest:sha256_hex(&serde_json::to_vec(&receipt.skipped).map_err(|_|fail())?),skip_reasons:reasons,max_files:request.max_files,max_file_bytes:request.max_file_bytes,max_total_bytes:MAX_TOTAL_BYTES,max_directories:MAX_DIRECTORIES_LIMIT,max_entries:MAX_ENTRIES_LIMIT,max_depth:MAX_DIRECTORY_DEPTH,max_duration_ms:MAX_CENSUS_DURATION.as_millis(),retained_observation:true,live_filesystem_verified:false};
    let record=Record{hash:sha256_hex(&serde_json::to_vec(&body).map_err(|_|fail())?),body};
    let mut bytes=serde_json::to_vec(&record).map_err(|_|fail())?;bytes.push(b'\n');
    if bytes.len()>32768||held.0.metadata().map_err(|_|fail())?.len()+bytes.len() as u64>BYTES{return Err(fail());}
    safe(&destination)?;registered_git_root(root,&receipt.workspace_id,receipt.registry_revision,&receipt.root_identity).map_err(|_|fail())?;
    if file_id(&held.0)?!=file_id(&File::open(&destination).map_err(|_|fail())?)?{return Err(fail());}
    let mut writer=&held.0;writer.write_all(&bytes).and_then(|_|writer.sync_all()).map_err(|_|fail())?;
    records.push(record);let reread=read(&held.0,&destination,&receipt.workspace_id)?;if reread.len()!=records.len()||reread.last().map(|r|&r.hash)!=records.last().map(|r|&r.hash){return Err(fail());}
    registered_git_root(root,&receipt.workspace_id,receipt.registry_revision,&receipt.root_identity).map_err(|_|fail())?;Ok(())
}
pub(super) fn latest(root:&Path,id:&str,revision:u32,identity:&str)->Result<serde_json::Value,WorkspaceCensusError>{
    registered_git_root(root,id,revision,identity).map_err(|_|fail())?;let (path,held)=open_locked(root,id,false)?;let records=read(&held.0,&path,id)?;let last=records.last().ok_or_else(fail)?;
    if last.body.registry_revision!=revision||last.body.root_identity!=identity{return Err(fail());}registered_git_root(root,id,revision,identity).map_err(|_|fail())?;
    let mut value=serde_json::to_value(&last.body).map_err(|_|fail())?;value["observationHash"]=serde_json::json!(last.hash);value["executionAuthorized"]=serde_json::json!(false);Ok(value)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn historical_profiles_remain_readable_without_rewriting_or_widening() {
        for budget in [50_000_000, 500_000_000] {
            let (_,registry,registration)=fixture();
            census_and_retain(&registry,request()).unwrap();
            let journal=registry.join("retained-workspace.census-observations.jsonl");
            let mut record:Record=serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
            record.body.max_total_bytes=budget; record.body.max_directories=10_000;
            record.body.max_entries=50_000; record.body.max_duration_ms=30_000;
            record.hash=sha256_hex(&serde_json::to_vec(&record.body).unwrap());
            let mut bytes=serde_json::to_vec(&record).unwrap();bytes.push(b'\n');
            fs::write(&journal,&bytes).unwrap();
            assert_eq!(latest(&registry,"retained-workspace",1,&registration.root_identity).unwrap()["maxTotalBytes"],budget);
            census_and_retain(&registry,request()).unwrap();
            assert!(fs::read(&journal).unwrap().starts_with(&bytes));
            let observed=latest(&registry,"retained-workspace",1,&registration.root_identity).unwrap();
            assert_eq!(observed["sequence"],2);
            assert_eq!(observed["previousHash"],record.hash);
            assert_eq!(observed["executionAuthorized"],false);
        }
    }
    #[test] fn unknown_recorded_profile_is_refused_even_with_matching_hash() {
        let (_,registry,registration)=fixture();census_and_retain(&registry,request()).unwrap();
        let journal=registry.join("retained-workspace.census-observations.jsonl");
        let mut record:Record=serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
        record.body.max_entries+=1;record.hash=sha256_hex(&serde_json::to_vec(&record.body).unwrap());
        let mut bytes=serde_json::to_vec(&record).unwrap();bytes.push(b'\n');fs::write(&journal,&bytes).unwrap();
        assert!(latest(&registry,"retained-workspace",1,&registration.root_identity).is_err());
        assert!(census_and_retain(&registry,request()).is_err());
        assert_eq!(fs::read(&journal).unwrap(),bytes);
    }
    fn fixture()->(PathBuf,PathBuf,WorkspaceRegistrationReceipt){let base=std::env::temp_dir().join(format!("pp-census-retained-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));let workspace=base.join("workspace");let registry=base.join("registry");fs::create_dir_all(&workspace).unwrap();fs::write(workspace.join("app.js"),"export const original=true;\n").unwrap();let registration=register_at(&registry,RegisterWorkspaceRequest{schema_version:1,workspace_id:"retained-workspace".into(),root_path:workspace.to_string_lossy().into(),explicit_user_approval:true}).unwrap();(workspace,registry,registration)}
    fn request()->CensusWorkspaceRequest{CensusWorkspaceRequest{schema_version:1,workspace_id:"retained-workspace".into(),registry_revision:1,max_files:20,max_file_bytes:1000}}
    #[test]fn scan_retains_host_digest_and_exact_coverage_without_live_claim(){let (workspace,registry,registration)=fixture();fs::write(workspace.join("large.js"),vec![b'x';2000]).unwrap();let receipt=census_and_retain(&registry,request()).unwrap();let observed=latest(&registry,"retained-workspace",1,&registration.root_identity).unwrap();assert_eq!(observed["censusDigest"],receipt.digest);assert_eq!(observed["skippedCount"],receipt.skipped.len());assert_eq!(observed["maxFileBytes"],1000);assert_eq!(observed["liveFilesystemVerified"],false);assert_eq!(observed["executionAuthorized"],false);}
    #[test]fn later_scan_appends_and_preserves_original_observation_bytes(){let (workspace,registry,registration)=fixture();let first=census_and_retain(&registry,request()).unwrap();let journal=registry.join("retained-workspace.census-observations.jsonl");let original=fs::read(&journal).unwrap();fs::write(workspace.join("app.js"),"export const changed=true;\n").unwrap();let second=census_and_retain(&registry,request()).unwrap();assert_ne!(first.digest,second.digest);assert!(fs::read(journal).unwrap().starts_with(&original));let observed=latest(&registry,"retained-workspace",1,&registration.root_identity).unwrap();assert_eq!(observed["sequence"],2);assert_eq!(observed["censusDigest"],second.digest);}
    #[test]fn partial_tail_refuses_read_and_new_success_without_rewriting_history(){let (_,registry,registration)=fixture();census_and_retain(&registry,request()).unwrap();let journal=registry.join("retained-workspace.census-observations.jsonl");let mut file=OpenOptions::new().append(true).open(&journal).unwrap();file.write_all(b"{partial").unwrap();file.sync_all().unwrap();drop(file);let before=fs::read(&journal).unwrap();assert!(latest(&registry,"retained-workspace",1,&registration.root_identity).is_err());assert!(census_and_retain(&registry,request()).is_err());assert_eq!(fs::read(journal).unwrap(),before);}
    #[test]fn registration_change_and_foreign_identity_refuse_old_observation(){let (_,registry,registration)=fixture();census_and_retain(&registry,request()).unwrap();assert!(latest(&registry,"retained-workspace",1,&"f".repeat(64)).is_err());let registration_file=registry_file(&registry,"retained-workspace");let mut value:serde_json::Value=serde_json::from_slice(&fs::read(&registration_file).unwrap()).unwrap();value["registryRevision"]=serde_json::json!(2);fs::write(registration_file,serde_json::to_vec(&value).unwrap()).unwrap();assert!(latest(&registry,"retained-workspace",1,&registration.root_identity).is_err());assert!(latest(&registry,"retained-workspace",2,&registration.root_identity).is_err());}
    #[test]fn hardlinked_observation_is_refused(){let (_,registry,registration)=fixture();census_and_retain(&registry,request()).unwrap();let journal=registry.join("retained-workspace.census-observations.jsonl");fs::hard_link(&journal,registry.join("linked-observation")).unwrap();assert!(latest(&registry,"retained-workspace",1,&registration.root_identity).is_err());}
    #[test]fn scan_lock_prevents_older_publication_over_newer_scan(){let (workspace,registry,registration)=fixture();let hook=||{let blocked=census_and_retain(&registry,request()).unwrap_err();assert_eq!(blocked.code,"WORKSPACE_CENSUS_BUSY");};let first=scan(&registry,request(),Some(&hook)).unwrap();assert_eq!(latest(&registry,"retained-workspace",1,&registration.root_identity).unwrap()["sequence"],1);fs::write(workspace.join("app.js"),"export const later=true;\n").unwrap();let second=census_and_retain(&registry,request()).unwrap();assert_ne!(first.digest,second.digest);let retained=latest(&registry,"retained-workspace",1,&registration.root_identity).unwrap();assert_eq!(retained["sequence"],2);assert_eq!(retained["censusDigest"],second.digest);}
    #[test]fn preexisting_empty_journal_is_not_silently_reset(){let (_,registry,_)=fixture();let journal=registry.join("retained-workspace.census-observations.jsonl");fs::write(&journal,[]).unwrap();assert!(census_and_retain(&registry,request()).is_err());assert!(fs::read(journal).unwrap().is_empty());}
    #[test]fn invalid_or_unregistered_requests_create_no_lock_artifacts(){let (_,registry,_)=fixture();let names=||{let mut values=fs::read_dir(&registry).unwrap().map(|entry|entry.unwrap().file_name()).collect::<Vec<_>>();values.sort();values};let before=names();let mut cases=Vec::new();for index in 0..8{let mut value=request();value.workspace_id=format!("unknown-workspace-{index}");cases.push(value);}let mut invalid=request();invalid.schema_version=2;cases.push(invalid);let mut invalid=request();invalid.max_files=0;cases.push(invalid);let mut stale=request();stale.registry_revision=2;cases.push(stale);for case in cases{assert!(census_and_retain(&registry,case).is_err());assert_eq!(names(),before);}}
}
