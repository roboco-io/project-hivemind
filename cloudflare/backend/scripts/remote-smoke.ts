// Explicit operator-run remote acceptance fixture; uses previously registered subscription lanes.
// No auth import, no API billing and no automatic replay of failed/uncertain model work.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {nativeParallelEvidence} from '../src/evidence.ts';
import {createSnapshot,sha256} from '../src/snapshot.ts';
import {terminal,type JobRecord,type Provider} from '../src/contracts.ts';
const [secretsPath,outputDirectory,mode='all',providerSelection='codex,claude']=process.argv.slice(2);
assert.ok(['codex','claude','codex,claude'].includes(providerSelection),'Invalid provider selection');
const selectedProviders=providerSelection.split(',') as Provider[];
assert.ok(['all','submit','collect'].includes(mode),'Mode must be all, submit, or collect');
if(!secretsPath||!outputDirectory||!process.env.HIVEMIND_URL)throw new Error('Set HIVEMIND_URL; usage: remote-smoke.ts CONTROL_SECRETS_FILE PRIVATE_EVIDENCE_DIRECTORY');
const origin=new URL(process.env.HIVEMIND_URL);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('Use an HTTPS backend origin');
const {CONTROL_TOKEN}=JSON.parse(await readFile(secretsPath,'utf8'));
const directory=resolve(outputDirectory);await mkdir(directory,{recursive:true,mode:0o700});
const request=async(path:string,method='GET',body?:unknown,expected=200)=>{
 const response=await fetch(new URL(path,origin),{method,headers:{authorization:`Bearer ${CONTROL_TOKEN}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000)});
 assert.equal(response.status,expected,`Unexpected HTTP status for ${method} ${path}`);return response.json() as Promise<any>;
};
assert.equal((await fetch(new URL('/v1/jobs',origin),{redirect:'error'})).status,401);
const file=(path:string,text:string)=>{const content=Buffer.from(text);return {path,content:content.toString('base64'),sha256:sha256(content),executable:false};};
const snapshot=createSnapshot([
 file('alpha.mjs','export const add = () => 0;\n'),file('beta.mjs','export const multiply = () => 0;\n'),
 file('math.test.mjs',"import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './alpha.mjs';import {multiply} from './beta.mjs';test('sum',()=>assert.equal(add(2,3),5));test('product',()=>assert.equal(multiply(3,4),12));\n"),
 file('verify.mjs',"import {spawnSync} from 'node:child_process';await new Promise(r=>setTimeout(r,10000));const r=spawnSync(process.execPath,['--test','math.test.mjs'],{stdio:'inherit'});process.exit(r.status??1);\n"),
]);
let nonce=randomBytes(16).toString('hex');let submitted:JobRecord[]=[];
if(mode==='collect'){
 const saved=JSON.parse(await readFile(resolve(directory,'submitted.json'),'utf8'));assert.equal(saved.origin,origin.origin);assert.equal(saved.inputSnapshotId,snapshot.digest);assert.match(saved.nonce,/^[0-9a-f]{32}$/);assert.equal(saved.jobs.length,selectedProviders.length);for(const job of saved.jobs)assert.match(job.id,/^[0-9a-f-]{36}$/);nonce=saved.nonce;submitted=saved.jobs;
}else{
await request(`/v1/snapshots/${snapshot.digest}`,'PUT',snapshot,201);
for(const provider of selectedProviders){
 const instructions=`Remote acceptance fixture ${nonce}. Use exactly two official native worker subagents concurrently, assigning alpha.mjs to one and beta.mjs to the other. Each must wait 10 seconds with Node.js before editing. First exports add(a,b) returning a+b; second exports multiply(a,b) returning a*b. Launch both before waiting for either. Do not edit the tests or verify.mjs. After both return, call the phase0_probe MCP tool with nonce ${nonce}. Verify actual files and report truthfully. Use Bash and Node.js for Claude edits. Do not inspect private paths or auth. Do not commit or push.`;
 const spec={provider,credentialId:`${provider}-remote`,snapshotId:snapshot.digest,instructions,checks:[{id:'unit-a',argv:['node','verify.mjs'],timeoutMs:60000},{id:'unit-b',argv:['node','verify.mjs'],timeoutMs:60000}],timeoutMs:360000,idempotencyKey:`acceptance-${provider}-${nonce}`};
 const job=await request('/v1/jobs','POST',spec,202);assert.equal((await request('/v1/jobs','POST',spec,202)).id,job.id);await request('/v1/jobs','POST',{...spec,instructions:instructions+' conflicting replay'},409);submitted.push(job);
 await writeFile(resolve(directory,'submitted.json'),JSON.stringify({recordedAt:new Date().toISOString(),origin:origin.origin,inputSnapshotId:snapshot.digest,nonce,jobs:submitted},null,2),{mode:0o600});
 console.log(JSON.stringify({provider,id:job.id,status:job.status}));
}
if(mode==='submit'){console.log(JSON.stringify({submitted:true,jobIds:submitted.map(job=>job.id),clientExiting:true}));process.exit(0);}
}
const seen=new Map<string,string>();const deadline=Date.now()+12*60000;
while(Date.now()<deadline){
 const jobs=await Promise.all(submitted.map(job=>request(`/v1/jobs/${job.id}`)));
 for(const job of jobs)if(seen.get(job.id)!==job.status){console.log(JSON.stringify({id:job.id,provider:job.provider,status:job.status,childIds:job.childIds,errorCode:job.errorCode}));seen.set(job.id,job.status);}
 if(jobs.every(job=>terminal(job.status)&&job.containerStopped))break;
 await new Promise(r=>setTimeout(r,4000));
}
const evidence=[];
for(const original of submitted){
 const job=await request(`/v1/jobs/${original.id}`);assert.equal(job.status,'SUCCEEDED',`${job.provider} did not pass`);assert.equal(job.containerStopped,true);assert.equal(job.authSynced,true);
 const result=await request(`/v1/jobs/${job.id}/result`);assert.equal(result.input.digest,snapshot.digest);assert.notEqual(result.output.digest,snapshot.digest);assert.equal(result.checks.length,2);
 for(const path of ['math.test.mjs','verify.mjs'])assert.deepEqual(result.output.files.find((f:any)=>f.path===path),snapshot.files.find(f=>f.path===path),'Fixture checks were modified');
 const processes=result.checks.map((check:any)=>{assert.equal(check.job.status,'SUCCEEDED');assert.equal(check.job.snapshotId,result.output.digest);assert.equal(check.job.containerStopped,true);assert.equal(check.result.credentialsAbsent,true);assert.equal(check.result.sourceUnchanged,true);assert.equal(check.result.boundary.verified,true);assert.equal(check.result.process.exitCode,0);for(const [label,count] of [['tests',2],['pass',2],['fail',0]])assert.match(check.result.process.stdout,new RegExp('^(?:# |ℹ )'+label+' '+count+'$','m'),'Missing real Node test totals');return check.result.process;});
 const overlapMs=Math.min(...processes.map((p:any)=>p.finishedAt))-Math.max(...processes.map((p:any)=>p.startedAt));assert.ok(overlapMs>0,'Check processes did not overlap');
 assert.equal(result.result.boundary.verified,true);const nativeParallel=nativeParallelEvidence(job.provider,result.result.sessionId,result.result.subagentReceipts??[]);assert.ok(nativeParallel,'Two distinct completed native subagents did not overlap');
 assert.ok(result.result.mcpReceipts?.some((r:any)=>r.nonce===nonce&&r.marker==='hivemind-phase0-mcp-v1'),'Matching native MCP challenge response missing');
 evidence.push({platform:'cloudflare-remote',recordedAt:new Date().toISOString(),provider:job.provider,jobId:job.id,inputSnapshotId:snapshot.digest,outputSnapshotId:result.output.digest,checksOverlapMs:overlapMs,nativeParallel,result});
}
const providerProcesses=evidence.map(e=>e.result.result.process);
const providersOverlapMs=providerProcesses.length>1?Math.min(...providerProcesses.map(p=>p.finishedAt))-Math.max(...providerProcesses.map(p=>p.startedAt)):null;if(providersOverlapMs!==null)assert.ok(providersOverlapMs>0,'Codex and Claude provider processes did not overlap');
await writeFile(resolve(directory,'acceptance.json'),JSON.stringify({passed:true,origin:origin.origin,providersOverlapMs,evidence},null,2),{mode:0o600});
console.log(JSON.stringify({passed:true,jobs:evidence.map(e=>({provider:e.provider,id:e.jobId,checksOverlapMs:e.checksOverlapMs}))}));
