//! Fixed private helper, not an authenticated renderer/MCP endpoint.
//! Only a verified destruction receipt is written to stdout.
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::io::{Read,Write};
use std::sync::mpsc;
use std::time::Duration;
use crate::native_review_window::{open_review,ReviewDisplay,ReviewDecision};

const CONTENT_LIMIT:usize=2*1024*1024;
// Worst-case JSON escaping of the bounded UTF8 content plus envelope.
const INPUT_LIMIT:usize=CONTENT_LIMIT*6+4096;
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Request { version:u32,request_id:String,proposal_digest:String,check_contract_digest:String,display_digest:String,content:String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Receipt { version:u32,request_id:String,proposal_digest:String,check_contract_digest:String,display_digest:String,instance_id:String,decision:&'static str,destroyed:bool,human_verified:bool }

fn decode(bytes:&[u8])->Result<ReviewDisplay,&'static str>{
    if bytes.len()>INPUT_LIMIT{return Err("PRESENTER_INPUT_LIMIT");}
    let request:Request=serde_json::from_slice(bytes).map_err(|_|"PRESENTER_REQUEST_INVALID")?;
    if request.version!=1||request.content.is_empty()||request.content.len()>CONTENT_LIMIT{return Err("PRESENTER_REQUEST_INVALID");}
    let observed=format!("{:x}",Sha256::digest(request.content.as_bytes()));
    if observed!=request.display_digest{return Err("PRESENTER_DISPLAY_DIGEST_MISMATCH");}
    // The hash binds the exact bytes supplied by the configured Node host.
    // No Rust reserialization is used to guess JavaScript canonical ordering.
    let body:serde_json::Value=serde_json::from_str(&request.content).map_err(|_|"PRESENTER_DISPLAY_INVALID")?;
    if !body.is_object()||body["requestId"]!=request.request_id||body["subject"]["proposalDigest"]!=request.proposal_digest||body["subject"]["checkContractDigest"]!=request.check_contract_digest{return Err("PRESENTER_DISPLAY_BINDING_MISMATCH");}
    Ok(ReviewDisplay{request_id:request.request_id,proposal_digest:request.proposal_digest,check_contract_digest:request.check_contract_digest,display_digest:request.display_digest,content:request.content})
}

pub fn run_stdio()->Result<(),&'static str>{
    let (sender,receiver)=mpsc::sync_channel(1);
    std::thread::Builder::new().name("native-review-input".into()).spawn(move||{
        let mut bytes=Vec::new();
        let result=std::io::stdin().lock().take((INPUT_LIMIT+1) as u64).read_to_end(&mut bytes).map_err(|_|"PRESENTER_INPUT_FAILED").and_then(|_|decode(&bytes));
        let _=sender.send(result);
    }).map_err(|_|"PRESENTER_INPUT_THREAD_FAILED")?;
    // One object followed by EOF. A blocked peer cannot hold the helper forever.
    let display=receiver.recv_timeout(Duration::from_secs(5)).map_err(|_|"PRESENTER_INPUT_TIMEOUT")??;
    let window=open_review(display)?;
    let instance=window.instance_id().to_owned();
    // Reserve input/startup and destruction time within the parent's 120s cap.
    let receipt=match window.wait(Duration::from_secs(90)){
        Ok(receipt)=>receipt,
        Err(_)=>{window.cancel()?;window.wait(Duration::from_secs(10)).map_err(|_|"PRESENTER_CLOSURE_UNCONFIRMED")?}
    };
    if !receipt.destroyed||receipt.instance_id!=instance{return Err("PRESENTER_CLOSURE_UNCONFIRMED");}
    let output=Receipt{version:1,request_id:receipt.request_id,proposal_digest:receipt.proposal_digest,check_contract_digest:receipt.check_contract_digest,display_digest:receipt.display_digest,instance_id:receipt.instance_id,decision:match receipt.decision{ReviewDecision::Approve=>"approved",ReviewDecision::Reject=>"rejected",ReviewDecision::Cancel=>"cancelled"},destroyed:true,human_verified:false};
    let encoded=serde_json::to_vec(&output).map_err(|_|"PRESENTER_RESPONSE_FAILED")?;
    let mut stdout=std::io::stdout().lock();stdout.write_all(&encoded).and_then(|_|stdout.write_all(b"\n")).and_then(|_|stdout.flush()).map_err(|_|"PRESENTER_OUTPUT_FAILED")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request()->serde_json::Value{
        let body=serde_json::json!({"requestId":"r1","subject":{"proposalDigest":"a".repeat(64),"checkContractDigest":"b".repeat(64)},"ledger":{"tasks":[{"title":"Full task"}]}}).to_string();
        serde_json::json!({"version":1,"requestId":"r1","proposalDigest":"a".repeat(64),"checkContractDigest":"b".repeat(64),"displayDigest":format!("{:x}",Sha256::digest(body.as_bytes())),"content":body})
    }
    #[test]fn accepts_exact_display_bytes(){let value=request();let decoded=decode(&serde_json::to_vec(&value).unwrap()).unwrap();assert_eq!(decoded.content,value["content"].as_str().unwrap());}
    #[test]fn refuses_unknown_fields(){let mut value=request();value["actor"]=serde_json::json!("spoof");assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());}
    #[test]fn refuses_changed_content(){let mut value=request();value["content"]=serde_json::json!("{}");assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());}
    #[test]fn refuses_foreign_binding(){let mut value=request();value["proposalDigest"]=serde_json::json!("d".repeat(64));assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());}
    #[test]fn refuses_trailing_objects(){let value=request().to_string()+"{}";assert!(decode(value.as_bytes()).is_err());}
}
