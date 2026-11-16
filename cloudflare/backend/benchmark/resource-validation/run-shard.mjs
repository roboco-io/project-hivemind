import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {command,prepare,serve,cleanup,readJson,fixtureRoot} from './fixture-runtime.mjs';
const selected=process.argv[2];
if(!['0','1','2','3','all'].includes(selected))throw Error('Expected shard 0,1,2,3,all');
const manifest=await readJson('shards.json'),suite=await readJson('suite.json');
const flat=manifest.shards.flat();
if(manifest.shards.length!==4||flat.length!==13||new Set(flat).size!==13||JSON.stringify([...flat].sort())!==JSON.stringify([...suite.tests].sort()))throw Error('Shard partition does not cover pinned suite');
const tests=selected==='all'?suite.tests:manifest.shards[Number(selected)];
const started=Date.now();let prepared,server;
try{
 prepared=await prepare();server=await serve(prepared);
 const uid='rv'+selected+'_'+createHash('sha256').update(prepared.root).digest('hex').slice(0,12);
 const hurl=process.env.HURL_BIN||'hurl';
 const result=await command([hurl,'--test','--jobs','1','--max-time','10','--variable','host='+server.url,'--variable','uid='+uid,...tests.map(t=>join(fixtureRoot,'hurl',t))],prepared.app,prepared.env);
 const output=result.out+'\n'+result.err;
 const files=Number(/Succeeded files:\s*(\d+)/.exec(output)?.[1]??0),requests=Number(/Executed requests:\s*(\d+)/.exec(output)?.[1]??0);
 const passed=result.code===0&&files===tests.length&&(selected!=='all'||requests===154);
 console.log(JSON.stringify({version:1,shard:selected,startedAt:started,finishedAt:Date.now(),passed,files,requests,testFiles:tests,phases:prepared.phases,hurlMs:result.ms}));
 if(!passed)process.exitCode=1;
}finally{await server?.stop();if(prepared)await cleanup(prepared);}
