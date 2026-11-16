import {readFile,mkdir,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {atomicJson,cloudClient,safeEnv} from './experiment.ts';
const RATE=0.00006112,BUDGET=10,RESERVE=1,NEXT=1;
export const order=()=>[
 ...[['local','remote-sequential','remote-parallel'],['remote-sequential','remote-parallel','local'],['remote-parallel','local','remote-sequential']].flatMap((modes,i)=>modes.map(mode=>({id:`b-b${i+1}-${mode}`,mode}))),
 ...[1,2,3].map(i=>({id:`c-${i}`,mode:'disconnect'})),
];
async function json(path:string):Promise<any>{return JSON.parse(await readFile(path,'utf8'));}
async function optional(path:string){try{return await json(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
export function costEstimate(jobs:any[],now=Date.now()){
 const records=jobs.map(job=>{
  if(!Number.isFinite(job.createdAt))throw Error('Missing job accounting timestamp');
  // Include queue time conservatively. Unrecorded container stop tail and infrastructure
  // overhead are covered only by the fixed reserve; this is not a billing statement.
  const end=job.containerStopped?job.finishedAt:now;
  if(!Number.isFinite(end))throw Error('Missing job accounting finish timestamp');
  const seconds=Math.max(0,(end-job.createdAt)/1000);
  return {id:job.id,status:job.status,containerStopped:job.containerStopped,seconds,usd:seconds*RATE};
 });
 const computeUsd=records.reduce((sum,r)=>sum+r.usd,0);
 return {kind:'conservative-admission-estimate-not-billing',rateUsdPerSecond:RATE,computeUsd,fixedReserveUsd:RESERVE,nextReservationUsd:NEXT,budgetUsd:BUDGET,remainingAfterReservation:BUDGET-computeUsd-RESERVE-NEXT,records};
}
async function execute(mode:string,output:string,settings:string,origin:string,secrets:string){
 const env={...safeEnv(),CODEX_BIN:process.env.CODEX_BIN,CLAUDE_BIN:process.env.CLAUDE_BIN};
 return new Promise<void>((done,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./workflow.ts',import.meta.url)),mode,output,settings,...(mode==='local'?[]:[origin,secrets])],{env,stdio:['ignore','inherit','inherit']});
  child.once('error',()=>reject(Error('Suite child could not start')));
  child.once('close',(code,signal)=>code===0&&!signal?done():reject(Error('Suite child failed; inspect its private evidence')));
 });
}
export async function runSuite(args:string[]){
 const [directory,aDirectory,settingsPath,origin,secrets]=args;
 if(!directory||!aDirectory||!settingsPath||!origin||!secrets)throw Error('Usage: suite.ts OUTPUT A_OUTPUT SETTINGS ORIGIN CONTROL_SECRET_FILE');
 for(const name of ['CODEX_BIN','CLAUDE_BIN'])if(!process.env[name]||!process.env[name]!.startsWith('/'))throw Error('Pinned absolute CODEX_BIN and CLAUDE_BIN required');
 const root=resolve(directory);await mkdir(root,{recursive:true,mode:0o700});
 const lockPath=join(root,'suite.lock'),lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid}));
 try{
  const settings=resolve(settingsPath),settingsSha256=createHash('sha256').update(await readFile(settings)).digest('hex');
  const extraAccountingGroups=(process.env.EXTRA_ACCOUNTING_GROUPS??'').split(',').filter(Boolean);
  if(extraAccountingGroups.some(id=>!/^[a-f0-9-]{36}$/i.test(id)))throw Error('Invalid extra accounting group');
  const configuration={extraAccountingGroups,version:1,aDirectory:resolve(aDirectory),settingsSha256,origin,CODEX_BIN:process.env.CODEX_BIN,CLAUDE_BIN:process.env.CLAUDE_BIN,order:order()};
  const prior=await optional(join(root,'suite.json'));if(prior&&JSON.stringify(prior)!==JSON.stringify(configuration))throw Error('Suite configuration changed');
  if(!prior)await atomicJson(join(root,'suite.json'),configuration);
  const a=await json(join(resolve(aDirectory),'ledger.json')),manifest=await json(join(resolve(aDirectory),'manifest.json'));
  if(manifest.conditions.length!==18||manifest.conditions.some((c:any)=>a.runs[c.id]?.status!=='SUCCEEDED'))throw Error('A matrix must finish successfully before B/C');
  const request=await cloudClient(origin,secrets);
  const groups=new Set<string>([...extraAccountingGroups,...Object.values(a.runs).map((r:any)=>r.remoteId).filter(Boolean)]);
  for(const item of order()){const marker=await optional(join(root,item.id,'started.json'));if(marker?.id)groups.add(marker.id);}
  for(const item of order()){
   const output=join(root,item.id),result=await optional(join(output,'result.json'));
   if(result){
    if((result.status??result.workflow?.status)!=='SUCCEEDED')throw Error('Previous suite goal failed; inspect evidence before continuing');
    if(item.mode==='disconnect'&&!(await optional(join(output,'disconnect.json')))?.verified)throw Error('Previous disconnect evidence failed');
    continue;
   }
   if(item.mode!=='local'){
    const listed=await request('/v1/jobs');const all=Array.isArray(listed)?listed:listed.jobs;
    if(!Array.isArray(all))throw Error('Job accounting unavailable');
    const selected=new Map<string,any>();
    for(const job of all)if(groups.has(job.executionGroup?.id))selected.set(job.id,job);
    let added=true;while(added){added=false;for(const job of all)if(job.parentId&&selected.has(job.parentId)&&!selected.has(job.id)){selected.set(job.id,job);added=true;}}
    for(const group of groups)if(![...selected.values()].some(j=>j.executionGroup?.id===group))throw Error('Existing remote group missing from accounting');
    if([...selected.values()].some(j=>!j.containerStopped))throw Error('Existing remote container not stopped; reconcile before next goal');
    const estimate=costEstimate([...selected.values()]);await atomicJson(join(root,item.id+'-budget.json'),estimate);
    if(estimate.remainingAfterReservation<0)throw Error('Conservative budget headroom exhausted');
   }
   await execute(item.mode,output,settings,origin,secrets);
   const completed=await json(join(output,'result.json'));
   if((completed.status??completed.workflow?.status)!=='SUCCEEDED')throw Error('Suite goal failed; no later goal started');
   if(item.mode==='disconnect'&&!(await json(join(output,'disconnect.json'))).verified)throw Error('Disconnect verification failed; no later goal started');
   const marker=await optional(join(output,'started.json'));if(marker?.id)groups.add(marker.id);
   await atomicJson(join(root,'progress.json'),{lastCompleted:item.id,updatedAt:Date.now()});
  }
  await atomicJson(join(root,'complete.json'),{finishedAt:Date.now(),goals:12});
 }finally{await lock.close();await unlink(lockPath);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)runSuite(process.argv.slice(2)).catch(()=>{console.error('Suite stopped. Inspect private evidence, configuration, and budget before resuming.');process.exitCode=1;});
