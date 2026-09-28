//! Bounded owner journal references. No output reads or task-success claims.
use super::*;
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TaskResultIndexRequest{identity:InspectRequest,offset:u32,expected_head_digest:Option<String>}
fn valid(offset:u32,head:Option<&str>)->bool{offset<=2048&&match head{Some("GENESIS")=>true,Some(v)=>digest(v),None=>offset==0}}
pub(super) async fn perform(app:tauri::AppHandle,r:TaskResultIndexRequest)->Result<Value,DraftError>{
 validate(&r.identity)?;if !valid(r.offset,r.expected_head_digest.as_deref()){return Err(error("NATIVE_TASK_INDEX_INVALID"));}
 perform_read(app,r.identity,ReadOperation::Index{offset:r.offset,expected:r.expected_head_digest}).await
}
pub(super) async fn perform_page(app:tauri::AppHandle,r:TaskResultIndexRequest)->Result<Value,DraftError>{
 validate(&r.identity)?;if !valid(r.offset,r.expected_head_digest.as_deref()){return Err(error("NATIVE_TASK_INDEX_INVALID"));}
 perform_read(app,r.identity,ReadOperation::Page{offset:r.offset,expected:r.expected_head_digest}).await
}
pub(super) fn project_page(value:Value,binding:&Binding,offset:u32,wanted:Option<&str>)->Result<Value,DraftError>{
 let invalid=||error("NATIVE_TASK_RESULT_INVALID");
 if !value.as_object().is_some_and(|o|o.len()==2&&o.contains_key("page")&&o.contains_key("outcomes")){return Err(invalid());}
 let page=project(value["page"].clone(),binding,offset,wanted)?;
 let rows:Vec<&Value>=page["entries"].as_array().ok_or_else(invalid)?.iter().filter(|r|!r["runId"].is_null()).collect();
 let outcomes=value["outcomes"].as_array().ok_or_else(invalid)?;if rows.len()!=outcomes.len(){return Err(invalid());}
 let mut projected=Vec::new();
 for(row,o)in rows.iter().zip(outcomes){
  if !o.as_object().is_some_and(|v|v.len()==3&&["grantId","phase","value"].iter().all(|k|v.contains_key(*k)))||o["grantId"]!=row["grantId"]{return Err(invalid());}
  if o["phase"]=="unavailable"{if !o["value"].is_null(){return Err(invalid());}projected.push(o.clone());continue;}
  if o["phase"]!="ready"{return Err(invalid());}
  let summary=project_result(o["value"].clone(),binding,row["grantId"].as_str().ok_or_else(invalid)?)?;
  if ["grantId","runId","taskId","checkId","attemptId","attemptNumber","workerId","intentDigest"].iter().any(|k|summary[*k]!=row[*k])||(!row["artifactDigest"].is_null()&&summary["artifactDigest"]!=row["artifactDigest"]){return Err(invalid());}
  projected.push(json!({"grantId":o["grantId"],"phase":"ready","value":summary}));
 }
 Ok(json!({"page":page,"outcomes":projected,"binding":binding,"transportCleanupComplete":true}))
}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct JournalHead{revision:u32,head_digest:String}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Entry{grant_id:String,task_id:String,check_id:String,attempt_id:String,attempt_number:u64,worker_id:String,lifecycle_state:String,journal_revision:u32,recorded_at:String,run_id:Option<String>,intent_digest:Option<String>,artifact_digest:Option<String>}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Page{schema_version:u32,kind:String,project_id:String,root_identity:String,journal_head:JournalHead,offset:u32,total_grants:u32,next_offset:Option<u32>,entries:Vec<Entry>,authority_verified:bool,execution_authorized:bool}
pub(super) fn project(value:Value,binding:&Binding,offset:u32,wanted:Option<&str>)->Result<Value,DraftError>{
 let invalid=||error("NATIVE_TASK_INDEX_INVALID");
 if !valid(offset,wanted)||!value.as_object().is_some_and(|o|o.len()==11&&o.contains_key("nextOffset"))||!value["entries"].as_array().is_some_and(|rows|rows.len()<=20&&rows.iter().all(|row|row.as_object().is_some_and(|o|o.len()==12&&["runId","intentDigest","artifactDigest"].iter().all(|k|o.contains_key(*k))))){return Err(invalid());}
 let page:Page=serde_json::from_value(value).map_err(|_|invalid())?;let h=&page.journal_head;
 if page.schema_version!=1||page.kind!="NATIVE_TASK_RESULT_INDEX"||page.project_id!=binding.project_id||page.root_identity!=binding.root_identity||page.offset!=offset
  ||h.revision>2048||(if h.revision==0{h.head_digest!="GENESIS"}else{!digest(&h.head_digest)})||wanted.is_some_and(|s|s!=h.head_digest)
  ||page.total_grants>h.revision||offset>page.total_grants||page.entries.len()as u32!=20.min(page.total_grants-offset)
  ||page.next_offset!=if offset+(page.entries.len()as u32)<page.total_grants{Some(offset+page.entries.len()as u32)}else{None}
  ||page.authority_verified||page.execution_authorized{return Err(invalid());}
 let mut last=h.revision+1;let mut ids=std::collections::HashSet::new();
 for row in &page.entries{
  let task=row.task_id.as_bytes();let phase=row.lifecycle_state.as_str();
  if !uuid(&row.grant_id)||!ids.insert(&row.grant_id)||!(5..=7).contains(&task.len())||task[0]!=b'T'||!task[1..].iter().all(u8::is_ascii_digit)
   ||[&row.check_id,&row.attempt_id,&row.worker_id].iter().any(|s|!request_token(s))||row.attempt_number==0||row.attempt_number>9_007_199_254_740_991
   ||row.journal_revision==0||row.journal_revision>=last||!matches!(phase,"issued"|"consumed"|"intent-recorded"|"result-recorded"|"revoked")
   ||!chrono::DateTime::parse_from_rfc3339(&row.recorded_at).ok().is_some_and(|t|t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)==row.recorded_at){return Err(invalid());}
  last=row.journal_revision;
  if matches!(phase,"intent-recorded"|"result-recorded"){if !row.run_id.as_deref().is_some_and(uuid)||!row.intent_digest.as_deref().is_some_and(digest){return Err(invalid());}}
  else if row.run_id.is_some()||row.intent_digest.is_some(){return Err(invalid());}
  if phase=="result-recorded"{if !row.artifact_digest.as_deref().is_some_and(digest){return Err(invalid());}}else if row.artifact_digest.is_some(){return Err(invalid());}
 }
 let mut output=serde_json::to_value(page).map_err(|_|invalid())?;output["binding"]=json!(binding);output["transportCleanupComplete"]=json!(true);Ok(output)
}
#[cfg(test)]mod tests{
 use super::*;
 fn binding()->Binding{Binding{project_id:"pp_index".into(),root_identity:"a".repeat(64),census_digest:"b".repeat(64)}}
 fn page()->Value{json!({"schemaVersion":1,"kind":"NATIVE_TASK_RESULT_INDEX","projectId":"pp_index","rootIdentity":"a".repeat(64),"journalHead":{"revision":1,"headDigest":"c".repeat(64)},"offset":0,"totalGrants":1,"nextOffset":null,"entries":[{"grantId":"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa","taskId":"T0001","checkId":"unit","attemptId":"attempt1","attemptNumber":1,"workerId":"worker1","lifecycleState":"issued","journalRevision":1,"recordedAt":"2026-09-14T00:00:00.000Z","runId":null,"intentDigest":null,"artifactDigest":null}],"authorityVerified":false,"executionAuthorized":false})}
 #[test]fn native_index_projects_reference_without_inventing_execution(){let p=project(page(),&binding(),0,None).unwrap();assert_eq!(p["entries"][0]["lifecycleState"],"issued");assert_eq!(p["executionAuthorized"],false);assert_eq!(p["entries"][0]["runId"],Value::Null);}
 #[test]fn native_index_refuses_inconsistent_pages_and_foreign_binding(){for patch in [json!({"projectId":"other"}),json!({"authorityVerified":true}),json!({"nextOffset":1}),json!({"totalGrants":2}),json!({"offset":1}),json!({"credentials":"secret"})]{let mut p=page();for(k,v)in patch.as_object().unwrap(){p[k]=v.clone();}assert!(project(p,&binding(),0,None).is_err());}assert!(project(page(),&binding(),0,Some(&"f".repeat(64))).is_err());}
 #[test]fn native_index_refuses_fabricated_rows(){for patch in [json!({"lifecycleState":"passed"}),json!({"journalRevision":2}),json!({"runId":"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"}),json!({"recordedAt":"yesterday"}),json!({"sessionId":"secret"}),json!({"lifecycleState":"result-recorded"})]{let mut p=page();for(k,v)in patch.as_object().unwrap(){p["entries"][0][k]=v.clone();}assert!(project(p,&binding(),0,None).is_err());}}
 #[test]fn native_index_requires_head_pinned_continuation(){assert!(valid(0,None));assert!(!valid(20,None));assert!(!valid(2049,Some(&"a".repeat(64))));assert!(valid(20,Some(&"a".repeat(64))));}
}
