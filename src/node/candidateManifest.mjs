import {createHash} from 'node:crypto';
// Same schema/order as candidateSnapshot. This records names, modes, sizes and
// content hashes, not input bytes, a filesystem lease or producer authority.
export function candidateManifestDigest(value){
 const fail=()=>{throw Error('NATIVE_TASK_CANDIDATE_MANIFEST_INVALID');};
 const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 if(!value||Object.keys(value).sort().join('|')!=='entries|index|schemaVersion'||value.schemaVersion!==2||!hex(value.index)||!Array.isArray(value.entries)||value.entries.length>100000)fail();
 let previous=null,bytes=0;
 for(const entry of value.entries){
  if(!Array.isArray(entry))fail();const [name,kind]=entry;
  if(typeof name!=='string'||!name||name.length>32768||name.includes('\0')||name.includes('\\')||name.includes(':')||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..')||(previous!==null&&previous>=name))fail();
  previous=name;
  if(kind==='missing'){if(entry.length!==2)fail();}
  else if(kind==='link'){if(entry.length!==3||!hex(entry[2]))fail();}
  else if(kind==='file'){
   if(entry.length!==5||!Number.isSafeInteger(entry[2])||entry[2]<0||!Number.isSafeInteger(entry[3])||entry[3]<0||entry[3]>65535||!hex(entry[4]))fail();
   bytes+=entry[2];if(bytes>2*1024*1024*1024)fail();
  }else fail();
 }
 const wire=JSON.stringify({schemaVersion:2,index:value.index,entries:value.entries});
 if(Buffer.byteLength(wire)>16*1024*1024)fail();
 return createHash('sha256').update(wire).digest('hex');
}
