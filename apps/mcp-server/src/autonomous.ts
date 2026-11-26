import {WorkloadDescriptorSchema} from '../../../packages/contracts/src/delegated.ts';
import {workloadFingerprint} from '../../../packages/core/src/delegated.ts';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';

const errorText='HIVEMIND 요청을 처리하지 못했습니다. 연결·권한·입력과 현재 작업 상태를 확인하세요.';
const base='/api/cloudflare/autonomous-tasks';
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const externalRequestId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/);
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeText=z.string().min(1).max(16000).refine(v=>!v.includes('\0'));
const model=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const unique=(values:string[])=>new Set(values).size===values.length;
const refs=z.array(id.refine(v=>!/(?:^(?:sk-|hf_|ghp_|github_pat_|AKIA|ASIA)|Bearer\s)/.test(v),'Use credential reference only')).length(1);
export const autonomousDraftSchema=z.strictObject({
  requestId:id,goal:safeText,provider:z.literal('claude'),model,subagentModel:model.optional(),
  endsAt:integer.min(1),budgetMicros:integer,tools:z.array(z.enum(['Bash','Agent','WebFetch','mcp__hivemind__action'])).min(1).max(4).refine(unique),
  systems:z.array(z.enum(['aws','hf','github'])).max(3).refine(unique),credentialIds:refs,
  externalProfiles:z.array(id).min(1).max(3).refine(unique).optional(),
  web:z.strictObject({allowedHosts:z.array(z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).min(1).max(32).refine(unique)}).optional(),
  execution:z.strictObject({backend:z.literal('cloudflare'),mode:z.enum(['pilot','long_running']).optional(),snapshotId:z.string().regex(/^[a-f0-9]{64}$/),checks:z.array(z.strictObject({id,argv:z.array(z.string().min(1).max(1000).refine(v=>!v.includes('\0'))).min(1).max(32),timeoutMs:integer.min(1000).max(10000)})).min(1).max(4)}),
  billingPolicy:z.strictObject({model:z.literal('subscription'),budget:z.literal('external_actions')}),
  maxRunMs:integer.min(1000).max(120000),maxIterations:integer.min(1).max(65536),
  schedule:z.strictObject({kind:z.literal('daily'),timeZone:z.string().min(1).max(100),localTime:z.string().regex(/^\d{2}:\d{2}$/)}).optional(),
}).superRefine((s,ctx)=>{
  if(!s.tools.includes('Bash')||s.tools.includes('WebFetch')!==Boolean(s.web)||s.tools.includes('mcp__hivemind__action')!==Boolean(s.externalProfiles)||(!s.externalProfiles&&s.systems.length)||s.externalProfiles&&!s.systems.length||s.execution.mode!=='long_running'&&s.maxIterations>4||!unique(s.execution.checks.map(c=>c.id)))ctx.addIssue({code:'custom',message:'Invalid explicit scope'});
});
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error(errorText);return v as Record<string,unknown>;}
const number=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?v as number:null;
const statuses=['awaiting_approval','ready','running','waiting','awaiting_input','stopping','completed','cancelled','budget_exceeded','expired','failed'];
export interface AutonomousOperatorOptions {apiUrl:string;operatorToken:string;fetchImpl?:typeof fetch;redact:(text:string)=>string}
export function registerAutonomousOperatorTools(server:McpServer,options:AutonomousOperatorOptions):void {
  const fetcher=options.fetchImpl??fetch;
  const text=(v:unknown,max=16000)=>typeof v==='string'?options.redact(v).replace(/(?:sk-ant-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+)/g,'[REDACTED]').slice(0,max):null;
  async function api(path:string,signal:AbortSignal,body?:unknown):Promise<unknown>{
    const encoded=body===undefined?undefined:JSON.stringify(body);if(encoded&&Buffer.byteLength(encoded)>65536)throw Error(errorText);
    const response=await fetcher(new URL(path,options.apiUrl),{method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:'Bearer '+options.operatorToken,...(encoded?{'content-type':'application/json'}:{})},...(encoded?{body:encoded}:{}),signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
    if(!response.ok||response.redirected||!response.body){void response.body?.cancel().catch(()=>{});throw Error(errorText);}
    const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0,done=false;
    try{for(;;){const part=await reader.read();if(part.done){done=true;break;}size+=part.value.byteLength;if(size>2_000_000)throw Error(errorText);parts.push(part.value);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}
    finally{if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  function specView(v:unknown){const s=record(v);return {goal:text(s.goal),provider:text(s.provider,20),model:text(s.model,100),subagentModel:text(s.subagentModel,100),endsAt:number(s.endsAt),budgetMicros:number(s.budgetMicros),tools:Array.isArray(s.tools)?s.tools.map(v=>text(v,128)).slice(0,4):[],systems:Array.isArray(s.systems)?s.systems.map(v=>text(v,20)).slice(0,3):[],credentialIds:Array.isArray(s.credentialIds)?s.credentialIds.map(v=>text(v,128)).slice(0,3):[],externalProfiles:Array.isArray(s.externalProfiles)?s.externalProfiles.map(v=>text(v,128)).slice(0,3):[],web:s.web?{allowedHosts:Array.isArray(record(s.web).allowedHosts)?(record(s.web).allowedHosts as unknown[]).slice(0,32).map(v=>text(v,253)):[]}:undefined,maxRunMs:number(s.maxRunMs),maxIterations:number(s.maxIterations),billingPolicy:s.billingPolicy?{model:text(record(s.billingPolicy).model,30),budget:text(record(s.billingPolicy).budget,40)}:undefined,schedule:s.schedule?{kind:text(record(s.schedule).kind,20),timeZone:text(record(s.schedule).timeZone,100),localTime:text(record(s.schedule).localTime,5)}:undefined,execution:s.execution?{backend:'cloudflare',mode:text(record(s.execution).mode,30),snapshotId:text(record(s.execution).snapshotId,64),checks:Array.isArray(record(s.execution).checks)?(record(s.execution).checks as unknown[]).slice(0,4).map(v=>{const c=record(v);return {id:text(c.id,128),argv:Array.isArray(c.argv)?c.argv.slice(0,32).map(v=>text(v,1000)):[],timeoutMs:number(c.timeoutMs)};}):[]}:undefined};}
  async function profileMetadata(t:Record<string,unknown>,signal:AbortSignal){
    const refs=record(t.spec).externalProfiles;if(refs===undefined||Array.isArray(refs)&&refs.length===0)return {profiles:[],available:true};
    if(!Array.isArray(refs)||refs.length>3||!refs.every(ref=>id.safeParse(ref).success)||new Set(refs).size!==refs.length)throw Error(errorText);
    try{
      const raw=record(await api(base+'/'+encodeURIComponent(String(t.id))+'/external-profiles',signal));
      if(raw.available===false||raw.enabled===false||!Array.isArray(raw.profiles)||raw.profiles.length!==refs.length)throw Error(errorText);
      const profiles=refs.map(ref=>{
        const p=record((raw.profiles as unknown[]).find(v=>record(v).id===ref)),target=record(p.target);
        if(p.enabled!==true||!['aws','hf','github'].includes(String(p.provider))||typeof p.profileHash!=='string'||!/^[a-f0-9]{64}$/.test(p.profileHash)||number(p.upperBoundMicros)===null||!Array.isArray(p.operations))throw Error(errorText);
        const fields=p.provider==='aws'?['accountId','region','workloadId']:p.provider==='hf'?['repository','revision',...('visibility'in target?['visibility']:[])]:['repository','branch'];
        if(fields.some(k=>typeof target[k]!=='string'||!target[k]))throw Error(errorText);
        const hasLargeConsent='allowPublicLarge'in target;
        if(hasLargeConsent&&(p.provider!=='hf'||target.allowPublicLarge!==true||target.visibility!=='public'||!p.operations.includes('hf.model.lfs_commit')))throw Error(errorText);
        if(p.provider==='hf'&&target.visibility!==undefined&&target.visibility!=='private'&&target.visibility!=='public')throw Error(errorText);
        if(p.provider==='hf'&&target.visibility==='public'&&p.operations.includes('hf.model.lfs_commit')&&!hasLargeConsent)throw Error(errorText);
        const display=p.provider==='hf'?record(p.hfVisibilityDisplay??{}):{};
        if(p.provider==='hf'&&target.visibility==='public'&&(display.visibility!=='public'||display.publicEffect!==true||typeof display.notice!=='string'))throw Error(errorText);
        const oidc=p.oidc===undefined?undefined:record(p.oidc);let oidcDisplay:Record<string,unknown>|undefined;
        if(oidc){oidcDisplay={issuer:text(oidc.issuer,256),audience:text(oidc.audience,255)};for(const purpose of ['execute','inspect','cleanup']){const v=record(oidc[purpose]);if(typeof v.roleArn!=='string'||!/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(v.roleArn)||typeof v.subject!=='string'||!/^hivemind:task:[a-f0-9]{64}:rev:[1-9][0-9]*:profile:[a-f0-9]{64}:(execute|inspect|cleanup)$/.test(v.subject)||typeof v.policyHash!=='string'||!/^[a-f0-9]{64}$/.test(v.policyHash)||!Number.isInteger(v.durationSeconds)||Number(v.durationSeconds)<1||Number(v.durationSeconds)>120)throw Error(errorText);oidcDisplay[purpose]={roleArn:text(v.roleArn,600),subject:text(v.subject,255),policyHash:v.policyHash,durationSeconds:v.durationSeconds};}}
        let delegatedDisplay:Record<string,unknown>|undefined;
        if(p.delegated!==undefined){const v=record(p.delegated),d=WorkloadDescriptorSchema.parse(v.descriptor);if(workloadFingerprint(d)!==v.descriptorHash||typeof v.inputManifestDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.inputManifestDigest)||!d.inputManifestDigests.includes(v.inputManifestDigest))throw Error(errorText);delegatedDisplay={descriptorHash:v.descriptorHash,inputManifestDigest:v.inputManifestDigest,descriptor:d};}
        return {...(oidcDisplay?{oidc:oidcDisplay}:{}),...(delegatedDisplay?{delegated:delegatedDisplay}:{}),id:text(p.id,128)!,provider:String(p.provider),profileHash:p.profileHash,target:{...Object.fromEntries(fields.map(k=>[k,text(target[k],200)])),...(hasLargeConsent?{allowPublicLarge:true}:{})},...(p.provider==='hf'?{publicEffect:target.visibility==='public',...(typeof display.notice==='string'?{visibilityNotice:text(display.notice,300)}:{})}:{}),operations:p.operations.slice(0,4).map(v=>text(v,128)),upperBoundMicros:number(p.upperBoundMicros),maxLifetimeMs:number(p.maxLifetimeMs),maxActiveActions:number(p.maxActiveActions)};
      });
      if(new Set(profiles.map(p=>p.provider)).size!==profiles.length)throw Error(errorText);return {profiles,available:true};
    }catch{return {profiles:[],available:false};}
  }
  async function reviewedTask(raw:unknown,signal:AbortSignal,limit=0){const t=record(raw),metadata=await profileMetadata(t,signal);return {...taskView(t,limit),externalProfilesMetadata:metadata.profiles,externalProfileMetadataAvailable:metadata.available};}
  function taskView(v:unknown,limit=0){
    const t=record(v);if(!id.safeParse(t.id).success||!number(t.revision)||!statuses.includes(String(t.status)))throw Error(errorText);
    const out:Record<string,unknown>={id:text(t.id,128),revision:t.revision,status:t.status,spec:specView(t.spec),spentMicros:number(t.spentMicros),reservedMicros:number(t.reservedMicros),iteration:number(t.iteration),nextRunAt:number(t.nextRunAt),stopReason:text(t.stopReason,1000),externalProfileMetadataAvailable:false,counts:{humanInterventions:number(t.counts&&record(t.counts).humanInterventions),helpRequests:number(t.counts&&record(t.counts).helpRequests),toolCalls:number(t.counts&&record(t.counts).toolCalls)}};
    if(limit){out.runs=(Array.isArray(t.runs)?t.runs:[]).slice(-limit).map(v=>{const r=record(v),u=r.usage?record(r.usage):{};return {runId:text(r.runId,128),outcome:text(r.outcome,30),costMicros:number(r.costMicros),reconciledCostMicros:number(r.reconciledCostMicros),usageUnavailable:r.usageUnavailable===true,usage:r.usageUnavailable===true?null:{inputTokens:number(u.inputTokens),cacheReadTokens:number(u.cacheReadTokens),cacheWriteTokens:number(u.cacheWriteTokens),outputTokens:number(u.outputTokens)}};});out.interventions=(Array.isArray(t.interventions)?t.interventions:[]).slice(-limit).map(v=>{const i=record(v);return {kind:text(i.kind,40),message:text(i.message,2000),at:number(i.at),revision:number(i.revision)};});out.actions=(Array.isArray(t.actions)?t.actions:[]).slice(-limit).map(v=>{const a=record(v);return {id:text(a.id,200),tool:text(a.tool,128),system:text(a.system,40),operation:text(a.operation,128),status:text(a.status,30),estimatedCostMicros:number(a.estimatedCostMicros),actualCostMicros:a.status==='accepted'?null:number(a.actualCostMicros),billingStatus:a.status==='accepted'?'unknown':a.actualCostMicros===undefined?'unknown':'reported'};});out.resources=(Array.isArray(t.resources)?t.resources:[]).slice(-limit).map(v=>{const r=record(v);return {id:text(r.id,200),system:text(r.system,40),status:text(r.status,30)};});}
    return out;
  }
  async function run(work:()=>Promise<Record<string,unknown>>):Promise<CallToolResult>{try{const data=await work();return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}catch{return {isError:true,content:[{type:'text',text:errorText}]};}}
  function approvedTargetView(value:unknown):Record<string,string|boolean>|undefined {
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const v=record(value),fields='accountId'in v?['accountId','region','workloadId']:'repository'in v&&('branch'in v)!==('revision'in v)?['repository','branch'in v?'branch':'revision',...('visibility'in v?['visibility']:[])]:[];
    if(!fields.length||fields.some(k=>typeof v[k]!=='string'||!(v[k] as string).length||(v[k] as string).length>256))return;
    if('visibility'in v&&v.visibility!=='private'&&v.visibility!=='public')return;
    if('allowPublicLarge'in v&&(v.allowPublicLarge!==true||v.visibility!=='public'||!('revision'in v)))return;
    return {...Object.fromEntries(fields.map(k=>[k,text(v[k],256)!])),...('allowPublicLarge'in v?{allowPublicLarge:true}:{})};
  }
  const auditHash=z.string().regex(/^[a-f0-9]{64}$/);
  const auditParameters=z.object({lifetimeMs:integer.min(1).optional(),startActionId:externalRequestId.optional(),artifactDigest:auditHash.optional(),expectedHead:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional()}).refine(v=>Object.keys(v).length>0);
  const auditProviderResult=z.discriminatedUnion('kind',[
    z.object({kind:z.literal('aws_instance'),id:z.string().regex(/^i-[a-f0-9]{8,32}$/)}),
    z.object({kind:z.literal('hf_commit'),oid:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}),
    z.object({kind:z.literal('github_commit'),oid:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}),
  ]);
  function auditMetadata<T>(schema:z.ZodType<T>,value:unknown):T|undefined {
    const parsed=schema.safeParse(value);if(!parsed.success)return;
    const values=typeof parsed.data==='string'?[parsed.data]:Object.entries(parsed.data as Record<string,unknown>).filter(([key])=>key!=='kind').map(([,value])=>value);if(values.some(v=>typeof v==='string'&&text(v,4096)!==v))return;return parsed.data;
  }
  function externalActionView(value:unknown){
    const a=record(value),revision=number(a.revision),source=text(a.billingSource,64),approvedTarget=approvedTargetView(a.approvedTarget),parameterHash=auditMetadata(auditHash,a.parameterHash),parametersSubset=auditMetadata(auditParameters,a.parametersSubset??a.parameters),providerResult=auditMetadata(auditProviderResult,a.providerResult);
    return {...(parameterHash!==undefined?{parameterHash}:{}),...(parametersSubset?{parametersSubset}:{}),...(providerResult?{providerResult}:{}),requestId:text(a.requestId,256),...(revision!==null&&revision>=1?{revision}:{}),actionId:text(a.actionId,200),...(typeof a.resourceId==='string'?{resourceId:text(a.resourceId,256)}:{}),...(id.safeParse(a.profileId).success?{profileId:text(a.profileId,128)}:{}),...(approvedTarget?{approvedTarget,approvedTargetLabel:'승인 당시 대상'}:{}),...(typeof a.approvedProfileHash==='string'&&/^[a-f0-9]{64}$/.test(a.approvedProfileHash)?{approvedProfileHash:a.approvedProfileHash}:{}),phase:text(a.phase,30),status:text(a.status,30),operation:text(a.operation,128),effect:text(a.effect,30),cleanupStatus:text(a.cleanupStatus,30),verifiedCostMicros:number(a.verifiedCostMicros),billingFinal:a.billingFinal===true,...(source?{billingSource:source,billingSourceLabel:source==='operator_attested'?'운영자 확인 · provider API 측정 아님':'보고 출처: '+source+' · 검증 근거 별도'}:{}),...(typeof a.evidenceRef==='string'?{evidenceRef:text(a.evidenceRef,1000)}:{}),...(number(a.attestedAt)!==null?{attestedAt:number(a.attestedAt)}:{})};
  }
  const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},mutation={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
  const reason=z.string().trim().min(1).max(2000),taskPath=(taskId:string)=>base+'/'+encodeURIComponent(taskId);
  server.registerTool('hivemind_autonomous_list',{title:'장기 작업 목록',description:'Cloudflare 장기 작업의 제한된 페이지를 조회합니다. 503이면 설정을 확인하며 local로 우회하지 않습니다.',inputSchema:z.strictObject({limit:integer.min(1).max(20).default(20),cursor:z.string().min(1).max(512).optional()}),annotations:read},({limit,cursor},extra)=>run(async()=>{const p=record(await api(base+'?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):''),extra.signal));if(!Array.isArray(p.items)||p.items.length>limit)throw Error(errorText);return {items:p.items.map(v=>taskView(v)),...(typeof p.nextCursor==='string'?{nextCursor:text(p.nextCursor,512)}:{})};}));
  server.registerTool('hivemind_autonomous_get',{title:'장기 작업 승인 범위',description:'현재 revision, 명시적 모델·snapshot·검사·도구·자격 증명 reference와 외부 profile ID를 조회합니다.',inputSchema:z.strictObject({taskId:id}),annotations:read},({taskId},extra)=>run(async()=>({task:await reviewedTask(await api(taskPath(taskId)+'?view=summary',extra.signal),extra.signal)})));
  server.registerTool('hivemind_autonomous_create',{title:'장기 작업 초안 등록',description:'사용자가 지정한 전체 범위로 초안만 등록합니다. 모델·snapshot·대상·인증 reference를 추측하지 않습니다. 등록 뒤 자동 승인하지 마세요.',inputSchema:autonomousDraftSchema,annotations:mutation},(args,extra)=>run(async()=>{const t=record(await api(base,extra.signal,args));if(t.status!=='awaiting_approval'||t.revision!==1)throw Error(errorText);return {task:taskView(t),executionApproved:false};}));
  server.registerTool('hivemind_autonomous_approve',{title:'장기 작업 현재 revision 실행 승인',description:'사용자가 명시적으로 실행을 승인한 현재 revision과 사유를 전달합니다. 외부 profile은 get에서 표시한 ID별 profileHash를 externalProfileHashes로 전달해야 합니다. 새 target을 자동 승인하지 마세요.',inputSchema:z.strictObject({taskId:id,revision:integer.min(1),reason,externalProfileHashes:z.record(id,z.string().regex(/^[a-f0-9]{64}$/)).refine(v=>Object.keys(v).length<=3).optional()}),annotations:mutation},({taskId,revision,reason,externalProfileHashes},extra)=>run(async()=>{
    const t=record(await api(taskPath(taskId)+'?view=summary',extra.signal));if(t.revision!==revision||t.status!=='awaiting_approval')throw Error(errorText);
    const refs=record(t.spec).externalProfiles as string[]|undefined;
    if(refs?.length){const metadata=await profileMetadata(t,extra.signal);if(!metadata.available||!externalProfileHashes||Object.keys(externalProfileHashes).length!==refs.length||metadata.profiles.some(p=>externalProfileHashes[p.id]!==p.profileHash))throw Error(errorText);}
    else if(externalProfileHashes&&Object.keys(externalProfileHashes).length)throw Error(errorText);
    return {task:taskView(await api(taskPath(taskId)+'/approve',extra.signal,{revision,reason,...(refs?.length?{externalProfileHashes}:{})}))};
  }));
  server.registerTool('hivemind_autonomous_cancel',{title:'장기 작업 중단 요청',description:'사용자의 명시적 지시에 따라 중단을 요청합니다. stopping은 실제 종료·정리 완료가 아닙니다.',inputSchema:z.strictObject({taskId:id,reason}),annotations:{...mutation,destructiveHint:true}},({taskId,reason},extra)=>run(async()=>{const current=record(await api(taskPath(taskId)+'?view=summary',extra.signal));if(current.id!==taskId)throw Error(errorText);return {task:taskView(await api(taskPath(taskId)+'/cancel',extra.signal,{reason}))};}));
  server.registerTool('hivemind_autonomous_message',{title:'장기 작업 운영자 메시지',description:'사용자가 요청한 메시지를 기록합니다. 메시지는 실행 승인이나 범위 확장을 대신하지 않습니다.',inputSchema:z.strictObject({taskId:id,message:reason}),annotations:mutation},({taskId,message},extra)=>run(async()=>({task:taskView(await api(taskPath(taskId)+'/message',extra.signal,{message}))})));
  server.registerTool('hivemind_autonomous_record_external_cost',{
    title:'외부 행동 운영자 확인 비용 기록',
    description:'사용자가 실제 최종 invoice 금액과 근거를 명시한 경우에만 호출합니다. audit의 정확한 taskId/requestId/revision을 사용하며 현재 revision으로 바꾸지 마세요. 서버가 실제 자원 부재를 이미 확인해야 하고 살아 있는 자원·미확정 청구를 면제하지 않습니다. OPERATOR_ATTESTED는 인간 확인이며 provider API 측정이 아닙니다. 토큰·요금 추정이나 자동 호출·재시도는 금지합니다.',
    inputSchema:z.strictObject({taskId:id,requestId:externalRequestId,revision:integer.min(1),actualCostMicros:integer.min(1),evidenceRef:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).refine(v=>! /^(?:sk-|hf_|ghp_|ghs_|github_pat_|AKIA|ASIA)/i.test(v)&&!v.includes(options.operatorToken)),reason:reason.max(1000).refine(v=>!/[\p{Cc}]/u.test(v)&&!v.includes(options.operatorToken)&&!/(?:Bearer\s+\S+|sk-ant-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:hf_|ghp_|ghs_|github_pat_)[A-Za-z0-9_]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(v))}),annotations:mutation,
  },({taskId,requestId,revision,actualCostMicros,evidenceRef,reason},extra)=>run(async()=>{
    const receipt=record(await api(taskPath(taskId)+'/external-actions/'+encodeURIComponent(requestId)+'/billing',extra.signal,{actualCostMicros,evidenceRef,reason,revision}));
    if(receipt.requestId!==requestId||receipt.revision!==revision||receipt.billingSource!=='operator_attested'||receipt.evidenceRef!==evidenceRef||receipt.verifiedCostMicros!==actualCostMicros||receipt.billingFinal!==true)throw Error(errorText);
    return {action:externalActionView(receipt)};
  }));
  server.registerTool('hivemind_autonomous_audit',{title:'장기 작업 감사 이력',description:'summary의 누적 counts와 제한된 네 이력 페이지·외부 행동 페이지를 조회합니다. 페이지 길이는 전체 건수가 아닙니다. 미측정 사용량·미확정 비용은 0이 아닙니다.',inputSchema:z.strictObject({taskId:id,limit:integer.min(1).max(100).default(20),cursor:z.string().min(1).max(4096).regex(/^[A-Za-z0-9_.-]+$/).optional(),historyCursors:z.strictObject({runs:z.string().min(1).max(512).optional(),actions:z.string().min(1).max(512).optional(),resources:z.string().min(1).max(512).optional(),interventions:z.string().min(1).max(512).optional()}).optional()}),annotations:read},({taskId,limit,cursor,historyCursors},extra)=>run(async()=>{
    const summary=record(await api(taskPath(taskId)+'?view=summary',extra.signal));
    const kinds=['runs','actions','resources','interventions'] as const;
    const histories=await Promise.all(kinds.map(async kind=>{
      const page=record(await api(taskPath(taskId)+'/history?kind='+kind+'&limit='+limit+(historyCursors?.[kind]?'&cursor='+encodeURIComponent(historyCursors[kind]!):''),extra.signal));
      if(!Array.isArray(page.items)||page.items.length>limit)throw Error(errorText);
      return {kind,items:page.items,pageCount:page.items.length,partial:Boolean(page.nextCursor)||Boolean(historyCursors?.[kind]),...(typeof page.nextCursor==='string'?{nextCursor:text(page.nextCursor,512)}:{})};
    }));
    const page=record(await api(taskPath(taskId)+'/external-actions?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):''),extra.signal));
    if(!Array.isArray(page.items)||page.items.length>limit)throw Error(errorText);
    const combined={...summary,...Object.fromEntries(histories.map(p=>[p.kind,p.items]))};
    return {task:await reviewedTask(combined,extra.signal,limit),historyPages:Object.fromEntries(histories.map(({kind,items:_items,...info})=>[kind,info])),externalActions:page.items.map(externalActionView),externalActionsCount:page.items.length,externalActionsPartial:typeof page.nextCursor==='string'||Boolean(cursor),...(typeof page.nextCursor==='string'?{externalActionsNextCursor:text(page.nextCursor,4096)}:{})};
  }));
}
