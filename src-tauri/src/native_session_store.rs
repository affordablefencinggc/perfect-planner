//! Successor session storage with preserve-first legacy and fresh admission.
//! Immutable records + a replaceable index; no historical file is removed.
use super::*;
const MAX_RECORD:u64=4096;

// Migration owns the legacy lock for its entire lifetime. It never rewrites or
// deletes legacy bytes. This is deliberately not a renderer-facing entry point.
pub(super) struct MigratedStore {
 legacy:File, legacy_path:PathBuf, legacy_bytes:Vec<u8>, store:Store, poisoned:bool,
}
impl MigratedStore {
 pub fn open(state_directory:&Path,root_identity:&str)->Result<Self,DraftError>{
  if !digest(root_identity){return Err(error("NATIVE_SESSION_STORE_INVALID"));}
  safe(state_directory)?;
  let project=project_id(root_identity);
  let legacy_path=state_directory.join(format!("{project}.sessions.jsonl"));
  let successor=state_directory.join(format!("{project}.sessions-v2"));
  // Never recreate a missing predecessor for an existing successor. An empty
  // predecessor left by interrupted admission also stays an explicit refusal.
  let exists=legacy_path.try_exists().map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;
  if !exists && successor.try_exists().map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?{return Err(error("NATIVE_SESSION_STORE_LEGACY_CHANGED"));}
  let (mut legacy,created)=if exists{
   (OpenOptions::new().read(true).write(true).open(&legacy_path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?,false)
  }else{
   match OpenOptions::new().read(true).write(true).create_new(true).open(&legacy_path){
    Ok(file)=>(file,true),
    Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>(OpenOptions::new().read(true).write(true).open(&legacy_path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?,false),
    Err(_)=>return Err(error("NATIVE_SESSION_STORE_UNAVAILABLE")),
   }
  };
  safe(&legacy_path)?;
  legacy.try_lock_exclusive().map_err(|_|error("NATIVE_DRAFT_BUSY"))?;
  let marker=fresh_marker(&project,root_identity)?;
  if created{
   // This is an admission marker, never an invented operation or successful
   // result. Older runtimes reject its version instead of starting a new log.
   if successor.exists(){return Err(error("NATIVE_SESSION_STORE_LEGACY_CHANGED"));}
   legacy.write_all(&marker).and_then(|_|legacy.sync_all()).map_err(|_|error("NATIVE_SESSION_STORE_UNCERTAIN"))?;
   std::io::Seek::rewind(&mut legacy).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;
  }
  let before=stamp(&legacy)?;
  if before.0==0||before.0>256*1024{return Err(error("NATIVE_SESSION_STORE_INVALID"));}
  let mut legacy_bytes=Vec::new();(&mut legacy).take(256*1024+1).read_to_end(&mut legacy_bytes).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;
  let initial=if legacy_bytes==marker{State{pending:None,original:None,original_digest:None}}else{parse_legacy(&legacy_bytes)?};
  if stamp(&legacy)?!=before||legacy_bytes.len()as u64!=before.0||stamp(&File::open(&legacy_path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?)?!=before{return Err(error("NATIVE_SESSION_STORE_CHANGED"));}
  let store=Store::open(&successor,&project,root_identity,&hash(&legacy_bytes),initial)?;
  let migrated=Self{legacy,legacy_path,legacy_bytes,store,poisoned:false};
  migrated.check_legacy()?;Ok(migrated)
 }
 fn check_legacy(&self)->Result<(),DraftError>{
  safe(&self.legacy_path)?;
  let current=File::open(&self.legacy_path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;let before=stamp(&current)?;
  if before!=stamp(&self.legacy)?||before.0!=self.legacy_bytes.len()as u64{return Err(error("NATIVE_SESSION_STORE_LEGACY_CHANGED"));}
  // Windows byte-range locks reject reads from a second handle. Re-read via
  // the handle that owns the lock; the second handle checks path identity only.
  let mut owned=&self.legacy;std::io::Seek::rewind(&mut owned).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;
  let mut bytes=Vec::new();owned.take(256*1024+1).read_to_end(&mut bytes).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;
  if bytes!=self.legacy_bytes||stamp(&current)?!=before{return Err(error("NATIVE_SESSION_STORE_LEGACY_CHANGED"));}Ok(())
 }
 pub fn state(&self)->&State{self.store.state()}
 pub fn sequence(&self)->u64{self.store.sequence()}
 // Read only the adjacent, hash-linked BEGIN/SETTLED pair. This supports
 // idempotent recovery without a second mutable outcome index or history scan.
 pub fn just_settled_session(&self)->Result<Option<(String,u64)>,DraftError>{
  self.check_legacy()?;
  let current=&self.store.current;
  if current.event!="SETTLED"||current.sequence<2{return Ok(None);}
  let prior=self.store.load(current.sequence-1)?;
  self.store.validate_next(&prior,current)?;
  if prior.event!="BEGIN"||prior.state.original.is_some(){return Ok(None);}
  Ok(prior.state.pending.map(|session|(session,prior.sequence-1)))
 }
 pub fn reserve_terminal(&mut self)->Result<(),DraftError>{self.check_legacy()?;self.store.reserve_terminal()}
 pub fn append_reserved(&mut self,event:&str,state:State)->Result<(),DraftError>{
  if self.poisoned{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}
  self.check_legacy()?;self.poisoned=true;self.store.append_reserved(event,state)?;self.check_legacy()?;self.poisoned=false;Ok(())
 }
 pub fn append(&mut self,event:&str,state:State)->Result<(),DraftError>{
  if self.poisoned{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}
  self.check_legacy()?;self.poisoned=true;self.store.append(event,state)?;self.check_legacy()?;self.poisoned=false;Ok(())
 }
}
fn fresh_marker(project:&str,root_identity:&str)->Result<Vec<u8>,DraftError>{
 let mut bytes=serde_json::to_vec(&json!({"schemaVersion":2,"kind":"NATIVE_SESSION_SUCCESSOR_ADMISSION","projectId":project,"rootIdentity":root_identity})).map_err(|_|error("NATIVE_SESSION_STORE_INVALID"))?;
 bytes.push(b'\n');Ok(bytes)
}
fn parse_legacy(bytes:&[u8])->Result<State,DraftError>{
 if bytes.is_empty()||bytes.len()>256*1024||bytes.last()!=Some(&b'\n'){return Err(error("NATIVE_SESSION_STORE_INVALID"));}
 let mut state=State{pending:None,original:None,original_digest:None};let mut sequence=0u32;
 for line in bytes[..bytes.len()-1].split(|b|*b==b'\n'){
  if line.is_empty()||line.len()>1024{return Err(error("NATIVE_SESSION_STORE_INVALID"));}
  // Deserialize directly first: duplicate fields must not disappear into Value.
  let record:SessionRecord=serde_json::from_slice(line).map_err(|_|error("NATIVE_SESSION_STORE_INVALID"))?;
  let value:Value=serde_json::from_slice(line).map_err(|_|error("NATIVE_SESSION_STORE_INVALID"))?;
  if value.get("outcomeRequestId").is_none()||value.get("outcomeLedgerRequestDigest").is_none()||record.schema_version!=1||sequence.checked_add(1)!=Some(record.sequence)||!token(&record.session_id,96){return Err(error("NATIVE_SESSION_STORE_INVALID"));}
  let next=State{pending:None,original:record.outcome_request_id,original_digest:record.outcome_ledger_request_digest};
  if !next.valid(){return Err(error("NATIVE_SESSION_STORE_INVALID"));}
  match record.state.as_str(){
   "BEGIN" if state.pending.is_none()&&next.original==state.original&&next.original_digest==state.original_digest=>state.pending=Some(record.session_id),
   "SETTLED" if state.pending.as_deref()==Some(&record.session_id)=>state=next,
   "PRE_DISPATCH_REFUSED" if state.pending.is_none()&&next==state=>{},
   _=>return Err(error("NATIVE_SESSION_STORE_INVALID")),
  }
  sequence=record.sequence;
 }
 Ok(state)
}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct State{pub pending:Option<String>,pub original:Option<String>,pub original_digest:Option<String>}
impl State{
 fn valid(&self)->bool{self.pending.as_deref().map_or(true,|s|token(s,96))&&self.original.as_deref().map_or(true,request_token)&&self.original_digest.as_deref().map_or(true,digest)&&self.original.is_some()==self.original_digest.is_some()}
}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Record{schema_version:u32,project:String,root_identity:String,legacy_digest:String,sequence:u64,previous_digest:String,event:String,state:State}
fn bytes(r:&Record)->Result<Vec<u8>,DraftError>{let b=serde_json::to_vec(r).map_err(|_|error("NATIVE_SESSION_STORE_INVALID"))?;if b.len()as u64>MAX_RECORD{return Err(error("NATIVE_SESSION_STORE_INVALID"));}Ok(b)}
fn hash(b:&[u8])->String{format!("{:x}",Sha256::digest(b))}
fn read(path:&Path)->Result<Vec<u8>,DraftError>{
 safe(path)?;let mut f=File::open(path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;let before=stamp(&f)?;
 if before.0==0||before.0>MAX_RECORD{return Err(error("NATIVE_SESSION_STORE_INVALID"));}
 let mut b=Vec::new();(&mut f).take(MAX_RECORD+1).read_to_end(&mut b).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;
 safe(path)?;let current=File::open(path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;
 if b.len()as u64!=before.0||stamp(&f)?!=before||stamp(&current)?!=before{return Err(error("NATIVE_SESSION_STORE_CHANGED"));}Ok(b)
}
fn write_new(path:&Path,b:&[u8])->Result<(),DraftError>{
 if b.is_empty()||b.len()as u64>MAX_RECORD{return Err(error("NATIVE_SESSION_STORE_INVALID"));}
 safe(path.parent().ok_or_else(||error("NATIVE_SESSION_STORE_INVALID"))?)?;
 let mut f=OpenOptions::new().write(true).create_new(true).open(path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;safe(path)?;let id=identity(&f)?;
 f.write_all(b).and_then(|_|f.sync_all()).map_err(|_|error("NATIVE_SESSION_STORE_UNCERTAIN"))?;
 if read(path)?!=b||identity(&File::open(path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?)?!=id{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}Ok(())
}
fn directory(path:&Path)->Result<(),DraftError>{
 match fs::create_dir(path){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(error("NATIVE_SESSION_STORE_UNAVAILABLE"))}
 safe(path)?;if !path.is_dir(){return Err(error("NATIVE_SESSION_STORE_INVALID"));}Ok(())
}
// A reservation contains real, flushed bytes. It is a temporary allocation,
// never an outcome receipt. Failure to allocate happens before host dispatch.
pub(super) fn reserve(path:&Path)->Result<(),DraftError>{
 let zeros=vec![0u8;MAX_RECORD as usize];
 if path.try_exists().map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?{
  if read(path)?!=zeros{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}
 }else{write_new(path,&zeros)?;}
 Ok(())
}
pub(super) fn publish_reserved(reservation:&Path,destination:&Path,bytes:&[u8])->Result<(),DraftError>{
 if bytes.is_empty()||bytes.len()as u64>MAX_RECORD||read(reservation)?!=vec![0u8;MAX_RECORD as usize]{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}
 if destination.try_exists().map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}
 safe(destination.parent().ok_or_else(||error("NATIVE_SESSION_STORE_INVALID"))?)?;
 let mut file=OpenOptions::new().read(true).write(true).open(reservation).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;
 let id=identity(&file)?;
 file.write_all(bytes).and_then(|_|file.set_len(bytes.len()as u64)).and_then(|_|file.sync_all()).map_err(|_|error("NATIVE_SESSION_STORE_UNCERTAIN"))?;
 if read(reservation)?!=bytes||identity(&File::open(reservation).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?)?!=id{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}
 drop(file);fs::rename(reservation,destination).map_err(|_|error("NATIVE_SESSION_STORE_UNCERTAIN"))?;
 if read(destination)?!=bytes||identity(&File::open(destination).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?)?!=id{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}Ok(())
}
pub(super) struct Store{root:PathBuf,_lock:File,current:Record,poisoned:bool}
impl Store{
 // root is selected by native composition, never renderer input. Caller must
 // first validate the complete legacy journal and supply its exact digest/state.
 pub fn open(root:&Path,project:&str,root_identity:&str,legacy_digest:&str,initial:State)->Result<Self,DraftError>{
  if !request_token(project)||!digest(root_identity)||!digest(legacy_digest)||!initial.valid(){return Err(error("NATIVE_SESSION_STORE_INVALID"));}
  directory(root)?;let lock_path=root.join("owner.lock");
  let lock=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path).map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?;safe(&lock_path)?;
  lock.try_lock_exclusive().map_err(|_|error("NATIVE_DRAFT_BUSY"))?;
  let base=Record{schema_version:2,project:project.into(),root_identity:root_identity.into(),legacy_digest:legacy_digest.into(),sequence:0,previous_digest:legacy_digest.into(),event:"IMPORTED".into(),state:initial};let encoded=bytes(&base)?;
  let base_path=root.join("import.json");
  if !base_path.try_exists().map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?{
   // A missing import must not reset an existing successor store.
   if root.join("head.json").exists()||root.join("events").exists()||root.join("next-head.json").exists(){return Err(error("NATIVE_SESSION_STORE_INVALID"));}
   write_new(&base_path,&encoded)?;
  }else if read(&base_path)?!=encoded{return Err(error("NATIVE_SESSION_STORE_LEGACY_CHANGED"));}
  let mut store=Self{root:root.into(),_lock:lock,current:base,poisoned:false};
  if !store.root.join("head.json").try_exists().map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?{
   if store.root.join("events").exists(){return Err(error("NATIVE_SESSION_STORE_INVALID"));}
   store.publish_head(&encoded)?;
  }
  let head_bytes=read(&store.root.join("head.json"))?;let head=store.parse(&head_bytes)?;
  if head.sequence==0{if head!=store.current{return Err(error("NATIVE_SESSION_STORE_INVALID"));}}
  else{
   if read(&store.record_path(head.sequence))?!=head_bytes{return Err(error("NATIVE_SESSION_STORE_CHANGED"));}
   let previous=store.load(head.sequence-1)?;store.validate_next(&previous,&head)?;
  }
  store.current=head;
  // A complete successor persisted before index publication is reconciled.
  // BEGIN remains pending, never settled or eligible for a replacement launch.
  let next=store.current.sequence.checked_add(1).ok_or_else(||error("NATIVE_SESSION_STORE_INVALID"))?;
  if store.record_path(next).try_exists().map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?{
   if next.checked_add(1).is_some_and(|n|store.record_path(n).exists()){return Err(error("NATIVE_SESSION_STORE_CHANGED"));}
   let value=store.load(next)?;store.validate_next(&store.current,&value)?;
   store.publish_head(&bytes(&value)?)?;store.current=value;
  }else if store.root.join("next-head.json").exists(){
   let b=bytes(&store.current)?;if read(&store.root.join("next-head.json"))?!=b{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}store.publish_head(&b)?;
  }
  Ok(store)
 }
 fn parse(&self,b:&[u8])->Result<Record,DraftError>{
  let r:Record=serde_json::from_slice(b).map_err(|_|error("NATIVE_SESSION_STORE_INVALID"))?;
  if r.schema_version!=2||r.project!=self.current.project||r.root_identity!=self.current.root_identity||r.legacy_digest!=self.current.legacy_digest||!r.state.valid()||!digest(&r.previous_digest)||bytes(&r)?!=b{return Err(error("NATIVE_SESSION_STORE_INVALID"));}Ok(r)
 }
 fn record_path(&self,n:u64)->PathBuf{self.root.join("events").join(format!("{:016x}",n/256)).join(format!("{n:016x}.json"))}
 fn load(&self,n:u64)->Result<Record,DraftError>{self.parse(&read(&if n==0{self.root.join("import.json")}else{self.record_path(n)})?)}
 fn validate_next(&self,previous:&Record,next:&Record)->Result<(),DraftError>{
  if previous.sequence.checked_add(1)!=Some(next.sequence)||next.previous_digest!=hash(&bytes(previous)?){return Err(error("NATIVE_SESSION_STORE_CHANGED"));}
  let old=&previous.state;let new=&next.state;
  let valid=match next.event.as_str(){
   "BEGIN"=>old.pending.is_none()&&new.pending.is_some()&&new.original==old.original&&new.original_digest==old.original_digest,
   "SETTLED"=>old.pending.is_some()&&new.pending.is_none(),
   "PRE_DISPATCH_REFUSED"=>old.pending.is_none()&&new==old,
   _=>false};if !valid{return Err(error("NATIVE_SESSION_STORE_INVALID"));}Ok(())
 }
 fn publish_head(&self,b:&[u8])->Result<(),DraftError>{
  let pending=self.root.join("next-head.json");
  if pending.try_exists().map_err(|_|error("NATIVE_SESSION_STORE_UNAVAILABLE"))?{if read(&pending)?!=b{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}}else{write_new(&pending,b)?;}
  // Only the derived index is replaced; import/event files remain immutable.
  safe(&self.root)?;if self.root.join("head.json").exists(){safe(&self.root.join("head.json"))?;}fs::rename(&pending,self.root.join("head.json")).map_err(|_|error("NATIVE_SESSION_STORE_UNCERTAIN"))?;
  if read(&self.root.join("head.json"))?!=b{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}Ok(())
 }
 pub fn state(&self)->&State{&self.current.state}
 pub fn sequence(&self)->u64{self.current.sequence}
 pub fn reserve_terminal(&mut self)->Result<(),DraftError>{
  if self.poisoned||self.current.state.pending.is_some(){return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}
  reserve(&self.root.join("terminal-event.reserve"))?;reserve(&self.root.join("terminal-head.reserve"))?;
  // Prepare the terminal event's directory too; crossing a shard boundary
  // must not defer directory allocation until after the host has run.
  let terminal=self.current.sequence.checked_add(2).ok_or_else(||error("NATIVE_SESSION_STORE_INVALID"))?;
  directory(&self.root.join("events"))?;directory(self.record_path(terminal).parent().unwrap())?;Ok(())
 }
 pub fn append_reserved(&mut self,event:&str,state:State)->Result<(),DraftError>{self.append_impl(event,state,||Ok(()),true)}
 // Explicit historical audit is separate from constant-size active-state reads.
 // Open does not claim that every old retained record was re-verified.
 pub fn audit_history(&self)->Result<u64,DraftError>{
  let mut previous=self.load(0)?;
  for n in 1..=self.current.sequence{let next=self.load(n)?;self.validate_next(&previous,&next)?;previous=next;}
  if previous!=self.current{return Err(error("NATIVE_SESSION_STORE_CHANGED"));}Ok(self.current.sequence)
 }
 pub fn append(&mut self,event:&str,state:State)->Result<(),DraftError>{self.append_with(event,state,||Ok(()))}
 fn append_with<F:FnOnce()->Result<(),DraftError>>(&mut self,event:&str,state:State,after_record:F)->Result<(),DraftError>{
  self.append_impl(event,state,after_record,false)
 }
 fn append_impl<F:FnOnce()->Result<(),DraftError>>(&mut self,event:&str,state:State,after_record:F,reserved:bool)->Result<(),DraftError>{
  if self.poisoned{return Err(error("NATIVE_SESSION_STORE_UNCERTAIN"));}
  let next=Record{schema_version:2,project:self.current.project.clone(),root_identity:self.current.root_identity.clone(),legacy_digest:self.current.legacy_digest.clone(),sequence:self.current.sequence.checked_add(1).ok_or_else(||error("NATIVE_SESSION_STORE_INVALID"))?,previous_digest:hash(&bytes(&self.current)?),event:event.into(),state};
  if !next.state.valid(){return Err(error("NATIVE_SESSION_STORE_INVALID"));}self.validate_next(&self.current,&next)?;
  if read(&self.root.join("head.json"))?!=bytes(&self.current)?{return Err(error("NATIVE_SESSION_STORE_CHANGED"));}
  self.poisoned=true;let b=bytes(&next)?;directory(&self.root.join("events"))?;let path=self.record_path(next.sequence);directory(path.parent().unwrap())?;
  if reserved{
   if event!="SETTLED"{return Err(error("NATIVE_SESSION_STORE_INVALID"));}
   publish_reserved(&self.root.join("terminal-event.reserve"),&path,&b)?;after_record()?;
   publish_reserved(&self.root.join("terminal-head.reserve"),&self.root.join("next-head.json"),&b)?;
  }else{write_new(&path,&b)?;after_record()?;}
  self.publish_head(&b)?;self.current=next;self.poisoned=false;Ok(())
 }
}

// Production admission. The legacy Guard is retained only in migration tests.
pub(super) struct LiveGuard{
 store:MigratedStore,
 reserved:bool,
 pub session:String,pub begun:bool,pub outstanding:Option<String>,pub outstanding_digest:Option<String>,
}
impl LiveGuard{
 pub fn open(directory:&Path,root_identity:&str,original:Option<(&str,&str)>)->Result<Self,DraftError>{
  if original.is_some_and(|(id,hash)|!request_token(id)||!digest(hash)){return Err(error("NATIVE_DRAFT_REQUEST_INVALID"));}
  let store=MigratedStore::open(directory,root_identity).map_err(|mut failure|{
   if matches!(failure.code,"NATIVE_SESSION_STORE_INVALID"|"NATIVE_SESSION_STORE_UNCERTAIN"|"NATIVE_SESSION_STORE_CHANGED"|"NATIVE_SESSION_STORE_LEGACY_CHANGED"){failure.requires_recovery=true;}failure
  })?;let state=store.state();
  if state.pending.is_some(){return Err(uncertain(true));}
  if let(Some((wanted,hash)),Some(outstanding))=(original,state.original.as_deref()){
   if wanted!=outstanding||Some(hash)!=state.original_digest.as_deref(){return Err(unknown(outstanding));}
  }
  Ok(Self{session:fresh_id(),begun:false,reserved:false,outstanding:state.original.clone(),outstanding_digest:state.original_digest.clone(),store})
 }
 pub fn sequence(&self)->u64{self.store.sequence()}
 pub fn root_identity(&self)->&str{&self.store.store.current.root_identity}
 pub fn reserve_terminal(&mut self)->Result<(),DraftError>{self.store.reserve_terminal()?;self.reserved=true;Ok(())}
 pub fn append(&mut self,event:&str)->Result<(),DraftError>{
  if !matches!((event,self.begun),("BEGIN",false)|("SETTLED",true)|("PRE_DISPATCH_REFUSED",false)){return Err(uncertain(true));}
  if event=="BEGIN"&&!self.reserved{return Err(error("NATIVE_SESSION_STORAGE_NOT_RESERVED"));}
  let state=State{pending:if event=="BEGIN"{Some(self.session.clone())}else{None},original:self.outstanding.clone(),original_digest:self.outstanding_digest.clone()};
  let saved=if event=="SETTLED"{self.store.append_reserved(event,state)}else{self.store.append(event,state)};
  saved.map_err(|mut failure|{failure.requires_recovery=true;failure.request_may_have_committed=self.begun;failure.original_request_id=self.outstanding.clone();failure})?;
  self.begun=event=="BEGIN";Ok(())
 }
}

#[cfg(test)]mod tests{
 use super::*;
 fn root()->PathBuf{let p=std::env::temp_dir().join(format!("pp-session-v2-{}",fresh_id()));fs::create_dir(&p).unwrap();p.join("successor")}
 fn initial()->State{State{pending:None,original:Some("retained-original".into()),original_digest:Some("b".repeat(64))}}
 fn open(p:&Path)->Store{Store::open(p,"pp_store",&"d".repeat(64),&"a".repeat(64),initial()).unwrap()}
 fn legacy_fixture()->(PathBuf,String,String){let p=root();directory(&p).unwrap();let identity="d".repeat(64);let project=project_id(&identity);(p,identity,project)}
 #[test]fn fresh_project_admission_reopens_without_inventing_an_operation(){
  let(p,identity,project)=legacy_fixture();let mut store=MigratedStore::open(&p,&identity).unwrap();
  assert_eq!(store.store.sequence(),0);assert_eq!(store.state(),&State{pending:None,original:None,original_digest:None});
  store.append("BEGIN",State{pending:Some("first-session".into()),original:None,original_digest:None}).unwrap();
  store.append("SETTLED",State{pending:None,original:None,original_digest:None}).unwrap();drop(store);
  let marker=fs::read(p.join(format!("{project}.sessions.jsonl"))).unwrap();
  let reopened=MigratedStore::open(&p,&identity).unwrap();assert_eq!(reopened.store.sequence(),2);drop(reopened);
  assert_eq!(fs::read(p.join(format!("{project}.sessions.jsonl"))).unwrap(),marker);
 }
 #[test]fn fresh_admission_serializes_with_legacy_and_prevents_downgrade(){
  let(p,identity,project)=legacy_fixture();let store=MigratedStore::open(&p,&identity).unwrap();
  assert_eq!(Guard::open(&p,&project,None).err().unwrap().code,"NATIVE_DRAFT_BUSY");
  assert!(MigratedStore::open(&p,&identity).is_err());drop(store);
  assert!(Guard::open(&p,&project,None).err().unwrap().requires_recovery);
  assert!(MigratedStore::open(&p,&identity).is_ok());
 }
 #[test]fn complete_admission_marker_resumes_but_partial_marker_is_preserved(){
  let(p,identity,project)=legacy_fixture();let marker=fresh_marker(&project,&identity).unwrap();
  fs::write(p.join(format!("{project}.sessions.jsonl")),&marker).unwrap();
  let store=MigratedStore::open(&p,&identity).unwrap();assert_eq!(store.store.sequence(),0);drop(store);
  for bytes in [vec![],marker[..marker.len()-1].to_vec()]{let(p,identity,project)=legacy_fixture();let path=p.join(format!("{project}.sessions.jsonl"));fs::write(&path,&bytes).unwrap();assert!(MigratedStore::open(&p,&identity).is_err());assert_eq!(fs::read(path).unwrap(),bytes);assert!(!p.join(format!("{project}.sessions-v2")).exists());}
 }
 #[test]fn missing_predecessor_never_recreates_existing_successor(){
  let(p,identity,project)=legacy_fixture();let store=MigratedStore::open(&p,&identity).unwrap();drop(store);
  let legacy=p.join(format!("{project}.sessions.jsonl"));fs::rename(&legacy,p.join("preserved-marker.json")).unwrap();
  assert_eq!(MigratedStore::open(&p,&identity).err().unwrap().code,"NATIVE_SESSION_STORE_LEGACY_CHANGED");assert!(!legacy.exists());
 }
 #[test]fn terminal_storage_is_reserved_before_begin_and_consumed_without_erasing_history(){
  let p=root();let mut store=open(&p);store.reserve_terminal().unwrap();
  assert_eq!(read(&p.join("terminal-event.reserve")).unwrap(),vec![0u8;4096]);
  assert_eq!(read(&p.join("terminal-head.reserve")).unwrap(),vec![0u8;4096]);
  let mut state=initial();state.pending=Some("reserved-session".into());store.append("BEGIN",state).unwrap();
  store.append_reserved("SETTLED",initial()).unwrap();assert_eq!(store.sequence(),2);assert_eq!(store.audit_history().unwrap(),2);
  assert!(!p.join("terminal-event.reserve").exists());assert!(!p.join("terminal-head.reserve").exists());
 }
 #[test]fn allocation_failure_precedes_begin_and_retains_original(){
  let p=root();let mut store=open(&p);fs::create_dir(p.join("terminal-head.reserve")).unwrap();
  assert!(store.reserve_terminal().is_err());assert_eq!(store.sequence(),0);assert_eq!(store.state(),&initial());
 }
 #[test]fn damaged_terminal_reservation_leaves_begin_pending_across_reopen(){
  let p=root();let mut store=open(&p);store.reserve_terminal().unwrap();let mut state=initial();state.pending=Some("reserved-session".into());store.append("BEGIN",state.clone()).unwrap();
  fs::write(p.join("terminal-event.reserve"),b"partial").unwrap();assert!(store.append_reserved("SETTLED",initial()).is_err());drop(store);
  let reopened=open(&p);assert_eq!(reopened.state(),&state);assert_eq!(reopened.sequence(),1);
 }
 #[test]fn migration_preserves_full_legacy_at_capacity_and_continues_successor(){
  let(p,identity,project)=legacy_fixture();let mut guard=Guard::open(&p,&project,None).unwrap();
  for _ in 0..255{guard.append("BEGIN").unwrap();guard.outstanding=initial().original;guard.outstanding_digest=initial().original_digest;guard.append("SETTLED").unwrap();}drop(guard);
  let path=p.join(format!("{project}.sessions.jsonl"));let original=fs::read(&path).unwrap();
  assert_eq!(Guard::open(&p,&project,None).err().unwrap().code,"NATIVE_DRAFT_SESSION_LIMIT");
  let mut migrated=MigratedStore::open(&p,&identity).unwrap();assert_eq!(migrated.state(),&initial());
  let mut pending=initial();pending.pending=Some("successor-session".into());migrated.append("BEGIN",pending).unwrap();migrated.append("SETTLED",initial()).unwrap();drop(migrated);
  let migrated=MigratedStore::open(&p,&identity).unwrap();assert_eq!(migrated.state(),&initial());assert_eq!(migrated.store.sequence(),2);drop(migrated);assert_eq!(fs::read(path).unwrap(),original);
 }
 #[test]fn migration_pending_begin_stays_pending_and_cannot_restart(){
  let(p,identity,project)=legacy_fixture();let mut guard=Guard::open(&p,&project,None).unwrap();let session=guard.session.clone();guard.append("BEGIN").unwrap();drop(guard);
  let mut migrated=MigratedStore::open(&p,&identity).unwrap();assert_eq!(migrated.state().pending.as_deref(),Some(session.as_str()));
  let state=migrated.state().clone();assert!(migrated.append("BEGIN",state).is_err());assert_eq!(migrated.store.sequence(),0);
 }
 #[test]fn migration_retains_legacy_lock_against_old_guard(){
  let(p,identity,project)=legacy_fixture();let mut guard=Guard::open(&p,&project,None).unwrap();guard.append("PRE_DISPATCH_REFUSED").unwrap();drop(guard);
  let migrated=MigratedStore::open(&p,&identity).unwrap();assert_eq!(Guard::open(&p,&project,None).err().unwrap().code,"NATIVE_DRAFT_BUSY");assert!(MigratedStore::open(&p,&identity).is_err());drop(migrated);
  assert!(MigratedStore::open(&p,&identity).is_ok());
 }
 #[test]fn malformed_legacy_is_preserved_without_successor_creation(){
  let valid=b"{\"schemaVersion\":1,\"sequence\":1,\"sessionId\":\"s\",\"state\":\"BEGIN\",\"outcomeRequestId\":null,\"outcomeLedgerRequestDigest\":null}\n";
  let duplicate=String::from_utf8(valid.to_vec()).unwrap().replace("\"sequence\":1","\"sequence\":1,\"sequence\":1");
  let missing=String::from_utf8(valid.to_vec()).unwrap().replace(",\"outcomeRequestId\":null","");
  let settled=String::from_utf8(valid.to_vec()).unwrap().replace("BEGIN","SETTLED");
  for data in [vec![],b"partial".to_vec(),[valid.as_slice(),b"\n"].concat(),duplicate.into_bytes(),missing.into_bytes(),settled.into_bytes()]{
   let(p,identity,project)=legacy_fixture();let path=p.join(format!("{project}.sessions.jsonl"));fs::write(&path,&data).unwrap();assert!(MigratedStore::open(&p,&identity).is_err());assert_eq!(fs::read(path).unwrap(),data);assert!(!p.join(format!("{project}.sessions-v2")).exists());
  }
 }
 #[test]fn legacy_change_after_migration_refuses_without_resetting_successor(){
  let(p,identity,project)=legacy_fixture();let mut guard=Guard::open(&p,&project,None).unwrap();guard.append("PRE_DISPATCH_REFUSED").unwrap();drop(guard);
  let migrated=MigratedStore::open(&p,&identity).unwrap();let import=fs::read(migrated.store.root.join("import.json")).unwrap();drop(migrated);
  let mut guard=Guard::open(&p,&project,None).unwrap();guard.append("PRE_DISPATCH_REFUSED").unwrap();drop(guard);
  assert!(MigratedStore::open(&p,&identity).is_err());assert_eq!(fs::read(p.join(format!("{project}.sessions-v2/import.json"))).unwrap(),import);
 }
 #[test]fn successor_exceeds_old_ceiling_and_retains_immutable_import(){
  let p=root();let mut s=open(&p);let import=read(&p.join("import.json")).unwrap();
  for i in 0..300{let mut state=s.state().clone();state.pending=Some(format!("session-{i}"));s.append("BEGIN",state).unwrap();s.append("SETTLED",initial()).unwrap();drop(s);s=open(&p);}
  assert_eq!(s.sequence(),600);assert_eq!(s.state(),&initial());assert_eq!(read(&p.join("import.json")).unwrap(),import);
  for n in 1..=600{assert_eq!(s.load(n).unwrap().sequence,n);}
  assert_eq!(s.audit_history().unwrap(),600);
 }
 #[test]fn complete_record_lost_index_reply_reopens_pending_not_finished(){
  let p=root();let mut s=open(&p);let mut state=initial();state.pending=Some("pending-session".into());
  assert!(s.append_with("BEGIN",state.clone(),||Err(error("INJECTED_STOP"))).is_err());assert!(s.append("SETTLED",initial()).is_err());drop(s);
  let mut reopened=open(&p);assert_eq!(reopened.state(),&state);assert_eq!(reopened.sequence(),1);assert!(reopened.append("BEGIN",state).is_err());
 }
 #[test]fn settled_record_lost_index_reply_retains_exact_new_obligation(){
  let p=root();let mut s=open(&p);let mut pending=initial();pending.pending=Some("session".into());s.append("BEGIN",pending).unwrap();
  let state=State{pending:None,original:Some("new-original".into()),original_digest:Some("c".repeat(64))};
  assert!(s.append_with("SETTLED",state.clone(),||Err(error("INJECTED_STOP"))).is_err());drop(s);assert_eq!(open(&p).state(),&state);
 }
 #[test]fn concurrent_store_open_refuses_and_legacy_changes_do_not_reset(){
  let p=root();let s=open(&p);assert!(Store::open(&p,"pp_store",&"d".repeat(64),&"a".repeat(64),initial()).is_err());drop(s);
  assert!(Store::open(&p,"pp_store",&"d".repeat(64),&"f".repeat(64),initial()).is_err());assert_eq!(open(&p).sequence(),0);
 }
 #[test]fn partial_successor_is_preserved_and_blocks_reopen(){
  let p=root();let s=open(&p);let path=s.record_path(1);directory(&p.join("events")).unwrap();directory(path.parent().unwrap()).unwrap();fs::write(&path,b"{partial").unwrap();drop(s);
  assert!(Store::open(&p,"pp_store",&"d".repeat(64),&"a".repeat(64),initial()).is_err());assert_eq!(fs::read(path).unwrap(),b"{partial");
 }
 #[test]fn missing_import_and_corrupt_head_never_initialize_fresh_state(){
  let p=root();drop(open(&p));let import=fs::read(p.join("import.json")).unwrap();fs::write(p.join("head.json"),b"corrupt").unwrap();assert!(Store::open(&p,"pp_store",&"d".repeat(64),&"a".repeat(64),initial()).is_err());assert_eq!(fs::read(p.join("import.json")).unwrap(),import);
  let p=root();drop(open(&p));fs::rename(p.join("import.json"),p.join("retained-import.json")).unwrap();assert!(Store::open(&p,"pp_store",&"d".repeat(64),&"a".repeat(64),initial()).is_err());
 }
 #[test]fn historical_audit_detects_old_corruption_without_claiming_a_full_audit_on_open(){
  let p=root();let mut s=open(&p);for i in 0..3{let mut state=initial();state.pending=Some(format!("s-{i}"));s.append("BEGIN",state).unwrap();s.append("SETTLED",initial()).unwrap();}
  let path=s.record_path(1);fs::write(path,b"corrupt").unwrap();drop(s);let s=open(&p);assert!(s.audit_history().is_err());assert_eq!(s.sequence(),6);
 }

 #[test]fn root_rebinding_refuses_without_changing_retained_files(){
  let p=root();let mut s=open(&p);let mut pending=initial();pending.pending=Some("bound-session".into());s.append("BEGIN",pending.clone()).unwrap();
  let import=read(&p.join("import.json")).unwrap();let head=read(&p.join("head.json")).unwrap();let event_path=s.record_path(1);let event=read(&event_path).unwrap();drop(s);
  assert!(Store::open(&p,"pp_store",&"e".repeat(64),&"a".repeat(64),initial()).is_err());
  assert_eq!(read(&p.join("import.json")).unwrap(),import);assert_eq!(read(&p.join("head.json")).unwrap(),head);assert_eq!(read(&event_path).unwrap(),event);
  assert_eq!(open(&p).state(),&pending);
 }
 #[test]fn invalid_root_identity_refuses_before_creating_store(){
  let p=root();assert!(Store::open(&p,"pp_store","not-an-identity",&"a".repeat(64),initial()).is_err());assert!(!p.exists());
 }
 #[test]fn foreign_root_head_and_event_cannot_be_adopted(){
  let p=root();let mut s=open(&p);let mut pending=initial();pending.pending=Some("bound-session".into());s.append("BEGIN",pending).unwrap();
  let path=s.record_path(1);let mut foreign=s.current.clone();foreign.root_identity="e".repeat(64);let data=bytes(&foreign).unwrap();drop(s);
  fs::write(&path,&data).unwrap();fs::write(p.join("head.json"),&data).unwrap();
  assert!(Store::open(&p,"pp_store",&"d".repeat(64),&"a".repeat(64),initial()).is_err());assert_eq!(read(&path).unwrap(),data);
 }
}
