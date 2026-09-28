import {validateAgentSessionBinding} from './agentSessionProtocol.js';
import {createRuntimeEventCodec} from './runtimeEventLedger.js';

export const exchangeFields=['turn','request','response','observed','explanation','error','solution','evidence'];
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
export function validateExchangeReport(input,expected){
  if(!exact(input,['binding','exchangeId','summary']))throw Error('EXCHANGE_REPORT_INVALID');
  const binding={...validateAgentSessionBinding(input.binding)};
  if(expected&&Object.keys(binding).some(k=>binding[k]!==expected[k]))throw Error('EXCHANGE_REPORT_FOREIGN');
  if(typeof input.exchangeId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(input.exchangeId)||!exact(input.summary,exchangeFields))throw Error('EXCHANGE_REPORT_INVALID');
  const summary={};
  for(const key of exchangeFields){
    const value=input.summary[key];
    if(typeof value!=='string'||value.length>1000||(['turn','request','response'].includes(key)&&!value.trim()))throw Error('EXCHANGE_REPORT_INVALID');
    summary[key]=value;
  }
  if(new TextEncoder().encode(JSON.stringify(input)).length>12000)throw Error('EXCHANGE_REPORT_LIMIT');
  return {binding,exchangeId:input.exchangeId,summary};
}
// Same conservative redaction as Operations. Never store the unredacted report.
export function redactExchangeSummary(report){
  return createRuntimeEventCodec().capture({projectId:report.binding.projectId,generation:0,adapter:'agent-exchange',source:'developer-notes',severity:'info',message:'Agent-reported exchange',runId:null,taskId:null,payload:report.summary}).payload;
}
