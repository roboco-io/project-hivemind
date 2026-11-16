import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const [local, cloud, output]=process.argv.slice(2);
const json=async file=>JSON.parse(await readFile(file,'utf8'));

export function expand(evidence){
  assert.equal(evidence.encoding,'brotli-delta-v1');
  const compressed=Buffer.from(evidence.data,'base64');
  assert.equal(createHash('sha256').update(compressed).digest('hex'),evidence.sha256);
  const raw=brotliDecompressSync(compressed,{maxOutputLength:2*1024*1024});
  const end=4+raw.readUInt32LE();
  assert.ok(end<raw.length);
  const paths=raw.subarray(end).toString().split('\n');
  assert.equal(paths.length,evidence.actions);
  let offset=4,start=0;
  function readVarint(){
    let value=0;
    for(let bits=0;bits<=28;bits+=7){
      assert.ok(offset<end);
      const byte=raw[offset++];
      value+=(byte&127)*2**bits;
      if(byte<128)return value;
    }
    throw Error('Invalid Ninja varint');
  }
  const rows=paths.map(path=>{
    start+=readVarint();
    return {startMs:start,finishMs:start+readVarint(),output:path};
  });
  assert.equal(offset,end);
  assert.equal(rows.reduce((s,row)=>s+row.finishMs-row.startMs,0),evidence.sumActionMs);
  return rows;
}

export function summarize(rows){
  const groups={compile:[],link:[],archive:[],other:[]};
  for(const row of rows){
    const path=row.output;
    const key=path.endsWith('.o')?'compile':path.endsWith('.a')?'archive':
      /\.(?:so|dylib|duckdb_extension)(?:\.[\d.]+)?$/.test(path)||
      ['duckdb','test/unittest','duckdb_platform_binary'].includes(path)?'link':'other';
    groups[key].push(row);
  }
  function aggregate(actions){
    let sumMs=0,activeMs=0,last=0;
    for(const {startMs,finishMs} of [...actions].sort((a,b)=>a.startMs-b.startMs)){
      sumMs+=finishMs-startMs;
      activeMs+=Math.max(0,finishMs-Math.max(last,startMs));
      last=Math.max(last,finishMs);
    }
    return {actions:actions.length,sumMs,activeMs};
  }
  return Object.fromEntries(Object.entries(groups).map(([key,value])=>[key,aggregate(value)]));
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
const l=await json(join(local,'result.json'));
const r=await json(cloud);
assert.equal(l.status,'SUCCEEDED');
assert.equal(l.outcome.passed,true);
assert.ok(r.outcomes?.length===2 && r.outcomes.every(x=>x.receipt?.passed===true));
const environment=await json(join(local,'environment.json'));
const comparison=[];
for(const profile of ['C3','C4']){
  const prefix=profile.toLowerCase();
  const stage=l.stages.find(x=>x.name===prefix+'-build');
  const remote=r.outcomes.find(x=>x.profile===profile).receipt;
  const localRows=await json(join(local,prefix+'-ninja-actions.json'));
  const remoteRows=expand(remote.ninja);
  assert.ok([...localRows,...remoteRows].every(row=>!row.output.includes('/jemalloc/')));
  await writeFile(join(output,prefix+'-remote-ninja.json'),JSON.stringify(remoteRows,null,2)+'\n');
  comparison.push({profile,local:{buildMs:stage.finishedAt-stage.startedAt,
    cpuSeconds:stage.cpuUserSeconds+stage.cpuSystemSeconds,phases:summarize(localRows)},
    remote:{buildMs:remote.phases.find(x=>x.name==='build').durationMs,
      cpuSeconds:remote.buildCpu.usageUsec/1e6,phases:summarize(remoteRows),toolchain:remote.toolchain}});
}
const result={scope:'C3 and C4 only, parallel jobs=4 per worker, one repeat per environment',
  localVersions:environment.versions,comparison,
  localTotalMs:l.finishedAt-l.startedAt,remoteTotalMs:r.group.finishedAt-r.group.approvedAt};
await writeFile(join(output,'comparison.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
}
