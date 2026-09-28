// Explicit in-memory recovery fixture for unrelated editor UI tests. This
// does not qualify IndexedDB durability; dedicated recovery tests do that.
export function createMemoryTaskFormRecovery(appendTaskFormHistory){
 const histories=new Map(),key=binding=>`${binding.projectId}:${binding.rootIdentity}`;
 const change=(input,action)=>{const rows=appendTaskFormHistory(histories.get(key(input.binding))??[],input,action);histories.set(key(input.binding),rows);return structuredClone(rows.at(-1));};
 return {async list(binding){const history=histories.get(key(binding))??[],heads=new Map();history.forEach(row=>heads.set(row.editorId,row));return structuredClone({records:[...heads.values()],history});},async read(binding,id){return structuredClone((histories.get(key(binding))??[]).filter(row=>row.editorId===id).at(-1)??null);},async put(input){return change(input,'put');},async resolve(input){return change(input,'resolve');},subscribe(){return()=>{};}};
}
