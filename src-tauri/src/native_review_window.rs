//! Private Windows-owned review window. No renderer decision endpoint.
//! A native button notification is NOT proof of a human (automation can send it).
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::time::Duration;
use std::sync::atomic::{AtomicU64,Ordering};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewDisplay { pub request_id:String, pub proposal_digest:String, pub check_contract_digest:String, pub display_digest:String, pub content:String }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewDecision { Approve, Reject, Cancel }
#[derive(Clone, Debug)]
pub struct WindowReceipt { pub request_id:String, pub proposal_digest:String, pub check_contract_digest:String, pub display_digest:String, pub instance_id:String, pub decision:ReviewDecision, pub destroyed:bool, pub human_verified:bool }
pub struct ReviewWindow { cancel:SyncSender<()>, result:Receiver<Result<WindowReceipt,&'static str>>, instance_id:String }
impl ReviewWindow {
    pub fn cancel(&self)->Result<(), &'static str>{match self.cancel.try_send(()){Ok(())|Err(TrySendError::Full(()))=>Ok(()),Err(TrySendError::Disconnected(()))=>Err("REVIEW_THREAD_UNAVAILABLE")}}
    pub fn wait(&self, timeout:Duration)->Result<WindowReceipt,&'static str>{self.result.recv_timeout(timeout).map_err(|_|"REVIEW_CLOSURE_UNCONFIRMED")?}
    pub fn instance_id(&self)->&str{&self.instance_id}
}
impl Drop for ReviewWindow { fn drop(&mut self){let _=self.cancel.try_send(());} }
fn valid(display:&ReviewDisplay)->bool {
    let hash=|s:&str|s.len()==64&&s.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c));
    !display.request_id.is_empty()&&display.request_id.len()<=128&&display.request_id.bytes().all(|c|c.is_ascii_alphanumeric()||b"._:-".contains(&c))&&hash(&display.proposal_digest)&&hash(&display.check_contract_digest)&&hash(&display.display_digest)&&!display.content.contains('\0')&&!display.content.is_empty()&&display.content.len()<=2*1024*1024
}
pub fn open_review(display:ReviewDisplay)->Result<ReviewWindow,&'static str>{
    if !valid(&display){return Err("REVIEW_DISPLAY_INVALID");}
    static NEXT:AtomicU64=AtomicU64::new(1);
    let serial=NEXT.fetch_update(Ordering::SeqCst,Ordering::SeqCst,|value|value.checked_add(1)).map_err(|_|"REVIEW_INSTANCE_EXHAUSTED")?;
    // Correlation, not a secret or authentication credential.
    let instance_id=format!("{}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"REVIEW_CLOCK_INVALID")?.as_nanos(),serial);
    let native_instance=instance_id.clone();
    let (cancel,requests)=mpsc::sync_channel(1);let (send,result)=mpsc::channel();
    std::thread::Builder::new().name("planner-native-review".into()).spawn(move||{let _=send.send(platform::run(display,requests,native_instance));}).map_err(|_|"REVIEW_THREAD_FAILED")?;
    Ok(ReviewWindow{cancel,result,instance_id})
}

#[cfg(not(windows))]
mod platform { use super::*;pub fn run(_:ReviewDisplay,_:Receiver<()>,_:String)->Result<WindowReceipt,&'static str>{Err("REVIEW_WINDOWS_REQUIRED")} }
#[cfg(windows)]
mod platform {
    use super::*;
    use std::ptr::{null,null_mut};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    struct State { display:ReviewDisplay, cancel:Receiver<()>, decision:ReviewDecision, destroyed:bool, edit:HWND, buttons:[HWND;3] }
    struct StateOwner(*mut State);
    impl Drop for StateOwner {
        fn drop(&mut self){unsafe{
            // A failed destruction must never leave window userdata pointing
            // into freed memory. Retain allocation on that exceptional path.
            // The caller receives closure-unconfirmed, not a clean result.
            if (*self.0).destroyed{drop(Box::from_raw(self.0));}
        }}
    }
    fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
    unsafe extern "system" fn procedure(hwnd:HWND,msg:u32,w:WPARAM,l:LPARAM)->LRESULT{
        if msg==WM_NCCREATE {let create=&*(l as *const CREATESTRUCTW);SetWindowLongPtrW(hwnd,GWLP_USERDATA,create.lpCreateParams as isize);}
        let pointer=GetWindowLongPtrW(hwnd,GWLP_USERDATA) as *mut State;
        if pointer.is_null(){return DefWindowProcW(hwnd,msg,w,l);}
        match msg {
            // Read/copy fields through the raw pointer; no State reference is
            // held across Win32 calls, which can synchronously reenter here.
            WM_COMMAND=>{let id=w&0xffff;let notification=(w>>16)&0xffff;let buttons=(*pointer).buttons;if notification==0&&(1..=3).contains(&id)&&l as HWND==buttons[id-1]{(*pointer).decision=match id{1=>ReviewDecision::Approve,2=>ReviewDecision::Reject,_=>ReviewDecision::Cancel};DestroyWindow(hwnd);}0},
            WM_TIMER=>{let cancelled=(*pointer).cancel.try_recv().is_ok();if cancelled{(*pointer).decision=ReviewDecision::Cancel;DestroyWindow(hwnd);}0},
            WM_CLOSE=>{(*pointer).decision=ReviewDecision::Cancel;DestroyWindow(hwnd);0},
            WM_SIZE=>{let width=(l as u32&0xffff) as i32;let height=((l as u32>>16)&0xffff) as i32;let edit=(*pointer).edit;let buttons=(*pointer).buttons;if !edit.is_null(){MoveWindow(edit,12,12,(width-24).max(100),(height-76).max(60),1);for (index,button) in buttons.iter().enumerate(){MoveWindow(*button,12+index as i32*140,(height-52).max(80),130,34,1);}}0},
            WM_NCDESTROY=>{(*pointer).destroyed=true;SetWindowLongPtrW(hwnd,GWLP_USERDATA,0);PostQuitMessage(0);DefWindowProcW(hwnd,msg,w,l)},
            _=>DefWindowProcW(hwnd,msg,w,l)
        }
    }
    pub fn run(display:ReviewDisplay,cancel:Receiver<()>,instance_id:String)->Result<WindowReceipt,&'static str>{unsafe{
        let instance=GetModuleHandleW(null());if instance.is_null(){return Err("REVIEW_MODULE_FAILED");}
        let name=wide("PerfectPlannerNativeReviewV1");
        let class=WNDCLASSW{lpfnWndProc:Some(procedure),hInstance:instance,lpszClassName:name.as_ptr(),hCursor:LoadCursorW(null_mut(),IDC_ARROW),..std::mem::zeroed()};
        // Re-registering the same fixed class in this process is harmless.
        if RegisterClassW(&class)==0&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS{return Err("REVIEW_CLASS_FAILED");}
        let state=Box::into_raw(Box::new(State{display,cancel,decision:ReviewDecision::Cancel,destroyed:false,edit:null_mut(),buttons:[null_mut();3]}));
        let _owner=StateOwner(state);
        let title=wide("Perfect Planner — review exact tasks (approval is not execution)");
        let hwnd=CreateWindowExW(0,name.as_ptr(),title.as_ptr(),WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,1000,760,null_mut(),null_mut(),instance,state.cast());
        if hwnd.is_null(){(*state).destroyed=true;return Err("REVIEW_WINDOW_FAILED");}
        let edit_class=wide("EDIT");
        let edit=CreateWindowExW(WS_EX_CLIENTEDGE,edit_class.as_ptr(),wide("").as_ptr(),WS_CHILD|WS_VISIBLE|WS_VSCROLL|WS_HSCROLL|ES_MULTILINE as u32|ES_READONLY as u32|ES_AUTOVSCROLL as u32|ES_AUTOHSCROLL as u32,12,12,950,650,hwnd,null_mut(),instance,null());
        (*state).edit=edit;
        let full=format!("Request: {}\r\nProposal: {}\r\nChecks: {}\r\nDisplay: {}\r\n\r\n{}",(*state).display.request_id,(*state).display.proposal_digest,(*state).display.check_contract_digest,(*state).display.display_digest,(*state).display.content.replace('\n',"\r\n"));
        let text=wide(&full);
        // EM_SETLIMITTEXT; verify all UTF-16 units were retained, never truncate.
        SendMessageW(edit,0x00c5,text.len(),0);
        if edit.is_null()||SetWindowTextW(edit,text.as_ptr())==0||GetWindowTextLengthW(edit) as usize!=text.len()-1{DestroyWindow(hwnd);return Err(if (*state).destroyed{"REVIEW_CONTENT_INCOMPLETE"}else{"REVIEW_CLOSURE_UNCONFIRMED"});}
        for (index,label) in ["Approve","Reject","Cancel"].iter().enumerate(){let button=CreateWindowExW(0,wide("BUTTON").as_ptr(),wide(label).as_ptr(),WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON as u32,12+index as i32*140,680,130,34,hwnd,(index+1) as HMENU,instance,null());(*state).buttons[index]=button;}
        let missing=(*state).buttons.iter().any(|button|button.is_null());
        if missing||SetTimer(hwnd,1,50,None)==0{DestroyWindow(hwnd);return Err(if (*state).destroyed{"REVIEW_CONTROLS_FAILED"}else{"REVIEW_CLOSURE_UNCONFIRMED"});}
        let cancelled=(*state).cancel.try_recv().is_ok();
        if cancelled{DestroyWindow(hwnd);if !(*state).destroyed{return Err("REVIEW_CLOSURE_UNCONFIRMED");}}else{ShowWindow(hwnd,SW_SHOW);}
        let mut message:MSG=std::mem::zeroed();
        while !(*state).destroyed {let got=GetMessageW(&mut message,null_mut(),0,0);if got<=0{if !(*state).destroyed{DestroyWindow(hwnd);}break;}if IsDialogMessageW(hwnd,&message)==0{TranslateMessage(&message);DispatchMessageW(&message);}}
        if !(*state).destroyed{return Err("REVIEW_CLOSURE_UNCONFIRMED");}
        Ok(WindowReceipt{request_id:(*state).display.request_id.clone(),proposal_digest:(*state).display.proposal_digest.clone(),check_contract_digest:(*state).display.check_contract_digest.clone(),display_digest:(*state).display.display_digest.clone(),instance_id,decision:(*state).decision,destroyed:(*state).destroyed,human_verified:false})
    }}
}
