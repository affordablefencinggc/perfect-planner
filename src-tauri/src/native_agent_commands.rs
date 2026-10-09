//! Renderer may inspect or stop its project broker. Pairing secrets and client
//! methods are intentionally absent from these native commands.
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use tauri::Manager;
pub use crate::native_agent_registry::AgentBrokers;

#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct AgentRequest{schema_version:u32,project_id:String,generation:u32,workspace_id:String,registry_revision:u32,root_identity:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct AgentPlanRequest{identity:AgentRequest,census_digest:String}
fn binding(r:&AgentRequest)->Result<Value,&'static str>{
    let token=|v:&str,max:usize|!v.is_empty()&&v.len()<=max&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b));
    if r.schema_version!=1||!token(&r.project_id,128)||!token(&r.workspace_id,64)||r.workspace_id.len()<3||r.registry_revision==0||r.root_identity.len()!=64||!r.root_identity.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("AGENT_REQUEST_INVALID");}
    Ok(json!({"projectId":r.project_id,"workspaceId":r.workspace_id,"rootIdentity":r.root_identity,"registryRevision":r.registry_revision}))
}
fn receipt(r:&AgentRequest,sessions:Vec<Value>,stopped:bool)->Value{
    json!({"schemaVersion":1,"projectId":r.project_id,"generation":r.generation,"workspaceId":r.workspace_id,"registryRevision":r.registry_revision,"rootIdentity":r.root_identity,"sessions":sessions,"stopped":stopped,"executionAuthorized":false,"externalEndpointAvailable":false})
}
#[tauri::command]
pub async fn prepare_agent_proposal_pairing(app:tauri::AppHandle,request:AgentPlanRequest)->Result<Value,String>{
    let expected=binding(&request.identity).map_err(str::to_owned)?;
    if request.census_digest.len()!=64||!request.census_digest.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("AGENT_PLAN_REQUEST_INVALID".into());}
    tauri::async_runtime::spawn_blocking(move||->Result<Value,String>{
        #[cfg(not(windows))]{let _=(app,request,expected);return Err("AGENT_PLATFORM_UNSUPPORTED".into());}
        #[cfg(windows)]{
            let r=&request.identity;
            let approved=rfd::MessageDialog::new().set_title("Allow this agent to propose task changes?")
                .set_description(format!("Project: {}\nWorkspace: {}\n\nAllow the verified packaged helper to read submitted planning tasks, create/edit/archive task proposals, and save agent-reported exchange summaries in Developer Notes? Reports are retained locally and are not verified facts. Do not submit secrets or private reasoning. Exact original task requests are retained for recovery. Your app's source files will not be changed. This does not approve work, run code, deploy or grant browser/desktop control. Existing read-only connections will not be upgraded. Connect your IDE within 30 seconds after approving.",r.project_id,r.workspace_id))
                .set_buttons(rfd::MessageButtons::OkCancel).show();
            if approved!=rfd::MessageDialogResult::Ok{return Err("AGENT_PAIRING_CANCELLED".into());}
            // Re-resolve the exact registered census after the native decision.
            // The renderer cannot supply executable paths, configuration or grants.
            let(resources,registry,configuration)=crate::native_draft_commands::agent_read_configuration(&app,&r.workspace_id,r.registry_revision,&r.root_identity,&request.census_digest).map_err(str::to_owned)?;
            let state=app.state::<AgentBrokers>();
            let mut value=crate::native_agent_setup::prepare_with_proposals(&state,&resources,&registry,expected,configuration).map_err(str::to_owned)?;
            let map=value.as_object_mut().ok_or("AGENT_CONFIG_INVALID")?;
            for(key,value)in serde_json::to_value(r).map_err(|_|"AGENT_REQUEST_INVALID")?.as_object().ok_or("AGENT_REQUEST_INVALID")?{map.insert(key.clone(),value.clone());}
            map.insert("planReadPermission".into(),json!("approved"));map.insert("proposalWritePermission".into(),json!("approved"));
            Ok(value)
        }
    }).await.map_err(|_|"AGENT_PAIRING_INTERRUPTED".to_owned())?
}
#[tauri::command]
pub async fn prepare_agent_plan_pairing(app:tauri::AppHandle,request:AgentPlanRequest)->Result<Value,String>{
    let expected=binding(&request.identity).map_err(str::to_owned)?;
    if request.census_digest.len()!=64||!request.census_digest.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("AGENT_PLAN_REQUEST_INVALID".into());}
    tauri::async_runtime::spawn_blocking(move||->Result<Value,String>{
        #[cfg(not(windows))]{let _=(app,request,expected);return Err("AGENT_PLATFORM_UNSUPPORTED".into());}
        #[cfg(windows)]{
            let r=&request.identity;
            let approved=rfd::MessageDialog::new().set_title("Allow this agent to read your plan?")
                .set_description(format!("Project: {}\nWorkspace: {}\n\nAllow the packaged helper to read this project's submitted task summaries, full task details and submission receipts? Unsubmitted editor drafts are not included. This does not allow edits, approvals, code execution or browser/desktop control. Connect your IDE within 30 seconds after approving.",r.project_id,r.workspace_id))
                .set_buttons(rfd::MessageButtons::OkCancel).show();
            if approved!=rfd::MessageDialogResult::Ok{return Err("AGENT_PAIRING_CANCELLED".into());}
            // Observe again after consent; dialog time is not a registration lease.
            let(resources,registry,configuration)=crate::native_draft_commands::agent_read_configuration(&app,&r.workspace_id,r.registry_revision,&r.root_identity,&request.census_digest).map_err(str::to_owned)?;
            let state=app.state::<AgentBrokers>();
            let mut value=crate::native_agent_setup::prepare_with_plan(&state,&resources,&registry,expected,Some(configuration)).map_err(str::to_owned)?;
            let map=value.as_object_mut().ok_or("AGENT_CONFIG_INVALID")?;
            for(key,value)in serde_json::to_value(r).map_err(|_|"AGENT_REQUEST_INVALID")?.as_object().ok_or("AGENT_REQUEST_INVALID")?{map.insert(key.clone(),value.clone());}
            map.insert("planReadPermission".into(),json!("approved"));
            Ok(value)
        }
    }).await.map_err(|_|"AGENT_PAIRING_INTERRUPTED".to_owned())?
}
#[tauri::command]
pub async fn prepare_agent_pairing(app:tauri::AppHandle,request:AgentRequest)->Result<Value,String>{
    let expected=binding(&request).map_err(str::to_owned)?;
    tauri::async_runtime::spawn_blocking(move||->Result<Value,String>{
        #[cfg(not(windows))]{let _=(app,request,expected);return Err("AGENT_PLATFORM_UNSUPPORTED".into());}
        #[cfg(windows)]{
            let registry=crate::workspace_census::app_registry_root(&app).map_err(|_|"AGENT_REGISTRY_UNAVAILABLE")?;
            let resources=app.path().resource_dir().map_err(|_|"AGENT_PACKAGE_UNAVAILABLE")?;
            crate::native_host_resources::verify_agent_helper(&resources).map_err(str::to_owned)?;
            let approved=rfd::MessageDialog::new().set_title("Connect an agent to Perfect Planner?")
                .set_description(format!("Project: {}\nWorkspace: {}\n\nAllow the packaged agent helper to pair for connection observation? This does not grant task approval, code execution or desktop control. Connect your IDE within 30 seconds after approving.",request.project_id,request.workspace_id))
                .set_buttons(rfd::MessageButtons::OkCancel).show();
            if approved!=rfd::MessageDialogResult::Ok{return Err("AGENT_PAIRING_CANCELLED".into());}
            let state=app.state::<AgentBrokers>();
            let mut value=crate::native_agent_setup::prepare(&state,&resources,&registry,expected).map_err(str::to_owned)?;
            let map=value.as_object_mut().ok_or("AGENT_CONFIG_INVALID")?;
            for (key,value) in serde_json::to_value(&request).map_err(|_|"AGENT_REQUEST_INVALID")?.as_object().ok_or("AGENT_REQUEST_INVALID")?{map.insert(key.clone(),value.clone());}
            Ok(value)
        }
    }).await.map_err(|_|"AGENT_PAIRING_INTERRUPTED".to_owned())?
}
#[tauri::command]
pub async fn read_agent_exchange_notes(app:tauri::AppHandle,request:AgentRequest,offset:u32)->Result<Value,String>{
    let expected=binding(&request).map_err(str::to_owned)?;
    if offset>1000{return Err("EXCHANGE_OFFSET_INVALID".into());}
    tauri::async_runtime::spawn_blocking(move||->Result<Value,String>{
        let registry=crate::workspace_census::app_registry_root(&app).map_err(|_|"AGENT_REGISTRY_UNAVAILABLE")?;
        let resources=app.path().resource_dir().map_err(|_|"AGENT_PACKAGE_UNAVAILABLE")?;
        let state=app.state::<AgentBrokers>();let key=expected.to_string();
        let shared=state.get_or_start(&key,&resources,&registry).map_err(str::to_owned)?;
        let mut broker=shared.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
        let reply=broker.request("owner.readExchanges",json!({"binding":expected,"offset":offset})).map_err(str::to_owned)?;
        let data=&reply["result"];
        if reply["ok"]!=true||data["binding"]!=expected||data["executionAuthorized"]!=false||data["coverage"]!="reported-exchanges-only"||!data["records"].as_array().is_some_and(|r|r.len()<=1){return Err("EXCHANGE_READ_UNCONFIRMED".into());}
        Ok(json!({"projectId":request.project_id,"generation":request.generation,"data":data}))
    }).await.map_err(|_|"EXCHANGE_READ_INTERRUPTED".to_owned())?
}
#[tauri::command]
pub async fn inspect_agent_sessions(app:tauri::AppHandle,request:AgentRequest)->Result<Value,String>{
    let expected=binding(&request).map_err(str::to_owned)?;
    tauri::async_runtime::spawn_blocking(move||->Result<Value,String>{
        let registry=crate::workspace_census::app_registry_root(&app).map_err(|_|"AGENT_REGISTRY_UNAVAILABLE")?;
        let resources=app.path().resource_dir().map_err(|_|"AGENT_PACKAGE_UNAVAILABLE")?;
        let state=app.state::<AgentBrokers>();
        let key=expected.to_string();
        let shared=state.get_or_start(&key,&resources,&registry).map_err(str::to_owned)?;
        // A slow project must not hold the registry lock for every project.
        let mut broker=shared.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
        let result=broker.request("owner.inspect",json!({"binding":expected}));
        let reply=match result{Ok(v)if v["ok"]==true=>v,_=>{
            broker.stop();
            drop(broker);
            state.retire(&key,&shared).map_err(str::to_owned)?;
            return Err("AGENT_INSPECTION_FAILED".into());
        }};
        drop(broker);
        let rows=reply["result"].as_array().ok_or("AGENT_OBSERVATION_INVALID")?;
        if rows.len()>32{return Err("AGENT_OBSERVATION_INVALID".into());}
        let mut sessions=Vec::new();
        for row in rows{
            let observation=&row["observation"];
            if observation["binding"]!=expected||row["workVerified"]!=false||row["executionAuthorized"]!=false||!matches!(row["state"].as_str(),Some("reachable"|"stale"|"closed")){return Err("AGENT_OBSERVATION_INVALID".into());}
            let id=observation["sessionId"].as_str().ok_or("AGENT_OBSERVATION_INVALID")?;
            if id.len()!=32||!id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("AGENT_OBSERVATION_INVALID".into());}
            let observed=observation["observedAt"].as_u64().ok_or("AGENT_OBSERVATION_INVALID")?;
            let expires=observation["expiresAt"].as_u64().ok_or("AGENT_OBSERVATION_INVALID")?;
            // Whitelist output; never forward raw broker objects to the renderer.
            sessions.push(json!({"sessionId":id,"state":row["state"],"observedAt":observed,"expiresAt":expires,"workVerified":false}));
        }
        let mut value=receipt(&request,sessions,false);
        #[cfg(windows)]{value["workers"]=state.worker_snapshot(&key,&shared).map_err(str::to_owned)?;}
        Ok(value)
    }).await.map_err(|_|"AGENT_INSPECTION_INTERRUPTED".to_owned())?
}
#[tauri::command]
pub async fn stop_project_agent_broker(app:tauri::AppHandle,request:AgentRequest)->Result<Value,String>{
    let key=binding(&request).map_err(str::to_owned)?.to_string();
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<AgentBrokers>();
        state.stop(&key).map_err(str::to_owned)?;
        Ok(receipt(&request,vec![],true))
    }).await.map_err(|_|"AGENT_STOP_INTERRUPTED".to_owned())?
}

#[cfg(test)]mod plan_request_tests{
    use super::*;
    #[test]fn plan_pairing_cannot_accept_configuration_or_silently_change_existing_request(){
        let identity=json!({"schemaVersion":1,"projectId":"pp_example","generation":1,"workspaceId":"example","registryRevision":1,"rootIdentity":"a".repeat(64)});
        assert!(serde_json::from_value::<AgentRequest>(identity.clone()).is_ok());
        assert!(serde_json::from_value::<AgentPlanRequest>(identity.clone()).is_err());
        let request=json!({"identity":identity,"censusDigest":"b".repeat(64)});
        assert!(serde_json::from_value::<AgentPlanRequest>(request.clone()).is_ok());
        for key in ["stateDirectory","hostConfiguration","approved","actor","executionAuthorized"]{let mut bad=request.clone();bad[key]=json!(true);assert!(serde_json::from_value::<AgentPlanRequest>(bad).is_err());}
        let mut bad=request.clone();bad["identity"]["journalPath"]=json!("foreign");assert!(serde_json::from_value::<AgentPlanRequest>(bad).is_err());
    }
}
