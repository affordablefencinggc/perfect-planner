//! Private persistent child supervisor. No Tauri command exposes owner credentials.
use serde_json::{json,Value};
use std::io::{Read,Write};
use std::path::Path;
use std::process::{Child,ChildStdin,Command,Stdio};
use std::sync::mpsc::{self,Receiver};
use std::thread::{self,JoinHandle};
use std::time::Duration;

pub(crate) struct AgentBroker {
    child:Child,input:Option<ChildStdin>,output:Option<Receiver<Result<Vec<u8>,()>>>,
    reader:Option<JoinHandle<()>>,sequence:u64,closed:bool,
}
impl AgentBroker {
    pub(crate) fn start(resources:&Path,registry:&Path)->Result<Self,&'static str>{
        let verified=crate::native_host_resources::verify_agent_broker(resources)?;
        Self::spawn(&verified.node_executable,&verified.bootstrap_script,registry)
    }
    fn spawn(node:&Path,script:&Path,registry:&Path)->Result<Self,&'static str>{
        if !registry.is_absolute()||!registry.is_dir(){return Err("NATIVE_AGENT_REGISTRY_INVALID");}
        let mut command=Command::new(node);
        command.arg(script).arg("--owner-stdio").env_clear()
            .env("PERFECT_PLANNER_REGISTRY_ROOT",registry)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(root)=std::env::var_os("SystemRoot"){command.env("SystemRoot",root);}
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut child=command.spawn().map_err(|_|"NATIVE_AGENT_START_FAILED")?;
        let input=child.stdin.take().ok_or("NATIVE_AGENT_PIPE_FAILED")?;
        let mut stdout=child.stdout.take().ok_or("NATIVE_AGENT_PIPE_FAILED")?;
        let (send,output)=mpsc::sync_channel(1);
        let reader=thread::spawn(move||{
            loop{
                let mut frame=Vec::new();let mut byte=[0u8;1];
                loop{match stdout.read(&mut byte){
                    Ok(1) if byte[0]==b'\n'=>break,
                    Ok(1)=>{frame.push(byte[0]);if frame.len()>32768{let _=send.send(Err(()));return;}},
                    _=>{let _=send.send(Err(()));return;}
                }}
                if send.send(Ok(frame)).is_err(){return;}
            }
        });
        Ok(Self{child,input:Some(input),output:Some(output),reader:Some(reader),sequence:0,closed:false})
    }
    pub(crate) fn request(&mut self,method:&str,params:Value)->Result<Value,&'static str>{
        self.exchange(method,params,Duration::from_secs(12))
    }
    fn exchange(&mut self,method:&str,params:Value,deadline:Duration)->Result<Value,&'static str>{
        if self.closed{return Err("NATIVE_AGENT_CLOSED");}
        if !matches!(method,"owner.pair"|"owner.pairProposal"|"owner.inspect"|"owner.readExchanges"|"owner.revoke"|"owner.cancel"|"owner.openClient"|"owner.openPlanClient"|"owner.openProposalClient"|"owner.closeClient"|"client.request"|"client.connect"|"client.heartbeat")||!params.is_object(){return Err("NATIVE_AGENT_REQUEST_INVALID");}
        let id=self.sequence.checked_add(1).ok_or("NATIVE_AGENT_SEQUENCE_LIMIT")?;
        let limit=if method=="client.request"&&params["request"]["method"]=="client.proposeTask"{70000}else{16384};
        let mut frame=serde_json::to_vec(&json!({"version":1,"id":id,"method":method,"params":params})).map_err(|_|"NATIVE_AGENT_REQUEST_INVALID")?;
        if frame.len()>limit{return Err("NATIVE_AGENT_REQUEST_LIMIT");}frame.push(b'\n');
        let mut input=self.input.take().ok_or("NATIVE_AGENT_CLOSED")?;
        let (sent,written)=mpsc::sync_channel(1);
        let writer=thread::spawn(move||{let result=input.write_all(&frame).and_then(|_|input.flush());let _=sent.send((input,result.is_ok()));});
        let start=std::time::Instant::now();
        let result=(||{
            let (input,ok)=written.recv_timeout(deadline).map_err(|_|"NATIVE_AGENT_WRITE_TIMEOUT")?;
            self.input=Some(input);if !ok{return Err("NATIVE_AGENT_WRITE_FAILED");}
            let remaining=deadline.checked_sub(start.elapsed()).ok_or("NATIVE_AGENT_REPLY_TIMEOUT")?;
            let bytes=self.output.as_ref().ok_or("NATIVE_AGENT_CLOSED")?.recv_timeout(remaining).map_err(|_|"NATIVE_AGENT_REPLY_TIMEOUT")?.map_err(|_|"NATIVE_AGENT_REPLY_INVALID")?;
            let reply:Value=serde_json::from_slice(&bytes).map_err(|_|"NATIVE_AGENT_REPLY_INVALID")?;
            let fields=reply.as_object().ok_or("NATIVE_AGENT_REPLY_INVALID")?;
            let ok=reply["ok"].as_bool().ok_or("NATIVE_AGENT_REPLY_INVALID")?;
            if fields.len()!=4||reply["version"]!=1||reply["id"]!=id||!fields.contains_key(if ok{"result"}else{"error"}){return Err("NATIVE_AGENT_REPLY_INVALID");}
            if !ok&&reply["error"]!="BROKER_OPERATION_REFUSED"{return Err("NATIVE_AGENT_REPLY_INVALID");}
            self.sequence=id;Ok(reply)
        })();
        if result.is_err(){self.stop();}
        // Killing the owned process closes its private pipe and releases a blocked writer.
        let _=writer.join();
        result
    }
    pub(crate) fn stop(&mut self){
        if self.closed{return;}self.closed=true;self.input.take();
        if self.child.try_wait().ok().flatten().is_none(){let _=self.child.kill();}
        let _=self.child.wait();self.output.take();
        if let Some(reader)=self.reader.take(){let _=reader.join();}
    }
}
impl Drop for AgentBroker{fn drop(&mut self){self.stop();}}

#[cfg(test)]mod tests{
    use super::*;
    #[test] #[ignore="Requires explicit DANS1 pinned broker fixture"] fn packaged_broker_pair_heartbeat_revoke(){
        let fixture=std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").expect("explicit packaged fixture required");
        let fixture:Value=serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
        let mut broker=AgentBroker::start(Path::new(fixture["resources"].as_str().unwrap()),Path::new(fixture["registry"].as_str().unwrap())).unwrap();
        let pair=broker.request("owner.pair",json!({"binding":fixture["binding"]})).unwrap();assert_eq!(pair["ok"],true);
        let connected=broker.request("client.connect",json!({"pairingId":pair["result"]["pairingId"],"secret":pair["result"]["secret"]})).unwrap();assert_eq!(connected["ok"],true);
        let credentials=&connected["result"];
        let beat=broker.request("client.heartbeat",json!({"sessionId":credentials["sessionId"],"secret":credentials["secret"],"expectedSequence":1})).unwrap();
        assert_eq!(beat["result"]["sequence"],2);
        let view=broker.request("owner.inspect",json!({"binding":fixture["binding"]})).unwrap();assert_eq!(view["result"][0]["state"],"reachable");
        assert!(!view.to_string().contains(credentials["secret"].as_str().unwrap()));
        assert_eq!(broker.request("owner.revoke",json!({"sessionId":credentials["sessionId"]})).unwrap()["result"],true);
        assert_eq!(broker.request("client.heartbeat",json!({"sessionId":credentials["sessionId"],"secret":credentials["secret"],"expectedSequence":2})).unwrap()["ok"],false);
        broker.stop();assert!(broker.child.try_wait().unwrap().is_some());
    }
    #[test]fn private_node_process_round_trip_and_timeout(){
        let node=std::env::var("PP_TEST_AGENT_NODE").expect("explicit DANS1 Node fixture required");
        let root=std::env::temp_dir().join(format!("pp-native-agent-{}",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();let script=root.join("fixture.mjs");
        std::fs::write(&script,"process.stdin.on('data',b=>{const r=JSON.parse(b);if(r.params.stall)return;process.stdout.write(JSON.stringify({version:1,id:r.id,ok:true,result:'fixture'})+'\\n')})").unwrap();
        let mut broker=AgentBroker::spawn(Path::new(&node),&script,&root).unwrap();
        assert_eq!(broker.request("owner.inspect",json!({})).unwrap()["result"],"fixture");
        for method in ["owner.openProposalClient","owner.pairProposal"]{
            assert_eq!(broker.request(method,json!({})).unwrap()["result"],"fixture");
        }
        assert_eq!(broker.request("owner.inspect",json!({"padding":"x".repeat(18000)})).unwrap_err(),"NATIVE_AGENT_REQUEST_LIMIT");
        assert!(!broker.closed);
        assert_eq!(broker.request("client.request",json!({"request":{"method":"client.proposeTask","padding":"x".repeat(18000)}})).unwrap()["result"],"fixture");
        assert_eq!(broker.request("client.request",json!({"request":{"method":"client.readTask","padding":"x".repeat(18000)}})).unwrap_err(),"NATIVE_AGENT_REQUEST_LIMIT");
        assert_eq!(broker.request("client.request",json!({"request":{"method":"client.proposeTask","padding":"x".repeat(70000)}})).unwrap_err(),"NATIVE_AGENT_REQUEST_LIMIT");
        assert!(broker.exchange("owner.inspect",json!({"stall":true}),Duration::from_millis(100)).is_err());
        assert!(broker.closed);assert!(broker.child.try_wait().unwrap().is_some());
        assert_eq!(broker.request("owner.inspect",json!({})).unwrap_err(),"NATIVE_AGENT_CLOSED");
    }
}
