//! App-owned brokers and their already-authorized native connection workers.
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}};
use crate::native_agent_broker::AgentBroker;

pub(crate) type SharedBroker=Arc<Mutex<AgentBroker>>;
struct ProjectBroker {
    broker:SharedBroker,
    stopping:AtomicBool,
    #[cfg(windows)] workers:Mutex<crate::native_agent_worker::AgentWorkerPool>,
}
#[derive(Default)]
pub struct AgentBrokers(Mutex<HashMap<String,Arc<ProjectBroker>>>);
impl AgentBrokers {
    pub(crate) fn get_or_start(&self,key:&str,resources:&Path,registry:&Path)->Result<SharedBroker,&'static str>{
        let mut entries=self.0.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
        if let Some(entry)=entries.get(key){
            if entry.stopping.load(Ordering::SeqCst){return Err("AGENT_PROJECT_STOPPING");}
            return Ok(Arc::clone(&entry.broker));
        }
        if entries.len()>=4{return Err("AGENT_BROKER_CAPACITY");}
        let broker=Arc::new(Mutex::new(AgentBroker::start(resources,registry)?));
        entries.insert(key.to_owned(),Arc::new(ProjectBroker{broker:Arc::clone(&broker),stopping:AtomicBool::new(false),
            #[cfg(windows)] workers:Mutex::new(crate::native_agent_worker::AgentWorkerPool::default())}));
        Ok(broker)
    }
    /// Native owner only. The peer must already be authorized; no PID or secret
    /// is accepted from a renderer. The exact binding determines project ownership.
    #[cfg(windows)]
    pub(crate) fn attach(&self,binding:serde_json::Value,shared:&SharedBroker,pipe:crate::native_agent_pipe::AgentPipe,peer:crate::native_agent_pipe::PipePeer)->Result<(),&'static str>{
        self.attach_inner(binding,shared,pipe,peer,false)
    }
    #[cfg(windows)]
    pub(crate) fn attach_pairing(&self,binding:serde_json::Value,shared:&SharedBroker,pipe:crate::native_agent_pipe::AgentPipe,peer:crate::native_agent_pipe::PipePeer)->Result<(),&'static str>{
        self.attach_inner(binding,shared,pipe,peer,true)
    }
    /// Native approved-connection flow only, before publishing configuration.
    /// Pins are encapsulated in the package verifier's result, not renderer data.
    #[cfg(windows)]
    pub(crate) fn attach_helper(&self,binding:serde_json::Value,shared:&SharedBroker,pipe:crate::native_agent_pipe::AgentPipe,helper:crate::native_host_resources::VerifiedAgentHelper)->Result<(),&'static str>{
        self.attach_configured_helper(binding,shared,pipe,helper,None)
    }
    #[cfg(windows)]
    pub(crate) fn attach_configured_helper(&self,binding:serde_json::Value,shared:&SharedBroker,pipe:crate::native_agent_pipe::AgentPipe,helper:crate::native_host_resources::VerifiedAgentHelper,configuration:Option<serde_json::Value>)->Result<(),&'static str>{
        self.attach_plan_helper(binding,shared,pipe,helper,configuration.map(crate::native_agent_worker::AgentPlanAccess::Read))
    }
    #[cfg(windows)]
    pub(crate) fn attach_proposal_helper(&self,binding:serde_json::Value,shared:&SharedBroker,pipe:crate::native_agent_pipe::AgentPipe,helper:crate::native_host_resources::VerifiedAgentHelper,configuration:serde_json::Value)->Result<(),&'static str>{
        self.attach_plan_helper(binding,shared,pipe,helper,Some(crate::native_agent_worker::AgentPlanAccess::Propose(configuration)))
    }
    #[cfg(windows)]
    fn attach_plan_helper(&self,binding:serde_json::Value,shared:&SharedBroker,pipe:crate::native_agent_pipe::AgentPipe,helper:crate::native_host_resources::VerifiedAgentHelper,configuration:Option<crate::native_agent_worker::AgentPlanAccess>)->Result<(),&'static str>{
        let key=binding.to_string();
        let entry=self.0.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?.get(&key).cloned().ok_or("AGENT_BROKER_CHANGED")?;
        let mut workers=entry.workers.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
        if entry.stopping.load(Ordering::SeqCst)||!Arc::ptr_eq(&entry.broker,shared){return Err("AGENT_BROKER_CHANGED");}
        if !workers.has_capacity(){return Err("AGENT_WORKER_CAPACITY");}
        let worker=match configuration{Some(crate::native_agent_worker::AgentPlanAccess::Read(config))=>crate::native_agent_worker::NativeAgentWorker::start_plan_admission(pipe,helper,Arc::clone(shared),binding,config)?,Some(crate::native_agent_worker::AgentPlanAccess::Propose(config))=>crate::native_agent_worker::NativeAgentWorker::start_proposal_admission(pipe,helper,Arc::clone(shared),binding,config)?,None=>crate::native_agent_worker::NativeAgentWorker::start_admission(pipe,helper,Arc::clone(shared),binding)?};
        workers.push(worker)
    }
    #[cfg(windows)]
    fn attach_inner(&self,binding:serde_json::Value,shared:&SharedBroker,pipe:crate::native_agent_pipe::AgentPipe,peer:crate::native_agent_pipe::PipePeer,pairing:bool)->Result<(),&'static str>{
        let key=binding.to_string();
        let entry=self.0.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?.get(&key).cloned().ok_or("AGENT_BROKER_CHANGED")?;
        let mut workers=entry.workers.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
        if entry.stopping.load(Ordering::SeqCst)||!Arc::ptr_eq(&entry.broker,shared){return Err("AGENT_BROKER_CHANGED");}
        if !workers.has_capacity(){return Err("AGENT_WORKER_CAPACITY");}
        let worker=if pairing{crate::native_agent_worker::NativeAgentWorker::start_pairing(pipe,peer,Arc::clone(shared),binding)?}
            else{crate::native_agent_worker::NativeAgentWorker::start(pipe,peer,Arc::clone(shared),binding)?};
        workers.push(worker)
    }
    pub(crate) fn stop(&self,key:&str)->Result<(),&'static str>{
        let entry=self.0.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?.get(key).cloned();
        if let Some(entry)=entry{self.retire(key,&entry.broker)?;}
        Ok(())
    }
    #[cfg(windows)]
    pub(crate) fn worker_snapshot(&self,key:&str,shared:&SharedBroker)->Result<serde_json::Value,&'static str>{
        let entry=self.0.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?.get(key).cloned().ok_or("AGENT_BROKER_CHANGED")?;
        let mut workers=entry.workers.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
        // Session observations and worker history must come from the same
        // retained broker, not a replacement installed during inspection.
        if entry.stopping.load(Ordering::SeqCst)||!Arc::ptr_eq(&entry.broker,shared){return Err("AGENT_BROKER_CHANGED");}
        let value=workers.snapshot();
        if value["poolId"].as_str().map_or(true,|id|id.len()!=64){return Err("AGENT_WORKER_OBSERVATION_INVALID");}
        Ok(value)
    }
    pub(crate) fn retire(&self,key:&str,shared:&SharedBroker)->Result<(),&'static str>{
        let entry=self.0.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?.get(key).cloned().ok_or("AGENT_BROKER_CHANGED")?;
        if !Arc::ptr_eq(&entry.broker,shared){return Err("AGENT_BROKER_CHANGED");}
        #[cfg(windows)]
        let mut workers=entry.workers.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
        // Refuse a busy project before detaching workers or altering its state.
        let broker=shared.try_lock().map_err(|_|"AGENT_BROKER_BUSY")?;
        entry.stopping.store(true,Ordering::SeqCst);
        drop(broker);
        let mut cleanup=Ok(());
        #[cfg(windows)]
        {
            cleanup=workers.stop_all();
        }
        // No global registry lock is held while workers revoke or a child stops.
        let mut broker=shared.lock().map_err(|_|"AGENT_BROKER_POISONED")?;
        broker.stop();
        let mut entries=self.0.lock().map_err(|_|"AGENT_REGISTRY_POISONED")?;
        if entries.get(key).is_some_and(|current|Arc::ptr_eq(current,&entry)){entries.remove(key);}
        cleanup
    }
}

#[cfg(test)]mod tests{
    use super::*;
    use serde_json::{json,Value};
    #[test]
    #[ignore="Requires explicit DANS1 pinned broker fixture"]
    fn busy_stop_retained_handles_and_replacement_are_isolated(){
        let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("PP_TEST_AGENT_PACKAGE_FIXTURE").unwrap()).unwrap()).unwrap();
        let resources=Path::new(fixture["resources"].as_str().unwrap());
        let registry=Path::new(fixture["registry"].as_str().unwrap());
        let entries=Arc::new(AgentBrokers::default());
        let old=entries.get_or_start("a",resources,registry).unwrap();
        let same=entries.get_or_start("a",resources,registry).unwrap();
        assert!(Arc::ptr_eq(&old,&same));
        #[cfg(windows)]
        let original_pool=entries.worker_snapshot("a",&old).unwrap()["poolId"].clone();
        let (held_tx,held_rx)=std::sync::mpsc::channel();
        let (release_tx,release_rx)=std::sync::mpsc::channel();
        let worker_handle=Arc::clone(&old);
        let worker=std::thread::spawn(move||{
            let _guard=worker_handle.lock().unwrap();held_tx.send(()).unwrap();
            release_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        });
        held_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        let busy=entries.stop("a");
        // Another project can inspect while the first handle is occupied.
        let other=entries.get_or_start("b",resources,registry).unwrap();
        #[cfg(windows)]{
            assert_eq!(entries.worker_snapshot("b",&old).unwrap_err(),"AGENT_BROKER_CHANGED");
            assert_ne!(entries.worker_snapshot("b",&other).unwrap()["poolId"],original_pool);
            assert_eq!(entries.worker_snapshot("missing",&old).unwrap_err(),"AGENT_BROKER_CHANGED");
        }
        let reply=other.lock().unwrap().request("owner.inspect",json!({"binding":fixture["binding"]})).unwrap();
        release_tx.send(()).unwrap();worker.join().unwrap();
        assert_eq!(busy.unwrap_err(),"AGENT_BROKER_BUSY");assert_eq!(reply["ok"],true);
        assert!(Arc::ptr_eq(&old,&entries.get_or_start("a",resources,registry).unwrap()));
        entries.stop("a").unwrap();
        assert!(old.lock().unwrap().request("owner.inspect",json!({"binding":fixture["binding"]})).is_err());
        let replacement=entries.get_or_start("a",resources,registry).unwrap();
        assert!(!Arc::ptr_eq(&old,&replacement));
        #[cfg(windows)]{
            assert_eq!(entries.worker_snapshot("a",&old).unwrap_err(),"AGENT_BROKER_CHANGED");
            let snapshot=entries.worker_snapshot("a",&replacement).unwrap();
            assert_ne!(snapshot["poolId"],original_pool);
            assert_eq!(snapshot["activeWorkers"],0);
            assert_eq!(snapshot["outcomes"],json!([]));
            let entry=entries.0.lock().unwrap().get("a").cloned().unwrap();
            entry.stopping.store(true,Ordering::SeqCst);
            assert_eq!(entries.worker_snapshot("a",&replacement).unwrap_err(),"AGENT_BROKER_CHANGED");
            entry.stopping.store(false,Ordering::SeqCst);
        }
        assert_eq!(entries.retire("a",&old).unwrap_err(),"AGENT_BROKER_CHANGED");
        assert_eq!(replacement.lock().unwrap().request("owner.inspect",json!({"binding":fixture["binding"]})).unwrap()["ok"],true);
        entries.stop("a").unwrap();entries.stop("b").unwrap();
        assert!(entries.0.lock().unwrap().is_empty());
    }
}
