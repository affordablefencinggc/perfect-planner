import {TextDecoder} from 'node:util';

// Private, connection-owned byte streams; not authenticated IPC or a CLI.
// Shutdown acknowledges transport/dispatch state, never native window closure.
export function createNativeReviewHostStream({input,output,protocol,shutdown,settleMs=1000,writeTimeoutMs=5000}) {
  if(!input?.[Symbol.asyncIterator]||typeof input.destroy!=='function'||typeof output?.write!=='function'||typeof output.on!=='function'||typeof protocol?.dispatchLine!=='function'||typeof shutdown!=='function'||!Number.isSafeInteger(settleMs)||settleMs<1||settleMs>5000||!Number.isSafeInteger(writeTimeoutMs)||writeTimeoutMs<1||writeTimeoutMs>5000)throw Error('NATIVE_REVIEW_STREAM_CONFIG_INVALID');
  const dispatch=protocol.dispatchLine.bind(protocol),closeHost=shutdown;
  const maxLine=protocol.limits?.lineBytes??16384,maxResponse=65536,maxChunk=65536;
  const snapshotResponse=protocol.limits?.snapshotResponseBytes??maxResponse;
  if(!Number.isSafeInteger(snapshotResponse)||snapshotResponse<maxResponse||snapshotResponse>3*1024*1024)throw Error('NATIVE_REVIEW_STREAM_CONFIG_INVALID');
  if(!Number.isSafeInteger(maxLine)||maxLine<16384||maxLine>1024*1024+4096)throw Error('NATIVE_REVIEW_STREAM_CONFIG_INVALID');
  let started=false,stopped=false,reason=null,finish,writeChain=Promise.resolve(),shutdownSettled=false,shutdownValue=null;
  let lineBuffer=null,bytes=0,outputUnsettled=false;
  const pending=new Set();
  const done=new Promise(resolve=>{finish=resolve;});
  const stop=code=>{
    if(stopped)return;stopped=true;reason=code;
    input.destroy();
    const closing=Promise.resolve().then(()=>closeHost()).then(value=>{shutdownSettled=true;shutdownValue=value;},()=>{shutdownSettled=true;shutdownValue=null;});
    // Pending dispatches may outlive a broken native presenter. Bound waiting,
    // retain truthful uncertainty, and suppress their late transport writes.
    let timer;
    Promise.race([closing.then(()=>Promise.allSettled([...pending])),new Promise(resolve=>{timer=setTimeout(resolve,settleMs);})]).then(()=>{
      clearTimeout(timer);
      finish(Object.freeze({reason,transportStopped:true,dispatchesSettled:pending.size===0,shutdownSettled,outputSettled:!outputUnsettled,cleanupComplete:!outputUnsettled&&pending.size===0&&shutdownSettled&&shutdownValue?.cleanupComplete===true,dialogClosed:null,executionAuthorized:false}));
    });
  };
  const write=chunk=>new Promise((resolve,reject)=>{
    if(stopped){resolve();return;}
    let callbackDone=false,drained=false,finished=false,timer;
    const cleanup=()=>{clearTimeout(timer);output.off('drain',onDrain);output.off('error',onError);output.off('close',onClose);};
    const complete=()=>{if(!finished&&callbackDone&&drained){finished=true;outputUnsettled=false;cleanup();resolve();}};
    const onError=()=>{if(!finished){finished=true;cleanup();reject(Error('STREAM_OUTPUT_FAILED'));}};
    const onClose=()=>onError();const onDrain=()=>{drained=true;complete();};
    outputUnsettled=true;
    output.on('error',onError);output.on('close',onClose);output.on('drain',onDrain);
    timer=setTimeout(()=>{outputUnsettled=true;stop('STREAM_OUTPUT_TIMEOUT');onError();},writeTimeoutMs);
    try{drained=output.write(chunk,error=>{if(error){onError();return;}callbackDone=true;complete();});complete();}catch{onError();}
  });
  const admit=line=>{
    let responseLimit=maxResponse;
    try{if(JSON.parse(line).command==='read-proposal-snapshot')responseLimit=snapshotResponse;}catch{}
    let job;
    job=Promise.resolve().then(()=>stopped?undefined:dispatch(line)).then(result=>{
      if(stopped)return;
      if(typeof result!=='string'||Buffer.byteLength(result)>responseLimit||!result.endsWith('\n')||/[\r\n]/.test(result.slice(0,-1)))throw Error('STREAM_RESPONSE_INVALID');
      writeChain=writeChain.then(()=>write(result));return writeChain;
    }).catch(()=>stop('STREAM_DISPATCH_OR_OUTPUT_FAILED')).finally(()=>pending.delete(job));
    pending.add(job);
  };
  return Object.freeze({
    done,
    stop(){stop('HOST_STOPPED');return done;},
    start(){
      if(started)throw Error('NATIVE_REVIEW_STREAM_ALREADY_STARTED');started=true;
      input.on('error',()=>stop('STREAM_INPUT_FAILED'));
      input.on('close',()=>stop(input.readableEnded?(bytes?'STREAM_TRAILING_PARTIAL':'STREAM_EOF'):'STREAM_DISCONNECTED'));
      output.on('error',()=>stop('STREAM_OUTPUT_FAILED'));
      output.on('close',()=>stop('STREAM_DISCONNECTED'));
      (async()=>{
        try{
          for await(const chunk of input){
            if(stopped)break;
            if(!Buffer.isBuffer(chunk)||chunk.length>maxChunk){stop('STREAM_INPUT_LIMIT');break;}
            let offset=0;
            while(offset<chunk.length&&!stopped){
              const end=chunk.indexOf(10,offset),limit=end<0?chunk.length:end+1,part=chunk.subarray(offset,limit);
              if(bytes+part.length>maxLine){stop('STREAM_INPUT_LIMIT');break;}
              // One bounded allocation, not one retained Buffer per fragment.
              // Tiny transport chunks must not multiply metadata allocations.
              lineBuffer??=Buffer.alloc(maxLine);part.copy(lineBuffer,bytes);bytes+=part.length;offset=limit;
              if(end<0)continue;
              let line;
              try{line=new TextDecoder('utf-8',{fatal:true}).decode(lineBuffer.subarray(0,bytes));}catch{stop('STREAM_UTF8_INVALID');break;}
              bytes=0;
              while(pending.size>=2&&!stopped)await Promise.race(pending);
              if(!stopped)admit(line);
            }
          }
          if(!stopped)stop(bytes?'STREAM_TRAILING_PARTIAL':'STREAM_EOF');
        }catch{stop('STREAM_INPUT_FAILED');}
      })();
      return done;
    },
  });
}
