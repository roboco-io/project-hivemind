import {readFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {atomicJson,cloudClient} from './experiment.ts';
import {order} from './suite.ts';
const PRICING='https://developers.cloudflare.com/containers/platform/pricing/';
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
const numeric=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
async function optional(path:string):Promise<any>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
export function retailUsage(rows:any){
 if(!Array.isArray(rows)||!rows.length)return {available:false,reason:'analytics-not-present',computeUsd:null,egressUsd:null,retailUsd:null};
 if(rows.length>=100)return {available:false,reason:'query-limit-reached',computeUsd:null,egressUsd:null,retailUsd:null};
 const parts=rows.map((row:any)=>{
  const sum=row?.sum??{},cpu=numeric(sum.cpuTimeSec)?sum.cpuTimeSec:null,memory=numeric(sum.allocatedMemory)?sum.allocatedMemory:null,disk=numeric(sum.allocatedDisk)?sum.allocatedDisk:null,tx=numeric(sum.txBytes)?sum.txBytes:null;
  const name=(value:any)=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,50}$/.test(value)?value:'unavailable';
  const location=name(row?.dimensions?.location),region=name(row?.dimensions?.region);
  const computeUsd=cpu!==null&&memory!==null&&disk!==null?cpu*.000020+memory/2**30*.0000025+disk/1e9*.00000007:null;
  const egressUsd=/^icn(?:[0-9]+)?$/.test(location.toLowerCase())&&tx!==null?tx/1e9*.05:null;
  return {location,region,cpuTimeSec:cpu,allocatedMemoryByteSeconds:memory,allocatedDiskByteSeconds:disk,txBytes:tx,computeUsd,egressUsd,egressRateUsdPerGB:/^icn(?:[0-9]+)?$/.test(location.toLowerCase())?.05:null};
 });
 const sum=(field:'computeUsd'|'egressUsd')=>parts.every(p=>p[field]!==null)?parts.reduce((n,p)=>n+p[field]!,0):null;
 const computeUsd=sum('computeUsd'),egressUsd=sum('egressUsd');
 return {available:computeUsd!==null&&egressUsd!==null,reason:computeUsd===null?'usage-fields-missing':egressUsd===null?'egress-location-or-usage-unavailable':null,parts,computeUsd,egressUsd,retailUsd:computeUsd!==null&&egressUsd!==null?computeUsd+egressUsd:null};
}
export async function usageReport(args:string[]){
 const [aPath,suitePath,outPath,origin,secrets]=args;if(!aPath||!suitePath||!outPath||!origin||!secrets)throw Error('Usage: usage.ts A_OUTPUT SUITE_OUTPUT OUTPUT ORIGIN CONTROL_SECRET_FILE');
 const ledger=await optional(join(resolve(aPath),'ledger.json'));if(!ledger)throw Error('A ledger unavailable');
 const extras=(process.env.EXTRA_ACCOUNTING_GROUPS??'').split(',').filter(Boolean),extraJobs=(process.env.EXTRA_ACCOUNTING_JOBS??'').split(',').filter(Boolean);
 if([...extras,...extraJobs].some(id=>!validId(id)))throw Error('Invalid accounting ID');
 const groups=new Set<string>([...extras,...Object.values(ledger.runs).map((r:any)=>r.remoteId).filter(Boolean)]);
 const suite=resolve(suitePath),configuration=await optional(join(suite,'suite.json'));
 for(const id of configuration?.extraAccountingGroups??[]){if(!validId(id))throw Error('Invalid configured accounting group');groups.add(id);}
 for(const item of order()){const marker=await optional(join(suite,item.id,'started.json'));if(marker?.id){if(!validId(marker.id))throw Error('Invalid workflow ID');groups.add(marker.id);}}
 const request=await cloudClient(origin,secrets),listed=await request('/v1/jobs'),all=Array.isArray(listed)?listed:listed.jobs;
 if(!Array.isArray(all))throw Error('Job accounting unavailable');
 const jobs=new Map<string,any>();for(const job of all)if(groups.has(job.executionGroup?.id)||extraJobs.includes(job.id))jobs.set(job.id,job);
 let changed=true;while(changed){changed=false;for(const job of all)if(job.parentId&&jobs.has(job.parentId)&&!jobs.has(job.id)){jobs.set(job.id,job);changed=true;}}
 if(!jobs.size||[...jobs.keys()].some(id=>!validId(id)))throw Error('Accounting jobs missing or invalid');
 for(const id of groups)if(![...jobs.values()].some(j=>j.executionGroup?.id===id))throw Error('Accounting group missing');
 for(const id of extraJobs)if(!jobs.has(id))throw Error('Accounting job missing');
 const cwd=fileURLToPath(new URL('../../',import.meta.url)),config=JSON.parse(await readFile(join(cwd,'wrangler.json'),'utf8'));
 // Wrangler's token stays in memory and is never printed or written to evidence.
 const auth=JSON.parse(execFileSync(join(cwd,'node_modules/.bin/wrangler'),['auth','token','--json','--config','wrangler.json'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024}));
 if(typeof auth.token!=='string'||!auth.token)throw Error('Analytics authentication unavailable');
 const selected=[...jobs.values()],rows:any[]=[],to=new Date().toISOString();
 const earliest=Math.min(...selected.map(j=>j.createdAt));if(!numeric(earliest))throw Error('Accounting time missing');
 const from=new Date(earliest-3600000).toISOString();
 for(let start=0;start<selected.length;start+=15){
  const batch=selected.slice(start,start+15);
  const fields=batch.map((job,i)=>{const filter=`limit:100,filter:{datetime_geq:$from,datetime_leq:$to,labels_has:"hvm-bench-job=${job.id}"}`;return `cost${i}:containersUsageAdaptiveGroups(${filter}){dimensions{region location} sum{cpuTimeSec allocatedMemory allocatedDisk txBytes}} stats${i}:containersMetricsAdaptiveGroups(${filter}){dimensions{region location} sum{cpuTimeSec} max{memory}}`;}).join('\n');
  const query=`query($acct:String,$from:Time,$to:Time){viewer{accounts(filter:{accountTag:$acct}){${fields}}}}`;
  const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:'Bearer '+auth.token,'content-type':'application/json'},body:JSON.stringify({query,variables:{acct:config.account_id,from,to}}),signal:AbortSignal.timeout(30000),redirect:'error'});
  const data:any=await response.json();if(!response.ok||data.errors?.length)throw Error('Analytics query failed');
  const account=data.data?.viewer?.accounts?.[0];if(!account)throw Error('Analytics account result missing');
  for(const [i,job] of batch.entries()){
   const stats=account['stats'+i],memory=Array.isArray(stats)?stats.map(r=>r?.max?.memory).filter(numeric):[],metricCpu=Array.isArray(stats)?stats.map(r=>r?.sum?.cpuTimeSec):[];
   rows.push({id:job.id,groupId:validId(job.executionGroup?.id)?job.executionGroup.id:null,parentId:validId(job.parentId)?job.parentId:null,createdAt:job.createdAt,finishedAt:numeric(job.finishedAt)?job.finishedAt:null,containerStopped:job.containerStopped===true,usage:retailUsage(account['cost'+i]),metrics:{available:memory.length>0,memoryPeakBytes:memory.length?Math.max(...memory):null,cpuTimeSec:metricCpu.length&&metricCpu.every(numeric)?metricCpu.reduce((a,b)=>a+b,0):null}});
  }
 }
 const available=rows.filter(r=>r.usage.available),knownRetailSubtotalUsd=available.reduce((sum,r)=>sum+r.usage.retailUsd,0);
 const output={version:1,kind:'observed-usage-retail-equivalent-before-free-allowance-not-final-bill',pricingSource:PRICING,pricingCheckedDate:'2026-11-13',queriedAt:to,from,to,jobCount:rows.length,availableJobCount:available.length,complete:available.length===rows.length&&rows.every(r=>r.containerStopped),retailUsd:available.length===rows.length?knownRetailSubtotalUsd:null,knownRetailSubtotalUsd,rows,limitations:['Missing Analytics is unavailable, never zero.','Adaptive Analytics may lag and can be sampled; re-query after all containers stop.','R2, Worker, image storage and other unrelated resources are not included.','Egress conversion is available only for observed icn location at $0.05/GB.','This differs from suite conservative admission estimates and is not a final invoice.']};
 const destination=resolve(outPath);await mkdir(destination,{recursive:true,mode:0o700});await atomicJson(join(destination,'observed-usage.json'),output);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)usageReport(process.argv.slice(2)).catch(()=>{console.error('Usage collection failed; no authentication or raw provider error is displayed.');process.exitCode=1;});
