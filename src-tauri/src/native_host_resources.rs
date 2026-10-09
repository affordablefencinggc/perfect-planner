//! Installed resource observation before process launch. Compiled build pin
//! only; adjacent manifest bytes are never their own trust anchor. No publisher
//! authentication or exclusive filesystem lease is claimed.
use serde::Deserialize;
use sha2::{Digest,Sha256};
use std::collections::HashSet;
use std::fs::{self,File};
use std::io::Read;
use std::path::{Path,PathBuf,Component};
use std::time::SystemTime;
const MANIFEST_LIMIT:u64=256*1024;
const TOTAL_LIMIT:u64=512*1024*1024;
const BOOTSTRAP:&str="host/src/node/installedNativeReviewHostProcess.mjs";
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Manifest{schema_version:u32,kind:String,files:Vec<Entry>,total_bytes:u64,execution_authorized:bool,publisher_verified:bool}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Entry{path:String,sha256:String,bytes:u64}
#[derive(Debug)]
pub(crate) struct VerifiedNativeHost{pub package_root:PathBuf,pub node_executable:PathBuf,pub bootstrap_script:PathBuf,pub presenter_executable:PathBuf,pub manifest_digest:String,pub execution_authorized:bool,pub publisher_verified:bool}
fn hash(value:&str)->bool{value.len()==64&&value.bytes().all(|byte|byte.is_ascii_digit()||(b'a'..=b'f').contains(&byte))}
fn spelling(path:&Path)->Result<String,&'static str>{
    let value=path.to_str().ok_or("NATIVE_HOST_RESOURCE_PATH_INVALID")?;
    #[cfg(windows)]{let value=value.replace('/',"\\").to_lowercase();let value=if let Some(tail)=value.strip_prefix("\\\\?\\unc\\"){format!("\\\\{tail}")}else{value.strip_prefix("\\\\?\\").unwrap_or(&value).to_owned()};return Ok(value);}
    #[cfg(not(windows))]{Ok(value.to_owned())}
}
fn safe(path:&Path)->Result<(),&'static str>{
    if !path.is_absolute()||path.components().any(|part|matches!(part,Component::ParentDir|Component::CurDir)){return Err("NATIVE_HOST_RESOURCE_PATH_INVALID");}
    for ancestor in path.ancestors(){let metadata=fs::symlink_metadata(ancestor).map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?;if metadata.file_type().is_symlink(){return Err("NATIVE_HOST_RESOURCE_REDIRECTED");}#[cfg(windows)]{use std::os::windows::fs::MetadataExt;if metadata.file_attributes()&0x400!=0{return Err("NATIVE_HOST_RESOURCE_REDIRECTED");}}if spelling(ancestor)?!=spelling(&fs::canonicalize(ancestor).map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?)?{return Err("NATIVE_HOST_RESOURCE_NONCANONICAL");}}
    Ok(())
}
pub(crate) fn verify_config_directory(path:&Path)->Result<(),&'static str>{
    safe(path)?;if !path.is_dir(){return Err("AGENT_CONFIG_DIRECTORY_INVALID");}Ok(())
}
fn identity(file:&File)->Result<(u64,u64),&'static str>{
    #[cfg(windows)]{use std::os::windows::io::AsRawHandle;#[link(name="kernel32")]extern "system"{fn GetFileInformationByHandle(handle:*mut std::ffi::c_void,info:*mut u32)->i32;}
        let mut info=[0u32;13];if unsafe{GetFileInformationByHandle(file.as_raw_handle(),info.as_mut_ptr())}==0||info[10]!=1{return Err("NATIVE_HOST_RESOURCE_IDENTITY_INVALID");}return Ok((info[7]as u64,((info[11]as u64)<<32)|info[12]as u64));}
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;let metadata=file.metadata().map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?;if metadata.nlink()!=1{return Err("NATIVE_HOST_RESOURCE_IDENTITY_INVALID");}return Ok((metadata.dev(),metadata.ino()));}
    #[cfg(not(any(windows,unix)))]{Err("NATIVE_HOST_RESOURCE_PLATFORM_UNSUPPORTED")}
}
fn stamp(file:&File)->Result<(u64,SystemTime,(u64,u64)),&'static str>{let metadata=file.metadata().map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?;if !metadata.is_file(){return Err("NATIVE_HOST_RESOURCE_NOT_FILE");}Ok((metadata.len(),metadata.modified().map_err(|_|"NATIVE_HOST_RESOURCE_TIMESTAMP_UNAVAILABLE")?,identity(file)?))}
fn verify_file(path:&Path,pin:&str,limit:u64,expected:Option<u64>,collect:bool)->Result<Vec<u8>,&'static str>{
    safe(path)?;let mut file=File::open(path).map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?;let before=stamp(&file)?;
    if before.0>limit||expected.map(|bytes|bytes!=before.0).unwrap_or(false){return Err("NATIVE_HOST_RESOURCE_SIZE_INVALID");}
    let mut digest=Sha256::new();let mut buffer=[0u8;65536];let mut count=0u64;let mut bytes=Vec::new();
    loop{let read=file.read(&mut buffer).map_err(|_|"NATIVE_HOST_RESOURCE_READ_FAILED")?;if read==0{break;}count=count.checked_add(read as u64).ok_or("NATIVE_HOST_RESOURCE_SIZE_INVALID")?;if count>before.0||count>limit{return Err("NATIVE_HOST_RESOURCE_CHANGED");}digest.update(&buffer[..read]);if collect{bytes.extend_from_slice(&buffer[..read]);}}
    safe(path)?;let current=File::open(path).map_err(|_|"NATIVE_HOST_RESOURCE_CHANGED")?;
    if count!=before.0||stamp(&file)?!=before||stamp(&current)?!=before||format!("{:x}",digest.finalize())!=pin{return Err("NATIVE_HOST_RESOURCE_PIN_MISMATCH");}Ok(bytes)
}
// Keep executable write/delete denial and ancestor rename denial alive across
// native process creation and settlement. This is not a candidate-content lease.
#[cfg(windows)]
pub(crate) struct PinnedTaskFiles{_executable:File,_directories:Vec<File>}
#[cfg(windows)]
pub(crate) struct PinnedDirectoryNames{_directories:Vec<File>}
#[cfg(windows)]
pub(crate) fn pin_directory_names(root:&Path)->Result<PinnedDirectoryNames,&'static str>{
    pin_directory_names_observed(root,|_|{})
}
#[cfg(windows)]
fn pin_directory_names_observed(root:&Path,mut observed:impl FnMut(&Path))->Result<PinnedDirectoryNames,&'static str>{
    use std::os::windows::fs::{OpenOptionsExt,MetadataExt};
    verify_config_directory(root)?;let mut directories=Vec::new();
    let ancestors:Vec<_>=root.ancestors().collect();
    for ancestor in ancestors.iter().rev(){
        let file=fs::OpenOptions::new().read(true).share_mode(3).custom_flags(0x02200000).open(ancestor).map_err(|_|"NATIVE_TASK_DIRECTORY_PIN_UNAVAILABLE")?;
        let metadata=file.metadata().map_err(|_|"NATIVE_TASK_DIRECTORY_PIN_UNAVAILABLE")?;
        if !metadata.is_dir()||metadata.file_attributes()&0x400!=0{return Err("NATIVE_TASK_DIRECTORY_PIN_UNAVAILABLE");}
        let current=fs::OpenOptions::new().read(true).share_mode(7).custom_flags(0x02200000).open(ancestor).map_err(|_|"NATIVE_TASK_DIRECTORY_PIN_UNAVAILABLE")?;
        if identity(&file)?!=identity(&current)?{return Err("NATIVE_TASK_DIRECTORY_PIN_UNAVAILABLE");}
        directories.push(file);observed(ancestor);
    }
    verify_config_directory(root)?;
    for(ancestor,file)in ancestors.iter().rev().zip(&directories){
        let current=fs::OpenOptions::new().read(true).share_mode(7).custom_flags(0x02200000).open(ancestor).map_err(|_|"NATIVE_TASK_DIRECTORY_PIN_UNAVAILABLE")?;
        if identity(file)?!=identity(&current)?{return Err("NATIVE_TASK_DIRECTORY_PIN_UNAVAILABLE");}
    }
    Ok(PinnedDirectoryNames{_directories:directories})
}
#[cfg(windows)]
pub(crate) fn pin_task_files(executable:&Path,pin:&str,root:&Path,cwd:&Path)->Result<PinnedTaskFiles,&'static str>{
    use std::os::windows::fs::OpenOptionsExt;
    if !hash(pin){return Err("NATIVE_TASK_EXECUTABLE_PIN_INVALID");}
    safe(executable)?;verify_config_directory(root)?;verify_config_directory(cwd)?;
    let canonical_root=fs::canonicalize(root).map_err(|_|"NATIVE_TASK_ROOT_UNAVAILABLE")?;
    if !fs::canonicalize(cwd).map_err(|_|"NATIVE_TASK_CWD_UNAVAILABLE")?.starts_with(&canonical_root){return Err("NATIVE_TASK_CWD_OUTSIDE_ROOT");}
    let mut directories=Vec::new();let mut seen=HashSet::new();
    for start in [executable.parent().ok_or("NATIVE_TASK_EXECUTABLE_PIN_INVALID")?,root,cwd]{
        for ancestor in start.ancestors(){
            if seen.insert(spelling(ancestor)?){
                let handle=fs::OpenOptions::new().read(true).share_mode(3).custom_flags(0x02000000).open(ancestor).map_err(|_|"NATIVE_TASK_DIRECTORY_PIN_UNAVAILABLE")?;
                directories.push(handle);
            }
        }
    }
    safe(executable)?;verify_config_directory(root)?;verify_config_directory(cwd)?;
    let mut file=fs::OpenOptions::new().read(true).share_mode(1).open(executable).map_err(|_|"NATIVE_TASK_EXECUTABLE_PIN_UNAVAILABLE")?;
    let before=stamp(&file)?;if before.0==0||before.0>256*1024*1024{return Err("NATIVE_TASK_EXECUTABLE_SIZE_INVALID");}
    let mut hasher=Sha256::new();let mut buffer=[0u8;65536];let mut total=0u64;
    loop{let n=file.read(&mut buffer).map_err(|_|"NATIVE_TASK_EXECUTABLE_READ_FAILED")?;if n==0{break;}total+=n as u64;if total>before.0{return Err("NATIVE_TASK_EXECUTABLE_CHANGED");}hasher.update(&buffer[..n]);}
    safe(executable)?;
    if total!=before.0||stamp(&file)?!=before||format!("{:x}",hasher.finalize())!=pin{return Err("NATIVE_TASK_EXECUTABLE_PIN_MISMATCH");}
    Ok(PinnedTaskFiles{_executable:file,_directories:directories})
}
fn module_path(value:&str)->bool{
    value.starts_with("host/")&&value.len()<=245&&[".mjs",".js",".json"].iter().any(|suffix|value.ends_with(suffix))&&value.split('/').all(|part|{
        let stem=part.split('.').next().unwrap_or("").to_ascii_lowercase();let device=matches!(stem.as_str(),"con"|"prn"|"aux"|"nul")||((stem.starts_with("com")||stem.starts_with("lpt"))&&stem.len()==4&&matches!(stem.as_bytes()[3],b'1'..=b'9'));
        !part.is_empty()&&!part.ends_with('.')&&!device&&part.as_bytes()[0]!=b'.'&&part.bytes().all(|byte|byte.is_ascii_alphanumeric()||b"._-".contains(&byte))
    })
}
// Node's ESM loader does not accept Windows verbatim script/package spelling.
// Convert only filesystem DOS/UNC prefixes, then observe both spellings before
// any normal-path verification. This is not a lease against later replacement.
#[cfg(windows)]
fn runtime_spelling(path:&Path)->Result<PathBuf,&'static str>{
    use std::path::Prefix;
    if !path.is_absolute(){return Err("NATIVE_HOST_RESOURCE_PATH_INVALID");}
    let mut parts=path.components();
    let mut result=match parts.next(){
        Some(Component::Prefix(prefix))=>match prefix.kind(){
            Prefix::VerbatimDisk(drive)|Prefix::Disk(drive)=>PathBuf::from(format!("{}:",drive as char)),
            Prefix::VerbatimUNC(server,share)|Prefix::UNC(server,share)=>{
                let mut value=std::ffi::OsString::from("\\\\");value.push(server);value.push("\\");value.push(share);PathBuf::from(value)
            },
            _=>return Err("NATIVE_HOST_RESOURCE_PATH_INVALID"),
        },
        _=>return Err("NATIVE_HOST_RESOURCE_PATH_INVALID"),
    };
    for part in parts{match part{Component::RootDir=>result.push("\\"),Component::Normal(name)=>result.push(name),_=>return Err("NATIVE_HOST_RESOURCE_PATH_INVALID")}}
    if !result.is_absolute(){return Err("NATIVE_HOST_RESOURCE_PATH_INVALID");}Ok(result)
}
#[cfg(not(windows))]
fn runtime_spelling(path:&Path)->Result<PathBuf,&'static str>{Ok(path.to_owned())}
fn runtime_resource_directory(original:&Path)->Result<PathBuf,&'static str>{
    safe(original)?;let normal=runtime_spelling(original)?;safe(&normal)?;
    // Compare actual canonical resolution and the same manifest file identity,
    // not merely a lexical prefix equivalence. Converted paths receive the full
    // existing manifest/file hash verification below as well.
    if fs::canonicalize(original).map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?!=fs::canonicalize(&normal).map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?{return Err("NATIVE_HOST_RESOURCE_NONCANONICAL");}
    let old_path=original.join("native-review-host/manifest.json");let new_path=normal.join("native-review-host/manifest.json");safe(&old_path)?;safe(&new_path)?;
    let old_manifest=File::open(old_path).map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?;
    let new_manifest=File::open(new_path).map_err(|_|"NATIVE_HOST_RESOURCE_UNAVAILABLE")?;
    if stamp(&old_manifest)?!=stamp(&new_manifest)?{return Err("NATIVE_HOST_RESOURCE_CHANGED");}Ok(normal)
}
fn verify_with_pin(resource_directory:&Path,pin:Option<&str>)->Result<VerifiedNativeHost,&'static str>{
    let pin=pin.filter(|value|hash(value)).ok_or("NATIVE_HOST_NOT_CONFIGURED")?;
    safe(resource_directory)?;if !resource_directory.is_dir(){return Err("NATIVE_HOST_RESOURCE_PATH_INVALID");}
    let resource_directory=runtime_resource_directory(resource_directory)?;
    let root=resource_directory.join("native-review-host");let manifest_path=root.join("manifest.json");
    let bytes=verify_file(&manifest_path,pin,MANIFEST_LIMIT,None,true)?;let manifest:Manifest=serde_json::from_slice(&bytes).map_err(|_|"NATIVE_HOST_MANIFEST_INVALID")?;
    if manifest.schema_version!=1||manifest.kind!="NATIVE_REVIEW_HOST_PACKAGE"||manifest.execution_authorized||manifest.publisher_verified||manifest.files.len()<3||manifest.files.len()>515||manifest.total_bytes>TOTAL_LIMIT{return Err("NATIVE_HOST_MANIFEST_INVALID");}
    let mut names=HashSet::new();let mut total=0u64;
    for entry in &manifest.files{let executable=entry.path=="runtime/node.exe"||entry.path=="native/native-review.exe"||entry.path=="native/planner-agent-helper.exe";let limit=if executable{128*1024*1024}else{8*1024*1024};if (!executable&&!module_path(&entry.path))||!hash(&entry.sha256)||entry.bytes>limit||!names.insert(entry.path.to_ascii_lowercase()){return Err("NATIVE_HOST_MANIFEST_INVALID");}total=total.checked_add(entry.bytes).ok_or("NATIVE_HOST_MANIFEST_INVALID")?;}
    if total!=manifest.total_bytes||total>TOTAL_LIMIT||!["runtime/node.exe","native/native-review.exe",BOOTSTRAP].iter().all(|name|manifest.files.iter().any(|file|file.path==*name)){return Err("NATIVE_HOST_MANIFEST_INVALID");}
    for entry in &manifest.files{verify_file(&root.join(&entry.path),&entry.sha256,entry.bytes,Some(entry.bytes),false)?;}
    verify_file(&manifest_path,pin,MANIFEST_LIMIT,Some(bytes.len()as u64),false)?;
    Ok(VerifiedNativeHost{node_executable:root.join("runtime/node.exe"),bootstrap_script:root.join(BOOTSTRAP),presenter_executable:root.join("native/native-review.exe"),package_root:root,manifest_digest:pin.to_owned(),execution_authorized:false,publisher_verified:false})
}
pub(crate) fn verify_installed(resource_directory:&Path)->Result<VerifiedNativeHost,&'static str>{
    verify_with_pin(resource_directory,option_env!("PP_COMPILED_NATIVE_HOST_MANIFEST_SHA256").filter(|value|!value.is_empty()))
}

pub(crate) fn verify_agent_broker(resource_directory:&Path)->Result<VerifiedNativeHost,&'static str>{
    let mut verified=verify_installed(resource_directory)?;
    let bytes=verify_file(&verified.package_root.join("manifest.json"),&verified.manifest_digest,MANIFEST_LIMIT,None,true)?;
    let manifest:Manifest=serde_json::from_slice(&bytes).map_err(|_|"NATIVE_HOST_MANIFEST_INVALID")?;
    const BROKER:&str="host/mcp/agentBrokerHost.mjs";
    if !manifest.files.iter().any(|entry|entry.path==BROKER){return Err("NATIVE_AGENT_BROKER_NOT_PACKAGED");}
    verified.bootstrap_script=verified.package_root.join(BROKER);
    Ok(verified)
}

#[derive(Debug)]
pub(crate) struct VerifiedAgentHelper{executable:PathBuf,sha256:String}
impl VerifiedAgentHelper{
    pub(crate) fn executable(&self)->&Path{&self.executable}
    pub(crate) fn sha256(&self)->&str{&self.sha256}
}
fn helper_with_pin(resource_directory:&Path,pin:Option<&str>)->Result<VerifiedAgentHelper,&'static str>{
    let verified=verify_with_pin(resource_directory,pin)?;
    let bytes=verify_file(&verified.package_root.join("manifest.json"),&verified.manifest_digest,MANIFEST_LIMIT,None,true)?;
    let manifest:Manifest=serde_json::from_slice(&bytes).map_err(|_|"NATIVE_HOST_MANIFEST_INVALID")?;
    let entry=manifest.files.iter().find(|e|e.path=="native/planner-agent-helper.exe").ok_or("NATIVE_AGENT_HELPER_NOT_PACKAGED")?;
    Ok(VerifiedAgentHelper{executable:verified.package_root.join(&entry.path),sha256:entry.sha256.clone()})
}
pub(crate) fn verify_agent_helper(resource_directory:&Path)->Result<VerifiedAgentHelper,&'static str>{
    helper_with_pin(resource_directory,option_env!("PP_COMPILED_NATIVE_HOST_MANIFEST_SHA256").filter(|v|!v.is_empty()))
}

#[cfg(test)]
mod tests{
    use super::*;use serde_json::{json,Value};
    #[cfg(windows)]#[test]fn parent_name_is_pinned_before_observing_its_child(){
        let base=PathBuf::from(std::env::var_os("PP_ARCHIVE_FIXTURE_ROOT").expect("fresh fixture required"));
        let parent=base.join("parent-pin");let child=parent.join("child");fs::create_dir(&parent).unwrap();fs::create_dir(&child).unwrap();let moved=base.join("parent-moved");
        assert!(parent.starts_with(&base)&&moved.starts_with(&base));
        let pins=pin_directory_names_observed(&child,|path|{if path==child{assert!(fs::rename(&parent,&moved).is_err(),"An unpinned parent must not be replaceable while child custody is being established");}}).unwrap();
        assert!(child.is_dir());drop(pins);
    }
    #[test]fn helper_is_optional_but_requires_the_compiled_package_pin_and_exact_bytes(){
        let (base,mut manifest,pin)=fixture();
        assert_eq!(helper_with_pin(&base,Some(&pin)).unwrap_err(),"NATIVE_AGENT_HELPER_NOT_PACKAGED");
        let file=base.join("native-review-host/native/planner-agent-helper.exe");fs::write(&file,b"helper fixture").unwrap();
        let digest=format!("{:x}",Sha256::digest(b"helper fixture"));
        manifest["files"].as_array_mut().unwrap().push(json!({"path":"native/planner-agent-helper.exe","sha256":digest,"bytes":14}));manifest["totalBytes"]=json!(68);
        let pin=save(&base,&manifest);let helper=helper_with_pin(&base,Some(&pin)).unwrap();
        assert_eq!(helper.executable,file);assert_eq!(helper.sha256,digest);
        assert!(helper_with_pin(&base,None).is_err());fs::write(file,b"tampered bytes").unwrap();assert!(helper_with_pin(&base,Some(&pin)).is_err());
    }
    #[cfg(windows)]#[test]fn runtime_paths_map_only_verbatim_filesystem_prefixes(){
        for (input,wanted) in [(r"\\?\C:\MiXeD\Résumé\Host",r"C:\MiXeD\Résumé\Host"),(r"\\?\UNC\Server\Share\MiXeD\Host",r"\\Server\Share\MiXeD\Host"),(r"C:\Normal\Host",r"C:\Normal\Host"),(r"\\Server\Share\Host",r"\\Server\Share\Host")]{assert_eq!(runtime_spelling(Path::new(input)).unwrap(),PathBuf::from(wanted));}
        for input in [r"\\?\GLOBALROOT\Device\HarddiskVolume1\host",r"\\.\C:\host",r"\\?\Volume{1234}\host",r"C:relative",r"relative\host"]{assert!(runtime_spelling(Path::new(input)).is_err(),"device/relative prefix must not become filesystem authority");}
    }
    #[cfg(windows)]#[test]fn runtime_spelling_keeps_long_paths_without_truncation(){let suffix=(0..24).map(|n|format!("directory-{n:02}")).collect::<Vec<_>>().join("\\");let normal=format!("C:\\{suffix}\\Résumé");assert!(normal.len()>260);assert_eq!(runtime_spelling(Path::new(&format!("\\\\?\\{normal}"))).unwrap(),PathBuf::from(normal));}
    #[cfg(windows)]#[test]fn runtime_spelling_normalizes_actual_wire_text_not_only_path_equality(){
        for (input,wanted) in [
            ("C:/Normal/Host",r"C:\Normal\Host"),
            (r"C:\Mixed/Host",r"C:\Mixed\Host"),
            ("//Server/Share/Host",r"\\Server\Share\Host"),
            ("C:/MiXeD/Résumé/Host",r"C:\MiXeD\Résumé\Host"),
        ]{
            let actual=runtime_spelling(Path::new(input)).unwrap();
            assert_eq!(actual.to_str().unwrap(),wanted,"wire spelling must match the normalized runtime, not merely equivalent Windows path components");
        }
    }
    #[cfg(windows)]#[test]fn verified_verbatim_package_returns_normal_paths_and_same_identity(){let (base,_,pin)=fixture();let verbatim=fs::canonicalize(&base).unwrap();let normal=verify_with_pin(&base,Some(&pin)).unwrap();let converted=verify_with_pin(&verbatim,Some(&pin)).unwrap();assert_eq!(normal.package_root,converted.package_root);assert_eq!(normal.bootstrap_script,converted.bootstrap_script);assert!(!converted.package_root.to_string_lossy().starts_with(r"\\?\"));assert_eq!(stamp(&File::open(normal.node_executable).unwrap()).unwrap(),stamp(&File::open(converted.node_executable).unwrap()).unwrap());}
    fn fixture()->(PathBuf,Value,String){let base=std::env::temp_dir().join(format!("pp-host-resources-{}-{}",std::process::id(),SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()));let root=base.join("native-review-host");let mut files=Vec::new();for name in ["runtime/node.exe","native/native-review.exe",BOOTSTRAP]{let target=root.join(name);fs::create_dir_all(target.parent().unwrap()).unwrap();fs::write(target,b"fixture bytes only").unwrap();files.push(json!({"path":name,"sha256":format!("{:x}",Sha256::digest(b"fixture bytes only")),"bytes":18}));}let manifest=json!({"schemaVersion":1,"kind":"NATIVE_REVIEW_HOST_PACKAGE","files":files,"totalBytes":54,"executionAuthorized":false,"publisherVerified":false});let pin=save(&base,&manifest);(base,manifest,pin)}
    fn save(base:&Path,value:&Value)->String{let bytes=serde_json::to_vec(value).unwrap();fs::write(base.join("native-review-host/manifest.json"),&bytes).unwrap();format!("{:x}",Sha256::digest(&bytes))}
    #[test]fn verifies_fixed_paths_and_requires_external_build_pin(){let (base,_,pin)=fixture();let verified=verify_with_pin(&base,Some(&pin)).unwrap();assert!(verified.bootstrap_script.ends_with(BOOTSTRAP));assert!(!verified.execution_authorized);assert!(!verified.publisher_verified);assert_eq!(verify_with_pin(&base,None).unwrap_err(),"NATIVE_HOST_NOT_CONFIGURED");}
    #[test]fn refuses_tampered_resource(){let (base,_,pin)=fixture();fs::write(base.join("native-review-host/runtime/node.exe"),b"tampered").unwrap();assert!(verify_with_pin(&base,Some(&pin)).is_err());}
    #[test]fn refuses_duplicate_case_traversal_reserved_and_missing_bootstrap(){for invalid in ["host/../escape.mjs","host/CON.js","host/dir./x.js","host/a\\b.js"]{let (base,mut value,_)=fixture();value["files"][2]["path"]=json!(invalid);let pin=save(&base,&value);assert!(verify_with_pin(&base,Some(&pin)).is_err());}let (base,mut value,_)=fixture();let duplicate=value["files"][2].clone();value["files"].as_array_mut().unwrap().push(duplicate);value["totalBytes"]=json!(72);let pin=save(&base,&value);assert!(verify_with_pin(&base,Some(&pin)).is_err());}
    #[test]fn refuses_hardlinked_resource(){let (base,_,pin)=fixture();fs::hard_link(base.join("native-review-host/runtime/node.exe"),base.join("alias.exe")).unwrap();assert!(verify_with_pin(&base,Some(&pin)).is_err());}
    #[test]fn refuses_case_variant_duplicate_module(){let (base,mut value,_)=fixture();let mut duplicate=value["files"][2].clone();duplicate["path"]=json!("host/src/node/InstalledNativeReviewHostProcess.mjs");value["files"].as_array_mut().unwrap().push(duplicate);value["totalBytes"]=json!(72);let pin=save(&base,&value);assert_eq!(verify_with_pin(&base,Some(&pin)).unwrap_err(),"NATIVE_HOST_MANIFEST_INVALID");}
    #[test]fn refuses_missing_bootstrap_even_when_other_module_is_valid_and_present(){let (base,mut value,_)=fixture();value["files"][2]["path"]=json!("host/src/node/other.mjs");fs::write(base.join("native-review-host/host/src/node/other.mjs"),b"fixture bytes only").unwrap();let pin=save(&base,&value);assert_eq!(verify_with_pin(&base,Some(&pin)).unwrap_err(),"NATIVE_HOST_MANIFEST_INVALID");}
    #[cfg(windows)]#[test]fn refuses_redirected_resource_directory(){use std::os::windows::process::CommandExt;let (base,_,pin)=fixture();let alias=base.join("alias");let status=std::process::Command::new("cmd.exe").args(["/D","/C","mklink","/J"]).arg(&alias).arg(base.join("native-review-host")).creation_flags(0x08000000).status().unwrap();assert!(status.success(),"junction fixture creation must succeed; no skipped coverage");assert!(safe(&alias).is_err());assert!(verify_with_pin(&base,Some(&pin)).is_ok());}
    #[test]fn verifies_real_remote_package_when_explicit_fixture_is_supplied(){let Ok(root)=std::env::var("PP_TEST_NATIVE_HOST_RESOURCE_ROOT")else{eprintln!("No real package fixture supplied; this test is not installed-package evidence.");return;};let pin=std::env::var("PP_TEST_NATIVE_HOST_MANIFEST_SHA256").expect("fixture pin");let result=verify_installed(Path::new(&root)).unwrap();assert!(result.node_executable.is_file());assert!(result.bootstrap_script.is_file());assert!(result.presenter_executable.is_file());assert_eq!(result.manifest_digest,pin);}
}
