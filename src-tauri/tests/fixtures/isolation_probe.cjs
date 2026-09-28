'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const input=process.env.PP_NODE_INPUT, runtime=process.env.PP_NODE_RUNTIME, output=process.env.PP_NODE_OUTPUT, owner=process.env.PP_OWNER_EVIDENCE;
assert.equal(fs.readFileSync(path.join(input,'nested/input.txt'),'utf8'),'allowed-input');
assert.equal(require(path.join(input,'nested/dependency.cjs')),41);
fs.writeFileSync(path.join(output,'output.txt'),'allowed-output');
const denied=[];
function mustDeny(name,action){let error;try{action()}catch(e){error=e}assert.ok(error&&['EACCES','EPERM','EBUSY'].includes(error.code),name+': expected access/share denial, got '+String(error));denied.push(name);}
mustDeny('owner-read',()=>fs.readFileSync(owner));
mustDeny('owner-write',()=>fs.writeFileSync(owner,'tampered-owner'));
for(const [label,root,file] of [['input',input,path.join(input,'nested/input.txt')],['runtime',runtime,process.execPath]]){
 mustDeny(label+'-write',()=>fs.writeFileSync(file,'tampered-copy'));
 mustDeny(label+'-delete',()=>fs.unlinkSync(file));
 mustDeny(label+'-file-rename',()=>fs.renameSync(file,file+'.moved'));
 mustDeny(label+'-root-rename',()=>fs.renameSync(root,root+'.moved'));
 mustDeny(label+'-create',()=>fs.writeFileSync(path.join(root,'injected.txt'),'injected'));
}
mustDeny('input-directory-rename',()=>fs.renameSync(path.join(input,'nested'),path.join(input,'moved')));
mustDeny('profile-root-rename',()=>fs.renameSync(path.dirname(input),path.dirname(input)+'.moved'));
console.log(JSON.stringify({node:process.version,ownInput:true,ownOutput:true,denied}));
