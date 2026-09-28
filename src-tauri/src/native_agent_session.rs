//! Private native session client. Credentials are never renderer/tool receipts.
use serde_json::{json,Value};
use std::time::{Duration,SystemTime,UNIX_EPOCH};
use crate::native_agent_pipe::AgentPipeClient;

fn exact(value:&Value,keys:&[&str])->bool{
    value.as_object().is_some_and(|map|map.len()==keys.len()&&keys.iter().all(|key|map.contains_key(*key)))
}
fn hex(value:&str,len:usize)->bool{value.len()==len&&value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn proposal_outcome(value:&Value,request_id:&str)->Result<Value,&'static str>{
    if !exact(value,&["observation","requestId","writeState","receipt","requestMayHaveCommitted","reconciliationRequired","sessionCurrent","executionAuthorized"])
        ||value["requestId"]!=request_id||value["requestMayHaveCommitted"]!=true||!value["sessionCurrent"].is_boolean()||value["executionAuthorized"]!=false{return Err("AGENT_PROPOSAL_REPLY_INVALID");}
    let r=&value["receipt"];
    if value["writeState"]=="outcome-unknown"{
        if !r.is_null()||value["reconciliationRequired"]!=true{return Err("AGENT_PROPOSAL_REPLY_INVALID");}
    }else if value["writeState"]=="recorded-proposal"{
        let s=&r["submitted"];let h=&r["observedHead"];
        let revision=|v:&Value|v.as_u64().filter(|n|*n>0&&*n<=9007199254740991);
        let submitted=revision(&s["hostRevision"]);let observed=revision(&h["hostRevision"]);
        if !exact(r,&["schemaVersion","submissionPersisted","idempotent","submitted","observedHead","submittedMatchesObservedHead","registrationCurrent","registrationLeaseHeld","approvalState","executionAuthorized"])
            ||r["schemaVersion"]!=1||r["submissionPersisted"]!=true||!r["idempotent"].is_boolean()||!r["registrationCurrent"].is_boolean()||r["registrationLeaseHeld"]!=false||r["approvalState"]!="unapproved-proposal"||r["executionAuthorized"]!=false
            ||!exact(s,&["hostRevision","headDigest","ledgerDigest"])||!exact(h,&["hostRevision","headDigest"])||submitted.is_none()||observed.is_none()||observed<submitted
            ||![&s["headDigest"],&s["ledgerDigest"],&h["headDigest"]].iter().all(|v|v.as_str().is_some_and(|s|hex(s,64)))
            ||(observed==submitted&&h["headDigest"]!=s["headDigest"])||r["submittedMatchesObservedHead"]!=json!(observed==submitted&&h["headDigest"]==s["headDigest"])||value["reconciliationRequired"]!=false{return Err("AGENT_PROPOSAL_REPLY_INVALID");}
    }else{return Err("AGENT_PROPOSAL_REPLY_INVALID");}
    Ok(json!({"requestId":request_id,"writeState":value["writeState"],"receipt":r,"requestMayHaveCommitted":true,"reconciliationRequired":value["reconciliationRequired"],"sessionCurrent":value["sessionCurrent"],"executionAuthorized":false}))
}
fn proposal_input(input:&Value,binding:&Value)->Result<String,&'static str>{
    if !exact(input,&["binding","request","task","updatedAt"])||!exact(&input["binding"],&["projectId","rootIdentity","censusDigest"])||input["binding"]["projectId"]!=binding["projectId"]||input["binding"]["rootIdentity"]!=binding["rootIdentity"]||!input["binding"]["censusDigest"].as_str().is_some_and(|s|hex(s,64))
        ||!exact(&input["request"],&["requestId","expectedRevision","expectedHeadDigest"])||!input["task"].is_object()||!input["updatedAt"].is_string()||serde_json::to_vec(input).map_err(|_|"AGENT_PROPOSAL_REQUEST_INVALID")?.len()>65536{return Err("AGENT_PROPOSAL_REQUEST_INVALID");}
    let r=&input["request"];let id=r["requestId"].as_str().filter(|s|!s.is_empty()&&s.len()<=128&&s.as_bytes()[0].is_ascii_alphanumeric()&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b"._:-".contains(&b))).ok_or("AGENT_PROPOSAL_REQUEST_INVALID")?;
    let revision=r["expectedRevision"].as_u64().filter(|n|*n<=9007199254740991).ok_or("AGENT_PROPOSAL_REQUEST_INVALID")?;
    if if revision==0{r["expectedHeadDigest"]!="GENESIS"}else{!r["expectedHeadDigest"].as_str().is_some_and(|s|hex(s,64))}{return Err("AGENT_PROPOSAL_REQUEST_INVALID");}
    Ok(id.to_owned())
}
fn now()->Result<u64,&'static str>{SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|"AGENT_CLIENT_CLOCK").map(|v|v.as_millis() as u64)}
fn observation(value:&Value,binding:&Value,id:&str,sequence:u64,kind:&str,previous:u64)->Result<Value,&'static str>{
    if !exact(value,&["schemaVersion","binding","sessionId","sequence","kind","observedAt","expiresAt"])
        ||value["schemaVersion"]!=1||value["binding"]!=*binding||value["sessionId"]!=id||value["sequence"]!=sequence||value["kind"]!=kind{
        return Err("AGENT_CLIENT_OBSERVATION_INVALID");
    }
    let observed=value["observedAt"].as_u64().ok_or("AGENT_CLIENT_OBSERVATION_INVALID")?;
    let expires=value["expiresAt"].as_u64().ok_or("AGENT_CLIENT_OBSERVATION_INVALID")?;
    let time=now()?;
    if observed<previous||observed>time||expires<=time||expires.checked_sub(observed)!=Some(30000){return Err("AGENT_CLIENT_OBSERVATION_EXPIRED");}
    // This is reachability at observation time, never task completion or authority.
    Ok(json!({"sessionId":id,"sequence":sequence,"observedAt":observed,"expiresAt":expires,"binding":binding,"workVerified":false,"executionAuthorized":false}))
}
fn exchange(client:&AgentPipeClient,id:u64,method:&str,params:Value)->Result<Value,&'static str>{
    let frame=serde_json::to_vec(&json!({"version":1,"id":id,"method":method,"params":params})).map_err(|_|"AGENT_CLIENT_FRAME_INVALID")?;
    let bytes=client.request(&frame,Duration::from_secs(12))?;
    let outer:Value=serde_json::from_slice(&bytes).map_err(|_|"AGENT_CLIENT_REPLY_INVALID")?;
    if !exact(&outer,&["version","id","ok","result"])||outer["version"]!=1||outer["ok"]!=true||outer["id"].as_u64().filter(|id|*id>0).is_none(){return Err("AGENT_CLIENT_REQUEST_REFUSED");}
    let inner=&outer["result"];
    if !exact(inner,&["version","id","ok","result"])||inner["version"]!=1||inner["id"]!=id||inner["ok"]!=true{return Err("AGENT_CLIENT_REQUEST_REFUSED");}
    Ok(inner["result"].clone())
}
pub(crate) struct NativeAgentSession{
    client:Option<AgentPipeClient>,binding:Value,session_id:String,secret:String,sequence:u64,last_observed:u64,plan_read:bool,proposal_write:bool,
}
impl NativeAgentSession{
    /// Secrets arrive on the authenticated private pipe, never command-line
    /// arguments, renderer events, or MCP tool output. Binding is independently
    /// selected by the caller; bootstrap cannot silently select another project.
    pub(crate) fn pair_from_owner(client:AgentPipeClient,binding:Value)->Result<(Self,Value),&'static str>{
        let bytes=client.receive_private(Duration::from_secs(12))?;
        let value:Value=serde_json::from_slice(&bytes).map_err(|_|"AGENT_CLIENT_PAIRING_INVALID")?;
        let (id,secret)=bootstrap(&value,&binding)?;
        let(mut session,mut receipt)=Self::pair(client,binding,id,secret)?;
        session.plan_read=value["planReadEnabled"]==true;
        session.proposal_write=value["proposalWriteEnabled"]==true;
        receipt["planReadEnabled"]=json!(session.plan_read);
        receipt["proposalWriteEnabled"]=json!(session.proposal_write);
        Ok((session,receipt))
    }
    pub(crate) fn pair(client:AgentPipeClient,binding:Value,pairing_id:String,secret:String)->Result<(Self,Value),&'static str>{
        if !hex(&pairing_id,32)||!hex(&secret,64){return Err("AGENT_CLIENT_PAIRING_INVALID");}
        let result=exchange(&client,1,"client.connect",json!({"pairingId":pairing_id,"secret":secret}))?;
        if !exact(&result,&["sessionId","secret","observation"]){return Err("AGENT_CLIENT_REPLY_INVALID");}
        let id=result["sessionId"].as_str().filter(|v|hex(v,32)).ok_or("AGENT_CLIENT_REPLY_INVALID")?;
        let credential=result["secret"].as_str().filter(|v|hex(v,64)).ok_or("AGENT_CLIENT_REPLY_INVALID")?;
        let receipt=observation(&result["observation"],&binding,id,1,"open",0)?;
        let session=Self{client:Some(client),binding,session_id:id.to_owned(),secret:credential.to_owned(),sequence:1,last_observed:receipt["observedAt"].as_u64().unwrap(),plan_read:false,proposal_write:false};
        Ok((session,receipt))
    }
    pub(crate) fn heartbeat(&mut self)->Result<Value,&'static str>{
        let result=(||{
            let client=self.client.as_ref().ok_or("AGENT_CLIENT_CLOSED")?;
            let next=self.sequence.checked_add(1).filter(|v|*v<=9007199254740991).ok_or("AGENT_CLIENT_SEQUENCE_LIMIT")?;
            let result=exchange(client,next,"client.heartbeat",json!({"sessionId":self.session_id,"secret":self.secret,"expectedSequence":self.sequence}))?;
            let receipt=observation(&result,&self.binding,&self.session_id,next,"heartbeat",self.last_observed)?;
            self.sequence=next;self.last_observed=receipt["observedAt"].as_u64().unwrap();Ok(receipt)
        })();
        if result.is_err(){self.client.take();self.secret.clear();}
        result
    }
    fn disconnect(&mut self)->Result<(),&'static str>{
        let result=(||{
            let client=self.client.as_ref().ok_or("AGENT_CLIENT_CLOSED")?;
            let next=self.sequence.checked_add(1).ok_or("AGENT_CLIENT_SEQUENCE_LIMIT")?;
            let reply=exchange(client,next,"client.disconnect",json!({}))?;
            if reply!=json!({"closed":true}){return Err("AGENT_CLIENT_DISCONNECT_UNCONFIRMED");}
            Ok(())
        })();
        self.client.take();self.secret.clear();result
    }
    fn read_plan(&mut self,method:&str,input:Value)->Result<(Value,Value),&'static str>{
        if !self.plan_read||!matches!(method,"client.readBrief"|"client.readTask"|"client.readRequestResult"){return Err("AGENT_PLAN_READ_NOT_ALLOWED");}
        let result=(||{
            let client=self.client.as_ref().ok_or("AGENT_CLIENT_CLOSED")?;
            let next=self.sequence.checked_add(1).filter(|v|*v<=9007199254740991).ok_or("AGENT_CLIENT_SEQUENCE_LIMIT")?;
            let value=exchange(client,next,method,json!({"sessionId":self.session_id,"secret":self.secret,"expectedSequence":self.sequence,"input":input}))?;
            let failed=value.get("readError").is_some();
            if !(if failed{exact(&value,&["observation","data","executionAuthorized","readError"])}else{exact(&value,&["observation","data","executionAuthorized"])})||value["executionAuthorized"]!=false{return Err("AGENT_PLAN_REPLY_INVALID");}
            let receipt=observation(&value["observation"],&self.binding,&self.session_id,next,"heartbeat",self.last_observed)?;
            if failed{
                if value["readError"]!="AGENT_LEDGER_READ_REFUSED"||!value["data"].is_null(){return Err("AGENT_PLAN_REPLY_INVALID");}
            }else{
                let data=&value["data"];
                if data["binding"]["projectId"]!=self.binding["projectId"]||data["binding"]["rootIdentity"]!=self.binding["rootIdentity"]||!data["binding"]["censusDigest"].as_str().is_some_and(|v|hex(v,64))||data["executionAuthorized"]!=false||data["approvalState"]!="unapproved-proposal"||serde_json::to_vec(data).map_err(|_|"AGENT_PLAN_REPLY_INVALID")?.len()>20000{return Err("AGENT_PLAN_REPLY_INVALID");}
            }
            self.sequence=next;self.last_observed=receipt["observedAt"].as_u64().unwrap();
            Ok((receipt,json!({"data":value["data"],"readError":value.get("readError"),"executionAuthorized":false})))
        })();
        if result.is_err(){self.client.take();self.secret.clear();}
        result
    }
    fn propose_task(&mut self,input:Value)->Result<(Value,Value),&'static str>{
        if !self.proposal_write{return Err("AGENT_PROPOSAL_WRITE_NOT_ALLOWED");}
        let request_id=proposal_input(&input,&self.binding)?;
        let result=(||{
            let client=self.client.as_ref().ok_or("AGENT_CLIENT_CLOSED")?;
            let next=self.sequence.checked_add(1).filter(|v|*v<=9007199254740991).ok_or("AGENT_CLIENT_SEQUENCE_LIMIT")?;
            let value=exchange(client,next,"client.proposeTask",json!({"sessionId":self.session_id,"secret":self.secret,"expectedSequence":self.sequence,"input":input}))?;
            let data=proposal_outcome(&value,&request_id)?;
            let receipt=observation(&value["observation"],&self.binding,&self.session_id,next,"heartbeat",self.last_observed)?;
            self.sequence=next;self.last_observed=receipt["observedAt"].as_u64().unwrap();Ok((receipt,data))
        })();
        if result.is_err(){self.client.take();self.secret.clear();}
        result
    }
    fn report_exchange(&mut self,input:Value)->Result<(Value,Value),&'static str>{
        if !self.proposal_write{return Err("AGENT_EXCHANGE_WRITE_NOT_ALLOWED");}
        if !exact(&input,&["binding","exchangeId","summary"])||input["binding"]!=self.binding||!input["exchangeId"].is_string()||serde_json::to_vec(&input).map_err(|_|"AGENT_EXCHANGE_INVALID")?.len()>12000{return Err("AGENT_EXCHANGE_INVALID");}
        let result=(||{
            let next=self.sequence.checked_add(1).ok_or("AGENT_CLIENT_SEQUENCE_LIMIT")?;
            let value=exchange(self.client.as_ref().ok_or("AGENT_CLIENT_CLOSED")?,next,"client.reportExchange",json!({"sessionId":self.session_id,"secret":self.secret,"expectedSequence":self.sequence,"input":input}))?;
            if !exact(&value,&["observation","exchangeId","receipt","writeState","sessionCurrent","executionAuthorized"])||value["exchangeId"]!=input["exchangeId"]||value["executionAuthorized"]!=false||!value["sessionCurrent"].is_boolean(){return Err("AGENT_EXCHANGE_REPLY_INVALID");}
            if value["writeState"]=="recorded-exchange"{
                let r=&value["receipt"];
                if r["binding"]!=self.binding||r["sessionId"]!=self.session_id||r["exchangeId"]!=input["exchangeId"]||r["origin"]!="authenticated-agent-report"||r["verification"]!="not-verified"||!r["idempotent"].is_boolean()||!r["digest"].as_str().is_some_and(|s|hex(s,64)){return Err("AGENT_EXCHANGE_REPLY_INVALID");}
            }else if value["writeState"]!="outcome-unknown"||!value["receipt"].is_null(){return Err("AGENT_EXCHANGE_REPLY_INVALID");}
            let receipt=observation(&value["observation"],&self.binding,&self.session_id,next,"heartbeat",self.last_observed)?;
            self.sequence=next;self.last_observed=receipt["observedAt"].as_u64().unwrap();
            Ok((receipt,json!({"exchangeId":value["exchangeId"],"receipt":value["receipt"],"writeState":value["writeState"],"sessionCurrent":value["sessionCurrent"],"executionAuthorized":false})))
        })();
        if result.is_err(){self.client.take();self.secret.clear();}result
    }
}
fn bootstrap(value:&Value,binding:&Value)->Result<(String,String),&'static str>{
    let scoped=exact(value,&["schemaVersion","binding","pairingId","secret","expiresAt","planReadEnabled"])&&value["planReadEnabled"]==true;
    let proposal=exact(value,&["schemaVersion","binding","pairingId","secret","expiresAt","planReadEnabled","proposalWriteEnabled"])&&value["planReadEnabled"]==true&&value["proposalWriteEnabled"]==true;
    if !(proposal||scoped||exact(value,&["schemaVersion","binding","pairingId","secret","expiresAt"]))
        ||value["schemaVersion"]!=1||value["binding"]!=*binding{
        return Err("AGENT_CLIENT_PAIRING_INVALID");
    }
    let id=value["pairingId"].as_str().filter(|v|hex(v,32)).ok_or("AGENT_CLIENT_PAIRING_INVALID")?;
    let secret=value["secret"].as_str().filter(|v|hex(v,64)).ok_or("AGENT_CLIENT_PAIRING_INVALID")?;
    let expires=value["expiresAt"].as_u64().ok_or("AGENT_CLIENT_PAIRING_INVALID")?;
    let time=now()?;
    if expires<=time||expires-time>60000{return Err("AGENT_CLIENT_PAIRING_EXPIRED");}
    Ok((id.to_owned(),secret.to_owned()))
}

/// Helper-owned connection maintenance. No LLM/tool call is needed to heartbeat.
/// Snapshot is reachability only and must never authorize task execution.
enum ConnectionRequest{Stop,Read{method:String,input:Value,reply:std::sync::mpsc::SyncSender<Result<Value,&'static str>>},Propose{input:Value,reply:std::sync::mpsc::SyncSender<Result<Value,&'static str>>},Report{input:Value,reply:std::sync::mpsc::SyncSender<Result<Value,&'static str>>}}
pub(crate) struct NativeAgentConnection{
    stop:Option<crate::native_agent_pipe::AgentPipeStop>,
    signal:Option<std::sync::mpsc::SyncSender<ConnectionRequest>>,
    worker:Option<std::thread::JoinHandle<()>>,
    state:std::sync::Arc<(std::sync::Mutex<Value>,std::sync::Condvar)>,
}
impl NativeAgentConnection{
    pub(crate) fn start(client:AgentPipeClient,binding:Value)->Result<Self,&'static str>{
        use std::sync::{Arc,Mutex,Condvar,mpsc};
        let stop=client.stop_handle();let (signal,receive)=mpsc::sync_channel(4);
        let state=Arc::new((Mutex::new(json!({"state":"connecting","binding":binding,"workVerified":false,"executionAuthorized":false})),Condvar::new()));
        let shared=Arc::clone(&state);
        let worker=std::thread::Builder::new().name("planner-agent-heartbeat".into()).spawn(move||{
            let publish=|value:Value|{if let Ok(mut current)=shared.0.lock(){*current=value;shared.1.notify_all();}};
            let result:Result<(),&'static str>=(||{
                let (mut session,mut receipt)=NativeAgentSession::pair_from_owner(client,binding.clone())?;
                loop{
                    receipt["state"]=json!("reachable");receipt["planReadEnabled"]=json!(session.plan_read);receipt["proposalWriteEnabled"]=json!(session.proposal_write);publish(receipt.clone());
                    match receive.recv_timeout(Duration::from_secs(10)){
                        Ok(ConnectionRequest::Stop)|Err(mpsc::RecvTimeoutError::Disconnected)=>return session.disconnect(),
                        Err(mpsc::RecvTimeoutError::Timeout)=>receipt=session.heartbeat()?,
                        Ok(ConnectionRequest::Read{method,input,reply})=>match session.read_plan(&method,input){
                            Ok((observed,data))=>{receipt=observed;let _=reply.send(Ok(data));},
                            Err(code)=>{let _=reply.send(Err(code));return Err(code);},
                        },
                        Ok(ConnectionRequest::Propose{input,reply})=>match session.propose_task(input){
                            Ok((observed,data))=>{let current=data["sessionCurrent"]==true;receipt=observed;let _=reply.send(Ok(data));if !current{return Err("AGENT_PROPOSAL_SESSION_CHANGED");}},
                            Err(code)=>{let _=reply.send(Err(code));return Err(code);},
                        },
                        Ok(ConnectionRequest::Report{input,reply})=>match session.report_exchange(input){
                            Ok((observed,data))=>{let current=data["sessionCurrent"]==true;receipt=observed;let _=reply.send(Ok(data));if !current{return Err("AGENT_EXCHANGE_SESSION_CHANGED");}},
                            Err(code)=>{let _=reply.send(Err(code));return Err(code);},
                        },
                    }
                }
            })();
            let value=match result{
                Ok(())=>json!({"state":"closed","binding":binding,"workVerified":false,"executionAuthorized":false}),
                Err(code)=>json!({"state":"failed","code":code,"binding":binding,"workVerified":false,"executionAuthorized":false}),
            };
            publish(value);
        }).map_err(|_|"AGENT_CLIENT_WORKER_START_FAILED")?;
        Ok(Self{stop:Some(stop),signal:Some(signal),worker:Some(worker),state})
    }
    pub(crate) fn snapshot(&self)->Result<Value,&'static str>{
        let mut value=self.state.0.lock().map_err(|_|"AGENT_CLIENT_STATE_UNAVAILABLE")?.clone();
        if value["state"]=="reachable"{
            let time=now()?;
            if value["expiresAt"].as_u64().map_or(true,|v|v<=time)||value["observedAt"].as_u64().map_or(true,|v|v>time){value["state"]=json!("stale");}
        }
        Ok(value)
    }
    pub(crate) fn stop(&mut self)->Result<(),&'static str>{
        if let Some(signal)=self.signal.take(){let _=signal.send(ConnectionRequest::Stop);}
        if let Some(worker)=self.worker.take(){worker.join().map_err(|_|"AGENT_CLIENT_WORKER_PANICKED")?;}
        if let Some(stop)=self.stop.take(){stop.stop();}
        // Preserve a failure already observed; stopping must not erase it.
        Ok(())
    }
    pub(crate) fn read_plan(&self,method:&str,input:Value)->Result<Value,&'static str>{
        let state=self.snapshot()?;
        if state["state"]!="reachable"||state["planReadEnabled"]!=true||!matches!(method,"client.readBrief"|"client.readTask"|"client.readRequestResult"){return Err("AGENT_PLAN_READ_NOT_ALLOWED");}
        if serde_json::to_vec(&input).map_err(|_|"AGENT_PLAN_REQUEST_INVALID")?.len()>4096{return Err("AGENT_PLAN_REQUEST_INVALID");}
        let(tx,rx)=std::sync::mpsc::sync_channel(1);
        self.signal.as_ref().ok_or("AGENT_CLIENT_CLOSED")?.try_send(ConnectionRequest::Read{method:method.into(),input,reply:tx}).map_err(|_|"AGENT_PLAN_READ_BUSY")?;
        rx.recv_timeout(Duration::from_secs(15)).map_err(|_|"AGENT_PLAN_READ_UNAVAILABLE")?
    }
    pub(crate) fn propose_task(&self,input:Value)->Result<Value,&'static str>{
        let state=self.snapshot()?;
        if state["state"]!="reachable"||state["proposalWriteEnabled"]!=true{return Err("AGENT_PROPOSAL_WRITE_NOT_ALLOWED");}
        proposal_input(&input,&state["binding"])?;
        let(tx,rx)=std::sync::mpsc::sync_channel(1);
        self.signal.as_ref().ok_or("AGENT_CLIENT_CLOSED")?.try_send(ConnectionRequest::Propose{input,reply:tx}).map_err(|_|"AGENT_PROPOSAL_WRITE_BUSY")?;
        // A timeout cannot prove that the native Ledger was not changed.
        rx.recv_timeout(Duration::from_secs(15)).map_err(|_|"AGENT_PROPOSAL_OUTCOME_UNKNOWN")?
    }
    pub(crate) fn report_exchange(&self,input:Value)->Result<Value,&'static str>{
        let state=self.snapshot()?;
        if state["state"]!="reachable"||state["proposalWriteEnabled"]!=true{return Err("AGENT_EXCHANGE_WRITE_NOT_ALLOWED");}
        if input["binding"]!=state["binding"]||serde_json::to_vec(&input).map_err(|_|"AGENT_EXCHANGE_INVALID")?.len()>12000{return Err("AGENT_EXCHANGE_INVALID");}
        let(tx,rx)=std::sync::mpsc::sync_channel(1);
        self.signal.as_ref().ok_or("AGENT_CLIENT_CLOSED")?.try_send(ConnectionRequest::Report{input,reply:tx}).map_err(|_|"AGENT_EXCHANGE_BUSY")?;
        rx.recv_timeout(Duration::from_secs(15)).map_err(|_|"AGENT_EXCHANGE_OUTCOME_UNKNOWN")?
    }
}
impl Drop for NativeAgentConnection{fn drop(&mut self){let _=self.stop();}}
#[cfg(test)]mod tests{
    use super::*;
    fn write_fixture(observation:Value)->Value{json!({"observation":observation,"requestId":"original-1","writeState":"recorded-proposal","receipt":{"schemaVersion":1,"submissionPersisted":true,"idempotent":false,"submitted":{"hostRevision":1,"headDigest":"a".repeat(64),"ledgerDigest":"b".repeat(64)},"observedHead":{"hostRevision":1,"headDigest":"a".repeat(64)},"submittedMatchesObservedHead":true,"registrationCurrent":true,"registrationLeaseHeld":false,"approvalState":"unapproved-proposal","executionAuthorized":false},"requestMayHaveCommitted":true,"reconciliationRequired":false,"sessionCurrent":true,"executionAuthorized":false})}
    #[test]fn proposal_receipts_refuse_invented_success_and_preserve_unknown_outcomes(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let good=write_fixture(Value::Null);assert_eq!(proposal_outcome(&good,"original-1").unwrap()["writeState"],"recorded-proposal");
        for (key,value)in [("requestId",json!("other")),("writeState",json!("complete")),("requestMayHaveCommitted",json!(false)),("reconciliationRequired",json!(true)),("executionAuthorized",json!(true)),("secret",json!("PRIVATE"))]{let mut bad=good.clone();bad[key]=value;assert!(proposal_outcome(&bad,"original-1").is_err());}
        for (key,value)in [("executionAuthorized",json!(true)),("registrationLeaseHeld",json!(true)),("approvalState",json!("approved")),("submissionPersisted",json!(false)),("submittedMatchesObservedHead",json!(false)),("secret",json!("PRIVATE"))]{let mut bad=good.clone();bad["receipt"][key]=value;assert!(proposal_outcome(&bad,"original-1").is_err());}
        let mut fork=good.clone();fork["receipt"]["observedHead"]["headDigest"]=json!("c".repeat(64));assert!(proposal_outcome(&fork,"original-1").is_err());
        let mut unknown=good.clone();unknown["writeState"]=json!("outcome-unknown");unknown["receipt"]=Value::Null;unknown["reconciliationRequired"]=json!(true);assert_eq!(proposal_outcome(&unknown,"original-1").unwrap()["reconciliationRequired"],true);
        unknown["receipt"]=good["receipt"].clone();assert!(proposal_outcome(&unknown,"original-1").is_err());
    }
    #[test]fn actual_helper_queue_handles_large_proposal_unknown_then_recorded_with_serial_sequence(){
        use crate::native_agent_pipe::AgentPipe;use sha2::{Digest,Sha256};
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let endpoint=crate::native_agent_pipe::random_endpoint().unwrap();let pipe=AgentPipe::create(&endpoint).unwrap();let exe=std::env::current_exe().unwrap();let pin=format!("{:x}",Sha256::digest(std::fs::read(&exe).unwrap()));
        let client=AgentPipeClient::connect_pinned(&endpoint,&exe,&pin).unwrap();pipe.accept(Duration::from_secs(3)).unwrap();
        let binding=json!({"projectId":"pp_write","workspaceId":"writer","registryRevision":1,"rootIdentity":"a".repeat(64)});let server_binding=binding.clone();
        let owner=std::thread::spawn(move||{
            pipe.write_frame(&serde_json::to_vec(&json!({"schemaVersion":1,"binding":server_binding,"pairingId":"b".repeat(32),"secret":"c".repeat(64),"expiresAt":now().unwrap()+30000,"planReadEnabled":true,"proposalWriteEnabled":true})).unwrap(),Duration::from_secs(3)).unwrap();
            for id in 1..=4u64{
                let bytes=pipe.read_frame(Duration::from_secs(5)).unwrap();let request:Value=serde_json::from_slice(&bytes).unwrap();assert_eq!(request["id"],id);let time=now().unwrap();let observed=json!({"schemaVersion":1,"binding":server_binding,"sessionId":"d".repeat(32),"sequence":id,"kind":if id==1{"open"}else{"heartbeat"},"observedAt":time,"expiresAt":time+30000});
                let result=if id==1{json!({"sessionId":"d".repeat(32),"secret":"e".repeat(64),"observation":observed})}else if id==4{assert_eq!(request["method"],"client.disconnect");json!({"closed":true})}else{
                    assert!(bytes.len()>16384);assert_eq!(request["method"],"client.proposeTask");assert_eq!(request["params"]["expectedSequence"],id-1);assert_eq!(request["params"]["input"]["request"]["requestId"],"original-1");
                    let mut value=write_fixture(observed);if id==2{value["writeState"]=json!("outcome-unknown");value["receipt"]=Value::Null;value["reconciliationRequired"]=json!(true);}value
                };
                pipe.write_frame(&serde_json::to_vec(&json!({"version":1,"id":id,"ok":true,"result":{"version":1,"id":id,"ok":true,"result":result}})).unwrap(),Duration::from_secs(3)).unwrap();
            }
        });
        let mut connection=NativeAgentConnection::start(client,binding.clone()).unwrap();wait_state(&connection,|v|v["state"]=="reachable");
        let input=json!({"binding":{"projectId":binding["projectId"],"rootIdentity":binding["rootIdentity"],"censusDigest":"f".repeat(64)},"request":{"requestId":"original-1","expectedRevision":0,"expectedHeadDigest":"GENESIS"},"task":{"title":"Large scoped task","description":"x".repeat(7000),"acceptance":"y".repeat(7000),"recovery":"z".repeat(7000),"owner":"Display only","claims":[],"dependsOn":[],"archived":false},"updatedAt":"2026-09-14T00:00:00.000Z"});
        let mut foreign=input.clone();foreign["binding"]["projectId"]=json!("foreign");assert!(connection.propose_task(foreign).is_err());
        let first=connection.propose_task(input.clone()).unwrap();assert_eq!(first["writeState"],"outcome-unknown");
        let second=connection.propose_task(input).unwrap();assert_eq!(second["writeState"],"recorded-proposal");assert!(!second.to_string().contains(&"e".repeat(64)));connection.stop().unwrap();owner.join().unwrap();
    }
    #[test]fn helper_queue_retains_sequence_after_read_refusal(){
        use crate::native_agent_pipe::AgentPipe;
        use sha2::{Digest,Sha256};
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let endpoint=crate::native_agent_pipe::random_endpoint().unwrap();let pipe=AgentPipe::create(&endpoint).unwrap();
        let exe=std::env::current_exe().unwrap();let pin=format!("{:x}",Sha256::digest(std::fs::read(&exe).unwrap()));
        let client=AgentPipeClient::connect_pinned(&endpoint,&exe,&pin).unwrap();pipe.accept(Duration::from_secs(3)).unwrap();
        let binding=json!({"projectId":"pp_queue","workspaceId":"queue","registryRevision":1,"rootIdentity":"a".repeat(64)});
        let server_binding=binding.clone();
        // Actual native pipe and helper actor, with a test-only owner responder.
        // Does not claim installed-host/journal integration.
        let owner=std::thread::spawn(move||{
            pipe.write_frame(&serde_json::to_vec(&json!({"schemaVersion":1,"binding":server_binding,"pairingId":"b".repeat(32),"secret":"c".repeat(64),"expiresAt":now().unwrap()+30000,"planReadEnabled":true})).unwrap(),Duration::from_secs(3)).unwrap();
            for id in 1..=4u64{
                let request:Value=serde_json::from_slice(&pipe.read_frame(Duration::from_secs(5)).unwrap()).unwrap();assert_eq!(request["id"],id);
                let time=now().unwrap();let observed=json!({"schemaVersion":1,"binding":server_binding,"sessionId":"d".repeat(32),"sequence":id,"kind":if id==1{"open"}else{"heartbeat"},"observedAt":time,"expiresAt":time+30000});
                let result=if id==1{assert_eq!(request["method"],"client.connect");json!({"sessionId":"d".repeat(32),"secret":"e".repeat(64),"observation":observed})}
                else if id==4{assert_eq!(request["method"],"client.disconnect");json!({"closed":true})}
                else{
                    assert_eq!(request["method"],"client.readBrief");assert_eq!(request["params"]["expectedSequence"],id-1);
                    if id==2{json!({"observation":observed,"data":null,"readError":"AGENT_LEDGER_READ_REFUSED","executionAuthorized":false})}
                    else{json!({"observation":observed,"data":{"binding":{"projectId":"pp_queue","rootIdentity":"a".repeat(64),"censusDigest":"f".repeat(64)},"approvalState":"unapproved-proposal","executionAuthorized":false},"executionAuthorized":false})}
                };
                let reply=json!({"version":1,"id":id,"ok":true,"result":{"version":1,"id":id,"ok":true,"result":result}});
                pipe.write_frame(&serde_json::to_vec(&reply).unwrap(),Duration::from_secs(3)).unwrap();
            }
        });
        let mut connection=NativeAgentConnection::start(client,binding).unwrap();
        wait_state(&connection,|v|v["state"]=="reachable");
        assert!(connection.read_plan("owner.pair",json!({})).is_err());
        let first=connection.read_plan("client.readBrief",json!({"offset":0,"expectedHeadDigest":null})).unwrap();assert_eq!(first["readError"],"AGENT_LEDGER_READ_REFUSED");
        let second=connection.read_plan("client.readBrief",json!({"offset":0,"expectedHeadDigest":null})).unwrap();assert!(second["readError"].is_null());
        connection.stop().unwrap();owner.join().unwrap();assert_eq!(connection.snapshot().unwrap()["state"],"closed");
    }
    fn wait_state(connection:&NativeAgentConnection, predicate:impl Fn(&Value)->bool){
        let state=connection.state.0.lock().unwrap();
        let (state,timed)=connection.state.1.wait_timeout_while(state,Duration::from_secs(25),|v|!predicate(v)).unwrap();
        assert!(!timed.timed_out(),"connection predicate timed out: {}",state["state"]);
        assert!(predicate(&state));
    }
    #[test]
    #[ignore="Requires explicit DANS1 pinned broker fixture"]
    fn helper_heartbeats_without_tool_calls_and_detects_project_stop(){
        use crate::native_agent_pipe::{AgentPipe,PipePeer};
        use sha2::{Sha256,Digest};
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let owners=crate::native_agent_registry::AgentBrokers::default();let key=fixture["binding"].to_string();
        let broker=owners.get_or_start(&key,std::path::Path::new(fixture["resources"].as_str().unwrap()),std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap();
        // Endpoint is unique within this process/campaign; no user project data.
        let endpoint=format!("{:064x}",std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
        let pipe=AgentPipe::create(&endpoint).unwrap();let exe=std::env::current_exe().unwrap();
        let pin=format!("{:x}",Sha256::digest(std::fs::read(&exe).unwrap()));
        let client=AgentPipeClient::connect_pinned(&endpoint,&exe,&pin).unwrap();
        pipe.accept(Duration::from_secs(3)).unwrap();
        let peer=PipePeer::from_pipe_client(&pipe,&exe,&pin).unwrap();
        owners.attach_pairing(fixture["binding"].clone(),&broker,pipe,peer).unwrap();
        let mut connection=NativeAgentConnection::start(client,fixture["binding"].clone()).unwrap();
        wait_state(&connection,|v|v["sequence"].as_u64().unwrap_or(0)>=2);
        let view=connection.snapshot().unwrap();assert_eq!(view["state"],"reachable");assert_eq!(view["workVerified"],false);assert!(view.get("secret").is_none());
        owners.stop(&key).unwrap();
        wait_state(&connection,|v|v["state"]=="failed");
        let failed=connection.snapshot().unwrap();connection.stop().unwrap();connection.stop().unwrap();
        assert_eq!(connection.snapshot().unwrap(),failed);
    }
    #[test]fn private_bootstrap_rejects_foreign_expired_and_authority_fields(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let binding=json!({"projectId":"test"});
        let good=json!({"schemaVersion":1,"binding":binding,"pairingId":"a".repeat(32),"secret":"b".repeat(64),"expiresAt":now().unwrap()+30000});
        assert!(bootstrap(&good,&binding).is_ok());
        let mut scoped=good.clone();scoped["planReadEnabled"]=json!(true);assert!(bootstrap(&scoped,&binding).is_ok());
        let mut proposal=scoped.clone();proposal["proposalWriteEnabled"]=json!(true);assert!(bootstrap(&proposal,&binding).is_ok());
        for bad in [json!(false),json!("true"),json!(1),Value::Null]{let mut invalid=proposal.clone();invalid["proposalWriteEnabled"]=bad;assert!(bootstrap(&invalid,&binding).is_err());}
        let mut no_read=good.clone();no_read["proposalWriteEnabled"]=json!(true);assert!(bootstrap(&no_read,&binding).is_err());
        let mut authority=proposal.clone();authority["executionAuthorized"]=json!(true);assert!(bootstrap(&authority,&binding).is_err());
        scoped["planReadEnabled"]=json!("true");assert!(bootstrap(&scoped,&binding).is_err());
        for (field,value) in [("binding",json!({"projectId":"foreign"})),("expiresAt",json!(0)),("expiresAt",json!(u64::MAX)),("secret",json!("bad")),("executionAuthorized",json!(true))]{
            let mut bad=good.clone();bad[field]=value;assert!(bootstrap(&bad,&binding).is_err());
        }
    }
    #[test]fn receipts_reject_foreign_replayed_or_authority_bearing_observations(){
        assert_eq!(std::env::var("COMPUTERNAME").unwrap().to_lowercase(),"dans1");
        let binding=json!({"projectId":"test"});let id="a".repeat(32);let time=now().unwrap();
        let good=json!({"schemaVersion":1,"binding":binding,"sessionId":id,"sequence":2,"kind":"heartbeat","observedAt":time,"expiresAt":time+30000});
        let receipt=observation(&good,&binding,&id,2,"heartbeat",time).unwrap();assert!(receipt.get("secret").is_none());
        for field in ["binding","sequence","executionAuthorized"]{
            let mut bad=good.clone();bad[field]=json!(true);
            assert!(observation(&bad,&binding,&id,2,"heartbeat",time).is_err());
        }
    }
}
