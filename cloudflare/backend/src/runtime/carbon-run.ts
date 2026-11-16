import {replayTerraWire,type WireReplayTiming} from './terra-wire-replay.ts';
import {mkdtemp, mkdir, readFile, writeFile, stat, cp, readdir, unlink, rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer, createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import type {ProcessResult} from '../contracts.ts';
import {carbonModel,type CarbonEffort,type BenchmarkInstance,type NpmCacheMode} from '../carbon-benchmark.ts';
import {terraEndpoint,terraModel,terraOrigin} from '../terra-gateway.ts';
import {latencyExpected,latencyPrompt,latencySystemPrompt,latencySequence,readPiBenchmarkProfile,readTerraClientTiming,readTerraSequenceTimings,type PiBenchmarkProfile,type TerraClientTiming,type TerraLatencyMode,type TerraSequenceTiming} from '../terra-latency.ts';
import {readNpmBenchmarkTimings,type NpmBenchmarkTiming} from './npm-benchmark-timing.ts';
import {downloadNpmCache,uploadNpmCache} from './npm-cache-archive.ts';
import {processDiagnostic} from './process-diagnostic.ts';
import {runProcess} from './process.ts';
import {measureBenchmarkResources,type BenchmarkResources} from './benchmark-resources.ts';

export interface CarbonRuntimeInput {effort:CarbonEffort; capability:string;probe?:boolean;model?:'terra';instance?:BenchmarkInstance;latency?:TerraLatencyMode;cacheMode?:NpmCacheMode}
export interface CarbonScore {files:number; requests:number; exitCode:number|null}
interface TimedCarbonScore extends CarbonScore {gradeMs:number;hurlProcessMs:number|null}
export interface CarbonRoundTiming {iteration:number;piSessionMs:number;piProcess?:ReturnType<typeof processDiagnostic>;toolMs?:number;toolCount?:number;profile?:PiBenchmarkProfile;grades:TimedCarbonScore[]}
interface ReplayStep {name:string;ms:number;status:ProcessResult['status'];exitCode:number|null}
interface ReplaySample {steps:ReplayStep[];grade?:TimedCarbonScore}
interface BashReplay {platform:string;arch:string;versions:Record<string,string>;samples:ReplaySample[]}
interface CacheReplaySample {
  pair:number;mode:'cold'|'warm';steps:ReplayStep[];elapsedMs:number;
  cachePresent:boolean;registryGets?:number;usageUsec?:number;
}
export interface CarbonEvidence {model?:'terra';effort:CarbonEffort; iterations:number; elapsedMs:number; scores:CarbonScore[]; roundTimings?:CarbonRoundTiming[]; resources?:BenchmarkResources; replay?:BashReplay; wireReplay?:WireReplayTiming[]; npm?:{seed?:{ms:number;registryGets:number;verificationGets?:number};commands:NpmBenchmarkTiming[];cacheMode?:NpmCacheMode;lockSha256?:string;r2?:{restore:{ms:number;bytes:number;sha256:string};publish?:{ms:number;bytes:number;sha256:string}}}; cacheReplay?:CacheReplaySample[]; latency?:TerraClientTiming; latencyTurns?:TerraSequenceTiming[]; streamProbe?: {bytes:number;elapsedMs:number;firstChunkMs:number;reservationGuard:boolean}}

const read = async (path:string) => (await stat(path)).isFile();
function policy(privatePaths:string[],app?:string) {
  const denied = privatePaths.map(path=>`${JSON.stringify(path)}="deny"`).join(',');
  const git = app ? ','+JSON.stringify(join(app,'.git'))+'="write"' : '';
  return ['codex','sandbox','-c',`permissions.benchmark={extends=":workspace",network={enabled=true},filesystem={${denied}${git}}}`,'-P','benchmark','--'];
}
function terraSandbox(fixture:string,runtimeDir:string,work:string,sessions:string,settings?:string):string[] {
  return ['/opt/hivemind/compat-bin/bwrap','--unshare-user','--unshare-pid','--die-with-parent','--new-session',
    '--ro-bind','/','/','--dev','/dev','--tmpfs','/proc','--tmpfs',fixture,'--tmpfs',runtimeDir,
    '--bind',work,work,...(sessions===work?[]:['--bind',sessions,sessions]),...(settings?['--bind',settings,settings]:[]),'--'];
}
async function freePort() {
  const server=createServer();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Cannot allocate a benchmark port');
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return address.port;
}
async function listening(port:number) {
  return new Promise<boolean>(resolve=>{
    const socket=createConnection({host:'127.0.0.1',port});
    socket.setTimeout(200);
    const finish=(ok:boolean)=>{socket.destroy();resolve(ok);};
    socket.once('connect',()=>finish(true));socket.once('timeout',()=>finish(false));socket.once('error',()=>finish(false));
  });
}
function stop(pid:number|undefined,signal:NodeJS.Signals) {
  if(pid)try{process.kill(-pid,signal);}catch{/* Already stopped. */}
}
async function grade(app:string,fixture:string,env:NodeJS.ProcessEnv,sandbox:string[],deadline:number,signal:AbortSignal,hurlPath:string) {
  const port=await freePort();
  const proc=spawn(sandbox[0]!,[...sandbox.slice(1),'npm','run','dev'],
    {cwd:app,env:{...env,PORT:String(port)},stdio:'ignore',detached:true});
  let ended=false;
  proc.once('error',()=>{ended=true;});proc.once('exit',()=>{ended=true;});
  try{
    const until=Math.min(deadline,Date.now()+30000);
    let ready=false;
    while(!ended&&!signal.aborted&&Date.now()<until){
      if(await listening(port)){ready=true;break;}
      await sleep(250);
    }
    if(!ready)return {score:{files:0,requests:0,exitCode:null},logs:'Benchmark server did not become ready',hurlProcessMs:null};
    const manifest=JSON.parse(await readFile(join(fixture,'suite.json'),'utf8')) as {tests:string[]};
    if(manifest.tests.length!==13||new Set(manifest.tests).size!==13||manifest.tests.some(path=>!/^[a-z_]+\.hurl$/.test(path)))
      throw new Error('Invalid pinned Hurl suite');
    const result=await runProcess([hurlPath,'--test','--jobs','1','--max-time','10',
      '--variable',`host=http://localhost:${port}`,'--variable',`uid=${randomUUID().replaceAll('-','')}`,
      ...manifest.tests.map(path=>join(fixture,'hurl',path))],
      {cwd:app,env,signal,timeoutMs:Math.max(1,Math.min(180000,deadline-Date.now())),maxBytes:32768});
    const output=result.stdout+'\n'+result.stderr;
    return {score:{files:Number(/Succeeded files:\s*(\d+)/.exec(output)?.[1]??0),
      requests:Number(/Executed requests:\s*(\d+)/.exec(output)?.[1]??0),exitCode:result.exitCode},
      logs:output.slice(-4000),hurlProcessMs:result.durationMs};
  }finally{
    stop(proc.pid,'SIGTERM');await sleep(200);stop(proc.pid,'SIGKILL');
  }
}
async function timedGrade(...args:Parameters<typeof grade>) {
  const started=performance.now();
  const result=await grade(...args);
  const score:TimedCarbonScore={...result.score,gradeMs:Math.round(performance.now()-started),hurlProcessMs:result.hurlProcessMs};
  return {score,logs:result.logs};
}
const passed=(score:CarbonScore)=>score.exitCode===0&&score.files===13&&score.requests===154;

async function watchAgent(argv:string[], app:string, sessions:string, env:NodeJS.ProcessEnv, deadline:number, signal:AbortSignal,privateInput?:string){
  const stall = new AbortController();
  let lastActivity = Date.now(), prior = '', checking = false;
  const timer = setInterval(() => {
    if(checking)return;
    checking=true;
    void (async () => {
      const names = (await readdir(sessions)).filter(name=>name.endsWith('.jsonl'));
      const entries = await Promise.all(names.map(async name=>{
        const info = await stat(join(sessions,name));
        return name+':'+info.size+':'+info.mtimeMs;
      }));
      const latest=entries.sort().join('|');
      if(latest!==prior){prior=latest;lastActivity=Date.now();}
      else if(Date.now()-lastActivity>=300000)stall.abort();
    })().catch(()=>stall.abort()).finally(()=>{checking=false;});
  },2000);
  timer.unref();
  try{return await runProcess(argv,{cwd:app,env,signal:AbortSignal.any([signal,stall.signal]),
    timeoutMs:Math.max(1,deadline-Date.now()),maxBytes:1024*1024,privateInput});}
  finally{clearInterval(timer);}
}

async function probeStream(input:CarbonRuntimeInput,signal:AbortSignal){
  const url='https://hivemind-carbon-probe.invalid/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse';
  const request=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':input.capability},
    body:JSON.stringify({contents:[{parts:[{text:'synthetic metering probe'}]}],
      generationConfig:{thinkingConfig:{thinkingLevel:input.effort.toUpperCase()}}}),
    redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(350000)])});
  const started=Date.now();
  const response=await request();
  if(!response.ok||!response.body)throw new Error('Synthetic stream request failed: '+response.status);
  const reader=response.body.getReader();
  let bytes=0,firstChunkMs=-1,guard=false;
  try{
    for(;;){
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.length;
      if(firstChunkMs<0){
        firstChunkMs=Date.now()-started;
        const duplicate=await request();
        guard=duplicate.status===429;
        await duplicate.body?.cancel();
        if(!guard)throw new Error('Concurrent request bypassed reservation');
      }
    }
  }finally{await reader.cancel().catch(()=>undefined);}
  const elapsedMs=Date.now()-started;
  if(bytes<=1024*1024||elapsedMs<270000||firstChunkMs>20000||!guard)
    throw new Error('Synthetic stream did not meet the duration, size or reservation criteria');
  return {bytes,elapsedMs,firstChunkMs,reservationGuard:guard};
}
const piTimingArgs=['-e','/opt/hivemind/backend/src/runtime/pi-tool-timing.mjs'];
function readToolTiming(stderr:string):{toolMs:number;toolCount:number}|undefined {
  const records=stderr.split('\n').filter(line=>line.startsWith('HIVEMIND_PI_TOOL_TIMING '));
  if(records.length!==1)return;
  try{
    const {toolMs,toolCount}=JSON.parse(records[0]!.slice('HIVEMIND_PI_TOOL_TIMING '.length));
    if(Number.isSafeInteger(toolMs)&&toolMs>=0&&Number.isSafeInteger(toolCount)&&toolCount>=0)return {toolMs,toolCount};
  }catch{return;}
}
const replayGitRevision='25588846c314b15a5e427ffe816e6b4af7be68c7';

async function replayRealWorld(fixture:string,runtimeDir:string,workRoot:string,timeoutMs:number,signal:AbortSignal,nativeHurl?:string) {
  const startedAt=Date.now(),deadline=startedAt+timeoutMs;
  const versions:Record<string,string>={};
  const samples:ReplaySample[]=[];
  let error='';
  for(let i=0;i<3&&!signal.aborted&&Date.now()<deadline;i++){
    const work=await mkdtemp(join(workRoot,'realworld-replay-'));
    const app=join(work,'app'),home=join(work,'home'),upstream=join(work,'upstream'),temp=join(work,'tmp');
    await Promise.all([mkdir(app),mkdir(home),mkdir(upstream),mkdir(temp)]);
    await cp(join(fixture,'reference'),app,{recursive:true});
    const sandbox=nativeHurl?['/usr/bin/env']:terraSandbox(fixture,runtimeDir,work,temp);
    const env:NodeJS.ProcessEnv={
      PATH:nativeHurl?dirname(process.execPath)+':'+process.env.PATH:process.env.PATH,
      HOME:home,TMPDIR:temp,XDG_CACHE_HOME:join(home,'.cache'),USER:'node',CI:'1',TERM:'dumb',
      SSL_CERT_FILE:process.env.SSL_CERT_FILE,NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,
      GIT_SSL_CAINFO:nativeHurl?undefined:process.env.SSL_CERT_FILE,
      npm_config_cache:join(home,'.npm-cache'),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',
      GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Benchmark',GIT_AUTHOR_EMAIL:'benchmark@example.invalid',
      GIT_COMMITTER_NAME:'Benchmark',GIT_COMMITTER_EMAIL:'benchmark@example.invalid',
    };
    const hurl=nativeHurl??'/usr/bin/hurl';
    const run=(argv:string[],cwd=app)=>runProcess([...sandbox,...argv],{cwd,env,signal,
      timeoutMs:Math.max(1,Math.min(180000,deadline-Date.now())),maxBytes:65536});
    if(i===0){
      for(const [name,cmd] of [['node','node'],['npm','npm'],['git','git'],['hurl',hurl]]){
        const r=await run([cmd!,'--version']);
        if(r.status!=='passed')throw Error('Replay tool unavailable: '+name);
        versions[name!]=r.stdout.split('\n')[0]!.trim();
      }
      if(!nativeHurl){
        const denied=await run(['node','-e',
          'const fs=require("node:fs");for(const p of process.argv.slice(1)){try{fs.readFileSync(p);process.exit(8)}catch(e){if(!["EACCES","EPERM","ENOENT","ENOTDIR"].includes(e.code))process.exit(9)}}',
          join(fixture,'PROMPT.md'),join(runtimeDir,'input.json'),'/proc/self/environ']);
        if(denied.status!=='passed')throw Error('Replay sandbox file boundary failed');
      }
    }
    const sample:ReplaySample={steps:[]};
    samples.push(sample);
    const commands:[string,string[],string?][]=[
      ['git-init',['git','init','-q']],
      ['git-add',['git','add','--all']],
      ['git-commit',['git','-c','commit.gpgsign=false','commit','-qm','reference fixture']],
      ['git-fetch-setup',['git','init','-q'],upstream],
      ['git-fetch',['git','fetch','-q','--depth=1','https://github.com/realworld-apps/realworld.git',replayGitRevision],upstream],
      ['npm-ci',['npm','ci','--ignore-scripts','--no-audit','--no-fund']],
      ['prisma-generate',['npm','run','db:generate']],
      ['prisma-migrate',['npm','run','db:migrate']],
      ['build',['npm','run','build','--','--types','node']],
    ];
    for(const [name,argv,cwd] of commands){
      const r=await run(argv,cwd);
      sample.steps.push({name,ms:r.durationMs,status:r.status,exitCode:r.exitCode});
      if(r.status!=='passed'){error=name+' '+r.status+': '+(r.stderr||r.stdout).trim().slice(-350);break;}
    }
    if(error)break;
    sample.grade=(await timedGrade(app,fixture,env,sandbox,deadline,signal,hurl)).score;
    if(!passed(sample.grade)){error='Pinned Hurl replay did not pass';break;}
  }
  const finishedAt=Date.now(),ok=samples.length===3&&!error&&!signal.aborted;
  const replay:BashReplay={platform:process.platform,arch:process.arch,versions,samples};
  const processResult:ProcessResult={status:ok?'passed':finishedAt>=deadline?'timed_out':'failed',exitCode:ok?0:1,
    stdout:ok?'Three fixed command replays and Hurl suites passed.':'',stderr:error,durationMs:finishedAt-startedAt,truncated:false,startedAt,finishedAt};
  return {process:processResult,evidence:{model:'terra' as const,effort:'medium' as const,iterations:0,
    elapsedMs:finishedAt-startedAt,scores:samples.flatMap(sample=>sample.grade?[sample.grade]:[]),replay}};
}

export function runNativeRealWorldReplay(fixture:string,workRoot:string,hurlPath:string,signal:AbortSignal) {
  return replayRealWorld(fixture,workRoot,workRoot,600000,signal,hurlPath);
}

export async function replayRealWorldCache(fixture:string,runtimeDir:string,workRoot:string,timeoutMs:number,signal:AbortSignal,native=false){
  const startedAt=Date.now(),deadline=startedAt+timeoutMs;
  const samples:CacheReplaySample[]=[];
  let error='';
  for(let pair=1;pair<=3&&!error&&!signal.aborted;pair++){
    const work=await mkdtemp(join(workRoot,'realworld-cache-'));
    const cache=join(work,'npm-cache');
    const sandbox=native?['/usr/bin/env']:terraSandbox(fixture,runtimeDir,work,work);
    for(const mode of ['cold','warm'] as const){
      if(signal.aborted||Date.now()>=deadline)break;
      let stageStarted=Date.now();
      let finishResources:(()=>Promise<BenchmarkResources>)|undefined;
      const app=join(work,'app-'+mode),home=join(work,'home-'+mode),temp=join(work,'tmp-'+mode);
      const cachePresent=(await stat(join(cache,'_cacache')).catch(()=>undefined))?.isDirectory()===true;
      const sample:CacheReplaySample={pair,mode,steps:[],elapsedMs:0,cachePresent};
      samples.push(sample);
      try{
        if(cachePresent!==(mode==='warm'))throw Error('Unexpected npm cache state');
        await Promise.all([mkdir(app),mkdir(home),mkdir(temp)]);
        await cp(join(fixture,'reference'),app,{recursive:true});
        const env:NodeJS.ProcessEnv={
          PATH:native?dirname(process.execPath)+':'+process.env.PATH:process.env.PATH,
          HOME:home,TMPDIR:temp,XDG_CACHE_HOME:join(home,'.cache'),CI:'1',TERM:'dumb',
          SSL_CERT_FILE:process.env.SSL_CERT_FILE,NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,
          npm_config_cache:cache,
        };
        if(!native&&pair===1&&mode==='cold'){
          const boundary=await runProcess([...sandbox,'node','-e',
            'const fs=require("node:fs");for(const p of process.argv.slice(1)){try{fs.readFileSync(p);process.exit(8)}catch(e){if(!["EACCES","EPERM","ENOENT","ENOTDIR"].includes(e.code))process.exit(9)}}',
            join(fixture,'PROMPT.md'),join(runtimeDir,'input.json'),'/proc/self/environ'],
            {cwd:app,env,signal,timeoutMs:10000,maxBytes:2000});
          if(boundary.status!=='passed')throw Error('Cache replay sandbox file boundary failed');
        }
        finishResources=native?undefined:await measureBenchmarkResources();
        stageStarted=Date.now();
        const commands:[string,string[]][]=[
          ['npm-ci',['npm','ci','--ignore-scripts','--no-audit','--no-fund','--prefer-offline','--loglevel=http']],
          ['prisma-generate',['npm','run','db:generate']],
          ['build',['npm','run','build','--','--types','node']],
        ];
        for(const [name,argv] of commands){
          const result=await runProcess([...sandbox,...argv],{cwd:app,env,signal,
            timeoutMs:Math.max(1,Math.min(180000,deadline-Date.now())),maxBytes:131072});
          sample.steps.push({name,ms:result.durationMs,status:result.status,exitCode:result.exitCode});
          if(name==='npm-ci')sample.registryGets=(result.stderr.match(/^npm http fetch GET /gm)??[]).length;
          if(result.status!=='passed')throw Error(name+' '+result.status+': '+(result.stderr||result.stdout).trim().slice(-350));
        }
        if(!await read(join(app,'dist','server.js')))throw Error('Expected build output missing');
      }catch(cause){
        error=cause instanceof Error?cause.message:'Cache replay failed';
      }finally{
        sample.elapsedMs=Date.now()-stageStarted;
        sample.usageUsec=(await finishResources?.())?.usageUsec;
      }
      if(error)break;
    }
  }
  const finishedAt=Date.now(),ok=samples.length===6&&!error&&!signal.aborted;
  const processResult:ProcessResult={status:ok?'passed':finishedAt>=deadline?'timed_out':'failed',exitCode:ok?0:1,
    stdout:ok?'Three cold/warm npm-cache pairs completed.':'',stderr:error,durationMs:finishedAt-startedAt,truncated:false,startedAt,finishedAt};
  return {process:processResult,evidence:{model:'terra' as const,effort:'medium' as const,iterations:0,
    elapsedMs:finishedAt-startedAt,scores:[],cacheReplay:samples}};
}

export async function runCarbon(input:CarbonRuntimeInput,fixture:string,runtimeDir:string,timeoutMs:number,signal:AbortSignal) {
  if(input.latency==='wire-replay'){
    const startedAt=Date.now();
    const wireReplay=await replayTerraWire(fixture,{access:input.capability},
      AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]),input.probe);
    const success=wireReplay.length===(input.probe?1:26)&&wireReplay.every(row=>!row.error);
    const finishedAt=Date.now();
    const process:ProcessResult={status:success?'passed':'failed',exitCode:success?0:1,stdout:'',
      stderr:wireReplay.find(row=>row.error)?.error??'',durationMs:finishedAt-startedAt,truncated:false,startedAt,finishedAt};
    return {process,evidence:{model:input.model,effort:input.effort,iterations:0,elapsedMs:process.durationMs,scores:[],wireReplay}};
  }
  if(input.latency==='cache-replay')return replayRealWorldCache(fixture,runtimeDir,'/home/node',timeoutMs,signal);
  if(input.latency==='replay')return replayRealWorld(fixture,runtimeDir,'/home/node',timeoutMs,signal);
  const end=input.instance?await measureBenchmarkResources():undefined;
  try{
    const result=await runBenchmark(input,fixture,runtimeDir,timeoutMs,signal);
    if(end)result.evidence.resources=await end();
    return result;
  }catch(error){
    await end?.();
    throw error;
  }
}
interface NativeTerraOptions {
  workRoot:string;
  hurlPath:string;
  modelsPath:string;
  preloadPath:string;
  transport:'auto'|'sse';
  credential:string;
  locked?:boolean;
}
export function runNativeTerraBenchmark(fixture:string,options:NativeTerraOptions,signal:AbortSignal){
  return runBenchmark({model:'terra',effort:'medium',capability:'native-placeholder',latency:options.locked?'realworld-cold':'realworld',...(options.locked?{cacheMode:'cold' as const}:{})},
    fixture,options.workRoot,1200000,signal,options);
}
async function runBenchmark(input:CarbonRuntimeInput,fixture:string,runtimeDir:string,timeoutMs:number,signal:AbortSignal,native?:NativeTerraOptions):Promise<{process:ProcessResult; evidence:CarbonEvidence}> {
  const startedAt=Date.now(), deadline=startedAt+Math.min(timeoutMs,1200000);
  const work=await mkdtemp(native?join(native.workRoot,'run-'):'/home/node/hivemind-carbon-');
  const app=join(work,'app'),home=join(work,'home'),sessions=await mkdtemp(join(tmpdir(),'hivemind-carbon-sessions-'));
  await mkdir(app);await mkdir(home);
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:home,USER:'node',CI:'1',TERM:'dumb',
    SSL_CERT_FILE:process.env.SSL_CERT_FILE,NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,
    GIT_SSL_CAINFO:native?undefined:process.env.SSL_CERT_FILE,
    npm_config_cache:join(app,'.npm-cache'),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  const git=await runProcess(['git','init','-q'],{cwd:app,env,signal,timeoutMs:5000});
  if(git.exitCode!==0)throw new Error('Could not initialize clean benchmark workspace');
  const prompt=await readFile(join(fixture,'PROMPT.md'),'utf8');
  await writeFile(join(app,'PROMPT.md'),prompt);
  const terra=input.model==='terra';
  const r2=input.latency==='realworld-r2-cache';
  const locked=input.latency==='realworld-cache-pairs'||input.latency==='realworld-cold'||r2;
  const warm=input.latency==='realworld-warm'||input.cacheMode==='warm'||r2;
  const lockedDir=join(fixture,'benchmark-lock');
  const lockSha256=locked?createHash('sha256').update(await readFile(join(lockedDir,'package-lock.json'))).digest('hex'):undefined;
  const dependencies=(text:string)=>{
    const {dependencies={},devDependencies={}}=JSON.parse(text);
    return [dependencies,devDependencies].map(values=>Object.entries(values).sort());
  };
  const fixedDependencies=locked?dependencies(await readFile(join(lockedDir,'package.json'),'utf8')):undefined;
  if(locked&&!input.probe)await Promise.all(['package.json','package-lock.json'].map(file=>cp(join(lockedDir,file),join(app,file))));
  if(warm||locked)Object.assign(env,{npm_config_cache:join(work,'npm-cache'),npm_config_prefer_offline:'true',
    npm_config_timing:'true',npm_config_logs_dir:join(work,'npm-timing'),npm_config_logs_max:'100'});
  if(r2)env.npm_config_update_notifier='false';
  const model=terra?'openai-codex/'+terraModel:'google/'+carbonModel;
  // A fresh copy is writable for Pi's settings locks. Each iteration uses the pinned image copy.
  async function piSettings(){
    const settings=await mkdtemp(join(tmpdir(),'hivemind-carbon-pi-'));
    if(native)await cp(native.modelsPath,join(settings,'models.json'));
    else await cp('/opt/hivemind/backend/benchmark/agent',settings,{recursive:true});
    if(terra){
      const provider='openai-codex';
      const claims=Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'hivemind'}})).toString('base64');
      if(!native)await writeFile(join(settings,'models.json'),JSON.stringify({providers:{[provider]:{baseUrl:terraOrigin,models:[{
        id:terraModel,name:'GPT-6.1 Terra',api:'openai-codex-responses',baseUrl:terraOrigin,reasoning:true,
        input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:272000,maxTokens:128000,
        thinkingLevelMap:{off:'none',minimal:'low',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'},
        compat:{supportsOpenAIGrammarTools:true,supportsAdditionalTools:true,supportsToolSearch:true,supportsMidConvoSystemMessages:true},
      }]}}}));
      await writeFile(join(settings,'auth.json'),JSON.stringify({[provider]:{
        type:'oauth',access:'placeholder.'+claims+'.placeholder',refresh:'placeholder',expires:9999999999999,
      }}),{mode:0o600});
      await writeFile(join(settings,'settings.json'),JSON.stringify({transport:native?.transport??'sse',...(!native?{shellPath:'/opt/hivemind/backend/benchmark/pi-shell'}:{})}));
    }
    return settings;
  }
  if(terra){env.TMPDIR=join(work,'tmp');await mkdir(env.TMPDIR);}
  const agentEnv={...env,PORT:String(await freePort()),PI_OFFLINE:'1',
    PI_SKIP_VERSION_CHECK:'1',...(native?{
      NODE_OPTIONS:'--import='+native.preloadPath,
    }:terra?{
      NODE_OPTIONS:'--import=/opt/hivemind/backend/src/runtime/terra-transport.mjs',
      HIVEMIND_TERRA_CAPABILITY:input.capability,
    }:{GEMINI_API_KEY:input.capability}),GIT_AUTHOR_NAME:'Benchmark',GIT_AUTHOR_EMAIL:'benchmark@example.invalid',
    GIT_COMMITTER_NAME:'Benchmark',GIT_COMMITTER_EMAIL:'benchmark@example.invalid'};
  const persistence=(await readFile(join(fixture,'pi-persistence.md'),'utf8'))+(locked?
    '\n\nThe supplied package.json and package-lock.json pin the dependencies for this benchmark. Start with npm ci --ignore-scripts --no-audit --no-fund. Keep the dependency sets and package-lock.json unchanged. Add your own application code and scripts, and run Prisma generation separately as needed.': '');
  const privatePaths=[fixture,runtimeDir,'/proc'];
  const sandbox=(settings?:string,git=false)=>native?['/usr/bin/env']:terra?terraSandbox(fixture,runtimeDir,work,sessions,settings):policy(privatePaths,git?app:undefined);
  const boundary=native?undefined:await runProcess([...sandbox(),'node','-e',
    'const fs=require("node:fs");for(const [i,p] of process.argv.slice(1).entries()){try{if(fs.readFileSync(p).length!==0){console.error("Readable protected file "+i);process.exit(8)}}catch(e){if(!["EACCES","EPERM","ENOENT","ENOTDIR"].includes(e.code)){console.error("Boundary read "+i+": "+e.code);process.exit(9)}}};fs.writeFileSync("benchmark-boundary.tmp","ok");fs.unlinkSync("benchmark-boundary.tmp");',
    join(fixture,'PROMPT.md'),join(runtimeDir,'input.json'),'/proc/self/environ','/proc/1/environ'],
    {cwd:app,env,signal,timeoutMs:10000,maxBytes:2000});
  if(boundary&&boundary.status!=='passed')throw new Error('Carbon file boundary failed: '+boundary.stderr.trim().slice(-550));
  let seed:{ms:number;registryGets:number;verificationGets?:number}|undefined;
  const transferSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(120000,deadline-Date.now())))]);
  const cache=env.npm_config_cache!;
  let restored=r2?await downloadNpmCache(cache,input.capability,transferSignal):undefined;
  let published:Awaited<ReturnType<typeof uploadNpmCache>>|undefined;
  if(r2&&!restored&&!input.probe)throw Error('R2 npm cache missing after verified preparation');
  if(warm&&(!restored||input.probe)){
    const staging=join(work,'npm-seed');
    await cp(locked?lockedDir:join(fixture,'reference'),staging,{recursive:true});
    try{
      const prepare=()=>runProcess([...sandbox(),'npm','ci','--ignore-scripts','--no-audit','--no-fund','--loglevel=http'],
        {cwd:staging,env:{...env,npm_config_timing:'false',npm_config_logs_dir:join(work,'seed-logs')},
          signal,timeoutMs:Math.max(1,Math.min(180000,deadline-Date.now())),maxBytes:131072});
      const gets=(process:ProcessResult)=>(process.stderr.match(/^npm http fetch GET /gm)??[]).length;
      if(!restored){
        const primed=await prepare();
        if(primed.status!=='passed')throw Error('npm cache preparation failed: '+primed.status);
        seed={ms:primed.durationMs,registryGets:gets(primed)};
        if(r2){
          published=await uploadNpmCache(cache,input.capability,transferSignal);
          await rm(cache,{recursive:true,force:true});
          restored=await downloadNpmCache(cache,input.capability,transferSignal);
          if(!restored||restored.sha256!==published.sha256)throw Error('R2 npm cache round-trip failed');
        }
      }
      if(locked&&input.probe){
        const verified=await prepare();
        if(verified.status!=='passed'||gets(verified)!==0)throw Error('Pinned lockfile cache verification failed');
        if(seed)seed.verificationGets=gets(verified);
      }
    }finally{await rm(staging,{recursive:true,force:true});}
  }
  const npmEvidence=async()=>seed||locked?{seed,lockSha256,cacheMode:input.cacheMode,r2:restored?{restore:restored,publish:published}:undefined,commands:await readNpmBenchmarkTimings(join(work,'npm-timing'))}:undefined;
  const profile=input.latency==='realworld'||warm||locked;
  const profileExtension=native?fileURLToPath(new URL('./pi-latency.mjs',import.meta.url)):'/opt/hivemind/backend/src/runtime/pi-latency.mjs';
  const toolTimingExtension=native?['-e',fileURLToPath(new URL('./pi-tool-timing.mjs',import.meta.url))]:piTimingArgs;
  const score=(path:string)=>timedGrade(path,fixture,env,sandbox(),deadline,signal,native?.hurlPath??'/usr/bin/hurl');
  if(input.latency&&!profile){
    const sequence=input.latency==='sequence'?latencySequence():undefined;
    const settings=await piSettings();
    const process=await runProcess([...sandbox(settings),'pi','-p','-nc','-ns','-ne','-np','-na','--no-session','--no-tools',
      '-e','/opt/hivemind/backend/src/runtime/pi-latency.mjs','--model',model,'--thinking','medium',
      '--system-prompt',latencySystemPrompt,'--',...(sequence?.map(turn=>turn.prompt)??[latencyPrompt])],
      {cwd:app,env:{...agentEnv,PI_CODING_AGENT_DIR:settings,...(input.probe?{HIVEMIND_TERRA_PROBE:'1'}:{})},
        signal,timeoutMs:Math.min(sequence?360000:120000,Math.max(1,deadline-Date.now())),maxBytes:40000});
    const latency=sequence?undefined:readTerraClientTiming(process.stderr);
    const latencyTurns=sequence?readTerraSequenceTimings(process.stderr):undefined;
    const outputVerified=sequence?Boolean(latencyTurns?.every((turn,i)=>turn.textSha256===createHash('sha256')
      .update(input.probe?'Terra fixture complete.':sequence[i]!.expected).digest('hex'))):
      process.stdout.trim()===(input.probe?'Terra fixture complete.':latencyExpected);
    const timed=sequence?Boolean(latencyTurns?.every(turn=>turn.transport==='sse')):latency?.transport==='sse';
    const success=process.status==='passed'&&timed&&outputVerified;
    return {process:{...process,status:success?'passed':process.status==='passed'?'failed':process.status,
      exitCode:success?0:process.exitCode||1,stdout:outputVerified?'Fixed latency response verified.':'',
      stderr:success?'':timed?'Fixed latency response mismatch.':'Pi latency events missing or unsuccessful.'},
      evidence:{model:input.model,effort:input.effort,iterations:1,elapsedMs:Date.now()-startedAt,scores:[],latency,latencyTurns}};
  }
  if(input.probe){
    const settings=await piSettings();
    const registry=await runProcess([...sandbox(settings),'pi','-nc','-ns','-ne','-np','-na','--list-models',model.split('/')[1]!],
      {cwd:app,env:{...env,PI_OFFLINE:'1',PI_CODING_AGENT_DIR:settings,GEMINI_API_KEY:'nonbillable-registry-fixture'},signal,timeoutMs:5000,maxBytes:4000});
    if(registry.status!=='passed'||!registry.stdout.includes(model.split('/')[1]!)||/EACCES|Invalid settings/.test(registry.stderr))
      throw new Error('Pi registry probe failed: '+(registry.stderr||registry.stdout).trim().slice(-300));
    const hurl=await runProcess(['/usr/bin/hurl','--version'],{cwd:app,env,signal,timeoutMs:5000});
    const pi=await runProcess([...sandbox(),'pi','--version'],{cwd:app,env,signal,timeoutMs:5000});
    if(hurl.status!=='passed'||!/^hurl 8\.0\.1\b/.test(hurl.stdout)||pi.status!=='passed'||pi.stdout.trim()!=='0.87.1')
      throw new Error('Carbon benchmark runtime version mismatch');
    const shell=await runProcess([...sandbox(),'/opt/hivemind/backend/benchmark/pi-shell','-c',
      'test -z "${GEMINI_API_KEY+x}"'],{cwd:app,env:{...env,GEMINI_API_KEY:'fixture'},signal,timeoutMs:5000});
    if(shell.status!=='passed')throw new Error('Carbon shell did not remove the provider capability');
    if(terra){
      const direct=await fetch(terraEndpoint,{method:'POST',headers:{authorization:'Bearer '+input.capability,
        'x-hivemind-terra-probe':'1','content-type':'application/json'},
        body:JSON.stringify({model:terraModel,reasoning:{effort:'medium'},stream:true,store:false,input:[],tools:[]}),
        signal:AbortSignal.any([signal,AbortSignal.timeout(12000)])});
      if(!direct.ok||!(await direct.text()).includes('response.completed'))throw new Error('Terra direct gateway failed: HTTP '+direct.status);
      const smoke=await runProcess([...sandbox(settings),'pi','-p','-nc','-ns','-ne','-np','-na','--no-session',
        '--mode','json',...(input.instance?piTimingArgs:[]),...(profile?['-e',profileExtension]:[]),'--model',model,'--thinking','medium','--','Return fixture text.'],
        {cwd:app,env:{...agentEnv,PI_CODING_AGENT_DIR:settings,HIVEMIND_TERRA_PROBE:'1'},signal,timeoutMs:22000,maxBytes:24000});
      let diagnostic='';
      const hasUsage=smoke.stdout.split('\n').some(line=>{
        try{
          const event=JSON.parse(line);
          if(event.type==='message_end'&&event.message?.errorMessage)diagnostic=String(event.message.errorMessage);
          return event.type==='message_end'&&event.message.model===terraModel&&
            event.message.stopReason==='stop'&&event.message.usage?.totalTokens===168;
        }catch{return false;}
      });
      if(smoke.status!=='passed'||!hasUsage||(input.instance&&!readToolTiming(smoke.stderr))||(profile&&readPiBenchmarkProfile(smoke.stderr).turns.length!==1))throw new Error('Terra Pi synthetic gateway failed ('+smoke.status+'): '+
        (smoke.stderr.trim()||diagnostic||'no expected usage event').replaceAll(input.capability,'[REDACTED]').slice(-400));
    }
    if(terra){
      const tls=await runProcess([...sandbox(),'/opt/hivemind/backend/benchmark/pi-shell','-c',
        'test -n "$GIT_SSL_CAINFO" && test -r "$GIT_SSL_CAINFO" && git ls-remote https://github.com/realworld-apps/realworld.git HEAD'],
        {cwd:app,env,signal,timeoutMs:20000,maxBytes:2000});
      if(tls.status!=='passed')throw Error('Git HTTPS CA probe failed: '+tls.status);
    }
    const commit=await runProcess([...sandbox(undefined,true),'/bin/bash','-c',
      'git add PROMPT.md && git -c user.name=Benchmark -c user.email=benchmark@example.invalid commit -qm fixture'],
      {cwd:app,env,signal,timeoutMs:10000,maxBytes:2000});
    if(commit.status!=='passed')throw new Error('Scratch Git commit failed: '+commit.stderr.trim().slice(-650));
    await cp(join(fixture,'reference'),app,{recursive:true});
    const install=await runProcess([...sandbox(),'npm','ci','--no-audit','--no-fund'],
      {cwd:app,env,signal,timeoutMs:180000,maxBytes:32768});
    if(install.status!=='passed')throw new Error('Reference app install failed: '+install.stderr.trim().slice(-450));
    const positive=await score(app);
    const empty=join(work,'empty');
    await mkdir(empty);
    const negative=await score(empty);
    if(!passed(positive.score)||passed(negative.score))throw new Error('Pinned Hurl reference failed: '+JSON.stringify({positive:positive.score,negative:negative.score}));
    const streamProbe=terra?undefined:await probeStream(input,signal);
    const finishedAt=Date.now();
    return {process:{status:'passed',exitCode:0,stdout:'Pinned pi 0.87.1, Orange Hurl 8.0.1, denied private paths and stripped shell capability. Known-good suite 13/154, empty app rejected. '+(terra?'Pi Responses usage settled.':'Long synthetic stream settled.'),
      stderr:'',durationMs:finishedAt-startedAt,truncated:false,startedAt,finishedAt},evidence:{model:input.model,effort:input.effort,iterations:0,elapsedMs:finishedAt-startedAt,scores:[positive.score,negative.score],streamProbe,npm:await npmEvidence()}};
  }

  let logs='',error='',iterations=0,completedAt:number|undefined;
  const scores:CarbonScore[]=[];
  const roundTimings:CarbonRoundTiming[]=[];
  for(let i=1;i<=30&&!signal.aborted&&Date.now()<deadline;i++){
    iterations=i;
    const settings=await piSettings();
    const agent=await watchAgent([...sandbox(settings,true),'pi','-p','-nc','-ns','-ne','-np','-na',
      ...(input.instance||profile?toolTimingExtension:[]),...(profile?['-e',profileExtension]:[]),'--session-dir',sessions,'--model',model,'--thinking',input.effort,'--append-system-prompt',persistence,'--',prompt],
      app,sessions,{...agentEnv,PI_CODING_AGENT_DIR:settings},deadline,signal,native?.credential);
    const timing:CarbonRoundTiming={iteration:i,piSessionMs:agent.durationMs,piProcess:processDiagnostic(agent),...(input.instance||profile?readToolTiming(agent.stderr):undefined),...(profile?{profile:readPiBenchmarkProfile(agent.stderr)}:{}),grades:[]};
    roundTimings.push(timing);
    if(agent.status!=='passed'){
      error=profile?'Model invocation failed ('+agent.status+').':'Model invocation failed: '+(agent.stderr||agent.stdout).trim().replaceAll(input.capability,'[REDACTED]').slice(-500);
      break;
    }
    const checked=await score(app);
    timing.grades.push(checked.score);
    logs=checked.logs;
    if(!(await read(join(app,'.ralph-done')).catch(()=>false)))continue;
    if(!passed(checked.score)){
      await unlink(join(app,'.ralph-done'));
      continue;
    }
    completedAt=Date.now();
    scores.push(checked.score);
    for(let rerun=0;rerun<2;rerun++){
      const recheck=await score(app);
      timing.grades.push(recheck.score);
      scores.push(recheck.score);
      logs=recheck.logs;
      if(!passed(recheck.score))break;
    }
    break;
  }
  const npm=await npmEvidence();
  if(locked){
    const finalLock=await readFile(join(app,'package-lock.json')).catch(()=>undefined);
    const finalDependencies=await readFile(join(app,'package.json'),'utf8').then(dependencies).catch(()=>undefined);
    const installs=npm?.commands.filter(command=>command.kind==='install')??[];
    if(!finalLock||createHash('sha256').update(finalLock).digest('hex')!==lockSha256||
      JSON.stringify(finalDependencies)!==JSON.stringify(fixedDependencies))error='Pinned dependencies changed during the run';
    else if(!installs.length||installs.some(command=>command.operation!=='ci'))error='Expected npm ci timing is missing or install method changed';
  }
  const finishedAt=Date.now(), ok=scores.length===3&&scores.every(passed)&&!signal.aborted&&!error;
  return {
    process:{status:ok?'passed':finishedAt>=deadline?'timed_out':'failed',exitCode:ok?0:1,stdout:logs,
      stderr:ok?'':error||'Required Hurl checks did not pass',durationMs:finishedAt-startedAt,truncated:false,startedAt,finishedAt},
    evidence:{model:input.model,effort:input.effort,iterations,elapsedMs:(completedAt??finishedAt)-startedAt,scores,roundTimings,npm},
  };
}
