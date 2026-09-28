import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createArchitectureRefresh } from "./architectureRefresh.js";
import { createFolderRefresh } from "./folderRefresh.js";
import { createComponentRefresh } from "./componentRefresh.js";
import { createPlanRefresh } from "./planRefresh.js";
import { taskDraftBinding } from "./taskDraftLedger.js";
import { createImportedProjectSession, createEmptyProjectState, validateProjectSession, withProjectState } from "./projectSession.js";
import { createProjectRegistry, resolveProjectRegistryStorage } from "./projectRegistry.js";
import { selectProjectMetric, selectProjectMetrics } from "./projectProvenance.js";
import { createProjectHistoryState, projectHistoryHref, resolveProjectSelection } from "./projectUrl.js";

const ProjectContext = createContext(null);

function currentBrowserUrl() {
  return typeof window === "undefined" ? "/" : window.location.href;
}

export function ProjectProvider({ children, registry: suppliedRegistry = null, storage, storageKey, initialUrl, syncHistory = true }) {
  // Capture before descendant passive effects can normalize browser history.
  const startupUrl=useRef(initialUrl??currentBrowserUrl());
  const [selectionInitialized,setSelectionInitialized]=useState(false);
  const registryRef = useRef(null);
  if (!registryRef.current) {
    registryRef.current = suppliedRegistry ?? createProjectRegistry({
      storage: storage === undefined ? resolveProjectRegistryStorage() : storage,
      storageKey,
    });
  }
  const registry = registryRef.current;
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const [architectureStatuses,setArchitectureStatuses]=useState({});
  const [folderStatuses,setFolderStatuses]=useState({});
  const [componentStatuses,setComponentStatuses]=useState({});
  const [planStatuses,setPlanStatuses]=useState({});
  const planRefreshRef=useRef(null),planSequence=useRef(new Map()),planDirty=useRef(new Map());
  const invalidatePlan=useCallback((projectId=registry.getSnapshot().activeProjectId,{dirty,reason='changed'}={})=>{
    if(!projectId)return;
    if(typeof dirty==='boolean')planDirty.current.set(projectId,dirty);
    planSequence.current.set(projectId,(planSequence.current.get(projectId)??0)+1);planRefreshRef.current?.invalidate(projectId);
    setPlanStatuses(current=>({...current,[projectId]:{state:'stale',projectId,reason}}));
  },[registry]);
  useEffect(()=>{const refresh=createPlanRefresh({registry,getDirty:id=>planDirty.current.get(id)===true});planRefreshRef.current=refresh;return()=>{refresh.dispose();planRefreshRef.current=null;};},[registry]);
  const refreshPlan=useCallback(async(projectId=registry.getSnapshot().activeProjectId)=>{
    const refresh=planRefreshRef.current;if(!projectId||!refresh)return null;
    const sequence=(planSequence.current.get(projectId)??0)+1;planSequence.current.set(projectId,sequence);
    setPlanStatuses(current=>({...current,[projectId]:{state:'refreshing',projectId}}));
    let result;try{result=await refresh.refresh(projectId);}catch{result={status:'unavailable',projectId};}
    if(planRefreshRef.current===refresh&&planSequence.current.get(projectId)===sequence)setPlanStatuses(current=>({...current,[projectId]:result?{...result,state:result.status}:{state:'stale',projectId}}));
    return result;
  },[registry]);
  const componentRefreshRef=useRef(null),componentSequence=useRef(new Map());
  useEffect(()=>{
    const refresh=createComponentRefresh({registry,recordStatus:(id,observation)=>registry.recordComponentObservation(id,observation)});
    componentRefreshRef.current=refresh;
    return()=>{refresh.dispose();componentRefreshRef.current=null;};
  },[registry]);
  const refreshComponent=useCallback(async(projectId=registry.getSnapshot().activeProjectId)=>{
    if(!projectId||!componentRefreshRef.current)return null;
    invalidatePlan(projectId,{reason:'component-refresh'});
    const refresh=componentRefreshRef.current,sequence=(componentSequence.current.get(projectId)??0)+1;
    componentSequence.current.set(projectId,sequence);
    const rootIdentity=registry.get(projectId)?.registration?.rootIdentity;
    setComponentStatuses(current=>({...current,[projectId]:{state:'refreshing',projectId,rootIdentity}}));
    let result;
    try{result=await refresh.refresh(projectId);}catch{result={status:'local-cache-unavailable'};}
    if(componentRefreshRef.current===refresh&&componentSequence.current.get(projectId)===sequence&&result&&registry.get(projectId)?.registration?.rootIdentity===rootIdentity)setComponentStatuses(current=>({...current,[projectId]:{state:result.status,projectId,rootIdentity,digest:result.receipt?.catalogHead?.contractDigest??null,revision:result.receipt?.catalogHead?.revision??null,architectureDigest:result.receipt?.architectureHead?.contractDigest??null,architectureRevision:result.receipt?.architectureHead?.revision??null,folderDigest:result.receipt?.folderHead?.contractDigest??null,folderRevision:result.receipt?.folderHead?.revision??null}}));
    if(componentRefreshRef.current===refresh&&componentSequence.current.get(projectId)===sequence&&result)void refreshPlan(projectId);
    return result;
  },[registry,invalidatePlan,refreshPlan]);
  const folderRefreshRef=useRef(null),folderSequence=useRef(new Map());
  useEffect(()=>{
    const refresh=createFolderRefresh({registry,recordStatus:(id,observation)=>registry.recordFolderObservation(id,observation)});
    folderRefreshRef.current=refresh;
    return()=>{refresh.dispose();folderRefreshRef.current=null;};
  },[registry]);
  const refreshFolder=useCallback(async(projectId=registry.getSnapshot().activeProjectId)=>{
    if(!projectId||!folderRefreshRef.current)return null;
    invalidatePlan(projectId,{reason:'folder-refresh'});
    const refresh=folderRefreshRef.current,sequence=(folderSequence.current.get(projectId)??0)+1;
    folderSequence.current.set(projectId,sequence);
    const rootIdentity=registry.get(projectId)?.registration?.rootIdentity;
    setFolderStatuses(current=>({...current,[projectId]:{state:'refreshing',projectId,rootIdentity}}));
    let result;
    try{result=await refresh.refresh(projectId);}catch{result={status:'local-cache-unavailable'};}
    if(folderRefreshRef.current===refresh&&folderSequence.current.get(projectId)===sequence&&result)setFolderStatuses(current=>({...current,[projectId]:{state:result.status,projectId,rootIdentity,digest:result.receipt?.head?.contractDigest??null,revision:result.receipt?.head?.revision??null,architectureDigest:result.architectureReceipt?.head?.contractDigest??null,architectureRevision:result.architectureReceipt?.head?.revision??null}}));
    if(folderRefreshRef.current===refresh&&folderSequence.current.get(projectId)===sequence&&result&&registry.get(projectId)?.registration?.rootIdentity===rootIdentity)await refreshComponent(projectId);
    return result;
  },[registry,refreshComponent,invalidatePlan]);
  const architectureRefreshRef=useRef(null),architectureSequence=useRef(new Map());
  useEffect(()=>{
    const refresh=createArchitectureRefresh({registry,recordStatus:(projectId,observation)=>registry.recordArchitectureObservation(projectId,observation)});
    architectureRefreshRef.current=refresh;
    return()=>{refresh.dispose();architectureRefreshRef.current=null;};
  },[registry]);
  const refreshArchitecture=useCallback(async(projectId=registry.getSnapshot().activeProjectId)=>{
    if(!projectId||!architectureRefreshRef.current)return null;
    invalidatePlan(projectId,{reason:'architecture-refresh'});
    const refresh=architectureRefreshRef.current,sequence=(architectureSequence.current.get(projectId)??0)+1;
    architectureSequence.current.set(projectId,sequence);
    const rootIdentity=registry.get(projectId)?.registration?.rootIdentity;
    setArchitectureStatuses(current=>({...current,[projectId]:{state:'refreshing',projectId,rootIdentity}}));
    let result;
    try{result=await refresh.refresh(projectId);}catch{result={status:'local-cache-unavailable'};}
    if(architectureRefreshRef.current===refresh&&architectureSequence.current.get(projectId)===sequence&&result)setArchitectureStatuses(current=>({...current,[projectId]:{state:result.status,projectId,rootIdentity,digest:result.receipt?.head?.contractDigest??null,revision:result.receipt?.head?.revision??null}}));
    if(architectureRefreshRef.current===refresh&&architectureSequence.current.get(projectId)===sequence&&result)await refreshFolder(projectId);
    return result;
  },[registry,refreshFolder,invalidatePlan]);
  const activeRoot=snapshot.activeProject?.registration?.rootIdentity;
  const activeCensus=snapshot.activeProject?.census?.digest;
  useEffect(()=>{
    const project=registry.get(snapshot.activeProjectId);if(project?.kind!=='imported'||!project.registration||!project.census)return;
    const listener=()=>invalidatePlan(project.projectId,{reason:'draft-or-recovery-changed'});
    const release=planRefreshRef.current?.subscribe(taskDraftBinding(project),listener);
    const focus=()=>invalidatePlan(project.projectId,{reason:'focus-recheck-required'});
    if(typeof window!=='undefined')window.addEventListener('focus',focus);
    return()=>{release?.();planRefreshRef.current?.invalidate(project.projectId);planSequence.current.set(project.projectId,(planSequence.current.get(project.projectId)??0)+1);if(typeof window!=='undefined')window.removeEventListener('focus',focus);};
  },[registry,snapshot.activeProjectId,activeRoot,activeCensus,invalidatePlan]);
  useEffect(()=>{
    const project=snapshot.activeProject;
    if(project?.kind!=='imported'||!activeRoot)return;
    refreshArchitecture(project.projectId);
    return()=>{architectureRefreshRef.current?.invalidate(project.projectId);folderRefreshRef.current?.invalidate(project.projectId);componentRefreshRef.current?.invalidate(project.projectId);};
  },[snapshot.activeProjectId,activeRoot,refreshArchitecture]);
  const displaySnapshot=useMemo(()=>{
    const architectureProjects=snapshot.projects.map(project=>{
      const status=architectureStatuses[project.projectId];
      if(project.kind!=='imported'||project.authorities.architecture?.state!=='authoritative'||(status?.state==='observed'&&status.rootIdentity===project.registration?.rootIdentity&&status.digest===project.authorities.architecture.digest&&status.revision===project.authorities.architecture.revision))return project;
      const provenance={...project.provenance};
      if(provenance['authority.architecture'])provenance['authority.architecture']={...provenance['authority.architecture'],state:'stale',reason:'architecture-refresh-pending'};
      return {...project,authorities:{...project.authorities,architecture:{...project.authorities.architecture,state:'stale'}},provenance};
    });
    const folderProjects=architectureProjects.map(project=>{
      const folder=project.authorities?.folder,status=folderStatuses[project.projectId],architecture=project.authorities?.architecture;
      if(project.kind!=='imported'||folder?.state!=='authoritative')return project;
      if(status?.state==='observed'&&status.rootIdentity===project.registration?.rootIdentity&&status.digest===folder.digest&&status.revision===folder.revision&&architecture?.state==='authoritative'&&status.architectureDigest===architecture.digest&&status.architectureRevision===architecture.revision)return project;
      const provenance={...project.provenance};
      if(provenance['authority.folder'])provenance['authority.folder']={...provenance['authority.folder'],state:'stale',reason:'folder-refresh-pending'};
      return {...project,authorities:{...project.authorities,folder:{...folder,state:'stale'}},provenance};
    });
    const componentProjects=folderProjects.map(project=>{
      const component=project.authorities?.component,status=componentStatuses[project.projectId],architecture=project.authorities?.architecture,folder=project.authorities?.folder;
      if(project.kind!=='imported'||component?.state!=='authoritative')return project;
      if(status?.state==='observed'&&status.rootIdentity===project.registration?.rootIdentity&&status.digest===component.digest&&status.revision===component.revision&&architecture?.state==='authoritative'&&folder?.state==='authoritative'&&status.architectureDigest===architecture.digest&&status.architectureRevision===architecture.revision&&status.folderDigest===folder.digest&&status.folderRevision===folder.revision)return project;
      const provenance={...project.provenance};
      if(provenance['authority.component'])provenance['authority.component']={...provenance['authority.component'],state:'stale',reason:'component-refresh-pending'};
      return {...project,authorities:{...project.authorities,component:{...component,state:'stale'}},provenance};
    });
    const projects=componentProjects.map(project=>{
      const status=planStatuses[project.projectId];
      if(project.kind!=='imported'||project.authorities?.plan?.state!=='authoritative')return project;
      if(!['stale','unavailable'].includes(project.state)&&status?.state==='observed'&&status.rootIdentity===project.registration?.rootIdentity&&status.censusDigest===project.census?.digest&&!planDirty.current.get(project.projectId)&&status.revision===project.authorities.plan.revision&&status.digest===project.authorities.plan.digest&&['architecture','folder','component'].every(kind=>project.authorities?.[kind]?.state==='authoritative'&&status.parents?.[kind]?.revision===project.authorities[kind].revision&&status.parents?.[kind]?.digest===project.authorities[kind].digest))return project;
      const provenance={...project.provenance};
      if(provenance['authority.plan'])provenance['authority.plan']={...provenance['authority.plan'],state:'stale',reason:'planning-parent-unverified'};
      return {...project,authorities:{...project.authorities,plan:{...project.authorities.plan,state:'stale'}},provenance};
    });
    return {...snapshot,projects,activeProject:projects.find(project=>project.projectId===snapshot.activeProjectId)??null};
  },[snapshot,architectureStatuses,folderStatuses,componentStatuses,planStatuses]);
  const checkedPlanStatuses=useMemo(()=>Object.fromEntries(Object.entries(planStatuses).map(([id,status])=>{
    const project=displaySnapshot.projects.find(item=>item.projectId===id);
    if(status.state!=='observed')return [id,status];
    const matches=project&&!['stale','unavailable'].includes(project.state)&&displaySnapshot.activeProjectId===id&&status.rootIdentity===project.registration?.rootIdentity&&status.censusDigest===project.census?.digest&&!planDirty.current.get(id)&&['architecture','folder','component'].every(kind=>project.authorities?.[kind]?.state==='authoritative'&&status.parents?.[kind]?.revision===project.authorities[kind].revision&&status.parents?.[kind]?.digest===project.authorities[kind].digest);
    return [id,matches?status:{state:'stale',projectId:id}];
  })),[displaySnapshot,planStatuses]);

  const applySelection = useCallback((urlLike, { writeView = true } = {}) => {
    const resolved = resolveProjectSelection(registry.getSnapshot(), urlLike);
    if (resolved.projectId) {
      registry.setActive(resolved.projectId);
      if (writeView) registry.updateView(resolved.projectId, { workspace: resolved.workspace, phase: resolved.phase });
    }
    return resolved;
  }, [registry]);

  useEffect(() => {
    applySelection(initialUrl ?? startupUrl.current);
    setSelectionInitialized(true);
  }, [applySelection, initialUrl]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof registry.synchronize !== "function")
      return undefined;
    const onStorage = (event) => {
      if (event.key !== registry.storageKey) return;
      registry.synchronize(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [registry]);

  useEffect(() => {
    if (!syncHistory || typeof window === "undefined") return undefined;
    const onPopState = () => applySelection(window.location.href);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applySelection, syncHistory]);

  const selectProject = useCallback((projectId, { workspace, phase, historyMode = "push" } = {}) => {
    const project = registry.setActive(projectId);
    const nextWorkspace = workspace ?? project.view.workspace;
    const nextPhase = phase === undefined ? project.view.phase : phase;
    registry.updateView(projectId, { workspace: nextWorkspace, phase: nextPhase });
    if (syncHistory && typeof window !== "undefined") {
      const href = projectHistoryHref(window.location.href, { projectId, workspace: nextWorkspace, phase: nextPhase });
      const state = createProjectHistoryState(window.history.state, { projectId, workspace: nextWorkspace, phase: nextPhase });
      if (historyMode === "replace") window.history.replaceState(state, "", href);
      else window.history.pushState(state, "", href);
    }
    return registry.get(projectId);
  }, [registry, syncHistory]);

  const value = useMemo(() => ({
    state: snapshot.state,
    selectionInitialized,
    historySyncEnabled:syncHistory,
    snapshot:displaySnapshot,
    projects: displaySnapshot.projects,
    activeProjectId: snapshot.activeProjectId,
    activeProject: displaySnapshot.activeProject,
    registryHealth: snapshot.health,
    refreshArchitecture,
    refreshFolder,
    refreshComponent,
    componentStatuses,
    refreshPlan,
    invalidatePlan,
    planStatuses:checkedPlanStatuses,
    planRefreshStatus:checkedPlanStatuses[snapshot.activeProjectId]??{state:'idle',projectId:snapshot.activeProjectId},
    componentRefreshStatus: displaySnapshot.activeProject?.authorities?.component?.state==='stale'&&componentStatuses[snapshot.activeProjectId]?.state==='observed'?{state:'stale',projectId:snapshot.activeProjectId}:componentStatuses[snapshot.activeProjectId]??{state:'idle',projectId:snapshot.activeProjectId},
    folderRefreshStatus: displaySnapshot.activeProject?.authorities?.folder?.state==='stale'&&folderStatuses[snapshot.activeProjectId]?.state==='observed'?{state:'stale',projectId:snapshot.activeProjectId}:folderStatuses[snapshot.activeProjectId]??{state:'idle',projectId:snapshot.activeProjectId},
    architectureRefreshStatus: displaySnapshot.activeProject?.authorities.architecture?.state==='stale'&&architectureStatuses[snapshot.activeProjectId]?.state==='observed'?{state:'idle',projectId:snapshot.activeProjectId}:architectureStatuses[snapshot.activeProjectId]??{state:'idle',projectId:snapshot.activeProjectId},
    emptyState: snapshot.activeProject ? null : createEmptyProjectState(),
    registerProject(session, options) { return registry.upsert(validateProjectSession(session), options); },
    registerImportedProject(input, options) { return registry.upsert(createImportedProjectSession(input), options); },
    selectProject,
    closeProject(projectId) { return registry.remove(projectId); },
    clearProjects() { return registry.clear(); },
    updateView(projectId, patch) { return registry.updateView(projectId, patch); },
    markState(projectId, nextState, options) {
      const project = registry.get(projectId);
      if (!project) throw new Error("Cannot update an unknown project.");
      const updated = withProjectState(project, nextState, options);
      registry.upsert(updated, { activate: snapshot.activeProjectId === projectId });
      return updated;
    },
    metric(key, project = displaySnapshot.activeProject) { return project ? selectProjectMetric(project, key) : null; },
    metrics(keys, project = displaySnapshot.activeProject) { return project ? selectProjectMetrics(project, keys) : Object.freeze([]); },
    syncFromUrl(urlLike) { return applySelection(urlLike); },
    exportRedacted() { return registry.exportRedacted(); },
  }), [applySelection, registry, selectProject, snapshot,displaySnapshot,refreshArchitecture,architectureStatuses,refreshFolder,folderStatuses,refreshComponent,componentStatuses,refreshPlan,invalidatePlan,checkedPlanStatuses,selectionInitialized,syncHistory]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) throw new Error("useProject must be used inside ProjectProvider.");
  return context;
}

export function useOptionalProject() {
  return useContext(ProjectContext);
}

export { ProjectContext };
