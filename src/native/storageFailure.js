const unavailable=new Set(['NATIVE_SESSION_STORE_UNAVAILABLE','NATIVE_SESSION_STORAGE_NOT_RESERVED','NATIVE_DRAFT_STORAGE_UNAVAILABLE','NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE']);
const limits=new Set(['NATIVE_DRAFT_SESSION_LIMIT','NATIVE_DRAFT_STORAGE_LIMIT','NATIVE_DRAFT_DIAGNOSTIC_LIMIT']);
const recovery=new Set(['NATIVE_SESSION_STORE_INVALID','NATIVE_SESSION_STORE_UNCERTAIN','NATIVE_SESSION_STORE_CHANGED','NATIVE_SESSION_STORE_LEGACY_CHANGED','NATIVE_DRAFT_DIAGNOSTIC_INVALID','NATIVE_DRAFT_DIAGNOSTIC_CHANGED','NATIVE_DRAFT_SESSION_UNRESOLVED']);
// Native text, paths and arbitrary properties never become user-facing copy.
export function nativeStorageFailure(cause){
 if(cause?.executionAuthorized!==false||typeof cause.requiresRecovery!=='boolean'||typeof cause.requestMayHaveCommitted!=='boolean')return null;
 const kind=recovery.has(cause.code)?'recovery':limits.has(cause.code)?'limit':unavailable.has(cause.code)?'unavailable':null;
 if(!kind)return null;
 const messages={
  unavailable:'Native storage is unavailable. Check disk space and folder access, then refresh status. Keep the original request.',
  limit:'Native storage has reached its limit. Keep the original request and existing evidence; storage recovery is required before retrying.',
  recovery:'Native session history needs recovery. Keep the original request and existing evidence; do not reset the project or send a replacement.',
 };
 const error=Object.assign(new Error(messages[kind]),{code:cause.code,storageReason:kind,requiresRecovery:cause.requiresRecovery,requestMayHaveCommitted:cause.requestMayHaveCommitted,executionAuthorized:false});
 if(typeof cause.originalRequestId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cause.originalRequestId))error.originalRequestId=cause.originalRequestId;
 return error;
}
