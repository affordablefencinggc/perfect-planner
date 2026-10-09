import { createTaskRunObservationMiddleware } from './taskRunObservationHttp.mjs';

// Local host only (Vite dev server or the zero-dependency production server).
// PP_ configuration is never injected into browser code.
// Empty configuration is explicitly unavailable; no repository scan/discovery.
export function createTaskObservationHost(options={}) {
  let bindings=[], configurationInvalid=false;
  try {
    bindings=structuredClone(Object.hasOwn(options,'bindings')?options.bindings:JSON.parse(process.env.PP_TASK_OBSERVATION_BINDINGS??'[]'));
    if(!Array.isArray(bindings))throw new Error('Invalid bindings');
  } catch { bindings=[];configurationInvalid=true; }
  const hosts=new Set();
  return {
    revoke(projectId){for(const host of hosts)for(const reader of host.readers.values())reader.revoke(projectId);bindings=bindings.filter(item=>item?.projectId!==projectId);},
    // getAddress returns the listening AddressInfo (or null); isHttps reports TLS hosting (refused).
    attach({getAddress,isHttps=()=>false}){
      const host={readers:new Map(),closed:false};hosts.add(host);
      const {readers}=host;
      const middleware=(req,res,next)=>{
        if(!String(req.url).startsWith('/api/task-run-observations'))return next();
        res.setHeader('Cache-Control','no-store');
        const address=getAddress();
        if(host.closed||!address||typeof address==='string'||isHttps()){res.statusCode=503;res.end('Observation host unavailable');return;}
        if(configurationInvalid){res.statusCode=503;res.end('Observation configuration unavailable');return;}
        const allowed=new Set([`http://127.0.0.1:${address.port}`,`http://localhost:${address.port}`,`http://[::1]:${address.port}`]);
        const origin=req.headers.origin;
        if(!allowed.has(origin)){res.statusCode=403;res.end('Observation origin refused');return;}
        let reader=readers.get(origin);
        try{if(!reader){reader=createTaskRunObservationMiddleware({origin,bindings});readers.set(origin,reader);}}
        catch{res.statusCode=503;res.end('Observation configuration unavailable');return;}
        return reader(req,res,next);
      };
      const close=()=>{host.closed=true;for(const reader of readers.values())reader.dispose();readers.clear();hosts.delete(host);};
      return {middleware,close};
    },
  };
}

export function taskObservationVitePlugin(options={}) {
  const observations=createTaskObservationHost(options);
  return {
    name:'perfect-planner-task-observations',
    api:{revoke:observations.revoke},
    configureServer(server){
      const {middleware,close}=observations.attach({getAddress:()=>server.httpServer?.address(),isHttps:()=>Boolean(server.config.server.https)});
      server.middlewares.use(middleware);
      server.httpServer?.once('close',close);
    },
  };
}
