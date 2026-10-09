//! Native-owner lifecycle for one already-authorized peer. Not an admission API.
use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
use std::thread::{self,JoinHandle};
use std::time::Duration;
use serde_json::Value;
use crate::native_agent_pipe::{AgentPipe,AgentPipeStop,PipePeer};
use crate::native_agent_registry::SharedBroker;
use crate::native_agent_channel::NativeAgentChannel;

pub(crate) struct NativeAgentWorker{stop:Option<AgentPipeStop>,requested:Arc<AtomicBool>,worker:Option<JoinHandle<Result<(),&'static str>>>,outcome:Option<Result<(),&'static str>>}
enum PeerAuthority{Retained(PipePeer),Packaged(crate::native_host_resources::VerifiedAgentHelper)}
pub(crate) enum AgentPlanAccess{Read(Value),Propose(Value)}
impl NativeAgentWorker{
    pub(crate) fn start(pipe:AgentPipe,peer:PipePeer,broker:SharedBroker,binding:Value)->Result<Self,&'static str>{
        Self::start_inner(pipe,PeerAuthority::Retained(peer),broker,binding,false,None)
    }
    pub(crate) fn start_pairing(pipe:AgentPipe,peer:PipePeer,broker:SharedBroker,binding:Value)->Result<Self,&'static str>{
        Self::start_inner(pipe,PeerAuthority::Retained(peer),broker,binding,true,None)
    }
    /// Caller must have explicit user approval before starting admission. The
    /// helper type can only be obtained from native package verification.
    pub(crate) fn start_admission(pipe:AgentPipe,helper:crate::native_host_resources::VerifiedAgentHelper,broker:SharedBroker,binding:Value)->Result<Self,&'static str>{
        Self::start_inner(pipe,PeerAuthority::Packaged(helper),broker,binding,true,None)
    }
    pub(crate) fn start_plan_admission(pipe:AgentPipe,helper:crate::native_host_resources::VerifiedAgentHelper,broker:SharedBroker,binding:Value,configuration:Value)->Result<Self,&'static str>{
        Self::start_inner(pipe,PeerAuthority::Packaged(helper),broker,binding,true,Some(AgentPlanAccess::Read(configuration)))
    }
    pub(crate) fn start_proposal_admission(pipe:AgentPipe,helper:crate::native_host_resources::VerifiedAgentHelper,broker:SharedBroker,binding:Value,configuration:Value)->Result<Self,&'static str>{
        Self::start_inner(pipe,PeerAuthority::Packaged(helper),broker,binding,true,Some(AgentPlanAccess::Propose(configuration)))
    }
    fn start_inner(pipe:AgentPipe,authority:PeerAuthority,broker:SharedBroker,binding:Value,pairing:bool,configuration:Option<AgentPlanAccess>)->Result<Self,&'static str>{
        let stop=pipe.stop_handle();let requested=Arc::new(AtomicBool::new(false));let stopping=Arc::clone(&requested);
        let worker=thread::Builder::new().name("planner-agent-channel".into()).spawn(move||{
            if let Err(error)=if pipe.is_connected(){Ok(())}else{pipe.accept(Duration::from_secs(30))}{
                return if stopping.load(Ordering::SeqCst){Ok(())}else{Err(error)};
            }
            if stopping.load(Ordering::SeqCst){return Ok(());}
            let peer=match authority{PeerAuthority::Retained(peer)=>peer,PeerAuthority::Packaged(helper)=>PipePeer::from_pipe_client(&pipe,helper.executable(),helper.sha256())?};
            let mut channel=match configuration{Some(AgentPlanAccess::Read(config))=>NativeAgentChannel::open_plan(broker,&pipe,&peer,binding.clone(),config)?,Some(AgentPlanAccess::Propose(config))=>NativeAgentChannel::open_proposal(broker,&pipe,&peer,binding.clone(),config)?,None=>NativeAgentChannel::open(broker,&pipe,&peer,binding.clone())?};
            if pairing{channel.send_pairing(&pipe,&peer)?;}
            loop{
                if stopping.load(Ordering::SeqCst){return channel.close();}
                if let Err(error)=channel.exchange(&pipe,&peer,Duration::from_secs(20)){
                    // exchange already attempts revocation; never disguise failed cleanup.
                    if matches!(error,"AGENT_CHANNEL_CLEANUP_UNCONFIRMED"|"AGENT_CHANNEL_BROKER_STOPPED"){return Err(error);}
                    channel.close()?;
                    return if stopping.load(Ordering::SeqCst){Ok(())}else{Err(error)};
                }
                if channel.is_closed(){return Ok(());}
            }
        }).map_err(|_|"AGENT_WORKER_START_FAILED")?;
        Ok(Self{stop:Some(stop),requested,worker:Some(worker),outcome:None})
    }
    pub(crate) fn try_finish(&mut self)->Option<Result<(),&'static str>>{
        if self.outcome.is_some(){return self.outcome;}
        if !self.worker.as_ref().is_some_and(|worker|worker.is_finished()){return None;}
        let result=self.worker.take().unwrap().join().unwrap_or(Err("AGENT_WORKER_PANICKED"));
        self.stop.take();self.outcome=Some(result);self.outcome
    }
    /// Call from a native background task, never the UI event thread.
    pub(crate) fn stop(&mut self)->Result<(),&'static str>{
        if let Some(outcome)=self.outcome{return outcome;}
        self.requested.store(true,Ordering::SeqCst);
        if let Some(stop)=self.stop.as_ref(){stop.stop();}
        let result=match self.worker.take(){Some(worker)=>worker.join().unwrap_or(Err("AGENT_WORKER_PANICKED")),None=>Ok(())};
        // Release the cancellation handle too: a stopped worker must not keep
        // the endpoint alive and force its client to wait for a read timeout.
        self.stop.take();self.outcome=Some(result);result
    }
}
impl Drop for NativeAgentWorker{fn drop(&mut self){let _=self.stop();}}

#[derive(Default)]
pub(crate) struct AgentWorkerPool{
    pool_id:Option<String>,
    active:Vec<(u64,NativeAgentWorker)>,
    outcomes:std::collections::VecDeque<Value>,
    issued:u64,omitted:u64,
}
impl AgentWorkerPool{
    fn record(&mut self,id:u64,result:Result<(),&'static str>){
        if self.outcomes.len()==32{self.outcomes.pop_front();self.omitted+=1;}
        self.outcomes.push_back(serde_json::json!({"workerId":id,"state":if result.is_ok(){"stopped"}else{"failed"},"code":result.err(),"workVerified":false}));
    }
    pub(crate) fn reap(&mut self){
        let mut index=0;
        while index<self.active.len(){
            if let Some(result)=self.active[index].1.try_finish(){
                let (id,_)=self.active.remove(index);self.record(id,result);
            }else{index+=1;}
        }
    }
    pub(crate) fn has_capacity(&mut self)->bool{self.reap();self.active.len()<8&&self.issued<u64::MAX}
    pub(crate) fn push(&mut self,worker:NativeAgentWorker)->Result<(),&'static str>{
        if !self.has_capacity(){return Err("AGENT_WORKER_CAPACITY");}
        self.issued+=1;self.active.push((self.issued,worker));Ok(())
    }
    pub(crate) fn stop_all(&mut self)->Result<(),&'static str>{
        let mut result=Ok(());
        for (id,mut worker) in std::mem::take(&mut self.active){
            let stopped=worker.stop();if stopped.is_err(){result=stopped;}self.record(id,stopped);
        }
        result
    }
    pub(crate) fn snapshot(&mut self)->Value{
        if self.pool_id.is_none(){self.pool_id=crate::native_agent_pipe::random_endpoint().ok();}
        self.reap();serde_json::json!({"poolId":self.pool_id,"activeWorkers":self.active.len(),"outcomes":self.outcomes.iter().rev().collect::<Vec<_>>(),"omittedOutcomes":self.omitted,"durable":false,"workVerified":false})
    }
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]
    #[ignore="Requires explicit DANS1 helper package fixture"]
    fn admission_rejects_wrong_executable_and_pending_listener_stops(){
        use crate::native_agent_pipe::AgentPipeClient;
        use sha2::{Sha256,Digest};
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let root=std::path::Path::new(fixture["resources"].as_str().unwrap());
        let broker=Arc::new(std::sync::Mutex::new(crate::native_agent_broker::AgentBroker::start(root,std::path::Path::new(fixture["registry"].as_str().unwrap())).unwrap()));
        let endpoint=||format!("{:064x}",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let name=endpoint();let pipe=AgentPipe::create(&name).unwrap();
        let mut worker=NativeAgentWorker::start_admission(pipe,crate::native_host_resources::verify_agent_helper(root).unwrap(),broker.clone(),fixture["binding"].clone()).unwrap();
        // This test process has the same account but is not the approved helper.
        let exe=std::env::current_exe().unwrap();let pin=format!("{:x}",Sha256::digest(std::fs::read(&exe).unwrap()));
        let client=AgentPipeClient::connect_pinned(&name,&exe,&pin).unwrap();
        // The pool has not reaped the worker or dropped its stop handle yet.
        // A rejected peer must see EOF rather than wait for UI polling/reaping.
        let started=std::time::Instant::now();
        let error=client.receive_private(Duration::from_secs(2)).unwrap_err();
        assert!(started.elapsed()<Duration::from_secs(1),"Rejected peer waited for retained endpoint: {error}");
        let deadline=std::time::Instant::now()+Duration::from_secs(10);
        loop{if let Some(result)=worker.try_finish(){assert_eq!(result,Err("AGENT_PEER_IMAGE_MISMATCH"));break;}assert!(std::time::Instant::now()<deadline);thread::sleep(Duration::from_millis(10));}
        assert!(client.receive_private(Duration::from_secs(2)).is_err());
        assert_eq!(broker.lock().unwrap().request("owner.inspect",serde_json::json!({"binding":fixture["binding"]})).unwrap()["result"],serde_json::json!([]));
        let mut pending=NativeAgentWorker::start_admission(AgentPipe::create(&endpoint()).unwrap(),crate::native_host_resources::verify_agent_helper(root).unwrap(),broker.clone(),fixture["binding"].clone()).unwrap();
        let started=std::time::Instant::now();pending.stop().unwrap();assert!(started.elapsed()<Duration::from_secs(3));
        broker.lock().unwrap().stop();
    }
    fn failed()->NativeAgentWorker{
        NativeAgentWorker{stop:None,requested:Arc::new(AtomicBool::new(false)),worker:Some(thread::spawn(||Err("AGENT_PIPE_IO_FAILED"))),outcome:None}
    }
    #[test]fn repeated_stop_preserves_failure_and_reaping_reclaims_capacity(){
        let mut pool=AgentWorkerPool::default();
        for _ in 0..40{
            let mut worker=failed();assert_eq!(worker.stop(),Err("AGENT_PIPE_IO_FAILED"));
            assert_eq!(worker.stop(),Err("AGENT_PIPE_IO_FAILED"));
            assert_eq!(worker.try_finish(),Some(Err("AGENT_PIPE_IO_FAILED")));
            pool.push(worker).unwrap();
        }
        let snapshot=pool.snapshot();assert_eq!(snapshot["activeWorkers"],0);assert_eq!(snapshot["omittedOutcomes"],8);
        assert_eq!(snapshot["outcomes"].as_array().unwrap().len(),32);assert_eq!(snapshot["outcomes"][0]["workerId"],40);
        assert_eq!(snapshot["outcomes"][0]["state"],"failed");assert_eq!(snapshot["durable"],false);
        assert!(pool.has_capacity());
    }
}
