import { createTaskRunObservationMiddleware } from './taskRunObservationHttp.mjs';

// Development host only. PP_ configuration is never injected into browser code.
// Empty configuration is explicitly unavailable; no repository scan/discovery.
export function taskObservationVitePlugin(options={}) {
  let bindings=[], configurationInvalid=false;
  try {
    bindings=structuredClone(Object.hasOwn(options,'bindings')?options.bindings:JSON.parse(process.env.PP_TASK_OBSERVATION_BINDINGS??'[]'));
    if(!Array.isArray(bindings))throw new Error('Invalid bindings');
  } catch { bindings=[];configurationInvalid=true; }
  const hosts=new Set();
  return {
    name:'perfect-planner-task-observations',
    api:{revoke(projectId){for(const host of hosts)for(const reader of host.readers.values())reader.revoke(projectId);bindings=bindings.filter(item=>item?.projectId!==projectId);}},
    configureServer(server){
      const host={readers:new Map(),closed:false};hosts.add(host);
      const {readers}=host;
      server.middlewares.use((req,res,next)=>{
        if(!String(req.url).startsWith('/api/task-run-observations'))return next();
        res.setHeader('Cache-Control','no-store');
        const address=server.httpServer?.address();
        if(host.closed||!address||typeof address==='string'||server.config.server.https){res.statusCode=503;res.end('Observation host unavailable');return;}
        if(configurationInvalid){res.statusCode=503;res.end('Observation configuration unavailable');return;}
        const allowed=new Set([`http://127.0.0.1:${address.port}`,`http://localhost:${address.port}`,`http://[::1]:${address.port}`]);
        const origin=req.headers.origin;
        if(!allowed.has(origin)){res.statusCode=403;res.end('Observation origin refused');return;}
        let reader=readers.get(origin);
        try{if(!reader){reader=createTaskRunObservationMiddleware({origin,bindings});readers.set(origin,reader);}}
        catch{res.statusCode=503;res.end('Observation configuration unavailable');return;}
        return reader(req,res,next);
      });
      server.httpServer?.once('close',()=>{host.closed=true;for(const reader of readers.values())reader.dispose();readers.clear();hosts.delete(host);});
    },
  };
}
