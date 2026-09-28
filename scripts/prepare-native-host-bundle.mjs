import {open,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyNativeReviewHostPackage} from '../src/node/nativeReviewHostPackage.mjs';

// Trusted build input only, never imported by the renderer or repository intake.
// An explicit file map prevents unlisted files from entering the host bundle.
// The returned pin must accompany the same Tauri build invocation; build.rs
// embeds it and the installed native verifier checks it again before launch.
export async function prepareNativeHostBundle(config){
  if(!config||typeof config!=='object'||Array.isArray(config)||
    Object.keys(config).length!==3||!['packageRoot','manifestDigest','outputFile'].every(k=>Object.hasOwn(config,k)))throw Error('HOST_BUNDLE_CONFIG_INVALID');
  const {packageRoot,manifestDigest,outputFile}=structuredClone(config);
  if(typeof outputFile!=='string'||!path.isAbsolute(outputFile)||path.normalize(outputFile)!==outputFile||outputFile.includes('\0'))throw Error('HOST_BUNDLE_OUTPUT_INVALID');
  for(const part of outputFile.slice(path.parse(outputFile).root.length).split(path.sep)){
    if(!part||/[<>:"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))throw Error('HOST_BUNDLE_OUTPUT_INVALID');
  }
  const spelling=p=>process.platform==='win32'?p.toLowerCase():p;
  for(let dir=path.dirname(outputFile);;){
    const info=await lstat(dir);
    if(!info.isDirectory()||info.isSymbolicLink()||spelling(await realpath(dir))!==spelling(dir))throw Error('HOST_BUNDLE_OUTPUT_UNSAFE');
    const parent=path.dirname(dir);if(parent===dir)break;dir=parent;
  }
  const verified=await verifyNativeReviewHostPackage({packageRoot,manifestDigest});
  if(!verified.files.some(f=>f.path==='host/src/node/installedNativeReviewHostProcess.mjs'))throw Error('HOST_BUNDLE_BOOTSTRAP_MISSING');
  const relative=path.relative(packageRoot,outputFile);
  if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('HOST_BUNDLE_OUTPUT_INSIDE_PACKAGE');
  const resources={};
  for(const name of ['manifest.json',...verified.files.map(f=>f.path)]){
    resources[path.join(packageRoot,...name.split('/'))]='native-review-host/'+name;
  }
  const overlay={bundle:{resources}};
  // Never overwrite an earlier build definition. An interrupted write remains
  // visible as a failed artifact and is not silently reused.
  const bytes=Buffer.from(JSON.stringify(overlay,null,2)+'\n');
  const handle=await open(outputFile,'wx',0o600);let written;
  try{await handle.writeFile(bytes);await handle.sync();written=await handle.stat({bigint:true});}finally{await handle.close();}
  const reader=await open(outputFile,'r');
  try{
    const observed=await reader.stat({bigint:true});
    const same=s=>s.isFile()&&s.nlink===1n&&['dev','ino','size','mtimeNs','ctimeNs'].every(k=>s[k]===written[k]);
    if(!same(observed)||observed.size!==BigInt(bytes.length))throw Error('HOST_BUNDLE_OUTPUT_CHANGED');
    const actual=Buffer.alloc(bytes.length+1);let offset=0;
    while(offset<actual.length){const {bytesRead}=await reader.read(actual,offset,actual.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
    const current=await lstat(outputFile,{bigint:true});
    if(offset!==bytes.length||!actual.subarray(0,offset).equals(bytes)||!same(await reader.stat({bigint:true}))||!same(current)||current.isSymbolicLink()||spelling(await realpath(outputFile))!==spelling(outputFile))throw Error('HOST_BUNDLE_OUTPUT_CHANGED');
  }finally{await reader.close();}
  return Object.freeze({configFile:outputFile,resourceCount:Object.keys(resources).length,
    buildEnvironment:Object.freeze({PP_NATIVE_HOST_MANIFEST_SHA256:manifestDigest}),
    executionAuthorized:false,publisherVerified:false});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==5)throw Error('Expected: package-root trusted-manifest-sha256 new-config-file');
    const result=await prepareNativeHostBundle({packageRoot:process.argv[2],manifestDigest:process.argv[3],outputFile:process.argv[4]});
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
}
