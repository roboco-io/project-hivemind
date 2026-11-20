import type {AutonomousLease,AutonomousRunResult,AutonomousTask,AutonomousCheckpoint} from '../../../packages/contracts/src/autonomous.ts';
import type {AutonomousApiService} from '../../../apps/control-plane/src/autonomous-api.ts';
import type {AutonomousStorage} from './autonomous-service.ts';

/** Private Durable Object state; never returned in an HTTP response. */
export interface AutonomousCloudRecord {
 taskId:string; runId:string; workerId:string; token:string; jobId:string;
 phase:'claiming'|'submitting'|'polling'|'finishing'|'finishing-unstarted'|'paused'|'done';
 lease?:AutonomousLease; checkpoint?:AutonomousCheckpoint; snapshotId:string;
 result?:AutonomousRunResult; checksPassed?:boolean; recoveryComplete?:boolean;
}
export interface AutonomousCloudSubmission {task:AutonomousTask; lease:AutonomousLease; jobId:string; idempotencyKey:string; snapshotId:string}
export type AutonomousCloudPoll = {state:'pending'}|{state:'unknown'}|{state:'unstarted';stopped:true;authSynced:true}|{state:'finished'; stopped:boolean; authSynced:boolean; checksPassed:boolean; snapshotId:string; result:AutonomousRunResult};
/** Adapters reuse Scheduler JobRecord, activeJobId, RunnerDO and existing credential quarantine. */
export interface AutonomousCloudPorts {
 /** Check legacy queued/active credential owner, agent pool and source <=64 KiB/32 files before claim. */
 available(task:AutonomousTask):Promise<boolean>;
 submit(input:AutonomousCloudSubmission):Promise<{jobId:string}>;
 poll(jobId:string):Promise<AutonomousCloudPoll>;
 cancel(jobId:string):Promise<void>;
 /** Only quarantine when this exact job owns the credential; missing/different owners are a no-op. */
 quarantine(credentialId:string,jobId:string):Promise<void>;
}
export interface AutonomousCloudOptions {storage:AutonomousStorage; service:AutonomousApiService; ports:AutonomousCloudPorts; enabled:boolean; clock?:()=>number; randomId?:()=>string}

/** Each call advances one short durable step. A submitting marker is never replayed. */
export class AutonomousCloudController {
 private readonly options:AutonomousCloudOptions;
 private readonly clock:()=>number;
 private readonly randomId:()=>string;
 private tail:Promise<unknown>=Promise.resolve();
 constructor(options:AutonomousCloudOptions) {this.options=options;this.clock=options.clock??Date.now;this.randomId=options.randomId??(()=>crypto.randomUUID());}
 private key(id:string){return 'autonomous-cloud:'+id;}
 private async save(r:AutonomousCloudRecord){await this.options.storage.put(this.key(r.taskId),r);}
 async status(taskId:string):Promise<{taskId:string;phase:AutonomousCloudRecord['phase']|'idle';jobId?:string}> {
  const r=await this.options.storage.get<AutonomousCloudRecord>(this.key(taskId));
  return {taskId,phase:r?.phase??'idle',...(r?{jobId:r.jobId}:{})};
 }
 step(taskId:string):Promise<void> {
  const run=this.tail.then(()=>this.advance(taskId));this.tail=run.catch(()=>undefined);return run;
 }
 private async pause(r:AutonomousCloudRecord,task:AutonomousTask):Promise<void> {
  r.phase='paused';delete r.result;await this.save(r);
  // Both operations are idempotent adapters over the existing Scheduler lane.
  try {await this.options.ports.cancel(r.jobId);} finally {
   try {await this.options.ports.quarantine(task.spec.credentialIds[0]!,r.jobId);} finally {
    if(r.lease)await this.options.service.execute('abandonCloud',{lease:r.lease});
   }
  }
  r.recoveryComplete=true;await this.save(r);
 }
 private async advance(taskId:string):Promise<void> {
  const {service,storage,ports}=this.options;
  let r=await storage.get<AutonomousCloudRecord>(this.key(taskId));
  const task=await service.execute('get',{id:taskId}) as AutonomousTask;
  if(!task.spec.execution)return;
  // Revision can revoke approval while an intent still has no core lease or child job.
  if(r?.phase==='claiming'&&!r.lease&&!task.lease&&task.status==='awaiting_approval')return;
  if(r?.phase==='paused'){if(!r.recoveryComplete)await this.pause(r,task);return;}
  if(r&&['finishing','finishing-unstarted'].includes(r.phase)&&task.runs.some(run=>run.runId===r!.runId)) {
   r.phase='done';delete r.lease;delete r.result;await this.save(r);return;
  }
  if(r&&r.phase!=='done'&&(!['ready','running','waiting','stopping'].includes(task.status)||this.clock()>=task.spec.endsAt)) {await this.pause(r,task);return;}
  if(!r||r.phase==='done') {
   if(!this.options.enabled||task.status!=='ready'||!await ports.available(task))return;
   const snapshotId=r?.snapshotId??task.spec.execution.snapshotId;
   r={taskId,runId:this.randomId(),workerId:'autonomous-cloud',token:this.randomId(),jobId:this.randomId(),phase:'claiming',snapshotId,...(task.checkpoint?{checkpoint:task.checkpoint}:{})};
   await this.save(r);return;
  }
  if(r.phase==='claiming') {
   if(task.status==='ready'&&task.iteration===0&&r.snapshotId!==task.spec.execution.snapshotId){r.snapshotId=task.spec.execution.snapshotId;await this.save(r);return;}
   if(!this.options.enabled||!await ports.available(task))return;
   const lease=await service.execute('claimCloud',{id:taskId,workerId:r.workerId,token:r.token,runId:r.runId}) as AutonomousLease|null;
   if(!lease)return;
   r.lease=lease;r.phase='submitting';await this.save(r);return;
  }
  if(!r.lease){await this.pause(r,task);return;}
  if(task.status==='stopping') {
   if(r.phase==='submitting'){await this.pause(r,task);return;}
   if(r.phase==='polling')await ports.cancel(r.jobId);
  } else {
   try {r.lease=await service.execute('heartbeat',{lease:r.lease}) as AutonomousLease;}
   catch {await this.pause(r,task);return;}
  }
  if(r.phase==='submitting') {
   // Claim may race a newly approved draft revision during credential availability.
   if(!r.checkpoint&&task.iteration===1&&r.snapshotId!==task.spec.execution.snapshotId){r.snapshotId=task.spec.execution.snapshotId;await this.save(r);return;}
   // Save intent before crossing the Scheduler boundary. After a lost response only poll this ID.
   r.phase='polling';await this.save(r);
   try {
    const submitted=await ports.submit({task,lease:r.lease,jobId:r.jobId,idempotencyKey:`autonomous:${taskId}:${r.runId}`,snapshotId:r.snapshotId});
    if(submitted.jobId!==r.jobId)await this.pause(r,task);
   } catch { /* Unknown submission: the next alarm polls the exact persisted job, never submits. */ }
   return;
  }
  if(r.phase==='polling') {
   let polled:AutonomousCloudPoll;
   try {polled=await ports.poll(r.jobId);} catch {await this.pause(r,task);return;}
   if(polled.state==='pending'){await this.save(r);return;}
   if(polled.state==='unstarted'){
    if(polled.stopped!==true||polled.authSynced!==true){await this.pause(r,task);return;}
    r.phase='finishing-unstarted';await this.save(r);return;
   }
   if(polled.state==='unknown'||!polled.stopped||!polled.authSynced||!polled.snapshotId||!polled.result.checkpoint){await this.pause(r,task);return;}
   r.result=polled.result;r.checksPassed=polled.checksPassed;r.snapshotId=polled.snapshotId;r.checkpoint=polled.result.checkpoint;r.phase='finishing';await this.save(r);return;
  }
  if(r.phase==='finishing-unstarted') {
   try {await service.execute('finishUnstartedCloud',{lease:r.lease});}
   catch {await this.pause(r,task);return;}
   r.phase='done';delete r.lease;await this.save(r);return;
  }
  if(r.phase==='finishing') {
   if(!r.result||typeof r.checksPassed!=='boolean'){await this.pause(r,task);return;}
   try {await service.execute('finishCloud',{lease:r.lease,result:r.result,checksPassed:r.checksPassed});}
   catch {await this.pause(r,task);return;}
   r.phase='done';delete r.lease;delete r.result;await this.save(r);
  }
 }
}
