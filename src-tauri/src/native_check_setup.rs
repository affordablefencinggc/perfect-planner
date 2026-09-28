//! Immutable native-owned setup receipts. Not a renderer configuration, check
//! result, tool trust decision, review selection, or permission to execute.
//! The caller must obtain the tool through native selection and resolve the
//! registered root before calling these functions. No command is exposed here.
use super::{digest,error,identity,safe,spelling,stamp,Binding,DraftError};
use fs2::FileExt;
use serde::{Deserialize,Serialize};
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::fs::{self,File,OpenOptions};
use std::io::{Read,Write};
use std::path::{Path,PathBuf};

const LIMIT:u64=64*1024;
const TOOL_LIMIT:u64=8*1024*1024;

// Only the native picker supplies this path. Observe bytes, never load or run
// the selected script, read npm configuration, or infer publisher trust.
pub(super) fn observe_tool(path:&Path)->Result<String,DraftError>{observe_tool_with(path,||{})}
fn observe_tool_with<F:FnOnce()>(path:&Path,before_reobserve:F)->Result<String,DraftError>{
    if path.file_name().and_then(|s|s.to_str())!=Some("npm-cli.js"){return Err(error("NATIVE_CHECK_TOOL_NAME_INVALID"));}
    safe(path)?;let mut file=File::open(path).map_err(|_|error("NATIVE_CHECK_TOOL_UNAVAILABLE"))?;
    let before=stamp(&file)?;
    if before.0==0||before.0>TOOL_LIMIT{return Err(error("NATIVE_CHECK_TOOL_SIZE_INVALID"));}
    let mut hash=Sha256::new();let mut buffer=[0u8;65536];let mut size=0u64;
    loop{let n=file.read(&mut buffer).map_err(|_|error("NATIVE_CHECK_TOOL_UNAVAILABLE"))?;if n==0{break;}size+=n as u64;if size>before.0||size>TOOL_LIMIT{return Err(error("NATIVE_CHECK_TOOL_CHANGED"));}hash.update(&buffer[..n]);}
    before_reobserve();safe(path)?;let current=File::open(path).map_err(|_|error("NATIVE_CHECK_TOOL_CHANGED"))?;
    if size!=before.0||stamp(&file)?!=before||stamp(&current)?!=before{return Err(error("NATIVE_CHECK_TOOL_CHANGED"));}
    Ok(format!("{:x}",hash.finalize()))
}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Record{schema_version:u32,binding:Binding,provision:Value,execution_authorized:bool}

fn validate(record:&Record,binding:&Binding,registered_root:&Path)->Result<(),DraftError>{
    if record.schema_version!=1||record.binding!=*binding||record.execution_authorized
        ||!digest(&binding.root_identity)||!digest(&binding.census_digest)
        ||binding.project_id!=super::project_id(&binding.root_identity){return Err(error("NATIVE_CHECK_SETUP_BINDING_INVALID"));}
    crate::native_host_supervisor::check_configuration(None,Some(&record.provision),None)
        .map_err(|_|error("NATIVE_CHECK_SETUP_INVALID"))?;
    safe(registered_root)?;
    if !registered_root.is_dir()||spelling(Path::new(record.provision["registeredRoot"].as_str().unwrap()))?!=spelling(registered_root)?{
        return Err(error("NATIVE_CHECK_SETUP_ROOT_MISMATCH"));
    }
    Ok(())
}
fn directory(state:&Path)->Result<PathBuf,DraftError>{
    safe(state)?;
    let path=state.join("native-check-setups-v1");
    match fs::create_dir(&path){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_CHECK_SETUP_UNAVAILABLE"))}
    safe(&path)?;if !path.is_dir(){return Err(error("NATIVE_CHECK_SETUP_UNAVAILABLE"));}Ok(path)
}

// A reference is the digest of all bytes, including the native binding. It is
// never a caller-chosen filename or an implicit pointer to the newest record.
pub(super) fn save(state:&Path,binding:&Binding,registered_root:&Path,provision:Value)->Result<String,DraftError>{
    let record=Record{schema_version:1,binding:binding.clone(),provision,execution_authorized:false};
    validate(&record,binding,registered_root)?;
    let bytes=serde_json::to_vec(&record).map_err(|_|error("NATIVE_CHECK_SETUP_INVALID"))?;
    if bytes.len()as u64>LIMIT{return Err(error("NATIVE_CHECK_SETUP_LIMIT"));}
    let reference=format!("{:x}",Sha256::digest(&bytes));
    let dir=directory(state)?;let path=dir.join(format!("{reference}.json"));
    // Serialize creation/capacity observations without borrowing the draft
    // session journal: opening that journal without a disposition can strand it.
    let lock_path=dir.join("creation.lock");
    let lock=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?;
    safe(&lock_path)?;let lock_id=identity(&lock)?;
    lock.try_lock_exclusive().map_err(|_|error("NATIVE_CHECK_SETUP_BUSY"))?;
    if identity(&File::open(&lock_path).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?)?!=lock_id{return Err(error("NATIVE_CHECK_SETUP_UNAVAILABLE"));}
    if path.try_exists().map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?{
        resolve(state,binding,registered_root,&reference)?;return Ok(reference);
    }
    let count=fs::read_dir(&dir).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?.take(258).collect::<Result<Vec<_>,_>>().map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?.len();
    if count>=257{return Err(error("NATIVE_CHECK_SETUP_LIMIT"));}
    let mut file=OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?;
    file.try_lock_exclusive().map_err(|_|error("NATIVE_CHECK_SETUP_BUSY"))?;
    safe(&path)?;let id=identity(&file)?;
    file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?;
    safe(&path)?;let current=File::open(&path).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?;
    if identity(&current)?!=id||stamp(&current)?.0!=bytes.len()as u64{return Err(error("NATIVE_CHECK_SETUP_UNAVAILABLE"));}
    drop(current);drop(file);
    resolve(state,binding,registered_root,&reference)?;
    Ok(reference)
}

pub(super) fn resolve(state:&Path,binding:&Binding,registered_root:&Path,reference:&str)->Result<Value,DraftError>{
    if !digest(reference){return Err(error("NATIVE_CHECK_SETUP_REFERENCE_INVALID"));}
    // Reads never create missing storage or fall back to another setup.
    let path=state.join("native-check-setups-v1").join(format!("{reference}.json"));
    safe(&path)?;
    let mut file=File::open(&path).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?;
    FileExt::try_lock_shared(&file).map_err(|_|error("NATIVE_CHECK_SETUP_BUSY"))?;
    let before=stamp(&file)?;
    if before.0==0||before.0>LIMIT{return Err(error("NATIVE_CHECK_SETUP_INVALID"));}
    let mut bytes=Vec::new();(&mut file).take(LIMIT+1).read_to_end(&mut bytes).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?;
    safe(&path)?;let current=File::open(&path).map_err(|_|error("NATIVE_CHECK_SETUP_UNAVAILABLE"))?;
    if bytes.len()as u64!=before.0||stamp(&file)?!=before||stamp(&current)?!=before||format!("{:x}",Sha256::digest(&bytes))!=reference{return Err(error("NATIVE_CHECK_SETUP_CHANGED"));}
    let record:Record=serde_json::from_slice(&bytes).map_err(|_|error("NATIVE_CHECK_SETUP_INVALID"))?;
    validate(&record,binding,registered_root)?;
    Ok(record.provision)
}

#[cfg(test)]mod tests{
    use super::*;
    use serde_json::json;
    #[test]fn selected_tool_is_hashed_without_execution(){let(dir,_,_)=fixture();let path=dir.join("npm-cli.js");let bytes=b"throw new Error('must not execute');";fs::write(&path,bytes).unwrap();assert_eq!(observe_tool(&path).unwrap(),format!("{:x}",Sha256::digest(bytes)));}
    #[test]fn selected_tool_rejects_wrong_name_empty_oversize_and_hardlinks(){
        let(dir,_,_)=fixture();let other=dir.join("other.js");fs::write(&other,b"source").unwrap();assert!(observe_tool(&other).is_err());
        let path=dir.join("npm-cli.js");fs::write(&path,b"").unwrap();assert!(observe_tool(&path).is_err());
        let file=OpenOptions::new().write(true).open(&path).unwrap();file.set_len(TOOL_LIMIT+1).unwrap();drop(file);assert!(observe_tool(&path).is_err());
        fs::write(&path,b"source").unwrap();fs::hard_link(&path,dir.join("linked.js")).unwrap();assert!(observe_tool(&path).is_err());
    }
    #[test]fn selected_tool_mutation_during_observation_is_refused(){let(dir,_,_)=fixture();let path=dir.join("npm-cli.js");fs::write(&path,b"before").unwrap();assert!(observe_tool_with(&path,||fs::write(&path,b"changed bytes").unwrap()).is_err());}
    fn fixture()->(PathBuf,Binding,Value){
        let path=std::env::temp_dir().join(super::super::fresh_id());fs::create_dir(&path).unwrap();let path=fs::canonicalize(path).unwrap();
        let binding=Binding{project_id:super::super::project_id(&"a".repeat(64)),root_identity:"a".repeat(64),census_digest:"b".repeat(64)};
        let provision=json!({"profileId":"perfect-planner-checks-v1","registeredRoot":path,"npmCli":{"path":path.join("npm-cli.js"),"sha256":"c".repeat(64)},"assignments":[{"taskId":"T0001","categories":["tests"]}]});
        (path,binding,provision)
    }
    #[test]fn roundtrip_and_exact_retry_preserve_one_immutable_receipt(){
        let(dir,b,p)=fixture();let reference=save(&dir,&b,&dir,p.clone()).unwrap();
        assert_eq!(resolve(&dir,&b,&dir,&reference).unwrap(),p);
        assert_eq!(save(&dir,&b,&dir,p.clone()).unwrap(),reference);
        assert_eq!(fs::read_dir(dir.join("native-check-setups-v1")).unwrap().count(),2);
        assert!(!dir.join(format!("{}.sessions.jsonl",b.project_id)).exists());
        let mut next=p;next["assignments"][0]["categories"]=json!(["build"]);
        let second=save(&dir,&b,&dir,next).unwrap();assert_ne!(reference,second);
        assert_eq!(resolve(&dir,&b,&dir,&reference).unwrap()["assignments"][0]["categories"],json!(["tests"]));
    }
    #[test]fn changed_census_root_or_project_cannot_resolve_saved_setup(){
        let(dir,b,p)=fixture();let reference=save(&dir,&b,&dir,p).unwrap();
        for field in ["root","census","project"]{let mut other=b.clone();match field{"root"=>other.root_identity="d".repeat(64),"census"=>other.census_digest="e".repeat(64),_=>other.project_id="pp_foreign".into()};assert!(resolve(&dir,&other,&dir,&reference).is_err());}
        let other=dir.join("other");fs::create_dir(&other).unwrap();assert!(resolve(&dir,&b,&other,&reference).is_err());
    }
    #[test]fn malformed_reference_never_creates_storage(){let(dir,b,_)=fixture();for id in ["../foreign","LATEST","",&"A".repeat(64)]{assert!(resolve(&dir,&b,&dir,id).is_err());}assert!(!dir.join("native-check-setups-v1").exists());}
    #[test]fn partial_or_altered_receipt_is_retained_and_never_repaired_by_retry(){
        for bytes in [b"".as_slice(),b"{}".as_slice()]{let(dir,b,p)=fixture();let reference=save(&dir,&b,&dir,p.clone()).unwrap();let path=dir.join("native-check-setups-v1").join(format!("{reference}.json"));fs::write(&path,bytes).unwrap();assert!(resolve(&dir,&b,&dir,&reference).is_err());assert!(save(&dir,&b,&dir,p).is_err());assert_eq!(fs::read(path).unwrap(),bytes);}
    }
    #[test]fn native_configuration_validation_rejects_injected_commands(){let(dir,b,mut p)=fixture();p["command"]=json!("arbitrary");assert!(save(&dir,&b,&dir,p).is_err());assert!(!dir.join("native-check-setups-v1").exists());}
    #[test]fn hardlinked_receipt_is_refused(){let(dir,b,p)=fixture();let reference=save(&dir,&b,&dir,p).unwrap();let path=dir.join("native-check-setups-v1").join(format!("{reference}.json"));fs::hard_link(path,dir.join("alias.json")).unwrap();assert!(resolve(&dir,&b,&dir,&reference).is_err());}
    #[test]fn busy_setup_creation_does_not_touch_draft_history(){let(dir,b,p)=fixture();let reference=save(&dir,&b,&dir,p.clone()).unwrap();let lock=OpenOptions::new().read(true).write(true).open(dir.join("native-check-setups-v1/creation.lock")).unwrap();lock.try_lock_exclusive().unwrap();assert_eq!(save(&dir,&b,&dir,p).unwrap_err().code,"NATIVE_CHECK_SETUP_BUSY");assert!(resolve(&dir,&b,&dir,&reference).is_ok());}
}
