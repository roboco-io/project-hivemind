import {createHmac,timingSafeEqual} from 'node:crypto';
import type {JobRecord,SchedulerState} from './contracts.ts';
export interface SchedulerJobQuery {limit?:number;cursor?:string}
export type JobSummary=Pick<JobRecord,'id'|'attempt'|'kind'|'status'|'createdAt'|'deadline'|'timeoutMs'|'containerStopped'|'authSynced'> & Partial<Pick<JobRecord,'provider'|'model'|'effort'|'credentialId'|'credentialGeneration'|'parentId'|'checkId'|'autonomous'|'startedAt'|'runningAt'|'finishedAt'|'cancellationRequested'>> & {checkCount:number;childCount:number;credentialOwned?:boolean};
export interface SchedulerJobPage {items:JobSummary[];nextCursor?:string}
function invalid():never{throw Object.assign(Error('Invalid scheduler jobs query'),{statusCode:400});}
function summary(job:JobRecord,state:SchedulerState):JobSummary {
 const out:Record<string,unknown>={};
 for(const key of ['id','attempt','kind','status','createdAt','deadline','timeoutMs','containerStopped','authSynced','provider','model','effort','credentialId','credentialGeneration','parentId','checkId','startedAt','runningAt','finishedAt','cancellationRequested'] as const)if(job[key]!==undefined)out[key]=job[key];
 for(const key of ['id','attempt','credentialId','parentId','checkId'] as const)if(out[key]!==undefined&&(typeof out[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(out[key]))))invalid();
 if(!['agent','compute'].includes(job.kind)||!['QUEUED','STARTING','RUNNING','VERIFYING','SAVING','SUCCEEDED','FAILED','CANCELLING','CANCELLED','TIMED_OUT','NEEDS_REAUTH','AUTH_SYNC_FAILED'].includes(job.status)||typeof job.containerStopped!=='boolean'||typeof job.authSynced!=='boolean')invalid();
 for(const key of ['createdAt','deadline','timeoutMs','credentialGeneration','startedAt','runningAt','finishedAt'] as const)if(out[key]!==undefined&&(!Number.isSafeInteger(out[key])||Number(out[key])<0))invalid();
 if(out.provider!==undefined&&!['claude','codex'].includes(String(out.provider))||out.effort!==undefined&&!['low','medium','high','xhigh'].includes(String(out.effort))||out.cancellationRequested!==undefined&&typeof out.cancellationRequested!=='boolean')invalid();
 if(out.model!==undefined&&(typeof out.model!=='string'||String(out.model).length>100))invalid();
 if(job.autonomous){if(typeof job.autonomous.taskId!=='string'||job.autonomous.taskId.length>256||typeof job.autonomous.runId!=='string'||job.autonomous.runId.length>256)invalid();out.autonomous={taskId:job.autonomous.taskId,runId:job.autonomous.runId};}
 if(!Array.isArray(job.checks)||!Array.isArray(job.childIds))invalid();out.checkCount=job.checks.length;out.childCount=job.childIds.length;
 if(job.kind==='agent')out.credentialOwned=state.credentials[job.credentialId!]?.activeJobId===job.id;
 return out as JobSummary;
}
/** Secret and immutable append-only ID order are private durable repository metadata. */
export function pageSchedulerJobs(state:SchedulerState,order:readonly string[],query:SchedulerJobQuery,secret:string):SchedulerJobPage {
 if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(k=>k!=='limit'&&k!=='cursor')||!/^[a-f0-9]{64}$/.test(secret))invalid();
 const limit=query.limit===undefined?20:query.limit;if(!Number.isSafeInteger(limit)||limit<1||limit>100)invalid();
 let high=order.length,last=0;const mac=(body:string)=>createHmac('sha256',secret).update(body).digest('hex');
 if(query.cursor!==undefined){
  if(typeof query.cursor!=='string'||!query.cursor||query.cursor.length>1024)invalid();const [body,signature,...rest]=query.cursor.split('.');if(!body||!signature||rest.length||!/^[a-f0-9]{64}$/.test(signature))invalid();const raw=Buffer.from(body,'base64url');
  if(raw.toString('base64url')!==body||!timingSafeEqual(Buffer.from(mac(body),'hex'),Buffer.from(signature,'hex')))invalid();
  let value:unknown;try{value=JSON.parse(raw.toString('utf8'));}catch{invalid();}
  if(!Array.isArray(value)||value.length!==4||value[0]!==1||value[1]!=='scheduler.jobs.summary'||!Number.isSafeInteger(value[2])||!Number.isSafeInteger(value[3])||value[2]<0||value[2]>order.length||value[3]<0||value[3]>value[2])invalid();high=value[2];last=value[3];
 }
 const ids=order.slice(last,Math.min(high,last+limit)),items=ids.map(id=>{if(!Object.hasOwn(state.jobs,id))invalid();return summary(state.jobs[id]!,state);}),next=last+ids.length;
 if(next>=high)return {items};const body=Buffer.from(JSON.stringify([1,'scheduler.jobs.summary',high,next])).toString('base64url');return {items,nextCursor:body+'.'+mac(body)};
}
