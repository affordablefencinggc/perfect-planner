//! Native-only scoped channel. No listener or renderer command is exposed here.
use std::time::Duration;
use serde_json::{json,Value};
use crate::native_agent_registry::SharedBroker;
use crate::native_agent_pipe::{AgentPipe,PipePeer};

pub(crate) struct NativeAgentChannel { broker:SharedBroker, id:String, closed:bool, pairing:Option<String>, binding:Value, plan_read:bool, proposal_write:bool }
impl NativeAgentChannel {
    pub(crate) fn is_closed(&self)->bool{self.closed}
    pub(crate) fn open(broker:SharedBroker,pipe:&AgentPipe,peer:&PipePeer,binding:Value)->Result<Self,&'static str>{
        Self::open_inner(broker,pipe,peer,binding,None,false)
    }
    pub(crate) fn open_plan(broker:SharedBroker,pipe:&AgentPipe,peer:&PipePeer,binding:Value,configuration:Value)->Result<Self,&'static str>{
        Self::open_inner(broker,pipe,peer,binding,Some(configuration),false)
    }
    /// Native owner only, after separate proposal-write consent. No renderer
    /// flag or helper request may select this constructor.
    pub(crate) fn open_proposal(broker:SharedBroker,pipe:&AgentPipe,peer:&PipePeer,binding:Value,configuration:Value)->Result<Self,&'static str>{
        Self::open_inner(broker,pipe,peer,binding,Some(configuration),true)
    }
    fn open_inner(broker:SharedBroker,pipe:&AgentPipe,peer:&PipePeer,binding:Value,configuration:Option<Value>,proposal_write:bool)->Result<Self,&'static str>{
        pipe.verify_client(peer)?;
        let plan=configuration.is_some();
        if proposal_write&&!plan{return Err("AGENT_PROPOSAL_CONFIG_REQUIRED");}
        let (method,params)=match configuration{Some(config)=>(if proposal_write{"owner.openProposalClient"}else{"owner.openPlanClient"},json!({"binding":binding,"hostConfiguration":config})),None=>("owner.openClient",json!({"binding":binding}))};
        let reply=broker.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?.request(method,params)?;
        if plan&&reply["result"]["planReadEnabled"]!=true{return Err("AGENT_PLAN_CHANNEL_REFUSED");}
        if proposal_write&&reply["result"]["proposalWriteEnabled"]!=true{return Err("AGENT_PROPOSAL_CHANNEL_REFUSED");}
        let id=reply["result"]["channelId"].as_str().ok_or("AGENT_CHANNEL_OPEN_REFUSED")?;
        if reply["ok"]!=true||id.len()!=32||!id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("AGENT_CHANNEL_OPEN_REFUSED");}
        Ok(Self{broker,id:id.to_owned(),closed:false,pairing:None,binding,plan_read:plan,proposal_write})
    }
    /// Owner-only bootstrap for an already approved, authenticated peer.
    /// Pending pairing belongs to this channel and is cancelled on close.
    pub(crate) fn send_pairing(&mut self,pipe:&AgentPipe,peer:&PipePeer)->Result<(),&'static str>{
        if self.closed||self.pairing.is_some(){return Err("AGENT_CHANNEL_STATE_INVALID");}
        let result=(||{
            pipe.verify_client(peer)?;
            let(method,params)=if self.proposal_write{("owner.pairProposal",json!({"channelId":self.id}))}else{("owner.pair",json!({"binding":self.binding}))};
            let reply=self.broker.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?.request(method,params)?;
            let id=reply["result"]["pairingId"].as_str().filter(|v|v.len()==32&&v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))).ok_or("AGENT_CHANNEL_PAIRING_REFUSED")?;
            if reply["ok"]!=true{return Err("AGENT_CHANNEL_PAIRING_REFUSED");}
            self.pairing=Some(id.to_owned());
            let mut value=json!({"schemaVersion":1,"binding":self.binding,"pairingId":id,"secret":reply["result"]["secret"],"expiresAt":reply["result"]["expiresAt"]});
            if self.plan_read{value["planReadEnabled"]=json!(true);}
            if self.proposal_write{value["proposalWriteEnabled"]=json!(true);}
            pipe.verify_client(peer)?;
            pipe.write_frame(&serde_json::to_vec(&value).map_err(|_|"AGENT_CHANNEL_FRAME_INVALID")?,Duration::from_secs(12))
        })();
        if result.is_err(){self.close()?;}
        result
    }
    pub(crate) fn exchange(&mut self,pipe:&AgentPipe,peer:&PipePeer,timeout:Duration)->Result<(),&'static str>{
        if self.closed{return Err("AGENT_CHANNEL_CLOSED");}
        let result=(||{
            pipe.verify_client(peer)?;
            // Waiting on external input must not retain the shared broker lock.
            let bytes=pipe.read_frame(timeout)?;
            let request:Value=serde_json::from_slice(&bytes).map_err(|_|"AGENT_CHANNEL_FRAME_INVALID")?;
            pipe.verify_client(peer)?;
            // Closing one's authenticated pipe channel cannot grant authority or
            // affect another channel. Revoke first, then acknowledge and stop.
            if request["method"]=="client.disconnect"{
                let valid=request.as_object().is_some_and(|m|m.len()==4&&["version","id","method","params"].iter().all(|k|m.contains_key(*k)))
                    &&request["version"]==1&&request["id"].as_u64().is_some_and(|v|v>0&&v<=9007199254740991)
                    &&request["params"].as_object().is_some_and(|m|m.is_empty());
                if !valid{return Err("AGENT_CHANNEL_FRAME_INVALID");}
                self.close()?;
                let reply=json!({"version":1,"id":request["id"],"ok":true,"result":{"version":1,"id":request["id"],"ok":true,"result":{"closed":true}}});
                return pipe.write_frame(&serde_json::to_vec(&reply).map_err(|_|"AGENT_CHANNEL_FRAME_INVALID")?,timeout);
            }
            let reply={let mut broker=self.broker.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
                broker.request("client.request",json!({"channelId":self.id,"request":request}))?};
            pipe.verify_client(peer)?;
            let encoded=serde_json::to_vec(&reply).map_err(|_|"AGENT_CHANNEL_FRAME_INVALID")?;
            pipe.write_frame(&encoded,timeout)
        })();
        if result.is_err(){self.close()?;}
        result
    }
    pub(crate) fn close(&mut self)->Result<(),&'static str>{
        if self.closed{return Ok(());}
        let mut broker=self.broker.lock().map_err(|_|"AGENT_CHANNEL_CLEANUP_UNCONFIRMED")?;
        if let Some(id)=self.pairing.take(){
            let reply=broker.request("owner.cancel",json!({"pairingId":id}));
            // false means already consumed/expired, also no longer usable.
            if !matches!(reply,Ok(v) if v["ok"]==true&&v["result"].is_boolean()){
                broker.stop();self.closed=true;return Err("AGENT_CHANNEL_BROKER_STOPPED");
            }
        }
        let reply=broker.request("owner.closeClient",json!({"channelId":self.id}));
        let confirmed=matches!(&reply,Ok(v) if v["ok"]==true&&v["result"]["closed"]==true&&v["result"]["revocationComplete"]==true);
        if !confirmed{
            // Failed cleanup cannot leave usable credentials in this in-memory broker.
            // Stop invalidates all of this broker's sessions, not just this channel.
            broker.stop();self.closed=true;return Err("AGENT_CHANNEL_BROKER_STOPPED");
        }
        self.closed=true;Ok(())
    }
}
impl Drop for NativeAgentChannel { fn drop(&mut self){let _=self.close();} }
