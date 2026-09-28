//! App-owned setup after native user approval. No renderer-supplied paths/pins.
use serde_json::{json,Value};
use std::path::Path;
use std::io::Read;
use sha2::{Sha256,Digest};
use crate::native_agent_registry::AgentBrokers;
pub(crate) fn prepare(owners:&AgentBrokers,resources:&Path,registry:&Path,binding:Value)->Result<Value,&'static str>{
    prepare_with_plan(owners,resources,registry,binding,None)
}
// Native consent handler only. Configuration must be built by draft custody,
// never deserialized from renderer or helper input.
pub(crate) fn prepare_with_plan(owners:&AgentBrokers,resources:&Path,registry:&Path,binding:Value,configuration:Option<Value>)->Result<Value,&'static str>{
    prepare_inner(owners,resources,registry,binding,configuration.map(crate::native_agent_worker::AgentPlanAccess::Read))
}
pub(crate) fn prepare_with_proposals(owners:&AgentBrokers,resources:&Path,registry:&Path,binding:Value,configuration:Value)->Result<Value,&'static str>{
    prepare_inner(owners,resources,registry,binding,Some(crate::native_agent_worker::AgentPlanAccess::Propose(configuration)))
}
fn prepare_inner(owners:&AgentBrokers,resources:&Path,registry:&Path,binding:Value,configuration:Option<crate::native_agent_worker::AgentPlanAccess>)->Result<Value,&'static str>{
    let helper=crate::native_host_resources::verify_agent_helper(resources)?;
    let shared=owners.get_or_start(&binding.to_string(),resources,registry)?;
    let reply=shared.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?.request("owner.inspect",json!({"binding":binding}))?;
    if reply["ok"]!=true{return Err("AGENT_PAIRING_BINDING_REFUSED");}
    let owner=std::env::current_exe().map_err(|_|"AGENT_OWNER_UNAVAILABLE")?;
    let mut file=std::fs::File::open(&owner).map_err(|_|"AGENT_OWNER_UNAVAILABLE")?;
    let mut hash=Sha256::new();let mut bytes=[0u8;65536];let mut total=0usize;
    loop{let n=file.read(&mut bytes).map_err(|_|"AGENT_OWNER_UNAVAILABLE")?;if n==0{break;}total+=n;if total>256*1024*1024{return Err("AGENT_OWNER_SIZE_LIMIT");}hash.update(&bytes[..n]);}
    crate::native_host_resources::verify_config_directory(registry)?;
    let directory=registry.join("agent-connections");
    match std::fs::create_dir(&directory){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err("AGENT_CONFIG_CREATE_FAILED")}
    crate::native_host_resources::verify_config_directory(&directory)?;
    let endpoint=crate::native_agent_pipe::random_endpoint()?;
    let pipe=crate::native_agent_pipe::AgentPipe::create(&endpoint)?;
    let path=directory.join(format!("{endpoint}.json"));
    let config=json!({"schemaVersion":1,"endpointId":endpoint,"ownerExecutable":owner,"ownerSha256":format!("{:x}",hash.finalize()),"binding":binding});
    crate::native_agent_pipe::write_owner_config(&path,&serde_json::to_vec(&config).map_err(|_|"AGENT_CONFIG_INVALID")?)?;
    let command=helper.executable().to_owned();
    match configuration{
        Some(crate::native_agent_worker::AgentPlanAccess::Propose(config))=>owners.attach_proposal_helper(binding,&shared,pipe,helper,config)?,
        Some(crate::native_agent_worker::AgentPlanAccess::Read(config))=>owners.attach_configured_helper(binding,&shared,pipe,helper,Some(config))?,
        None=>owners.attach_configured_helper(binding,&shared,pipe,helper,None)?,
    }
    let expires=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"AGENT_CLIENT_CLOCK")?.as_millis()as u64+30000;
    Ok(json!({"pairingState":"waiting","expiresAt":expires,"executionAuthorized":false,"mcpConfig":{"mcpServers":{"perfect-planner-agent":{"command":command,"args":["--connection-config",path]}}}}))
}
