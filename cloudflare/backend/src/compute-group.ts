import {validateLargeArtifacts,type LargeArtifactRef} from './large-artifact.ts';
import type {CheckSpec,JobRecord} from './contracts.ts';
import {terminal} from './contracts.ts';
import {SchedulerError,validateCheckSpec,type Scheduler} from './scheduler.ts';

export interface ComputeGroupSpec {
 snapshotId:string;
 idempotencyKey:string;
 concurrency:1|2|4;
 checks:CheckSpec[];
 artifacts?:LargeArtifactRef[];
 integration:CheckSpec;
 instance:'standard-1'|'standard-3'|'standard-4';
}
export interface ComputeGroupRecord {
 id:string;spec:ComputeGroupSpec;status:'DRAFT'|'RUNNING'|'INTEGRATING'|'SUCCEEDED'|'FAILED'|'CANCELLED';
 createdAt:number;approvedAt?:number;finishedAt?:number;deadline?:number;jobIds?:string[];integrationId?:string;
 cancellationRequested?:boolean;errorCode?:string;
}
export function validateComputeGroupSpec(value:unknown):ComputeGroupSpec {
 const x=value as ComputeGroupSpec;
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['snapshotId','idempotencyKey','concurrency','checks','integration','instance','artifacts'].includes(k))||
  typeof x.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(x.snapshotId)||
  typeof x.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x.idempotencyKey)||
  ![1,2,4].includes(x.concurrency)||!['standard-1','standard-3','standard-4'].includes(x.instance)||
  !Array.isArray(x.checks)||(x.checks.length<1||x.checks.length>4))throw new SchedulerError('Invalid compute group',400);
 let artifacts:LargeArtifactRef[]|undefined;try{artifacts=x.artifacts===undefined?undefined:validateLargeArtifacts(x.artifacts);}catch{throw new SchedulerError('Invalid group artifacts',400);}
 const checks=x.checks.map(validateCheckSpec),integration=validateCheckSpec(x.integration);
 if(new Set([...checks,integration].map(c=>c.id)).size!==checks.length+1)throw new SchedulerError('Duplicate compute group check',400);
 return {snapshotId:x.snapshotId,idempotencyKey:x.idempotencyKey,concurrency:x.concurrency,checks,integration,instance:x.instance,...(artifacts?{artifacts}:{})};
}
export function assignGroup(job:JobRecord,id:string,concurrency:number,instance:'standard-1'|'standard-3'|'standard-4'){
 job.executionGroup={id,concurrency,instance,dependencyNetwork:true};
}
export function advanceComputeGroup(group:ComputeGroupRecord,scheduler:Scheduler,now:number){
 if(!['RUNNING','INTEGRATING'].includes(group.status))return;
 const jobs=[...(group.jobIds??[]),...(group.integrationId?[group.integrationId]:[])].map(id=>scheduler.get(id));
 if(group.cancellationRequested||now>=group.deadline!){
  for(const job of jobs)if(!terminal(job.status))scheduler.requestCancel(job.id,now);
  if(jobs.every(job=>terminal(scheduler.get(job.id).status)&&scheduler.get(job.id).containerStopped)){
   group.status=group.cancellationRequested?'CANCELLED':'FAILED';group.errorCode=group.cancellationRequested?'CANCELLED':'TIMED_OUT';group.finishedAt=now;
  }
  return;
 }
 if(jobs.some(job=>!terminal(job.status)||!job.containerStopped))return;
 if(jobs.some(job=>job.status!=='SUCCEEDED')){group.status='FAILED';group.errorCode='CHECK_FAILED';group.finishedAt=now;return;}
 if(group.status==='RUNNING'){
  const job=scheduler.enqueueCompute(group.spec.snapshotId,group.spec.integration,now);
  assignGroup(scheduler.state.jobs[job.id]!,group.id,group.spec.concurrency,group.spec.instance);
  group.integrationId=job.id;group.status='INTEGRATING';
 }else{group.status='SUCCEEDED';group.finishedAt=now;}
}
