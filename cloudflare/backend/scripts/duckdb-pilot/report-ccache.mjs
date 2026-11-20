import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {expand,summarize} from './compare-build.mjs';

const [root,reportPath]=process.argv.slice(2);
const campaign=join(root,'ccache');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const optional=async p=>read(p).catch(e=>{if(e.code!=='ENOENT')throw e;return undefined;});
const usage=await optional(join(campaign,'accounting','observed-usage.json'));
const rows=[];
for(const platform of ['local','cloud']){
 for(let i=1;i<=3;i++){
  const repeat=String(i).padStart(2,'0');
  for(const mode of ['cold','warm']){
   const folder=platform==='local'?join(root,'runs','ccache-local-'+(mode==='warm'?'reuse':'cold')+'-'+repeat):
    join(campaign,'cloud-'+(mode==='cold'&&i===1?'seed':mode)+'-'+repeat,'build');
   const result=await optional(join(folder,'result.json'));
   const row={platform,mode,repeat,status:'unavailable'};
   rows.push(row);
   if(!result)continue;
   row.status=result.status??result.group.status;
   row.passed=platform==='local'?result.status==='SUCCEEDED'&&result.outcome.passed===true:result.validation.passed===true;
   if(!row.passed)continue;
   row.totalMs=platform==='local'?result.finishedAt-result.startedAt:result.group.finishedAt-result.group.approvedAt;
   row.workers=[];
   for(const profile of ['C3','C4']){
    const prefix=profile.toLowerCase();
    let actions,stats,build,restoreMs,publishMs,sha,cpuSeconds;
    if(platform==='local'){
     stats=await read(join(folder,prefix+'-ccache.json'));
     actions=await read(join(folder,prefix+'-ninja-actions.json'));
     const stage=name=>result.stages.find(x=>x.name===prefix+'-'+name);
     const elapsed=s=>s?s.finishedAt-s.startedAt:0;
     build=elapsed(stage('build'));
     restoreMs=elapsed(stage('cache-restore'))+(stats.seed?.hashMs??0)*(mode==='warm');
     publishMs=elapsed(stage('cache-save'));
     cpuSeconds=stage('build').cpuUserSeconds+stage('build').cpuSystemSeconds;
     sha=stats.seed?.sha256;
    }else{
     const outcome=result.outcomes.find(o=>o.profile===profile).receipt;
     const worker=result.jobs.find(j=>j.job.checkId===profile).result;
     stats=outcome.cacheStats;
     actions=expand(outcome.ninja);
     build=outcome.phases.find(s=>s.name==='build').durationMs;
     cpuSeconds=outcome.buildCpu.usageUsec/1e6;
     restoreMs=worker.buildCache.restoreMs;
     publishMs=worker.buildCache.published?.durationMs??0;
     sha=worker.buildCache.restoredSha256??worker.buildCache.published?.sha256;
     await writeFile(join(folder,prefix+'-ninja-actions.json'),JSON.stringify(actions,null,2)+'\n');
    }
    assert.ok(actions.every(x=>!x.output.includes('/jemalloc/')));
    const hits=stats.hits??stats.directHits+stats.preprocessedHits;
    row.workers.push({profile,hits,misses:stats.misses,hitRate:hits/(hits+stats.misses),
     restoreMs,publishMs,sha,buildMs:build,cpuSeconds,phases:summarize(actions)});
   }
   if(platform==='cloud'){
    row.groupId=result.group.id;
    const jobs=usage?.rows.filter(x=>x.groupId===row.groupId)??[];
    const available=jobs.filter(x=>Number.isFinite(x.usage.retailUsd));
    row.costJobs=available.length;
    row.cost=available.length?available.reduce((x,y)=>x+y.usage.retailUsd,0):null;
    row.missingJobComputeEstimate=jobs.filter(x=>!Number.isFinite(x.usage.retailUsd)&&Number.isFinite(x.finishedAt))
     .reduce((x,y)=>x+Math.max(0,y.finishedAt-y.createdAt)/1000*.0001114,0);
   }
  }
 }
}
const med=xs=>{
 const found=xs.filter(Number.isFinite).sort((a,b)=>a-b);
 return found.length?(found[Math.floor((found.length-1)/2)]+found[Math.floor(found.length/2)])/2:null;
};
const spec=[['local','cold'],['local','warm'],['cloud','cold'],['cloud','warm']];
const fmt=(v,d=1)=>v===null||v===undefined?'미계측':(v/d).toFixed(2);
const lines=['# DuckDB C3·C4 ccache 비교','',
 '각 조건은 C3·C4 두 워커, 워커당 컴파일 슬롯 4개, jemalloc-off와 고정 Projection 16개를 사용했다. 시간은 완주한 묶음의 중앙값이다.',
 '',
 '| 환경·캐시 | 완주 | 전체(초) | 적중률 | 캐시 복원 합계(초) | 빌드(초) | 컴파일(초) | 링크(초) | 빌드 CPU초 | 원격 완주당 비용($) |',
 '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
for(const [platform,mode] of spec){
 const condition=rows.filter(x=>x.platform===platform&&x.mode===mode);
 const valid=condition.filter(x=>x.passed);
 const m=f=>med(valid.map(f));
 const agg=(r,f)=>r.workers.reduce((s,w)=>s+f(w),0);
 const wall=(r,f)=>Math.max(...r.workers.map(f));
 const rate=m(r=>100*agg(r,w=>w.hits)/agg(r,w=>w.hits+w.misses));
 const costs=valid.filter(x=>x.cost!==undefined&&x.cost!==null);
 const cost=costs.length===valid.length&&valid.length?costs.reduce((s,w)=>s+w.cost+w.missingJobComputeEstimate,0)/valid.length:null;
 lines.push('| '+[platform+' '+mode,valid.length+'/3',fmt(m(r=>r.totalMs),1000),
  rate===null?'미계측':fmt(rate)+'%',fmt(m(r=>agg(r,w=>w.restoreMs)),1000),
  fmt(m(r=>wall(r,w=>w.buildMs)),1000),fmt(m(r=>wall(r,w=>w.phases.compile.activeMs)),1000),
  fmt(m(r=>wall(r,w=>w.phases.link.activeMs)),1000),
  fmt(m(r=>agg(r,w=>w.cpuSeconds))),fmt(cost)].join(' | ')+' |');
}
lines.push('','복원은 워커별 합계다. 빌드 및 컴파일·링크는 두 워커 중 큰 값이며 구간이 겹칠 수 있다. 컴파일 시간은 Ninja 오브젝트 작업의 중첩을 제거한 값이고, ccache 호출과 오브젝트 쓰기도 포함한다. 비용은 조회된 컨테이너 사용량과 미조회 작업의 시간 한도 환산을 합친 추정이며 R2·Worker 비용 및 로컬 전력은 별도다.');
const markdown=lines.join('\n')+'\n';
await writeFile(join(campaign,'cache-comparison.json'),JSON.stringify(rows,null,2)+'\n');
await writeFile(join(campaign,'cache-comparison.md'),markdown);
if(reportPath)await writeFile(reportPath,markdown);
console.log(markdown);
