/** Explicit pin syntax only; model availability must be verified separately. */
export function validateAutonomousModelPin(value:unknown):asserts value is string {
 const aliases=['default','inherit','latest','best','opus','sonnet','haiku','opusplan'];
 if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)||aliases.includes(value.toLowerCase()))throw new Error('Explicit concrete autonomous model pin required');
}
export interface AutonomousOperatorBillingEvidence {source:'operator_attested';evidenceRef:string;reason:string;reasonHash:string;at:number}
export interface AutonomousCloudExecution {backend:'cloudflare'; mode?:'pilot'|'long_running'; snapshotId:string; checks:{id:string; argv:string[]; timeoutMs:number}[]}

/** 장기 작업 계약. snapshot은 비공개 저장 전용이다. */
export interface AutonomousSpec {
  web?: {allowedHosts:string[]};
  externalProfiles?: string[];
  execution?: AutonomousCloudExecution;
  schedule?: {kind:'daily';timeZone:string;localTime:string};
  requestId: string; goal: string; provider: 'mock'|'claude'|'codex'; model: string;
  billingPolicy?: {model:'subscription'; budget:'external_actions'};
  subagentModel?: string; endsAt: number; budgetMicros: number; tools: string[];
  systems: string[]; credentialIds: string[]; maxRunMs: number; maxIterations: number;
}
export type AutonomousStatus = 'awaiting_approval'|'ready'|'running'|'waiting'|'awaiting_input'|'stopping'|'completed'|'cancelled'|'budget_exceeded'|'expired'|'failed';
export interface AutonomousLease {taskId:string; runId:string; workerId:string; token:string; expiresAt:number}
export interface AutonomousCheckpoint {sessionId:string; objectKey:string; model:string; sequence:number}
export interface AutonomousNativeAuthorization {taskId:string; spec:AutonomousSpec; checkpoint?:AutonomousCheckpoint; deadline:number}
export interface AutonomousUsage {inputTokens:number; cacheReadTokens:number; cacheWriteTokens:number; outputTokens:number}
export interface AutonomousQuotaProof {kind:'rejected';resetsAt:number;evidence:'claude_rate_limit_event'}
export interface AutonomousNativeReceipt {quota?:AutonomousQuotaProof; usageUnavailable?:true; runId:string; runtimeId:string; sessionId:string; model:string; sequence:number; usage:AutonomousUsage; stopped:true; outcome:AutonomousRunResult['outcome']; wakeAt?:number}
export interface AutonomousWorkerState {taskId:string; status:AutonomousStatus; endsAt:number; nextRunAt?:number; iteration:number}
export interface AutonomousRunResult {
  outcome:'continue'|'wait'|'input'|'complete'|'failed'; checkpoint?:AutonomousCheckpoint;
  usage:AutonomousUsage; costMicros:number|null; wakeAt?:number; message?:string;
  quota?:AutonomousQuotaProof;
  /** quota wait에서만 허용한다. 0은 미측정 placeholder다. */
  usageUnavailable?:true;
}
export interface AutonomousActionRequest {requestId:string; tool:string; system:string; operation:string; estimatedCostMicros:number}
export interface AutonomousAction extends AutonomousActionRequest {
  operatorBillingEvidence?:AutonomousOperatorBillingEvidence;
  id:string; status:'reserved'|'accepted'|'succeeded'|'failed'|'unknown'; actualCostMicros?:number; resourceId?:string;
}
export interface AutonomousResource {id:string; system:string; cleanupOperation:string; status:'active'|'cleanup_pending'|'cleaned'; actionId:string}
export interface AutonomousRun extends AutonomousRunResult {
  /** Canonical daily occurrence; startedAt remains actual dispatch time. */
  scheduledAt?:number;
  runId:string; workerId:string; startedAt:number; finishedAt:number; reconciledCostMicros?:number;
  /** lease 만료 또는 검증된 quota pause에서 보존한다. usage의 0은 측정값이 아니며 비용 대사 후에도 유지한다. */
  usageUnavailable?:true;
  billingEvidence?:'subscription_runtime'|'subscription_operator';
}
export interface AutonomousIntervention {kind:'approval'|'message'|'help'|'revision'|'reconciliation'|'cancel'; message:string; at:number; revision:number}
export interface AutonomousTask {
  id:string; spec:AutonomousSpec; revision:number; status:AutonomousStatus; createdAt:number;
  nativeRuntimeId?:string; nativeReceipt?:AutonomousNativeReceipt;
  lastScheduleKey?:string; activeScheduleAt?:number;
  approvedAt?:number; nextRunAt?:number; iteration:number; activeRunStartedAt?:number;
  /** Public views omit token. Only claim/heartbeat return executable authority. */
  lease?:Omit<AutonomousLease,'token'> & {token?:string}; checkpoint?:AutonomousCheckpoint;
  runs:AutonomousRun[]; actions:AutonomousAction[]; resources:AutonomousResource[];
  interventions:AutonomousIntervention[]; spentMicros:number; reservedMicros:number; stopReason?:string;
  counts?:{humanInterventions:number; helpRequests:number; toolCalls:number};
}
export interface AutonomousState {version:1; tasks:Record<string,AutonomousTask>}

/** Canonical native tool names. Registry authorization remains server-owned. */
export const AUTONOMOUS_EXTERNAL_TOOL='mcp__hivemind__action';
export function validateAutonomousCapabilities(value:{tools:string[];web?:{allowedHosts:string[]};externalProfiles?:string[];systems?:string[]}):void {
 const deny=():never=>{throw new Error('Invalid autonomous capabilities');};
 const tools=value.tools;
 if(!Array.isArray(tools)||!tools.includes('Bash')||new Set(tools).size!==tools.length||tools.some(tool=>!['Bash','Agent','WebFetch',AUTONOMOUS_EXTERNAL_TOOL].includes(tool)))deny();
 if((value.web!==undefined)!==tools.includes('WebFetch')||(value.externalProfiles!==undefined)!==tools.includes(AUTONOMOUS_EXTERNAL_TOOL))deny();
 if(value.web!==undefined){
  const web=value.web;if(!web||typeof web!=='object'||Array.isArray(web)||Object.keys(web).some(key=>key!=='allowedHosts')||!Array.isArray(web.allowedHosts)||!web.allowedHosts.length||web.allowedHosts.length>32||new Set(web.allowedHosts).size!==web.allowedHosts.length)deny();
  const reserved=['localhost','local','localdomain','private','corp','internal','lan','home','arpa','invalid','test','onion','nip.io','sslip.io','localtest.me','lvh.me','anthropic.com','claude.ai','claude.com','openai.com','chatgpt.com'];
  for(const host of web.allowedHosts){
   if(typeof host!=='string'||host.length>253||host!==host.toLowerCase()||!/^[a-z0-9.-]+$/.test(host))deny();
   const labels=host.split('.');if(labels.length<2||!/[a-z]/.test(labels.at(-1)!)||labels.some(label=>label.length<1||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))||reserved.some(name=>host===name||host.endsWith('.'+name)))deny();
   try{if(new URL('https://'+host).hostname!==host)deny();}catch{deny();}
  }
 }
 if(value.externalProfiles!==undefined){
  const p=value.externalProfiles;if(!Array.isArray(p)||p.length<1||p.length>3||new Set(p).size!==p.length||p.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)))deny();
 }
 if(value.systems!==undefined&&(!Array.isArray(value.systems)||new Set(value.systems).size!==value.systems.length||(value.externalProfiles===undefined?value.systems.length!==0:!value.systems.length||value.systems.some(system=>!['aws','hf','github'].includes(system)))))deny();
}
export function autonomousExternalOperation(system:string,operation:string):boolean {
 return ({aws:['aws.spot.start','aws.spot.inspect'],hf:['hf.model.commit'],github:['github.branch.push']} as Record<string,string[]>)[system]?.includes(operation)??false;
}
