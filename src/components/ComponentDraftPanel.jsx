import React,{useEffect,useId,useRef,useState}from'react';
import{assessComponentPlans,componentPlanKinds}from'../engine/componentPlanEngine.js';
import{assessComponentFolderScope}from'../engine/componentFolderScope.js';
import{blankComponent,componentDraftInput,componentDraftKey,encodeComponentDraft,parentBinding,rebindComponentDraft,restoreComponentDraft,sameComponentParents,savedCatalogDraft,COMPONENT_DRAFT_COMPONENT_LIMIT}from'../engine/componentDraftModel.js';
import{readComponentContext,publishComponentDraft}from'../runtime/componentClient.js';
import{useViewMode}from'../project/viewMode.js';
import'./ComponentDraftPanel.css';
// Field labels come from code keys; say them as words ("taskId" -> "Task ID").
const LABELS={id:'ID',taskId:'Task ID',componentId:'Component ID',folderNodeId:'Folder',estimateHours:'Estimate (hours)',notThis:'Not this',nonResponsibilities:'Not responsible for',sourceOfTruth:'Source of truth',diffRequired:'Diff required',screenshotRequired:'Screenshot required',updatedAt:'Last updated'};
const words=value=>value.replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().replace(/\bid\b/g,'ID');
const title=value=>LABELS[value]??words(value).replace(/^./,v=>v.toUpperCase());
// One-line answers get a one-line input; descriptions keep a textarea.
const SHORT_FIELDS=new Set(['name','scopeLabel','owner','reviewer','taskId','id','componentId','version','path','convention','classification','retention','entry','exit','trigger','sourceOfTruth','firstAction']);
// Simple view: plain sentences for the engine's field-path messages. Advanced
// view keeps the exact engine text. Unknown messages only lose their code keys.
export function plainComponentBlocker(blocker){
 const text=String(blocker);
 const whole=/^inventory\[(\d+)\] (.+)$/.exec(text);
 if(whole)return `Component ${Number(whole[1])+1} ${whole[2].replace(/\b[a-z]+[A-Z][A-Za-z]*\b/g,words)}`;
 const inventory=/^inventory\[(\d+)\]\.(\w+) (.+)$/.exec(text);
 if(inventory){const [,index,key,rest]=inventory,name=`Component ${Number(index)+1}`;
  if(key==='name')return `${name}: give it a name.`;
  if(key==='kind')return `${name}: choose a kind.`;
  if(key==='folderNodeId')return `${name}: choose the approved folder it lives in.`;
  if(key==='id')return `${name}: its number must look like C001.`;
  return `${name}: ${words(key)} ${rest}`;}
 const known=[
  [/^(\S+) requires purpose and definitiveOutcome\.$/,'$1: fill in its purpose and definitive outcome.'],
  [/^(\S+) requires owner, reviewer, and taskId\.$/,'$1: fill in owner, reviewer and task ID.'],
  [/^(\S+) requires a valid wave and positive estimateHours\.$/,'$1: choose a wave and enter an estimate in hours above zero.'],
  [/^(\S+) requires explicit responsibilities and nonResponsibilities\.$/,'$1: list what it is responsible for and what it is not.'],
 ];
 for(const [pattern,replacement] of known)if(pattern.test(text))return text.replace(pattern,replacement);
 return text
  .replace(/\.(\w+)\[(\d+)\]/g,(_,key,index)=>` ${words(key).replace(/s$/,'')} ${Number(index)+1}`)
  .replace(/\b(C\d+)\.(\w+)/g,(_,id,key)=>`${id} ${words(key)}`)
  .replace(/\b(architecture|folder)(Digest|Revision) must/g,(_,kind,part)=>`The saved ${kind} ${part.toLowerCase()} must`)
  .replace(/\b[a-z]+[A-Z][A-Za-z]*\b/g,words);
}
const rows={interfaces:['id','direction','name','contract','version'],dependencies:['componentId','reason','critical','fallback'],fileClaims:['path','access','reason','convention'],states:['name','entry','exit'],failureModes:['name','trigger','detection','containment','recovery','proof'],decisions:['decision','reason','owner','evidence'],assumptions:['statement','validation','owner']};
const options={kind:componentPlanKinds,wave:['architecture','foundation','build','integration','proof','release'],direction:['input','output','bidirectional'],access:['read','write'],classification:['public','internal','confidential','restricted']};
// Plain-language name of the saved record that must exist before components can bind to it.
export function componentPrerequisite(context){if(!context)return'Saved planning has not been checked yet. Use Refresh saved planning.';if(context.state==='architecture-missing')return'Publish the Blueprint architecture first.';if(context.state==='folder-missing')return'Approve the folder plan in Structure & Connections first.';if(context.state==='folder-stale')return'The folder plan was approved for an older architecture. Approve the folder plan again in Structure & Connections first.';return null;}
const Reason=({id,text})=>text?<small id={id} className="component-draft-reason">{text}</small>:null;
export function ComponentDraftPanel({projectId,onPublished,onOpenStructure}){return projectId?<ProjectComponents key={projectId} projectId={projectId} onPublished={onPublished} onOpenStructure={onOpenStructure}/>:<p>Select a project before drafting components.</p>;}
// A component with nothing typed into it yet: pure placeholder.
const isBlank=c=>!c.name.trim()&&!c.scopeLabel.trim()&&!c.definition.trim()&&!c.notThis.trim()&&!c.kind&&!c.folderNodeId&&!c.purpose.trim()&&!c.owner.trim()&&!c.reviewer.trim()&&!c.taskId.trim()&&!c.wave&&c.estimateHours===''&&!c.responsibilities.length&&!c.nonResponsibilities.length;
// What the person should do right now, in plain words, from saved planning state.
export function nextStep(context,{busy,count,blanks,reviewed}){
 if(busy&&!context)return{text:'Checking your saved planning…'};
 if(!context)return{text:'Saved planning could not be checked yet.',action:'refresh',label:'Check again'};
 if(context.state==='architecture-missing')return{text:'Publish the Blueprint architecture first, then come back here.'};
 if(context.state==='folder-missing')return{text:'Approve the folder layout first.',action:'structure',label:'Open Structure & Connections'};
 if(context.state==='folder-stale')return{text:'The folder layout changed. Approve it again first.',action:'structure',label:'Open Structure & Connections'};
 if(!count)return{text:'Add your first component. You can start from the folders found in your project.',action:'folders',label:'Start from my folders'};
 if(blanks===count)return{text:'Give your component a name and a folder.'};
 if(!reviewed)return{text:'Fill in each component, then review the draft.'};
 return null;
}
function ProjectComponents({projectId,onPublished,onOpenStructure}){
 const initial=useRef(null);if(!initial.current){try{initial.current=restoreComponentDraft(localStorage,projectId);}catch{initial.current=restoreComponentDraft({getItem(){throw Error();}},projectId);}}
 const{isAdvanced}=useViewMode();
 const[moreOpen,setMoreOpen]=useState(false);
 const[reviewError,setReviewError]=useState('');
 const[draft,setDraft]=useState(initial.current.draft),[selected,setSelected]=useState(0),[context,setContext]=useState(null),[error,setError]=useState(initial.current.error??''),[save,setSave]=useState('Local draft — not published'),[busy,setBusy]=useState(false),[review,setReview]=useState(null),[confirmed,setConfirmed]=useState(false),[notice,setNotice]=useState('');
 const [showCopy,setShowCopy]=useState(false);
 const [matchedRevision,setMatchedRevision]=useState(null);
 const reasonId=useId();
 const alive=useRef(true),generation=useRef(0),request=useRef(0);
 useEffect(()=>{alive.current=true;refresh();return()=>{alive.current=false;request.current++;};},[]);
 async function refresh(){const id=++request.current;setBusy(true);setReview(null);setConfirmed(false);try{const next=await readComponentContext(projectId);if(alive.current&&request.current===id){setContext(next);setError(initial.current.error??'');}}catch{if(alive.current&&request.current===id){setContext(null);setError('Saved planning could not be checked. Your draft is preserved; publication is disabled.');}}finally{if(alive.current&&request.current===id)setBusy(false);}}
 function edit(next){request.current++;setReviewError('');keep(next);}
 function keep(next){generation.current++;setDraft(next);setMatchedRevision(null);setReview(null);setConfirmed(false);setNotice('');if(initial.current.error){setSave('Memory only — original saved entry preserved');setError(initial.current.error);return;}try{localStorage.setItem(componentDraftKey(projectId),encodeComponentDraft(next));setSave('Draft saved on this computer — not published');setError('');}catch{setSave('Memory only — copy this draft before leaving');setError('Local draft could not be saved. Previous saved entry is preserved.');}}
 const component=draft.components[selected];
 function addComponent(){if(busy||draft.components.length>=COMPONENT_DRAFT_COMPONENT_LIMIT)return;const spare=draft.components.findIndex(isBlank);if(spare>=0){setSelected(spare);return;}const used=new Set(draft.components.map(c=>c.id));let n=1;while(used.has(`C${String(n).padStart(3,'0')}`))n++;edit({...draft,components:[...draft.components,blankComponent(`C${String(n).padStart(3,'0')}`)]});setSelected(draft.components.length);}
 function startFromFolders(){if(busy||draft.components.length)return;const top=(context?.folderNodes??[]).filter(n=>n.kind==='folder'&&n.path&&!n.path.includes('/')).slice(0,8);if(!top.length){addComponent();return;}edit({...draft,components:top.map((node,i)=>({...blankComponent(`C${String(i+1).padStart(3,'0')}`),name:node.path.replace(/^./,v=>v.toUpperCase()),folderNodeId:node.id}))});setSelected(0);}
 function removeEmpty(){const kept=draft.components.filter(c=>!isBlank(c));edit({...draft,components:kept});setSelected(0);}
 function change(path,value){const next=structuredClone(draft);let target=next.components[selected];const keys=path.split('.');for(const key of keys.slice(0,-1))target=target[key];target[keys.at(-1)]=value;target=next.components[selected];target.handover.updatedAt=new Date().toISOString();edit(next);}
 function field(path,value,label=title(path.split('.').at(-1)),group=''){
  const key=path.split('.').at(-1),identity={'data-component-field':path,'data-component-id':component.id,'aria-label':[`Component ${selected+1}`,group,label].filter(Boolean).join(' · ')};
  if(key==='estimateHours')return <label className="component-draft-field" key={path}>{label}<input {...identity} type="text" inputMode="decimal" value={value} onChange={event=>change(path,event.target.value)} maxLength={40}/></label>;
  if(key==='screenshotRequired')return <label className="component-draft-field" key={path}>{label}<select {...identity} value={value===''?'':String(value)} onChange={e=>change(path,e.target.value===''?'':e.target.value==='true')}><option value="">Choose screenshot proof requirement…</option><option value="true">Required</option><option value="false">Not required for this component</option></select></label>;
  const choices=key==='folderNodeId'?(context?.folderNodes??[]).filter(node=>node.kind==='folder').map(node=>({value:node.id,label:`${node.id} · ${node.path}`})):options[key];
  return <label className="component-draft-field" key={path}>{label}{typeof value==='boolean'?<input {...identity} type="checkbox" checked={value} onChange={e=>change(path,e.target.checked)}/>:choices?<select {...identity} value={value} onChange={e=>change(path,e.target.value)}><option value="">Choose…</option>{choices.map(option=><option key={option.value??option} value={option.value??option}>{option.label??option}</option>)}</select>:SHORT_FIELDS.has(key)&&!Array.isArray(value)?<input {...identity} type="text" value={value??''} maxLength={2000} onChange={e=>change(path,e.target.value)}/>:<textarea {...identity} value={Array.isArray(value)?value.join('\n'):value??''} maxLength={12000} onChange={e=>change(path,Array.isArray(value)?e.target.value.split('\n'):typeof value==='number'?Number(e.target.value):e.target.value)}/>}</label>;
 }
 function fields(object,prefix=''){return Object.entries(object).map(([key,value])=>field(`${prefix}${key}`,value,`${title(key)}${Array.isArray(value)?' (one per line)':''}`));}
 function table(name){return <section className="component-draft-rows" key={name}><h4>{title(name)}</h4>{component[name].map((row,index)=><fieldset key={index}><legend>{title(name)} {index+1}</legend><div className="component-draft-fields">{rows[name].map(key=>field(`${name}.${index}.${key}`,row[key]??'',title(key),`${title(name)} ${index+1}`))}</div><button type="button" onClick={()=>change(name,component[name].filter((_,i)=>i!==index))}>Remove {title(name)} {index+1}</button></fieldset>)}<button type="button" onClick={()=>change(name,[...component[name],Object.fromEntries(rows[name].map(key=>[key,key==='critical'?false:'']))])}>Add {words(name)}</button></section>;}
 async function reviewDraft(){let captured=generation.current;const id=++request.current;setBusy(true);setConfirmed(false);setReview(null);setNotice('');setReviewError('');try{const fresh=await readComponentContext(projectId);if(!alive.current||captured!==generation.current||request.current!==id)return;setContext(fresh);if(fresh.state!=='ready')throw Error(`${componentPrerequisite(fresh)} Your draft is kept; review again afterwards.`);let current=draft,boundNow=false;
 // A draft that was never bound has no parents to compare: bind it to the
 // current saved parents. Only a draft bound to OLDER parents needs a review.
 if(!sameComponentParents(draft,fresh)){if(![draft.architectureDigest,draft.architectureRevision,draft.folderDigest,draft.folderRevision].every(value=>value==null))throw Error('Saved parents changed or are unavailable. Explicitly rebind the draft and review again.');current=rebindComponentDraft(draft,fresh);keep(current);captured=generation.current;boundNow=true;}
 const input=componentDraftInput(current);let assessment;try{const content=assessComponentPlans(input),scope=assessComponentFolderScope(input,fresh.folderNodes);assessment={...content,ready:content.ready&&scope.ready,blockers:[...content.blockers,...scope.blockers]};}catch{throw Error('A component field is malformed. Correct the draft before review.');}setReview({input,assessment,context:fresh});if(!assessment.ready)setMoreOpen(true);setError(initial.current.error??'');if(boundNow)setNotice(isAdvanced?`This new draft is now bound to saved architecture revision ${fresh.architectureHead?.revision} and folder plan revision ${fresh.folderHead?.revision}.`:'Your draft now follows your latest approved plan.');}catch(e){if(alive.current&&request.current===id)setReviewError(e.message);}finally{if(alive.current&&request.current===id)setBusy(false);}}
 async function publish(){if(busy||!confirmed||!review?.assessment.ready)return;const captured=generation.current,id=++request.current;setBusy(true);setError('');try{const receipt=await publishComponentDraft(projectId,review.input,{actor:review.context.actor,expectedRevision:review.context.catalogHead?.revision??0,expectedHeadDigest:review.context.catalogHead?.contractDigest??'GENESIS'});if(alive.current&&generation.current===captured&&request.current===id){setContext(receipt);setMatchedRevision(receipt.catalogHead.revision);setNotice(`Saved component catalog revision ${receipt.catalogHead.revision}. Planning only — no work was executed.`);setReview(null);setConfirmed(false);try{await onPublished?.(receipt);}catch{setError('Catalog saved; surrounding summary needs a refresh.');}}}catch(e){if(alive.current){setError(e.message);setReview(null);setConfirmed(false);}}finally{if(alive.current)setBusy(false);}}
 const checking=busy?'Checking saved planning…':null,missing=context?.state==='ready'?null:componentPrerequisite(context);
 const why={
  refresh:checking,
  load:checking??(!context?componentPrerequisite(null):!context.catalog?'No component catalog has been published for this project yet.':null),
  rebind:checking??missing,
  review:checking,
  add:draft.components.length>=COMPONENT_DRAFT_COMPONENT_LIMIT?`Draft limit reached (${COMPONENT_DRAFT_COMPONENT_LIMIT} components). Remove one first.`:null,
  confirm:checking??(review?(review.assessment.ready?null:'Fix the issues listed in the review first.'):(missing??'Review the component draft first.')),
 };
 why.publish=why.confirm??(confirmed?null:'Tick the confirmation box first.');
 const described=key=>why[key]?{'aria-describedby':`${reasonId}-${key}`}:{};
 const action=(key,button)=><span className="component-draft-action">{button}<Reason id={`${reasonId}-${key}`} text={why[key]}/></span>;
 const step=nextStep(context,{busy,count:draft.components.length,blanks:draft.components.filter(isBlank).length,reviewed:!!review});
 const runStep=()=>{if(step.action==='refresh')refresh();else if(step.action==='structure')onOpenStructure?.();else if(step.action==='folders')startFromFolders();};
 const tools=<>
 <button type="button" onClick={()=>setShowCopy(value=>!value)}>Show draft backup to copy</button>{showCopy&&<label className="component-draft-field">Draft backup — select all and copy<textarea readOnly value={JSON.stringify(draft,null,2)} onFocus={event=>event.target.select()}/></label>}
 <div className="component-draft-actions">{action('refresh',<button disabled={busy} {...described('refresh')} onClick={refresh}>Refresh saved planning</button>)}{action('load',<button disabled={busy||!context?.catalog} {...described('load')} onClick={()=>{try{edit(savedCatalogDraft(context.catalog,projectId));setMatchedRevision(context.catalogHead.revision);setSelected(0);}catch{setError('Saved catalog could not be loaded safely. Draft preserved.');}}}>Load saved catalog</button>)}{action('rebind',<button disabled={busy||context?.state!=='ready'} {...described('rebind')} onClick={()=>{try{edit(rebindComponentDraft(draft,context));}catch{setError('Current parents are unavailable.');}}}>Update to latest approved plan</button>)}</div>
 <p className="component-draft-caution">Load saved catalog replaces the draft shown here. Copy any unsaved answers first. Updating to the latest approved plan keeps your answers, but removed folder references must be corrected.</p>
 </>;
 return <section className="component-draft-panel" aria-label="Component authoring"><header><h2>Plan your components</h2><p>Describe one part of your app at a time. Publishing only saves the plan; nothing is run.</p><small>{matchedRevision!==null?(isAdvanced?`Draft answers match saved catalog revision ${matchedRevision}.`:'Your draft matches the saved component list.'):save}</small>{matchedRevision!==null&&save.startsWith('Memory only')&&<small>{save}</small>}</header>
 {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 {step&&<div className="component-draft-next"><strong>Next step</strong><span>{step.text}</span>{step.action&&!(step.action==='structure'&&!onOpenStructure)&&<button type="button" disabled={busy&&step.action!=='refresh'} onClick={runStep}>{step.label}</button>}</div>}
 {isAdvanced?tools:<details className="component-draft-more"><summary>More options</summary>{tools}</details>}
 {isAdvanced?<p>{context?`Saved planning: ${context.state}. Catalog: ${context.catalogState}.`:'Saved planning has not been verified.'} {context&&missing?missing:''} {context?.state==='ready'&&!sameComponentParents(draft,context)?'Draft parent bindings need explicit review and rebinding.':''}</p>:(context?.state==='ready'&&!sameComponentParents(draft,context)&&draft.components.length>0?<p>Your draft will be checked against the latest approved plan when you review it.</p>:null)}
 <fieldset disabled={busy} className="component-draft-layout"><legend>Component draft</legend><aside><button disabled={draft.components.length>=COMPONENT_DRAFT_COMPONENT_LIMIT} {...described('add')} onClick={addComponent}>Add component</button><Reason id={`${reasonId}-add`} text={why.add}/>{draft.components.length>=COMPONENT_DRAFT_COMPONENT_LIMIT&&<p>Draft limit: {COMPONENT_DRAFT_COMPONENT_LIMIT} components. Existing answers remain editable. Remove a component only if it is no longer needed before adding another.</p>}{draft.components.filter(isBlank).length>1&&<button type="button" onClick={removeEmpty}>Remove empty drafts</button>}{draft.components.map((item,index)=><button key={`${item.id}-${index}`} aria-current={selected===index?'true':undefined} onClick={()=>setSelected(index)}>{item.id} · {item.name||'Unnamed component'}</button>)}</aside>
 <article>{!component?<p>No component answers have been assumed. Add your first component.</p>:<><h3>{component.id} · {component.name||'New component'}</h3><details open><summary>1. Identity and ownership</summary><div className="component-draft-fields">{(isAdvanced?['name','scopeLabel','definition','notThis','kind','folderNodeId','owner','reviewer','taskId','wave','estimateHours']:['name','definition','kind','folderNodeId','owner','reviewer','wave']).map(key=>field(key,component[key]))}</div>{!isAdvanced&&<details open={moreOpen} onToggle={e=>setMoreOpen(e.currentTarget.open)}><summary>More details (label, task ID, estimate)</summary><div className="component-draft-fields">{['scopeLabel','notThis','taskId','estimateHours'].map(key=>field(key,component[key]))}</div></details>}</details><details><summary>2. Responsibilities and connections</summary><div className="component-draft-fields">{['purpose','definitiveOutcome','responsibilities','nonResponsibilities'].map(key=>field(key,component[key]))}</div>{table('interfaces')}{table('dependencies')}</details><details><summary>3. Files and naming</summary>{table('fileClaims')}<div className="component-draft-fields">{fields(component.fileNaming,'fileNaming.')}</div></details><details><summary>4. Data and lifecycle</summary><div className="component-draft-fields">{fields(component.dataOwnership,'dataOwnership.')}</div>{table('states')}</details><details><summary>5. Failure and security</summary>{table('failureModes')}<p>Secret references only. Never enter keys, passwords or tokens.</p><div className="component-draft-fields">{fields(component.security,'security.')}</div></details><details><summary>6. Acceptance and handover</summary><div className="component-draft-fields">{fields(component.proof,'proof.')}</div>{table('decisions')}{table('assumptions')}<div className="component-draft-fields">{Object.entries(component.handover).filter(([key])=>key!=='updatedAt').map(([key,value])=>field(`handover.${key}`,value))}</div></details><button onClick={()=>{edit({...draft,components:draft.components.filter((_,i)=>i!==selected)});setSelected(Math.max(0,selected-1));}}>Remove selected component</button></>}</article></fieldset>
 <footer>{action('review',<button disabled={busy} {...described('review')} onClick={reviewDraft}>Review component draft</button>)}{reviewError&&<p role="alert" className="component-draft-review-error">{reviewError}</p>}{review&&<section aria-label="Component review"><p>{review.assessment.ready?'Draft is complete; explicit approval is still required.':`${review.assessment.blockers.length} ${review.assessment.blockers.length===1?'issue needs':'issues need'} attention.`}</p><ul>{review.assessment.blockers.map((blocker,i)=><li key={i}>{isAdvanced?blocker:plainComponentBlocker(blocker)}</li>)}</ul></section>}<span className="component-draft-action"><label><input type="checkbox" disabled={busy||!review?.assessment.ready} {...described('confirm')} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I reviewed these component responsibilities and exact file claims</label><Reason id={`${reasonId}-confirm`} text={why.confirm}/></span>{action('publish',<button disabled={busy||!confirmed||!review?.assessment.ready} {...described('publish')} onClick={publish}>{busy?'Checking…':'Publish component catalog'}</button>)}</footer>
 </section>;
}
