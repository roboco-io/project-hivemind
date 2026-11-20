import {createHash} from 'node:crypto';
/** Local copy of packages/contracts TOOL_AUDIT_LIMITS; runtime code must not import contract values. */
export const TOOL_AUDIT_LIMITS={recordBytes:1024,summaryBytes:512,batchRecords:32,taskRecords:20000,taskBytes:16*1024*1024,spoolBytes:8*1024*1024} as const;
export interface ToolAuditRecord {sequence:number;tool:string;inputDigest:string;inputSummary:string;inputTruncated:boolean;outcome:'allowed'|'denied'|'error';startedAt:number;durationMs:number|null;subagent?:true}
const MARK='[REDACTED]';
const PATTERNS:[RegExp,string][]=[
 [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,MARK],
 [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,'$1'+MARK+'@'],
 [/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s'",;]+/gi,'$1'+MARK],
 [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,'Bearer '+MARK],
 [/\bsk-ant-[A-Za-z0-9_-]{8,}/g,MARK],
 [/\bsk-proj-[A-Za-z0-9_-]{8,}/g,MARK],
 [/\bgh[pousr]_[A-Za-z0-9]{16,}/g,MARK],
 [/\bgithub_pat_[A-Za-z0-9_]{16,}/g,MARK],
 [/\bhf_[A-Za-z0-9]{16,}/g,MARK],
 [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,MARK],
 [/\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(?:\\"[\s\S]*?\\"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|"']+)/gi,'$1$2'+MARK]
];
export function redactText(text:string,secrets:readonly string[]):string {
 let out=text;
 for(const secret of [...secrets].filter(s=>typeof s==='string'&&s.length>=4).sort((a,b)=>b.length-a.length))out=out.split(secret).join(MARK);
 for(const [pattern,replacement] of PATTERNS)out=out.replace(pattern,replacement);
 return out;
}
function canonical(value:unknown):string {
 const walk=(v:unknown):unknown=>Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,walk((v as Record<string,unknown>)[k])])):v;
 try{return JSON.stringify(walk(value))??'null';}catch{return '"[unserializable]"';}
}
/** Cuts at a code point boundary so that UTF-8 size and JSON-escaped size both stay within the budgets. */
export function truncateSummary(text:string,maxBytes:number=TOOL_AUDIT_LIMITS.summaryBytes,maxJsonBytes:number=maxBytes+128):{text:string;truncated:boolean} {
 let bytes=0,json=0,out='';
 for(const ch of text){
  const b=Buffer.byteLength(ch),j=Buffer.byteLength(JSON.stringify(ch))-2;
  if(bytes+b>maxBytes||json+j>maxJsonBytes)return {text:out,truncated:true};
  bytes+=b;json+=j;out+=ch;
 }
 return {text:out,truncated:false};
}
export function summarizeToolInput(tool:string,input:unknown,secrets:readonly string[]):{inputDigest:string;inputSummary:string;inputTruncated:boolean} {
 const object=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:undefined;
 const raw=typeof input==='string'?input:tool==='Bash'&&typeof object?.command==='string'?object.command:canonical(input);
 const inputDigest=createHash('sha256').update(raw).digest('hex');
 const cut=truncateSummary(redactText(raw,secrets));
 return {inputDigest,inputSummary:cut.text,inputTruncated:cut.truncated};
}
