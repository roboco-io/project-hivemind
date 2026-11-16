import {profile} from './metrics.ts';
export function validateBuildBatch(configs:string[],concurrency:number,jobs:number){
 if(!Array.isArray(configs)||configs.length<1||configs.length>4||new Set(configs).size!==configs.length||
  ![1,2,4].includes(concurrency)||concurrency>configs.length||!Number.isSafeInteger(jobs)||jobs<1||jobs>10)
  throw Error('Invalid build batch settings');
 return {profiles:configs.map(config=>({config,...profile(config)})),concurrency,jobs};
}
export interface BatchRecord<T,R> {task:T;status:'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'NOT_STARTED';startedAt?:number;finishedAt?:number;value?:R;error?:'task-failed'|'cancelled-after-peer-failure'}
/** All workers settle before return, including after a peer's failure. */
export async function executeBatch<T,R>(tasks:T[],concurrency:number,run:(task:T,index:number)=>Promise<R>,stop:(reason:string)=>Promise<void>,save:(records:BatchRecord<T,R>[])=>Promise<void>,isStopped:()=>boolean=()=>false){
 if(!tasks.length||tasks.length>4||![1,2,4].includes(concurrency)||concurrency>tasks.length)throw Error('Invalid batch pool');
 const records:BatchRecord<T,R>[]=tasks.map(task=>({task,status:'QUEUED'}));let cursor=0,failed=false;
 let saving=Promise.resolve();const persist=()=>{saving=saving.then(()=>save(records));return saving;};
 await persist();
 await Promise.allSettled(Array.from({length:concurrency},async()=>{
  while(!failed&&!isStopped()&&cursor<tasks.length){
   const index=cursor++,record=records[index]!;record.status='RUNNING';record.startedAt=Date.now();
   try{await persist();if(isStopped()){record.status='NOT_STARTED';delete record.startedAt;break;}record.value=await run(record.task,index);record.status='SUCCEEDED';}
   catch{
    const first=!failed;failed=true;record.status=first?'FAILED':'CANCELLED';record.error=first?'task-failed':'cancelled-after-peer-failure';
    if(first)await stop('batch-task-failed');
   }finally{if(record.status!=='NOT_STARTED')record.finishedAt=Date.now();await persist();}
  }
 }));
 for(const record of records)if(record.status==='QUEUED')record.status='NOT_STARTED';
 await persist();return records;
}
