import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export function useBrowserInputMarkerControl(project){
  const key=JSON.stringify([project?.projectId,project?.generation,project?.registration?.rootIdentity,project?.registration?.registryRevision]);
  const scope=useRef({key,epoch:0});
  if(scope.current.key!==key)scope.current={key,epoch:scope.current.epoch+1};
  const epoch=scope.current.epoch;
  const [choice,setChoice]=useState(null);
  return {enabled:!!project?.projectId&&choice?.key===key&&choice?.epoch===epoch&&choice.enabled,
    scope:`${key}:${epoch}`,available:!!project?.projectId,
    setEnabled:enabled=>setChoice({key,epoch,enabled:enabled===true})};
}

export function BrowserInputMarkerControl({control}){
  if(!control)return null;
  return <section className="runtime-capability-card" aria-label="Browser input visibility">
    <strong>Show browser input</strong>
    <label style={{display:'flex',gap:12,alignItems:'center',minHeight:44,fontSize:14}}><input type="checkbox" checked={control.enabled} disabled={!control.available} onChange={e=>control.setEnabled(e.target.checked)}/> Show pointer and press markers</label>
    <p>Watch real input inside Planner, including browser-tool input. The browser cannot identify whether it came from you or an agent. Markers do not grant control or prove that an action succeeded.</p>
    <small>Off by default. This window and project only. No typed text, field values or input history is saved.</small>
  </section>;
}

export function BrowserInputMarkers({enabled,scope,onDisable}){
  const [point,setPoint]=useState(null);
  useEffect(()=>{
    setPoint(null);
    if(!enabled)return;
    let frame=0,timer=0,latest=null,disposed=false;
    const media=window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const clear=()=>{cancelAnimationFrame(frame);clearTimeout(timer);frame=0;latest=null;if(!disposed)setPoint(null);};
    const observe=event=>{
      // isTrusted excludes script dispatch, but is NOT proof of human or agent identity.
      if(!event.isTrusted||document.visibilityState==='hidden')return;
      if(event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')){clear();return;}
      if(event.type==='pointermove'&&media?.matches)return;
      if(!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY)||event.clientX<0||event.clientY<0||event.clientX>=window.innerWidth||event.clientY>=window.innerHeight){clear();return;}
      latest={x:event.clientX,y:event.clientY,kind:event.type==='pointerdown'?'Press':'Pointer'};
      if(!frame)frame=requestAnimationFrame(()=>{frame=0;if(!disposed)setPoint(latest);});
      clearTimeout(timer);timer=setTimeout(clear,1200);
    };
    window.addEventListener('pointermove',observe,true);
    window.addEventListener('pointerdown',observe,true);
    window.addEventListener('blur',clear);
    window.addEventListener('resize',clear);
    document.addEventListener('visibilitychange',clear);
    media?.addEventListener?.('change',clear);
    return()=>{clear();disposed=true;window.removeEventListener('pointermove',observe,true);window.removeEventListener('pointerdown',observe,true);window.removeEventListener('blur',clear);window.removeEventListener('resize',clear);document.removeEventListener('visibilitychange',clear);media?.removeEventListener?.('change',clear);};
  },[enabled,scope]);
  if(!enabled)return null;
  return createPortal(<>
    <div style={{position:'fixed',bottom:48,left:24,zIndex:10000,maxWidth:'calc(100vw - 48px)',boxSizing:'border-box',background:'#343e3b',color:'white',borderRadius:12,padding:'8px 12px',font:'14px/1.4 system-ui',boxShadow:'0 3px 12px #0003'}}>
      Input markers on · source unverified <button type="button" onClick={onDisable} style={{marginLeft:12,minHeight:44,font:'inherit',color:'#25312d',background:'#fff'}}>Hide input markers</button>
    </div>
    {point&&<div data-browser-input-marker={point.kind.toLowerCase()} aria-hidden="true" style={{position:'fixed',left:point.x,top:point.y,zIndex:10001,pointerEvents:'none'}}>
      <span style={{display:'block',position:'absolute',width:point.kind==='Press'?24:12,height:point.kind==='Press'?24:12,transform:'translate(-50%,-50%)',border:'2px solid #9a581c',borderRadius:'50%',background:'#f6bb7866',boxShadow:'0 0 0 3px #fff9'}}/>
      <span style={{position:'fixed',left:Math.max(8,Math.min(point.x+18,window.innerWidth-220)),top:Math.max(8,Math.min(point.y+18,window.innerHeight-38)),background:'#343e3b',color:'white',padding:'4px 8px',borderRadius:6,font:'13px/1.4 system-ui',whiteSpace:'nowrap'}}>{point.kind} · source unverified</span>
    </div>}
  </>,document.body);
}
