import {validateAutonomousCapabilities} from './runtime-shared/autonomous.ts';
import {validateSnapshot} from './snapshot.ts';
import type {NativeClaudeRequest,NativeClaudeResponse} from '../../../packages/contracts/src/autonomous-native.ts';
export interface SealedAuth {version:1;wrappedKey:string;iv:string;tag:string;ciphertext:string}
export interface AutonomousCloudInput {version:1;jobId:string;attempt:string;runtimeId:string;claudeNestedCompatible?:boolean;quotaPauseEnabled?:boolean;allowWebFetch?:boolean;request:NativeClaudeRequest;control:{origin:string;workerToken:string;reporterToken:string};authReturnPublicKey:string}
/** Private native transport only. Never place this envelope in public job artifacts. */
export interface AutonomousCloudOutput {version:1;jobId:string;attempt:string;ok:boolean;response?:NativeClaudeResponse;authReturn?:SealedAuth;errorCode?:string}
export const AUTONOMOUS_CLOUD_MAX_BYTES=16*1024*1024;
function record(v:unknown):Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid native envelope');return v as Record<string,any>;}
function keys(v:Record<string,any>,allowed:string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))throw Error('Invalid native envelope');}
function text(v:unknown,max=4096):v is string{return typeof v==='string'&&v.length>0&&v.length<=max&&!/[\p{Cc}]/u.test(v);}
function id(v:unknown){return typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);}
function uuid(v:unknown){return typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);}
function bounded(v:unknown){if(new TextEncoder().encode(JSON.stringify(v)).length>AUTONOMOUS_CLOUD_MAX_BYTES)throw Error('Invalid native envelope');}
function identity(v:Record<string,any>){if(v.version!==1||!id(v.jobId)||!uuid(v.attempt))throw Error('Invalid native identity');}
export function validateAutonomousCloudInput(value:unknown):AutonomousCloudInput{
 bounded(value);const v=record(value);keys(v,['version','jobId','attempt','runtimeId','claudeNestedCompatible','quotaPauseEnabled','allowWebFetch','request','control','authReturnPublicKey']);identity(v);
 for(const flag of ['quotaPauseEnabled','allowWebFetch'])if(v[flag]!==undefined&&typeof v[flag]!=='boolean')throw Error('Invalid trusted native gate');
 if(v.claudeNestedCompatible!==undefined&&typeof v.claudeNestedCompatible!=='boolean')throw Error('Invalid native configuration');
 if(!uuid(v.runtimeId)||typeof v.authReturnPublicKey!=='string'||v.authReturnPublicKey.length>16384||!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(v.authReturnPublicKey))throw Error('Invalid native configuration');
 const c=record(v.control);keys(c,['origin','workerToken','reporterToken']);const url=new URL(c.origin);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!text(c.workerToken)||!text(c.reporterToken)||c.workerToken===c.reporterToken||/\s/.test(c.workerToken+c.reporterToken))throw Error('Invalid native configuration');
 const r=record(v.request);keys(r,['version','taskId','executionLease','model','subagentModel','tools','goal','session','subscriptionAuth','maxRunMs','initialSnapshot','web','externalProfiles']);
 if(![r.model,r.subagentModel??r.model].every(m=>typeof m==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(m)))throw Error('Invalid native request');
 if(r.version!==1||!id(r.taskId)||!text(r.model,200)||(r.subagentModel!==undefined&&!text(r.subagentModel,200))||typeof r.goal!=='string'||!r.goal||r.goal.length>24000||r.goal.includes('\0')||typeof r.subscriptionAuth!=='string'||!/^sk-ant-oat01-[A-Za-z0-9_-]{8,262100}$/.test(r.subscriptionAuth)||!Number.isSafeInteger(r.maxRunMs)||r.maxRunMs<1||r.maxRunMs>120000||!Array.isArray(r.tools)||r.tools.length<1||new Set(r.tools).size!==r.tools.length)throw Error('Invalid native request');
 validateAutonomousCapabilities(r as unknown as NativeClaudeRequest);
 const l=record(r.executionLease);keys(l,['taskId','runId','workerId','token','expiresAt']);if(l.taskId!==r.taskId||!id(l.runId)||!id(l.workerId)||!text(l.token)||!Number.isSafeInteger(l.expiresAt))throw Error('Invalid native lease');
 const s=record(r.session);keys(s,['sessionId','model','sequence','data']);if(!uuid(s.sessionId)||s.model!==r.model||!Number.isSafeInteger(s.sequence)||s.sequence<0||!('data'in s))throw Error('Invalid native session');
 if(s.sequence===0?(s.data!==null||!r.initialSnapshot):(s.data===null||r.initialSnapshot!==undefined))throw Error('Invalid native session');
 if(r.initialSnapshot){const snap=record(r.initialSnapshot);validateSnapshot(snap);if(snap.files.reduce((n:number,f:{content:string})=>n+atob(f.content).length,0)>65536)throw Error('Invalid native snapshot');keys(snap,['version','digest','files']);if(snap.version!==1||typeof snap.digest!=='string'||!/^[a-f0-9]{64}$/.test(snap.digest)||!Array.isArray(snap.files)||snap.files.length>32)throw Error('Invalid native snapshot');}
 return value as AutonomousCloudInput;
}
export function validateAutonomousCloudOutput(value:unknown):AutonomousCloudOutput{
 bounded(value);const v=record(value);keys(v,['version','jobId','attempt','ok','response','authReturn','errorCode']);identity(v);
 if(typeof v.ok!=='boolean'||(v.ok?(!v.response||v.errorCode!==undefined):(v.response!==undefined||v.errorCode!=='NATIVE_EXECUTION_FAILED')))throw Error('Invalid native result');
 if(v.authReturn!==undefined){const a=record(v.authReturn);keys(a,['version','wrappedKey','iv','tag','ciphertext']);if(a.version!==1||!['wrappedKey','iv','tag','ciphertext'].every(k=>typeof a[k]==='string'&&a[k].length>0&&/^[A-Za-z0-9+/]+={0,2}$/.test(a[k])))throw Error('Invalid sealed auth');}
 if(v.response){const r=record(v.response);keys(r,['version','session','usage','outcome','wakeAt','boundary','quota','usageUnavailable']);const s=record(r.session),u=record(r.usage),b=record(r.boundary);keys(s,['sessionId','model','sequence','data']);keys(u,['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']);keys(b,['platform','verified','noNewPrivs','capabilitiesDropped']);if(r.version!==1||!uuid(s.sessionId)||!text(s.model,200)||!Number.isSafeInteger(s.sequence)||s.sequence<1||!('data'in s)||!['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0)||!['continue','complete','wait','input','failed'].includes(r.outcome)||(r.outcome==='wait'?(!Number.isSafeInteger(r.wakeAt)||r.wakeAt<=0||r.quota===undefined&&r.wakeAt<=Date.now()):r.wakeAt!==undefined)||b.platform!=='linux'||b.verified!==true||b.noNewPrivs!==1||b.capabilitiesDropped!==true)throw Error('Invalid native response');
 if(r.quota!==undefined){const q=record(r.quota);keys(q,['kind','resetsAt','evidence']);if(q.kind!=='rejected'||q.evidence!=='claude_rate_limit_event'||!Number.isSafeInteger(q.resetsAt)||q.resetsAt<=0||r.outcome!=='wait'||r.wakeAt!==q.resetsAt)throw Error('Invalid quota response');
 const d=record(s.data);keys(d,['version','sessionId','model','workspacePath','snapshot','transcripts']);if(d.version!==1||d.sessionId!==s.sessionId||d.model!==s.model||d.workspacePath!=='/workspace'||!Array.isArray(d.transcripts)||!d.transcripts.some((t:any)=>t?.path===s.sessionId+'.jsonl'&&typeof t.content==='string'&&t.content.trim().length>0))throw Error('Invalid quota checkpoint');validateSnapshot(d.snapshot);}
 if(Object.hasOwn(r,'usageUnavailable')&&(r.usageUnavailable!==true||!r.quota||Object.values(u).some(v=>v!==0)))throw Error('Invalid quota usage');
 }
 return value as AutonomousCloudOutput;
}
