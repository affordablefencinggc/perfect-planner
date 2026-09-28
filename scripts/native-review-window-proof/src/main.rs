#[path = "../../../src-tauri/src/native_review_window.rs"]
mod native_review_window;
#[path = "../../../src-tauri/src/native_review_presenter.rs"]
mod native_review_presenter;
use native_review_window::*;
use std::time::Duration;
fn main(){
    let arguments=std::env::args().skip(1).collect::<Vec<_>>();
    if arguments==["--presenter"]{if let Err(code)=native_review_presenter::run_stdio(){eprintln!("{code}");std::process::exit(2);}return;}
    // The installed presenter runs with a deliberately minimal environment.
    // Host admission belongs only to the standalone qualification mode below.
    assert_eq!(std::env::var("COMPUTERNAME").unwrap_or_default().to_lowercase(),"dans1","DANS1 only");
    assert!(arguments.is_empty(),"Unsupported harness arguments");
    let display=ReviewDisplay{request_id:"native-window-proof".into(),proposal_digest:"a".repeat(64),check_contract_digest:"b".repeat(64),display_digest:"c".repeat(64),content:(0..1000).map(|i|format!("Task {i}: complete scope and acceptance checks; retain all work.\n")).collect()};
    let window=open_review(display).expect("native window creation");
    let instance=window.instance_id().to_owned();
    // No approval is simulated. Exercise cancellation and destruction only.
    window.cancel().expect("send exact-window cancellation");
    let receipt=window.wait(Duration::from_secs(10)).expect("native destruction acknowledgement");
    assert_eq!(receipt.decision,ReviewDecision::Cancel);assert!(receipt.destroyed);assert!(!receipt.human_verified);
    assert_eq!(receipt.request_id,"native-window-proof");assert_eq!(receipt.proposal_digest,"a".repeat(64));assert_eq!(receipt.check_contract_digest,"b".repeat(64));
    assert_eq!(receipt.display_digest,"c".repeat(64));assert_eq!(receipt.instance_id,instance);
    println!("DANS1 native cancellation/destruction passed; no human approval proof");
}
