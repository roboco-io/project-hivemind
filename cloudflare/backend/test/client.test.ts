import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../src/client.ts';
import {createSnapshot} from '../src/snapshot.ts';
import type {JobRecord,JobSpec} from '../src/contracts.ts';
const snapshot=createSnapshot([]);
const job:JobRecord={id:'job-1',attempt:'attempt-1',kind:'agent',provider:'codex',credentialId:'codex-main',credentialGeneration:1,snapshotId:snapshot.digest,outputSnapshotId:snapshot.digest,status:'SUCCEEDED',checks:[],childIds:[],createdAt:1,deadline:999999,timeoutMs:1000,containerStopped:true,authSynced:true};
const spec:JobSpec={provider:'codex',credentialId:'codex-main',snapshotId:snapshot.digest,instructions:'fix',checks:[{id:'test',argv:['node','--test'],timeoutMs:1000}],timeoutMs:1000,idempotencyKey:'request-1'};
test('client sends bearer authentication only to fixed API routes and validates snapshots',async()=>{
 const calls:Array<{url:string,init:RequestInit|undefined}>=[];
 const fake:typeof fetch=async(input,init)=>{const url=String(input);calls.push({url,init});if(url.includes('/snapshots/'))return Response.json({snapshotId:snapshot.digest});if(url.endsWith('/result'))return Response.json({input:snapshot,output:snapshot,job});return Response.json(job);};
 const client=createClient('https://example.test/','private-token',fake);
 assert.equal(await client.upload(snapshot),snapshot.digest);assert.equal((await client.submit(spec)).id,'job-1');assert.equal((await client.get('job-1')).status,'SUCCEEDED');assert.equal((await client.result('job-1')).output.digest,snapshot.digest);
 assert.deepEqual(calls.map(c=>new URL(c.url).pathname),[`/v1/snapshots/${snapshot.digest}`,'/v1/jobs','/v1/jobs/job-1','/v1/jobs/job-1/result']);
 assert.deepEqual(calls.map(c=>c.init?.method),['PUT','POST','GET','GET']);
 for(const call of calls){assert.equal(new Headers(call.init?.headers).get('authorization'),'Bearer private-token');assert.equal(call.init?.redirect,'error');assert.ok(!call.url.includes('private-token'));}
});
test('client rejects insecure URLs and malformed authentication before requesting',()=>{
 for(const url of ['ftp://example.test','http://example.test','https://user:pass@example.test','https://example.test/path','https://example.test/?token=x'])assert.throws(()=>createClient(url,'token'),/URL|HTTPS|origin/i);
 assert.throws(()=>createClient('https://example.test',''),/token/i);
 assert.throws(()=>createClient('https://example.test','bad\ntoken'),/token/i);
 assert.doesNotThrow(()=>createClient('http://127.0.0.1:8790','token'));
});
test('client never repeats backend error bodies or transport details that may contain secrets',async()=>{
 const rejected=createClient('https://example.test','secret',async()=>new Response('secret-from-server',{status:401}));
 await assert.rejects(rejected.get('job-1'),error=>String(error).includes('401')&&!String(error).includes('secret'));
 const failed=createClient('https://example.test','secret',async()=>{throw new Error('secret transport');});
 await assert.rejects(failed.get('job-1'),error=>!String(error).includes('secret'));
});
test('client refuses mismatched jobs and corrupted result snapshots',async()=>{
 const wrong=createClient('https://example.test','t',async()=>Response.json({...job,id:'another'}));await assert.rejects(wrong.get('job-1'),/job/i);
 const corrupt=createClient('https://example.test','t',async()=>Response.json({input:snapshot,output:{...snapshot,digest:'0'.repeat(64)},job}));await assert.rejects(corrupt.result('job-1'),/digest/i);
 const mismatch=createClient('https://example.test','t',async()=>Response.json({input:snapshot,output:snapshot,job:{...job,snapshotId:'0'.repeat(64)}}));await assert.rejects(mismatch.result('job-1'),/snapshot/i);
});

test('offline CLI snapshot reports only metadata and needs no backend token',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {runClientCli}=await import('../src/client.ts');
 const dir=await mkdtemp(join(tmpdir(),'hivemind-cli-'));
 try{await writeFile(join(dir,'file.txt'),'private source body');const lines:string[]=[];await runClientCli(['snapshot',dir],{},s=>lines.push(s));assert.equal(lines.length,1);assert.ok(!lines[0]!.includes('private source body'));assert.equal(JSON.parse(lines[0]!).fileCount,1);}finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI apply refuses failed results and leaves local source unchanged',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {runClientCli}=await import('../src/client.ts');
 const dir=await mkdtemp(join(tmpdir(),'hivemind-cli-apply-'));
 try{await writeFile(join(dir,'user.txt'),'untouched');const fake:typeof fetch=async()=>Response.json({input:snapshot,output:snapshot,job:{...job,status:'FAILED'}});await assert.rejects(runClientCli(['apply','job-1',dir],{HIVEMIND_URL:'https://example.test',HIVEMIND_CONTROL_TOKEN:'private'},()=>{},fake),/SUCCEEDED/);assert.equal(await readFile(join(dir,'user.txt'),'utf8'),'untouched');}finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI applies a successful verified snapshot and prints no source content',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');const {runClientCli}=await import('../src/client.ts');
 const dir=await mkdtemp(join(tmpdir(),'hivemind-cli-success-'));
 try{
  const bytes=Buffer.from('private generated content');const output=createSnapshot([{path:'new.txt',content:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),executable:false}]);
  const fake:typeof fetch=async()=>Response.json({input:snapshot,output,job:{...job,outputSnapshotId:output.digest}});const lines:string[]=[];
  await runClientCli(['apply','job-1',dir],{HIVEMIND_URL:'https://example.test',HIVEMIND_CONTROL_TOKEN:'control-private'},s=>lines.push(s),fake);
  assert.equal(await readFile(join(dir,'new.txt'),'utf8'),'private generated content');assert.equal(JSON.parse(lines[0]!).status,'APPLIED');assert.ok(!lines[0]!.includes('private generated content'));assert.ok(!lines[0]!.includes('control-private'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

function resultFixture(){
 const parent={...job,checks:spec.checks,childIds:['check-1']};
 const child:JobRecord={...job,id:'check-1',attempt:'check-attempt',kind:'compute',provider:undefined,credentialId:undefined,parentId:job.id,checkId:'test',checks:[],childIds:[],argv:['node','--test']};
 const result={version:1,jobId:job.id,attempt:job.attempt,inputSnapshotId:snapshot.digest,outputSnapshotId:snapshot.digest,process:{status:'passed',exitCode:0,stdout:'agent output',stderr:'',durationMs:50,truncated:false,startedAt:100,finishedAt:150},summary:'done',sourceUnchanged:false,provider:'codex',sandboxPolicy:'codex-workspace'};
 const checkResult={...result,jobId:child.id,attempt:child.attempt,provider:undefined,credentialsAbsent:true,sourceUnchanged:true,sandboxPolicy:'compute-workspace',process:{status:'passed',exitCode:0,stdout:'actual TAP test evidence',stderr:'actual diagnostic',durationMs:31,truncated:false,startedAt:200,finishedAt:231}};
 return {job:parent,input:snapshot,output:snapshot,result,checks:[{job:child,result:checkResult}]};
}
test('client preserves actual agent and test evidence with bound parent and child records',async()=>{
 const fixture=resultFixture();const client=createClient('https://example.test','t',async()=>Response.json(fixture));
 const received=await client.result('job-1');
 assert.deepEqual(received,JSON.parse(JSON.stringify(fixture)));
});
test('client rejects results bound to another job, attempt, snapshot or parent',async()=>{
 const mutations:Array<(v:ReturnType<typeof resultFixture>)=>void>=[
  v=>{v.result.jobId='another';},v=>{v.result.attempt='another';},v=>{v.result.inputSnapshotId='0'.repeat(64);},v=>{v.result.outputSnapshotId='0'.repeat(64);},
  v=>{v.checks[0]!.job.parentId='another';},v=>{v.checks[0]!.job.id='another';},v=>{v.checks[0]!.job.checkId='another';},v=>{v.checks[0]!.job.snapshotId='0'.repeat(64);},
  v=>{v.checks[0]!.result.jobId='another';},v=>{v.checks[0]!.result.attempt='another';},v=>{v.checks[0]!.result.inputSnapshotId='0'.repeat(64);},
  v=>{v.checks.push(v.checks[0]!);},v=>{v.checks[0]!.result.process.durationMs=-1;},
 ];
 for(const mutate of mutations){const fixture=resultFixture();mutate(fixture);await assert.rejects(createClient('https://example.test','t',async()=>Response.json(fixture)).result('job-1'),/result|check|snapshot|binding/i);}
});
test('CLI saves actual test logs and timestamps while printing only test metadata',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {runClientCli}=await import('../src/client.ts');const dir=await mkdtemp(join(tmpdir(),'hivemind-cli-evidence-'));
 try{
  const fixture=resultFixture(),lines:string[]=[];const output=join(dir,'result.json');
  await runClientCli(['result','job-1','--out',output],{HIVEMIND_URL:'https://example.test',HIVEMIND_CONTROL_TOKEN:'control-private'},s=>lines.push(s),async()=>Response.json(fixture));
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),JSON.parse(JSON.stringify(fixture)));
  assert.deepEqual(JSON.parse(lines[0]!).checks,[{id:'check-1',checkId:'test',status:'SUCCEEDED',exitCode:0,durationMs:31}]);
  assert.ok(!lines[0]!.includes('actual TAP'));assert.ok(!lines[0]!.includes('actual diagnostic'));assert.ok(!lines[0]!.includes('agent output'));assert.ok(!lines[0]!.includes('control-private'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI result saves only the fixed MCP challenge receipt fields',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {runClientCli}=await import('../src/client.ts');const dir=await mkdtemp(join(tmpdir(),'hivemind-cli-mcp-'));
 const receipt={callId:'call-phase0-1',nonce:'0123456789abcdef0123456789abcdef',marker:'hivemind-phase0-mcp-v1'};
 try{
  const fixture=resultFixture();const output=join(dir,'result.json'),lines:string[]=[];
  const payload={...fixture,result:{...fixture.result,mcpReceipts:[{...receipt,rawToolData:'private tool body',extra:'discard'}]}};
  await runClientCli(['result','job-1','--out',output],{HIVEMIND_URL:'https://example.test',HIVEMIND_CONTROL_TOKEN:'private-token'},s=>lines.push(s),async()=>Response.json(payload));
  const saved=await readFile(output,'utf8');assert.deepEqual(JSON.parse(saved).result.mcpReceipts,[receipt]);assert.ok(!saved.includes('private tool body'));assert.ok(!saved.includes('discard'));assert.ok(!lines[0]!.includes(receipt.nonce));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('client rejects malformed fixed MCP challenge receipts',async()=>{
 const valid={callId:'call-1',nonce:'0123456789abcdef0123456789abcdef',marker:'hivemind-phase0-mcp-v1'};
 for(const receipts of [null,{},[{}],[{...valid,callId:''}],[{...valid,callId:7}],[{...valid,nonce:'short'}],[{...valid,nonce:'g'.repeat(32)}],[{...valid,marker:'other'}]]){
  const fixture=resultFixture();const payload={...fixture,result:{...fixture.result,mcpReceipts:receipts}};
  await assert.rejects(createClient('https://example.test','t',async()=>Response.json(payload)).result('job-1'),/MCP|receipt/i);
 }
});

test('CLI result retains only prepared sandbox audit metadata in the saved result',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {runClientCli}=await import('../src/client.ts');const dir=await mkdtemp(join(tmpdir(),'hivemind-cli-audit-'));
 const receipt={sessionId:'session-1',agentId:null,toolUseId:'tool-1',commandHash:'a'.repeat(64),timestamp:'2026-11-10T12:34:56.789Z'};
 try{
  const fixture=resultFixture(),output=join(dir,'result.json'),lines:string[]=[];
  const payload={...fixture,result:{...fixture.result,sandboxReceipts:[{...receipt,rawCommand:'private source command',guardExecuted:true},{...receipt,agentId:'subagent-1',toolUseId:'tool-2'}]}};
  await runClientCli(['result','job-1','--out',output],{HIVEMIND_URL:'https://example.test',HIVEMIND_CONTROL_TOKEN:'private-token'},s=>lines.push(s),async()=>Response.json(payload));
  const saved=await readFile(output,'utf8');assert.deepEqual(JSON.parse(saved).result.sandboxReceipts,[receipt,{...receipt,agentId:'subagent-1',toolUseId:'tool-2'}]);
  assert.ok(!saved.includes('private source command'));assert.ok(!saved.includes('guardExecuted'));for(const value of [receipt.sessionId,receipt.toolUseId,receipt.timestamp])assert.ok(!lines[0]!.includes(value));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('client rejects malformed prepared sandbox audit metadata',async()=>{
 const valid={sessionId:'session-1',agentId:null,toolUseId:'tool-1',commandHash:'a'.repeat(64),timestamp:'2026-11-10T12:34:56.789Z'};
 for(const receipts of [null,{},[null],[{}],[{...valid,sessionId:''}],[{...valid,agentId:7}],[{...valid,toolUseId:'bad\nid'}],[{...valid,commandHash:'g'.repeat(64)}],[{...valid,commandHash:'a'.repeat(63)}],[{...valid,timestamp:'yesterday'}],[{...valid,timestamp:'2026-02-30T12:34:56.789Z'}]]){
  const fixture=resultFixture(),payload={...fixture,result:{...fixture.result,sandboxReceipts:receipts}};
  await assert.rejects(createClient('https://example.test','t',async()=>Response.json(payload)).result('job-1'),/sandbox|audit|receipt/i);
 }
});
