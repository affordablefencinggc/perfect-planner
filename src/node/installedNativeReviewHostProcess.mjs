import {TextDecoder} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createInstalledNativeReviewHost} from './installedNativeReviewHost.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function uniqueKeys(text){const stack=[];for(const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)){if(token==='{'||token==='['){stack.push({object:token==='{',keys:new Set(),key:true});if(stack.length>16)return false;}else if(token==='}'||token===']')stack.pop();else if(token===','){if(stack.at(-1)?.object)stack.at(-1).key=true;}else if(token.startsWith('"')&&stack.at(-1)?.object&&stack.at(-1).key){const frame=stack.at(-1),key=JSON.parse(token);if(frame.keys.has(key))return false;frame.keys.add(key);frame.key=false;}}return true;}
function initialization(input){return new Promise((resolve,reject)=>{
  const buffer=Buffer.alloc(65536);let used=0,settled=false;
  const clear=()=>{input.off('readable',read);input.off('end',end);input.off('error',error);input.off('close',closed);};
  const fail=()=>{if(settled)return;settled=true;clear();reject(Error('HOST_INITIALIZATION_INVALID'));};
  const end=()=>fail(),error=()=>fail(),closed=()=>fail();
  const read=()=>{try{let chunk;while(!settled&&(chunk=input.read())!==null){if(!Buffer.isBuffer(chunk))return fail();const index=chunk.indexOf(10),take=index<0?chunk.length:index+1;if(used+take>buffer.length)return fail();chunk.copy(buffer,used,0,take);used+=take;if(index<0)continue;const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used));const message=JSON.parse(text);if(!uniqueKeys(text)||!exact(message,['version','kind','config'])||message.version!==1||message.kind!=='INITIALIZE_NATIVE_REVIEW_HOST')return fail();settled=true;clear();if(take<chunk.length)input.unshift(chunk.subarray(take));resolve(message.config);}}catch{fail();}};
  input.pause();input.on('readable',read);input.on('end',end);input.on('error',error);input.on('close',closed);read();
});}
function write(output,value,timeoutMs){return new Promise((resolve,reject)=>{
  let done=false,callback=false,drained=false;
  const clear=()=>{clearTimeout(timer);output.off('drain',drain);output.off('error',fail);output.off('close',fail);};
  const finish=()=>{if(!done&&callback&&drained){done=true;clear();resolve();}};
  const fail=()=>{if(done)return;done=true;clear();reject(Error('HOST_OUTPUT_UNSETTLED'));};
  const drain=()=>{drained=true;finish();};const timer=setTimeout(fail,timeoutMs);
  output.on('drain',drain);output.on('error',fail);output.on('close',fail);
  try{drained=output.write(JSON.stringify(value)+'\n',error=>{if(error)fail();else{callback=true;finish();}});finish();}catch{fail();}
});}
async function closeBounded(host){let timer;try{return await Promise.race([Promise.resolve().then(()=>host.shutdown()),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);})]);}catch{return null;}finally{clearTimeout(timer);}}

// Only inherited private supervisor pipes. The first message configures this
// host once; subsequent messages use the ordinary, config-free protocol.
// This module does not authenticate arbitrary peers or prove publisher trust.
export async function runInstalledNativeReviewHostProcess({input,output,startupTimeoutMs=10000,writeTimeoutMs=5000}){
  if(!input||typeof input.read!=='function'||typeof input.unshift!=='function'||typeof input.destroy!=='function'||!output||typeof output.write!=='function'||!Number.isInteger(startupTimeoutMs)||startupTimeoutMs<1||startupTimeoutMs>10000||!Number.isInteger(writeTimeoutMs)||writeTimeoutMs<1||writeTimeoutMs>5000)throw Error('HOST_PROCESS_CONFIG_INVALID');
  let host,abandoned=false,startupSettled=false,startupStarted=false,timer,stream,disconnect;
  const interrupted=new Promise((_,reject)=>{disconnect=()=>{if(!stream){abandoned=true;reject(Error('HOST_STARTUP_DISCONNECTED'));}};});
  input.on('error',disconnect);input.on('close',disconnect);input.on('end',disconnect);output.on('error',disconnect);output.on('close',disconnect);
  const startup=(async()=>{const config=await initialization(input);if(abandoned)throw Error('HOST_STARTUP_ABANDONED');startupStarted=true;const created=await createInstalledNativeReviewHost(config);if(abandoned){await closeBounded(created);throw Error('HOST_STARTUP_ABANDONED');}host=created;return created;})().finally(()=>{startupSettled=true;});
  let receipt;
  try{
    await Promise.race([startup,interrupted,new Promise((_,reject)=>{timer=setTimeout(()=>{abandoned=true;reject(Error('HOST_STARTUP_TIMEOUT'));},startupTimeoutMs);})]);
    clearTimeout(timer);
    if(abandoned)throw Error('HOST_STARTUP_ABANDONED');
    await write(output,{version:1,kind:'NATIVE_REVIEW_HOST_READY',binding:host.binding,packageManifestDigest:host.packageManifestDigest,executionAuthorized:false},writeTimeoutMs);
    if(abandoned)throw Error('HOST_STARTUP_ABANDONED');
    stream=host.attach({input,output});
    const result=await stream.start();
    receipt={version:1,kind:'NATIVE_REVIEW_HOST_STOPPED',reason:result.reason,startupSettled:true,dispatchesSettled:result.dispatchesSettled,shutdownSettled:result.shutdownSettled,outputSettled:result.outputSettled,cleanupComplete:result.cleanupComplete,dialogClosed:null,executionAuthorized:false};
  }catch{
    abandoned=true;clearTimeout(timer);input.destroy();let cleanup;
    if(host)cleanup=await closeBounded(host);
    receipt={version:1,kind:'NATIVE_REVIEW_HOST_STOPPED',reason:'HOST_INITIALIZATION_OR_TRANSPORT_FAILED',startupSettled,dispatchesSettled:!startupStarted,shutdownSettled:!!cleanup||!startupStarted,outputSettled:false,cleanupComplete:!startupStarted&&startupSettled,dialogClosed:null,executionAuthorized:false};
  }
  // No premature process.exit: late startup/cleanup remains observable. It can
  // never attach a stream once abandoned, but hashing is not cancellable yet.
  try{await write(output,receipt,writeTimeoutMs);}catch{receipt={...receipt,outputSettled:false,cleanupComplete:false};}
  input.off('error',disconnect);input.off('close',disconnect);input.off('end',disconnect);output.off('error',disconnect);output.off('close',disconnect);
  return Object.freeze(receipt);
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.length!==2){process.stderr.write('HOST_ARGUMENTS_REFUSED\n');process.exitCode=2;}
  else runInstalledNativeReviewHostProcess({input:process.stdin,output:process.stdout}).then(receipt=>{process.exitCode=receipt.cleanupComplete?0:2;},()=>{process.stderr.write('HOST_PROCESS_FAILED\n');process.exitCode=2;});
}
