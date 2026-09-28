//! Dedicated stdio helper. Trusted launch configuration is not tool input.
//! Plan reads require explicit permission received on the authenticated pipe.
use serde::Deserialize;
use serde_json::{json,Value};
use std::io::{BufRead,Read,Write};
use std::path::PathBuf;
use crate::native_agent_pipe::AgentPipeClient;
use crate::native_agent_session::NativeAgentConnection;
const LIMIT:usize=70000;
const PROTOCOL:&str="2025-11-25";
const TOOL:&str="planner_agent_connection";

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Config{schema_version:u32,endpoint_id:String,owner_executable:PathBuf,owner_sha256:String,binding:Binding}
#[derive(Deserialize,serde::Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Binding{project_id:String,workspace_id:String,registry_revision:u64,root_identity:String}
fn token(v:&str,min:usize,max:usize)->bool{(min..=max).contains(&v.len())&&v.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'_'|b'-'))}
fn hex(v:&str)->bool{v.len()==64&&v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn config(path:&std::path::Path)->Result<Config,&'static str>{
    if !path.is_absolute(){return Err("AGENT_HELPER_CONFIG_INVALID");}
    let file=std::fs::File::open(path).map_err(|_|"AGENT_HELPER_CONFIG_UNAVAILABLE")?;
    let mut bytes=Vec::new();file.take(16385).read_to_end(&mut bytes).map_err(|_|"AGENT_HELPER_CONFIG_UNAVAILABLE")?;
    if bytes.len()>16384{return Err("AGENT_HELPER_CONFIG_INVALID");}
    let c:Config=serde_json::from_slice(&bytes).map_err(|_|"AGENT_HELPER_CONFIG_INVALID")?;
    if c.schema_version!=1||!hex(&c.endpoint_id)||!hex(&c.owner_sha256)||!c.owner_executable.is_absolute()
        ||!token(&c.binding.project_id,1,128)||!token(&c.binding.workspace_id,3,64)||!hex(&c.binding.root_identity)
        ||c.binding.registry_revision==0||c.binding.registry_revision>9007199254740991{return Err("AGENT_HELPER_CONFIG_INVALID");}
    Ok(c)
}
fn frame(reader:&mut impl BufRead)->Result<Option<Vec<u8>>,&'static str>{
    let mut bytes=Vec::new();
    loop{
        let chunk=reader.fill_buf().map_err(|_|"AGENT_HELPER_IO")?;
        if chunk.is_empty(){return if bytes.is_empty(){Ok(None)}else{Err("AGENT_HELPER_FRAME_INVALID")};}
        let n=chunk.iter().position(|b|*b==b'\n').map_or(chunk.len(),|v|v+1);
        if bytes.len()+n>LIMIT{return Err("AGENT_HELPER_FRAME_LIMIT");}
        let end=chunk[n-1]==b'\n';bytes.extend_from_slice(&chunk[..n]);reader.consume(n);
        if end{return Ok(Some(bytes));}
    }
}
fn error(id:Value,code:i32,message:&str)->Value{json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})}
fn empty(v:&Value)->bool{v.as_object().is_some_and(|m|m.is_empty())}
fn serve(reader:&mut impl BufRead,writer:&mut impl Write,mut snapshot:impl FnMut()->Result<Value,&'static str>)->Result<(),&'static str>{
    serve_with_reads(reader,writer,&mut snapshot,|_,_|Err("AGENT_PLAN_READ_NOT_ALLOWED"))
}
fn serve_with_reads(reader:&mut impl BufRead,writer:&mut impl Write,snapshot:impl FnMut()->Result<Value,&'static str>,read_plan:impl FnMut(&str,Value)->Result<Value,&'static str>)->Result<(),&'static str>{
    serve_with_actions(reader,writer,snapshot,read_plan,|_|Err("AGENT_PROPOSAL_WRITE_NOT_ALLOWED"))
}
fn serve_with_actions(reader:&mut impl BufRead,writer:&mut impl Write,snapshot:impl FnMut()->Result<Value,&'static str>,read_plan:impl FnMut(&str,Value)->Result<Value,&'static str>,propose_task:impl FnMut(Value)->Result<Value,&'static str>)->Result<(),&'static str>{
    serve_with_reports(reader,writer,snapshot,read_plan,propose_task,|_|Err("AGENT_EXCHANGE_WRITE_NOT_ALLOWED"))
}
fn serve_with_reports(reader:&mut impl BufRead,writer:&mut impl Write,mut snapshot:impl FnMut()->Result<Value,&'static str>,mut read_plan:impl FnMut(&str,Value)->Result<Value,&'static str>,mut propose_task:impl FnMut(Value)->Result<Value,&'static str>,mut report_exchange:impl FnMut(Value)->Result<Value,&'static str>)->Result<(),&'static str>{
    let mut initialized=false;let mut ready=false;
    while let Some(bytes)=frame(reader)?{
        let message:Value=serde_json::from_slice(&bytes).map_err(|_|"AGENT_HELPER_FRAME_INVALID")?;
        let id=message.get("id").cloned();
        let method=message["method"].as_str().unwrap_or("");
        if message["jsonrpc"]!="2.0"||method.is_empty()||!message.is_object(){return Err("AGENT_HELPER_FRAME_INVALID");}
        let params=message.get("params").cloned().unwrap_or(json!({}));
        if bytes.len()>16384&&!(method=="tools/call"&&params["name"]=="planner_propose_task"){return Err("AGENT_HELPER_FRAME_LIMIT");}
        let Some(id)=id else{
            if method=="notifications/initialized"&&initialized&&empty(&params){ready=true;}
            continue;
        };
        if !(id.as_i64().is_some()||id.as_u64().is_some()||id.as_str().is_some_and(|v|!v.is_empty()&&v.len()<=128)){return Err("AGENT_HELPER_FRAME_INVALID");}
        let result=match method{
            "initialize" if !initialized=>{
                if !params["protocolVersion"].is_string()||!params["capabilities"].is_object()||!params["clientInfo"]["name"].is_string()||!params["clientInfo"]["version"].is_string(){Err((-32602,"Invalid initialization"))}
                else{initialized=true;Ok(json!({"protocolVersion":PROTOCOL,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"perfect-planner-agent","version":env!("CARGO_PKG_VERSION")},"instructions":"Observe the paired Planner connection. Plan reads and task proposals require their separate native permissions. Read the brief and all task chunks at the exact head; summaries do not replace obligations. Concatenate chunks before parsing JSON. Proposals must preserve the exact original request ID, parent revision and timestamp for retries. After an uncertain outcome read its original request result before retrying; never silently rebase or claim nothing changed. A recorded proposal is not approval, execution or completed work. Browser control is separate."}))}
            }
            "ping" if initialized=>Ok(json!({})),
            "tools/list" if ready&&empty(&params)=>{
                let mut tools=vec![json!({"name":TOOL,"title":"Planner agent connection","description":"Read the actual paired project connection, expiry and failure. Not task proof or execution authority.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})];
                for(name,description,properties,required)in [
                    ("planner_read_brief","Read submitted task summaries. Requires native plan-read approval. Use the returned head digest for subsequent pages and task chunks.",json!({"offset":{"type":"integer","minimum":0,"maximum":500},"expectedHeadDigest":{"type":["string","null"]}}),json!(["offset","expectedHeadDigest"])),
                    ("planner_read_task","Read a full task JSON chunk at an exact head. Requires native plan-read approval. Concatenate all chunks before parsing; offsets are UTF-16 code units.",json!({"taskId":{"type":"string","pattern":"^T[0-9]{4,6}$"},"offset":{"type":"integer","minimum":0,"maximum":1048576},"expectedHeadDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}}),json!(["taskId","offset","expectedHeadDigest"])),
                    ("planner_read_request_result","Read a submission receipt by original request ID. Requires native plan-read approval. A recorded proposal is not approved or executed work.",json!({"requestId":{"type":"string","minLength":1,"maxLength":128}}),json!(["requestId"])),
                ]{tools.push(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}));}
                tools.push(json!({"name":"planner_propose_task","title":"Propose one Planner task change","description":"Requires separately granted native proposal-write permission. Submit one complete task against an exact Ledger head. Original requests are retained; stale heads and conflicts are refused. A recorded proposal is not approved or executed. Reconcile unknown outcomes by original request ID.","inputSchema":{"type":"object","properties":{"binding":{"type":"object","properties":{"projectId":{"type":"string"},"rootIdentity":{"type":"string"},"censusDigest":{"type":"string"}},"required":["projectId","rootIdentity","censusDigest"],"additionalProperties":false},"request":{"type":"object","properties":{"requestId":{"type":"string","minLength":1,"maxLength":128},"expectedRevision":{"type":"integer","minimum":0},"expectedHeadDigest":{"type":"string"}},"required":["requestId","expectedRevision","expectedHeadDigest"],"additionalProperties":false},"task":{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},"owner":{"type":"string"},"acceptance":{"type":"string"},"recovery":{"type":"string"},"claims":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"access":{"enum":["read","write"]}},"required":["path","access"],"additionalProperties":false}},"dependsOn":{"type":"array","items":{"type":"string"}},"archived":{"type":"boolean"}},"required":["title","description","owner","acceptance","recovery","claims","dependsOn","archived"],"additionalProperties":false},"updatedAt":{"type":"string","description":"Exact ISO timestamp; reuse unchanged for an original-request retry."}},"required":["binding","request","task","updatedAt"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}));
                let mut fields=serde_json::Map::new();
                for key in ["turn","request","response","observed","explanation","error","solution","evidence"]{fields.insert(key.into(),json!({"type":"string","maxLength":1000}));}
                tools.push(json!({"name":"planner_report_exchange","title":"Report this exchange to Developer Notes","description":"After each prompt/reply exchange submit a concise factual summary, observed errors, suspected cause, next action and evidence references. Never include secrets or private reasoning. Requires native proposal-and-notes permission. Use a unique exchangeId; retry the identical report on uncertain save. Reports are claims, not verification. MCP cannot capture unreported IDE conversation.","inputSchema":{"type":"object","properties":{"binding":{"type":"object","properties":{"projectId":{"type":"string"},"workspaceId":{"type":"string"},"registryRevision":{"type":"integer","minimum":1},"rootIdentity":{"type":"string"}},"required":["projectId","workspaceId","registryRevision","rootIdentity"],"additionalProperties":false},"exchangeId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$"},"summary":{"type":"object","properties":fields,"required":["turn","request","response","observed","explanation","error","solution","evidence"],"additionalProperties":false}},"required":["binding","exchangeId","summary"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}));
                Ok(json!({"tools":tools}))
            }
            "tools/call" if ready=>{
                let args=params.get("arguments").cloned().unwrap_or(json!({}));
                if params.as_object().map_or(true,|m|m.keys().any(|k|k!="name"&&k!="arguments"&&k!="_meta")){Err((-32602,"Unknown tool or arguments"))}
                else if params["name"]==TOOL&&empty(&args){match snapshot(){Ok(value)=>Ok(json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})),Err(_)=>Ok(json!({"content":[{"type":"text","text":"Connection state is unavailable; no work is verified."}],"isError":true}))}}
                else if params["name"]=="planner_propose_task"{
                    if !args.is_object(){Err((-32602,"Invalid proposal arguments"))}else{match propose_task(args){Ok(value)=>Ok(json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":value["writeState"]!="recorded-proposal"})),Err(_)=>Ok(json!({"content":[{"type":"text","text":"Proposal outcome is not confirmed. Check separate native proposal permission and reconcile the original request ID. Do not assume no save occurred, change the request ID or silently rebase."}],"isError":true}))}}
                }
                else if params["name"]=="planner_report_exchange"{
                    match report_exchange(args){Ok(value)=>Ok(json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":value["writeState"]!="recorded-exchange"})),Err(_)=>Ok(json!({"content":[{"type":"text","text":"Exchange report save is unconfirmed. Check connection and proposal-and-notes permission. Retry the identical exchange ID and report; do not claim it was saved."}],"isError":true}))}
                }
                else if let Some(method)=match params["name"].as_str(){Some("planner_read_brief")=>Some("client.readBrief"),Some("planner_read_task")=>Some("client.readTask"),Some("planner_read_request_result")=>Some("client.readRequestResult"),_=>None}{
                    if !args.is_object(){Err((-32602,"Invalid read arguments"))}else{match read_plan(method,args){Ok(value)=>Ok(json!({"content":[{"type":"text","text":value.to_string()}],"isError":!value["readError"].is_null()})),Err(_)=>Ok(json!({"content":[{"type":"text","text":"Plan read unavailable. Check the connection and separate native plan-read approval; no work was changed."}],"isError":true}))}}
                }else{Err((-32602,"Unknown tool or arguments"))}
            }
            _=>Err((if ready{-32601}else{-32000},"Method unavailable")),
        };
        let reply=match result{Ok(value)=>json!({"jsonrpc":"2.0","id":id,"result":value}),Err((code,message))=>error(id,code,message)};
        let bytes=serde_json::to_vec(&reply).map_err(|_|"AGENT_HELPER_FRAME_INVALID")?;
        if bytes.len()>32768{return Err("AGENT_HELPER_FRAME_LIMIT");}
        writer.write_all(&bytes).and_then(|_|writer.write_all(b"\n")).and_then(|_|writer.flush()).map_err(|_|"AGENT_HELPER_IO")?;
    }
    Ok(())
}
pub fn run_agent_stdio()->i32{
    let run=||->Result<(),&'static str>{
        let args:Vec<_>=std::env::args_os().collect();
        if args.len()!=3||args[1]!="--connection-config"{return Err("AGENT_HELPER_ARGUMENTS_INVALID");}
        let c=config(std::path::Path::new(&args[2]))?;
        let client=AgentPipeClient::connect_pinned(&c.endpoint_id,&c.owner_executable,&c.owner_sha256)?;
        let binding=serde_json::to_value(&c.binding).map_err(|_|"AGENT_HELPER_CONFIG_INVALID")?;
        let mut connection=NativeAgentConnection::start(client,binding)?;
        let result=serve_with_reports(&mut std::io::stdin().lock(),&mut std::io::stdout().lock(),||connection.snapshot(),|method,input|connection.read_plan(method,input),|input|connection.propose_task(input),|input|connection.report_exchange(input));
        connection.stop()?;result
    };
    match run(){Ok(())=>0,Err(code)=>{eprintln!("{code}");2}}
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn proposal_tool_requires_initialization_and_reports_uncertainty_without_leaking_errors(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let request=|id|json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"planner_propose_task","arguments":{"request":{"requestId":"original-1"}}}});
        let messages=[request(1),json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),json!({"jsonrpc":"2.0","method":"notifications/initialized"}),request(3),request(4),request(5)];
        let input=messages.iter().map(|v|format!("{v}\n")).collect::<String>();let mut output=Vec::new();let mut calls=0;
        serve_with_actions(&mut std::io::Cursor::new(input),&mut output,||Ok(json!({"state":"reachable"})),|_,_|Err("not a read"),|input|{assert_eq!(input["request"]["requestId"],"original-1");calls+=1;match calls{1=>Ok(json!({"writeState":"recorded-proposal","executionAuthorized":false})),2=>Ok(json!({"writeState":"outcome-unknown","reconciliationRequired":true,"executionAuthorized":false})),_=>Err("PRIVATE_DETAILS")}}).unwrap();
        let text=String::from_utf8(output).unwrap();let replies:Vec<Value>=text.lines().map(|line|serde_json::from_str(line).unwrap()).collect();assert_eq!(calls,3);assert!(replies[0].get("error").is_some());assert_eq!(replies[2]["result"]["isError"],false);assert_eq!(replies[3]["result"]["isError"],true);assert_eq!(replies[4]["result"]["isError"],true);assert!(!text.contains("PRIVATE_DETAILS"));assert!(text.contains("Do not assume no save occurred"));
    }
    #[test]fn read_tools_route_only_after_initialization_and_report_refusal_without_secrets(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let messages=[json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),json!({"jsonrpc":"2.0","method":"notifications/initialized"}),json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"planner_read_brief","arguments":{"offset":0,"expectedHeadDigest":null}}}),json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"planner_read_task","arguments":{"taskId":"T0001","offset":0,"expectedHeadDigest":"a".repeat(64)}}})];
        let input=messages.iter().map(|v|format!("{v}\n")).collect::<String>();let mut output=Vec::new();let mut calls=0;
        serve_with_reads(&mut std::io::Cursor::new(input),&mut output,||Ok(json!({"state":"reachable"})),|method,args|{calls+=1;if method=="client.readBrief"{assert_eq!(args["offset"],0);Ok(json!({"data":{"title":"Actual task"},"readError":null,"executionAuthorized":false}))}else{Err("PRIVATE_PATH_OR_SECRET")}}).unwrap();
        let text=String::from_utf8(output).unwrap();let replies:Vec<Value>=text.lines().map(|s|serde_json::from_str(s).unwrap()).collect();
        assert_eq!(calls,2);assert_eq!(replies[1]["result"]["tools"].as_array().unwrap().len(),6);assert!(replies[1]["result"]["tools"].as_array().unwrap().iter().any(|t|t["name"]=="planner_report_exchange"));assert_eq!(replies[2]["result"]["isError"],false);assert_eq!(replies[3]["result"]["isError"],true);assert!(!text.contains("PRIVATE_PATH_OR_SECRET"));
    }
    #[test]
    #[ignore="Requires explicit DANS1 helper executable and pinned broker fixture"]
    fn separate_helper_mcp_process_reports_real_paired_project(){
        helper_process_lifecycle(false);
    }
    #[test]
    #[ignore="Requires explicit DANS1 helper executable and pinned broker fixture"]
    fn separate_helper_reports_owner_stop_and_rejects_old_launch_config(){
        helper_process_lifecycle(true);
    }
    #[test]
    #[ignore="DANS1 isolated registered workspace fixture only"]
    fn prepare_packaged_plan_read_census(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let registry=std::path::Path::new(fixture["registry"].as_str().unwrap());
        let workspace=registry.parent().unwrap().join("sample-workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("app.js"),"export const qualification = true;\n").unwrap();
        let registration=crate::workspace_census::register_qualification_workspace(registry,serde_json::from_value(json!({"schemaVersion":1,"workspaceId":"fixture","rootPath":workspace,"explicitUserApproval":true})).unwrap()).unwrap();
        std::fs::write(registry.parent().unwrap().join("registration.json"),serde_json::to_vec(&registration).unwrap()).unwrap();
        let request=serde_json::from_value(json!({"schemaVersion":1,"workspaceId":"fixture","registryRevision":1,"maxFiles":100,"maxFileBytes":1000000})).unwrap();
        let receipt=crate::workspace_census::census_and_retain(std::path::Path::new(fixture["registry"].as_str().unwrap()),request).unwrap();
        assert!(serde_json::to_value(receipt).unwrap()["fileCount"].as_u64().unwrap()>0);
    }
    #[test]
    #[ignore="Requires DANS1 packaged helper, actual census and submitted plan fixture"]
    fn separate_helper_reads_actual_submitted_plan(){
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        assert!(fixture["hostConfiguration"].is_object());
        assert!(fixture["expectedTaskTitle"].is_string());
        helper_process_lifecycle(false);
    }
    #[test]
    #[ignore="Requires DANS1 rebuilt package and fresh registered proposal fixture"]
    fn separate_helper_proposes_reads_and_retries_actual_task(){
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        assert!(fixture["proposalInput"].is_object());
        helper_process_lifecycle(false);
    }
    #[test]
    #[ignore="Requires DANS1 actual packaged helper and exchange fixture"]
    fn separate_helper_records_retries_and_preserves_exchange(){
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        assert!(fixture["exchangeInput"].is_object());
        helper_process_lifecycle(false);
    }
    #[test]
    #[ignore="Requires DANS1 packaged helper and retained exchange fixture"]
    fn separate_read_only_helper_cannot_modify_retained_exchanges(){
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        assert!(fixture["refusedExchangeInput"].is_object());
        assert!(fixture.get("exchangeInput").is_none());assert!(fixture.get("proposalInput").is_none());
        helper_process_lifecycle(false);
    }
    fn helper_process_lifecycle(stop_owner:bool){
        use std::os::windows::process::CommandExt;
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let owners=crate::native_agent_registry::AgentBrokers::default();let key=fixture["binding"].to_string();
        let broker=owners.get_or_start(&key,std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap();
        if let Some(configuration)=fixture.get("hostConfiguration"){
            let opened=broker.lock().unwrap().request("owner.openPlanClient",json!({"binding":fixture["binding"],"hostConfiguration":configuration})).unwrap();
            assert_eq!(opened["ok"],true,"Private plan-host admission failed: {opened}");
            let closed=broker.lock().unwrap().request("owner.closeClient",json!({"channelId":opened["result"]["channelId"]})).unwrap();
            assert_eq!(closed["ok"],true);
        }
        let setup=if fixture.get("proposalInput").is_some()||fixture.get("exchangeInput").is_some(){
            crate::native_agent_setup::prepare_with_proposals(&owners,std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap()),fixture["binding"].clone(),fixture["hostConfiguration"].clone()).unwrap()
        }else{crate::native_agent_setup::prepare_with_plan(&owners,std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap()),fixture["binding"].clone(),fixture.get("hostConfiguration").cloned()).unwrap()};
        assert_eq!(setup["pairingState"],"waiting");assert_eq!(setup["executionAuthorized"],false);
        let server=&setup["mcpConfig"]["mcpServers"]["perfect-planner-agent"];
        let helper=PathBuf::from(server["command"].as_str().unwrap());
        let config_path=PathBuf::from(server["args"][1].as_str().unwrap());
        let published:Value=serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();assert!(published.get("secret").is_none());assert_eq!(published["binding"],fixture["binding"]);
        struct Cleanup(std::process::Child,PathBuf);
        impl Drop for Cleanup{fn drop(&mut self){let _=self.0.kill();let _=self.0.wait();let _=std::fs::remove_file(&self.1);}}
        let mut child=Cleanup(std::process::Command::new(&helper).arg("--connection-config").arg(&config_path)
            .creation_flags(0x08000000).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap(),config_path);
        let mut input=child.0.stdin.take().unwrap();let output=child.0.stdout.take().unwrap();
        let (tx,rx)=std::sync::mpsc::channel();
        let reader=std::thread::spawn(move||{let mut reader=std::io::BufReader::new(output);while let Ok(Some(bytes))=frame(&mut reader){if tx.send(bytes).is_err(){break;}}});
        let mut call=|id:u64,method:&str,params:Value|{
            writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).unwrap();input.flush().unwrap();
            let reply:Value=serde_json::from_slice(&rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap()).unwrap();assert_eq!(reply["id"],id);reply
        };
        let initialized=call(1,"initialize",json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"remote-native-fixture","version":"1"}}));
        assert_eq!(initialized["result"]["serverInfo"]["name"],"perfect-planner-agent");drop(call);
        writeln!(input,"{}",json!({"jsonrpc":"2.0","method":"notifications/initialized"})).unwrap();input.flush().unwrap();
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(10);let mut id=2;
        loop{
            writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":TOOL,"arguments":{}}})).unwrap();input.flush().unwrap();
            let reply:Value=serde_json::from_slice(&rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap()).unwrap();assert_eq!(reply["id"],id);
            let state=&reply["result"]["structuredContent"];
            assert!(state.get("secret").is_none());assert_eq!(state["workVerified"],false);
            if state["state"]=="reachable"{assert_eq!(state["binding"],fixture["binding"]);break;}
            assert_eq!(state["state"],"connecting");assert!(std::time::Instant::now()<deadline);id+=1;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if fixture.get("hostConfiguration").is_some(){
            if let Some(proposal)=fixture.get("proposalInput"){
                let mut submitted=None;
                for retry in [false,true]{
                    id+=1;
                    writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"planner_propose_task","arguments":proposal}})).unwrap();input.flush().unwrap();
                    let reply:Value=serde_json::from_slice(&rx.recv_timeout(std::time::Duration::from_secs(20)).unwrap()).unwrap();assert_eq!(reply["id"],id);
                    assert_eq!(reply["result"]["isError"],false,"Proposal failed: {reply}");
                    let payload:Value=serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
                    assert_eq!(payload["writeState"],"recorded-proposal");assert_eq!(payload["executionAuthorized"],false);assert_eq!(payload["receipt"]["idempotent"],retry);assert_eq!(payload["receipt"]["approvalState"],"unapproved-proposal");
                    if let Some(first)=submitted.as_ref(){assert_eq!(&payload["receipt"]["submitted"],first);}else{submitted=Some(payload["receipt"]["submitted"].clone());}
                }
            }
            let mut read_tool=|name:&str,arguments:Value|{
                id+=1;
                writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}})).unwrap();input.flush().unwrap();
                let reply:Value=serde_json::from_slice(&rx.recv_timeout(std::time::Duration::from_secs(20)).unwrap()).unwrap();assert_eq!(reply["id"],id);
                assert_eq!(reply["result"]["isError"],false,"{reply}");
                let payload:Value=serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
                assert_eq!(payload["executionAuthorized"],false);payload["data"].clone()
            };
            let brief=read_tool("planner_read_brief",json!({"offset":0,"expectedHeadDigest":null}));
            assert_eq!(brief["tasks"][0]["title"],fixture["expectedTaskTitle"]);
            if let Some(proposal)=fixture.get("proposalInput"){
                assert_eq!(brief["tasks"].as_array().unwrap().len(),2,"Retry must not duplicate the task");
                assert!(brief["tasks"].as_array().unwrap().iter().any(|task|task["title"]==proposal["task"]["title"]));
                let outcome=read_tool("planner_read_request_result",json!({"requestId":proposal["request"]["requestId"]}));
                assert_eq!(outcome["outcome"],"recorded-proposal");
            }
            let task=read_tool("planner_read_task",json!({"taskId":brief["tasks"][0]["id"],"offset":0,"expectedHeadDigest":brief["observedHead"]["headDigest"]}));
            assert!(task["chunk"].as_str().unwrap().contains(fixture["expectedTaskTitle"].as_str().unwrap()));
            let request=read_tool("planner_read_request_result",json!({"requestId":fixture.get("originalRequestId").and_then(Value::as_str).unwrap_or("qualification-324")}));
            assert_eq!(request["outcome"],"recorded-proposal");
        }
        if let Some(exchange)=fixture.get("exchangeInput"){
            let mut digest=None;
            for attempt in 0..3 {
                let mut arguments=exchange.clone();
                if attempt==2 {arguments["summary"]["response"]=json!("Conflicting replacement must not overwrite original");}
                id+=1;
                writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"planner_report_exchange","arguments":arguments}})).unwrap();input.flush().unwrap();
                let reply:Value=serde_json::from_slice(&rx.recv_timeout(std::time::Duration::from_secs(20)).unwrap()).unwrap();
                assert_eq!(reply["id"],id);assert_eq!(reply["result"]["isError"],attempt==2,"{reply}");
                if attempt<2 {
                    let payload=&reply["result"]["structuredContent"];
                    assert_eq!(payload["writeState"],"recorded-exchange");assert_eq!(payload["executionAuthorized"],false);
                    assert_eq!(payload["receipt"]["idempotent"],attempt==1);
                    assert_eq!(payload["receipt"]["verification"],"not-verified");
                    if let Some(first)=digest.as_ref(){assert_eq!(&payload["receipt"]["digest"],first);}else{digest=Some(payload["receipt"]["digest"].clone());}
                }
            }
            let saved=broker.lock().unwrap().request("owner.readExchanges",json!({"binding":fixture["binding"],"offset":0})).unwrap();
            assert_eq!(saved["ok"],true,"{saved}");let data=&saved["result"];
            assert_eq!(data["total"],1);assert_eq!(data["executionAuthorized"],false);
            assert_eq!(data["records"][0]["exchangeId"],exchange["exchangeId"]);
            assert_eq!(data["records"][0]["summary"],exchange["summary"]);
            assert_eq!(data["records"][0]["verification"],"not-verified");
            assert_eq!(data["records"][0]["digest"],digest.unwrap());
        }
        if let Some(exchange)=fixture.get("refusedExchangeInput"){
            let before=broker.lock().unwrap().request("owner.readExchanges",json!({"binding":fixture["binding"],"offset":0})).unwrap();
            assert_eq!(before["ok"],true);assert_eq!(before["result"]["total"],1);
            assert_eq!(before["result"]["records"][0]["summary"],exchange["summary"]);
            for replacement in [false,true]{
                let mut arguments=exchange.clone();
                if replacement {arguments["summary"]["response"]=json!("Read only replacement denied");}
                else {arguments["exchangeId"]=json!("read-only-new-record-denied-32");}
                id+=1;
                writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"planner_report_exchange","arguments":arguments}})).unwrap();input.flush().unwrap();
                let reply:Value=serde_json::from_slice(&rx.recv_timeout(std::time::Duration::from_secs(20)).unwrap()).unwrap();
                assert_eq!(reply["id"],id);assert_eq!(reply["result"]["isError"],true,"{reply}");
                assert!(reply["result"].get("structuredContent").is_none());
            }
            let after=broker.lock().unwrap().request("owner.readExchanges",json!({"binding":fixture["binding"],"offset":0})).unwrap();
            assert_eq!(after["ok"],true);assert_eq!(before["result"],after["result"],"Read-only reporting changed retained notes");
        }
        if stop_owner{
            owners.stop(&key).unwrap();
            let deadline=std::time::Instant::now()+std::time::Duration::from_secs(25);
            loop{
                id+=1;
                writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":TOOL,"arguments":{}}})).unwrap();input.flush().unwrap();
                let reply:Value=serde_json::from_slice(&rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap()).unwrap();assert_eq!(reply["id"],id);
                let state=&reply["result"]["structuredContent"];
                assert_eq!(state["binding"],fixture["binding"]);assert_eq!(state["workVerified"],false);assert_eq!(state["executionAuthorized"],false);assert!(state.get("secret").is_none());
                if state["state"]=="failed"{assert!(state["code"].is_string());break;}
                assert!(state["state"]=="reachable"||state["state"]=="stale");assert!(std::time::Instant::now()<deadline);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            // A retained launch file must not reconnect after the owner has revoked its endpoint.
            let mut retry=Cleanup(std::process::Command::new(&helper).arg("--connection-config").arg(&child.1)
                .creation_flags(0x08000000).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap(),PathBuf::new());
            let deadline=std::time::Instant::now()+std::time::Duration::from_secs(15);
            loop{if let Some(exit)=retry.0.try_wait().unwrap(){assert!(!exit.success());break;}assert!(std::time::Instant::now()<deadline);std::thread::sleep(std::time::Duration::from_millis(20));}
        }
        drop(input);
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(10);
        loop{if let Some(exit)=child.0.try_wait().unwrap(){assert!(exit.success());break;}assert!(std::time::Instant::now()<deadline);std::thread::sleep(std::time::Duration::from_millis(10));}
        reader.join().unwrap();
        if !stop_owner{assert_eq!(broker.lock().unwrap().request("owner.inspect",json!({"binding":fixture["binding"]})).unwrap()["result"],json!([]));}
        // Normal MCP EOF has already revoked the session before project stop.
        owners.stop(&key).unwrap();
        if let Some(exchange)=fixture.get("refusedExchangeInput"){
            let restarted=owners.get_or_start(&key,std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap();
            let saved=restarted.lock().unwrap().request("owner.readExchanges",json!({"binding":fixture["binding"],"offset":0})).unwrap();
            assert_eq!(saved["ok"],true);assert_eq!(saved["result"]["total"],1);
            assert_eq!(saved["result"]["records"][0]["summary"],exchange["summary"]);
            assert_eq!(saved["result"]["records"][0]["verification"],"not-verified");
            owners.stop(&key).unwrap();
        }
    }
    #[test]fn mcp_lifecycle_gates_tools_and_never_exposes_owner_methods(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let requests=[json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}),json!({"jsonrpc":"2.0","method":"notifications/initialized"}),json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":TOOL,"arguments":{}}}),json!({"jsonrpc":"2.0","id":5,"method":"owner.pair"})];
        let input=requests.iter().map(|v|format!("{v}\n")).collect::<String>();let mut output=Vec::new();
        serve(&mut std::io::Cursor::new(input),&mut output,||Ok(json!({"state":"connecting","workVerified":false}))).unwrap();
        let replies:Vec<Value>=output.split(|b|*b==b'\n').filter(|v|!v.is_empty()).map(|v|serde_json::from_slice(v).unwrap()).collect();
        assert_eq!(replies.len(),5);assert!(replies[0].get("error").is_some());assert_eq!(replies[1]["result"]["protocolVersion"],PROTOCOL);
        assert_eq!(replies[2]["result"]["tools"][0]["name"],TOOL);assert_eq!(replies[3]["result"]["structuredContent"]["state"],"connecting");assert!(replies[4].get("error").is_some());
        assert!(frame(&mut std::io::Cursor::new(vec![b'x';LIMIT+1])).is_err());
    }
}
