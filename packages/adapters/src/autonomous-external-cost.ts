import {assertAwsRegion} from './autonomous-aws-region.js';
import {createHash,createHmac} from 'node:crypto';
import type {ExternalInvocation} from '../../contracts/src/autonomous-external.js';
import type {ExternalSqlPort} from '../../core/src/autonomous-external-sql.ts';
import {externalParametersHash} from '../../core/src/autonomous-external.ts';
export interface ExternalCostQuote {maximumQueryFeeMicros:number;resourceUpperBoundMicros:number}
export interface ExternalCostResult {verifiedCostMicros:number|null;final:boolean;evidenceId?:string}
export interface ExternalCostReader {
 quote(invocation:ExternalInvocation):ExternalCostQuote|null;
 read(invocation:ExternalInvocation,proof:{resourceConfirmedAbsent:boolean;observedStoppedAt:number}):Promise<ExternalCostResult>;
}
interface CostRecord {
 version:1;bindingHash:string;stoppedAt:number;requestCount:number;lastAttemptAt:number;
 resourceMicros?:number;resourceEvidence?:string;result?:ExternalCostResult;
}
export interface ExternalCostCache {
 /** Atomic persistent per-action read/modify/write, shared by all reader instances. */
 transaction<T>(key:string,fn:(record:CostRecord|undefined)=>{record:CostRecord;value:T}):T;
}
export interface AwsCostExplorerOptions {
 enabled?:boolean;accountId:string;resourceRegion:string;allowedRegions?:string[];workloadId:string;
 queryUpperBoundMicros:number;maxQueryCount:number;resourceUpperBoundMicros:number;
 tagActivation:{evidenceId:string;activeSince:number;observedAt:number;validUntil:number};
 cache:ExternalCostCache;
 credentials:(scope:Readonly<{accountId:string;resourceRegion:string;billingRegion:'us-east-1';purpose:'cost_read'}>)=>Promise<{accessKeyId:string;secretAccessKey:string;sessionToken?:string}>;
 /** Separate verified invoice/source for CE queries and every non-owner-EC2/EBS fee.
  * Lookup pre-existing verified receipts only; must not initiate new paid requests.
  * No source is installed here. Never supply model output or an assumed free tariff. */
 supplement?:{read(invocation:ExternalInvocation,scope:{scopeHash:string;requestCount:number;resourceEvidenceId:string}):Promise<{scope:'ce_queries_and_non_ec2_ebs';scopeHash:string;coveredRequestCount:number;verifiedCostMicros:number;final:true;evidenceId:string}|null>};
 fetch?:typeof fetch;now?:()=>number;
}
const DAY=86400000,MAX_BODY=1024*1024;
const unknown=():ExternalCostResult=>({verifiedCostMicros:null,final:false});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function check(v:unknown):asserts v {if(!v)throw Error('External cost unavailable');}
const int=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const date=(n:number)=>new Date(n).toISOString().slice(0,10);
const safe=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\s\p{Cc}]/u.test(v);
function data(v:unknown):Record<string,any>{check(v&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,any>;}
function validateRecord(r:CostRecord){
 check(r.version===1&&/^[a-f0-9]{64}$/.test(r.bindingHash)&&int(r.stoppedAt)&&int(r.lastAttemptAt)&&int(r.requestCount)&&r.requestCount<=14&&r.requestCount%2===0&&(r.requestCount>0||r.lastAttemptAt===0&&r.resourceMicros===undefined&&r.result===undefined));
 if(r.resourceMicros!==undefined)check(int(r.resourceMicros)&&safe(r.resourceEvidence));
 if(r.result)check(int(r.result.verifiedCostMicros)&&r.result.final===true&&safe(r.result.evidenceId));
}
export function createExternalCostCache(sql:ExternalSqlPort):ExternalCostCache {
 sql.exec('CREATE TABLE IF NOT EXISTS external_cost_cache (action_key TEXT PRIMARY KEY, data TEXT NOT NULL)');
 return {transaction(key,fn){return sql.transactionSync(()=>{
  check(/^[a-f0-9]{64}$/.test(key));const rows=[...sql.exec('SELECT data FROM external_cost_cache WHERE action_key=?',key)];check(rows.length<=1);
  let prior:CostRecord|undefined;if(rows[0]){const json=String(rows[0].data);check(Buffer.byteLength(json)<=8192);prior=JSON.parse(json);validateRecord(prior!);}
  const next=fn(prior);check(next&&typeof next==='object'&&!('then' in next));validateRecord(next.record);
  const encoded=JSON.stringify(next.record);check(Buffer.byteLength(encoded)<=8192);
  if(encoded!==JSON.stringify(prior))sql.exec('INSERT INTO external_cost_cache VALUES(?,?) ON CONFLICT(action_key) DO UPDATE SET data=excluded.data',key,encoded);
  return structuredClone(next.value);
 });}};
}
/** Sum decimal USD exactly, then ceil ONCE to integer micro USD. */
function micros(values:string[]):number {
 let scale=0;const parts=values.map(v=>{check(typeof v==='string'&&/^(?:0|[1-9]\d{0,15})(?:\.\d{1,18})?$/.test(v));const [whole,fraction='']=v.split('.');scale=Math.max(scale,fraction.length);return {whole:whole!,fraction};});
 let total=0n;for(const p of parts)total+=BigInt(p.whole+p.fraction.padEnd(scale,'0'));
 const divisor=10n**BigInt(scale),amount=(total*1000000n+divisor-1n)/divisor;check(amount<=BigInt(Number.MAX_SAFE_INTEGER));return Number(amount);
}
/** Optional CE adapter; it never infers absence, free queries or whole-account finality. */
export function createAwsCostExplorerReader(options?:AwsCostExplorerOptions):ExternalCostReader {
 const {credentials,cache,supplement,fetch:fetcher=globalThis.fetch,now=Date.now,...raw}=options??{} as Partial<AwsCostExplorerOptions>;
 const c=structuredClone(raw);
 function scope(i:ExternalInvocation){
  assertAwsRegion(c.resourceRegion!,c.allowedRegions);
  check(c.enabled===true&&cache&&typeof cache.transaction==='function'&&typeof credentials==='function'&&/^\d{12}$/.test(c.accountId??'')&&safe(c.workloadId));
  check(int(c.queryUpperBoundMicros)&&c.queryUpperBoundMicros!>0&&int(c.resourceUpperBoundMicros)&&int(c.maxQueryCount)&&c.maxQueryCount!>=2&&c.maxQueryCount!<=14);
  const a=c.tagActivation;check(a&&safe(a.evidenceId)&&int(a.activeSince)&&int(a.observedAt)&&int(a.validUntil)&&a.activeSince<=a.observedAt&&a.observedAt<=now()&&a.validUntil>now());
  check(i.profile.provider==='aws'&&i.operation==='aws.spot.start'&&i.profile.enabled===true&&i.profile.target.accountId===c.accountId&&i.profile.target.region===c.resourceRegion&&i.profile.target.workloadId===c.workloadId&&externalParametersHash(i.profile,i.operation,i.parameters)===i.parametersHash);
  check(safe(i.taskId)&&safe(i.actionId)&&safe(i.ownershipToken)&&int(i.revision)&&i.revision>0&&int(i.expiresAt));
  const ttl=(i.parameters as {lifetimeMs:number}).lifetimeMs,start=i.expiresAt-ttl;
  check(int(start)&&a.activeSince<=start&&a.observedAt<=start);
  const fee=c.queryUpperBoundMicros!*c.maxQueryCount!;check(int(fee)&&int(fee+c.resourceUpperBoundMicros!));
  return {start,quote:{maximumQueryFeeMicros:fee,resourceUpperBoundMicros:c.resourceUpperBoundMicros!},bindingHash:sha(JSON.stringify([i.profile,i.taskId,i.revision,i.actionId,i.ownershipToken,i.idempotencyKey,i.parametersHash,i.expiresAt,c]))};
 }
 async function call(action:string,body:unknown):Promise<{body:Record<string,any>;requestId:string}>{
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),5000);let abort:()=>void=()=>{};
  const work=async()=>{
   const credential=await credentials!({accountId:c.accountId!,resourceRegion:c.resourceRegion!,billingRegion:'us-east-1',purpose:'cost_read'});
   check(safe(credential.accessKeyId,128)&&safe(credential.secretAccessKey,4096)&&(credential.sessionToken===undefined||safe(credential.sessionToken,8192)));
   const payload=JSON.stringify(body),stamp=new Date(now()).toISOString().replace(/[:-]|\.\d{3}/g,''),day=stamp.slice(0,8),host='ce.us-east-1.amazonaws.com';
   const headers:Record<string,string>={host,'content-type':'application/x-amz-json-1.1','x-amz-date':stamp,'x-amz-target':'AWSInsightsIndexService.'+action};if(credential.sessionToken)headers['x-amz-security-token']=credential.sessionToken;
   const names=Object.keys(headers).sort(),signed=names.join(';'),canonical=names.map(k=>`${k}:${headers[k]!.trim()}\n`).join('');
   const awsScope=`${day}/us-east-1/ce/aws4_request`,request=['POST','/','',canonical,signed,sha(payload)].join('\n');
   const hmac=(key:string|Uint8Array,v:string)=>createHmac('sha256',key).update(v).digest();
   let key=hmac('AWS4'+credential.secretAccessKey,day);for(const v of ['us-east-1','ce','aws4_request'])key=hmac(key,v);
   headers.authorization=`AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${awsScope}, SignedHeaders=${signed}, Signature=${createHmac('sha256',key).update(['AWS4-HMAC-SHA256',stamp,awsScope,sha(request)].join('\n')).digest('hex')}`;
   control.signal.throwIfAborted();const response=await fetcher('https://ce.us-east-1.amazonaws.com/',{method:'POST',headers,body:payload,redirect:'manual',signal:control.signal});check(response.status>=200&&response.status<300&&!response.redirected);
   const length=response.headers.get('content-length');check(length===null||/^\d+$/.test(length)&&Number(length)<=MAX_BODY);
   const requestId=response.headers.get('x-amzn-requestid');check(safe(requestId,128));const reader=response.body?.getReader();check(reader);const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BODY){await reader.cancel();throw Error();}chunks.push(part.value);}}finally{reader.releaseLock();}
   return {body:data(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))),requestId};
  };
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{abort=()=>reject(Error('External cost unavailable'));control.signal.addEventListener('abort',abort,{once:true});if(control.signal.aborted)abort();})]);}
  finally{clearTimeout(timer);control.signal.removeEventListener('abort',abort);control.abort();}
 }
 function resourceCost(response:Record<string,any>,i:ExternalInvocation,begin:number,end:number):number {
  const definitions=response.GroupDefinitions;
  check(!response.NextPageToken&&Array.isArray(definitions)&&definitions.length===2&&definitions[0]?.Type==='DIMENSION'&&definitions[0]?.Key==='LINKED_ACCOUNT'&&definitions[1]?.Type==='TAG'&&definitions[1]?.Key==='hivemind:owner');
  const rows=response.ResultsByTime;check(Array.isArray(rows)&&rows.length===(end-begin)/DAY);const amounts:string[]=[];
  for(let n=0;n<rows.length;n++){
   const row=data(rows[n]);check(row.Estimated===false&&row.TimePeriod?.Start===date(begin+n*DAY)&&row.TimePeriod?.End===date(begin+(n+1)*DAY)&&Array.isArray(row.Groups)&&row.Groups.length===1);
   const group=data(row.Groups[0]);check(JSON.stringify(group.Keys)===JSON.stringify([c.accountId,'hivemind:owner$'+i.ownershipToken]));
   const metric=data(group.Metrics?.UnblendedCost);check(metric.Unit==='USD');amounts.push(metric.Amount);
  }
  return micros(amounts);
 }
 async function complete(i:ExternalInvocation,actionKey:string,bindingHash:string,record:CostRecord,begin:number,end:number):Promise<ExternalCostResult>{
  if(record.result)return record.result;
  if(record.resourceMicros===undefined)return unknown();
  const partial:ExternalCostResult={verifiedCostMicros:record.resourceMicros,final:false,evidenceId:record.resourceEvidence};
  if(!supplement)return partial;
  const scopeHash=sha(JSON.stringify([bindingHash,begin,end,record.requestCount,record.resourceEvidence]));
  const extra=await supplement.read(structuredClone(i),{scopeHash,requestCount:record.requestCount,resourceEvidenceId:record.resourceEvidence!});
  if(!extra)return partial;
  check(extra.scope==='ce_queries_and_non_ec2_ebs'&&extra.scopeHash===scopeHash&&extra.coveredRequestCount===record.requestCount&&extra.final===true&&int(extra.verifiedCostMicros)&&safe(extra.evidenceId));
  const total=record.resourceMicros+extra.verifiedCostMicros;check(int(total));
  const result:ExternalCostResult={verifiedCostMicros:total,final:true,evidenceId:'ce-final:'+sha(JSON.stringify([scopeHash,extra.evidenceId,total]))};
  return cache!.transaction(actionKey,current=>{check(current&&current.bindingHash===bindingHash);if(current.result)return {record:current,value:current.result};if(current.requestCount!==record.requestCount)return {record:current,value:partial};return {record:{...current,result},value:result};});
 }
 const api:ExternalCostReader={
  quote(i){try{return scope(i).quote;}catch{return null;}},
  async read(i,proof){
   let previous:ExternalCostResult=unknown();
   try{
    const s=scope(i);check(proof.resourceConfirmedAbsent===true&&int(proof.observedStoppedAt)&&proof.observedStoppedAt>=s.start&&proof.observedStoppedAt<=now());
    const actionKey=sha(JSON.stringify([i.taskId,i.revision,i.actionId]));
    const reservation=cache!.transaction(actionKey,prior=>{
     if(prior)check(prior.bindingHash===s.bindingHash);
     const stoppedAt=prior?.stoppedAt??proof.observedStoppedAt,begin=Math.floor(s.start/DAY)*DAY,end=(Math.floor(stoppedAt/DAY)+1)*DAY;
     check((end-begin)/DAY>=1&&(end-begin)/DAY<=14);
     const record=prior??{version:1 as const,bindingHash:s.bindingHash,stoppedAt,requestCount:0,lastAttemptAt:0};
     const permit=record.resourceMicros===undefined&&end+2*DAY<=now()&&(!prior||record.requestCount===0||now()-record.lastAttemptAt>=DAY)&&record.requestCount+2<=c.maxQueryCount!;
     const next=permit?{...record,requestCount:record.requestCount+2,lastAttemptAt:now()}:record;
     return {record:next,value:{permit,record:next,begin,end}};
    });
    const {record,permit,begin,end}=reservation;
    previous=record.result??(record.resourceMicros!==undefined?{verifiedCostMicros:record.resourceMicros,final:false,evidenceId:record.resourceEvidence}:unknown());if(!permit)return await complete(i,actionKey,s.bindingHash,record,begin,end);
    const active=await call('ListCostAllocationTags',{TagKeys:['hivemind:owner','hivemind:workload'],Status:'Active',Type:'UserDefined',MaxResults:100});
    check(!active.body.NextToken&&Array.isArray(active.body.CostAllocationTags));
    for(const name of ['hivemind:owner','hivemind:workload']){
     const tags=active.body.CostAllocationTags.filter((r:any)=>r.TagKey===name);check(tags.length===1&&tags[0].Type==='UserDefined'&&tags[0].Status==='Active');
     const at=Date.parse(tags[0].LastUpdatedDate);check(int(at)&&at<=s.start);
    }
    const response=await call('GetCostAndUsage',{TimePeriod:{Start:date(begin),End:date(end)},Granularity:'DAILY',Metrics:['UnblendedCost'],GroupBy:[{Type:'DIMENSION',Key:'LINKED_ACCOUNT'},{Type:'TAG',Key:'hivemind:owner'}],Filter:{And:[{Dimensions:{Key:'LINKED_ACCOUNT',Values:[c.accountId],MatchOptions:['EQUALS']}},{Dimensions:{Key:'REGION',Values:[c.resourceRegion],MatchOptions:['EQUALS']}},{Tags:{Key:'hivemind:owner',Values:[i.ownershipToken],MatchOptions:['EQUALS']}},{Tags:{Key:'hivemind:workload',Values:[c.workloadId],MatchOptions:['EQUALS']}},{Dimensions:{Key:'SERVICE',Values:['Amazon Elastic Compute Cloud - Compute','EC2 - Other'],MatchOptions:['EQUALS']}}]}});
    const cost=resourceCost(response.body,i,begin,end);check(record.resourceMicros===undefined||cost>=record.resourceMicros);
    const evidenceId='ce:'+response.requestId+':'+sha(JSON.stringify([response.body,i.parametersHash])).slice(0,32);
    const saved=cache!.transaction(actionKey,current=>{check(current&&current.bindingHash===s.bindingHash);if(current.result||current.requestCount!==record.requestCount)return {record:current,value:current};
     const next={...current,resourceMicros:cost,resourceEvidence:evidenceId};return {record:next,value:next};});
    previous={verifiedCostMicros:saved.resourceMicros??null,final:false,...(saved.resourceEvidence?{evidenceId:saved.resourceEvidence}:{})};
    return await complete(i,actionKey,s.bindingHash,saved,begin,end);
   }catch{return previous;}
  },
 };
 return api;
}
