import {spawn,execFile,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,open,stat,statfs,readdir,rename,unlink,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {platform,cpus,totalmem,release} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {createHostSampler,summarizeHost,type HostSample} from '../resource-validation/host-metrics.ts';
import {atomicJson,safeEnv} from '../resource-validation/experiment.ts';
import {Guard,parseVm,profile,validateMemoryOptions} from './metrics.ts';
import {selectMacSdk} from './sdk.ts';
import {validateBuildBatch,executeBatch} from './batch.ts';
import {validateMemoryBatch,shardScript} from './memory-batch.ts';
const HERE=dirname(fileURLToPath(import.meta.url));
export const COMMIT='68d7555f68bd25c1a251ccca2e6338949c33986a';
const archiveUrl=`https://codeload.github.com/duckdb/duckdb/tar.gz/${COMMIT}`;
const readJson=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const exists=async(p:string)=>!!await stat(p).catch(()=>undefined);
const command=(file:string,args:string[],env=safeEnv())=>new Promise<string>((ok,no)=>execFile(file,args,{env,timeout:15000,maxBuffer:1024*1024},(e,out)=>e?no(e):ok(out)));
async function fileHash(path:string){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
async function prepare(root:string){
 await mkdir(root,{recursive:true,mode:0o700});
 const archive=join(root,'duckdb-source.tar.gz');
 if(!await exists(archive)){
  const response=await fetch(archiveUrl,{redirect:'error',signal:AbortSignal.timeout(180000)});if(!response.ok||!response.body)throw Error('Source download failed');
  const out=await open(archive+'.partial','wx',0o600);let size=0;
  try{for await(const chunk of response.body as any){size+=chunk.length;if(size>256*1024**2)throw Error('Source archive too large');await out.write(chunk);}}catch(e){await out.close();await unlink(archive+'.partial');throw e;}await out.close();await rename(archive+'.partial',archive);
 }
 const digest=await fileHash(archive),old=await readJson(join(root,'source.json')).catch(()=>undefined);
 if(old&&old.sha256!==digest)throw Error('Prepared source changed');
 await atomicJson(join(root,'source.json'),{repository:'https://github.com/duckdb/duckdb',commit:COMMIT,url:archiveUrl,sha256:digest,bytes:(await stat(archive)).size});
 const normalized=join(root,'duckdb-source-normalized.tar.gz'),normalization=join(root,'normalization.json');
 if(!await exists(normalized))execFileSync('python3',[join(HERE,'normalize-source.py'),archive,normalized,normalization],{env:safeEnv(),stdio:'ignore',timeout:180000});
 const normalizedRecord=await readJson(normalization);if(normalizedRecord.normalizedArchiveSha256!==await fileHash(normalized))throw Error('Normalized source archive changed');
 const source=join(root,'source');
 if(!await exists(source)){
  const helper=resolve(HERE,'../../src/runtime/safe-tar.py');if(!await exists(helper))throw Error('Safe archive helper is not ready; download is preserved');
  const args=[helper,'--archive',normalized,'--destination',source,'--max-bytes',String(2*1024**3),'--max-files','100000','--strip-components','1'];
  const result=execFileSync('python3',args,{env:safeEnv(),encoding:'utf8',maxBuffer:1024*1024});await atomicJson(join(root,'extraction.json'),JSON.parse(result));
 }
 const tools=join(root,'tools'),python=join(tools,'bin','python3');
 if(!await exists(python))execFileSync('python3',['-m','venv',tools],{env:safeEnv(),stdio:'ignore'});
 if(!await exists(join(tools,'bin','ninja'))||!await exists(join(tools,'bin','cmake'))){
  const wheels=join(root,'wheels');await mkdir(wheels,{recursive:true});
  execFileSync(python,['-m','pip','--isolated','download','--disable-pip-version-check','--index-url','https://pypi.org/simple','--no-deps','--dest',wheels,'ninja==1.13.0','cmake==3.31.6'],{env:safeEnv(),stdio:'ignore',timeout:180000});
  execFileSync(python,['-m','pip','--isolated','install','--disable-pip-version-check','--no-index','--find-links',wheels,'ninja==1.13.0','cmake==3.31.6'],{env:safeEnv(),stdio:'ignore',timeout:60000});
 }
 const pressure=join(tools,'pressure');
 if(platform()==='darwin'&&!await exists(pressure))execFileSync('swiftc',['-O',join(HERE,'pressure.swift'),'-o',pressure],{env:safeEnv(),stdio:'ignore',timeout:120000});
 const probe=join(root,'probe');await mkdir(probe,{recursive:true});if(!await exists(join(probe,'.git')))execFileSync('git',['init','-q',probe],{env:safeEnv(),stdio:'ignore'});
 const versions:Record<string,string>={};for(const [key,bin,args] of [['node',process.execPath,['--version']],['cmake',join(tools,'bin','cmake'),['--version']],['ninja',join(tools,'bin','ninja'),['--version']],['clang','clang++',['--version']],['python',python,['--version']]] as const)versions[key]=(await command(bin,[...args])).split('\n').slice(0,2).join('\n');
 const wheelHashes=[];for(const name of await readdir(join(root,'wheels')))wheelHashes.push({name,sha256:await fileHash(join(root,'wheels',name))});
 await atomicJson(join(root,'environment.json'),{platform:platform(),osRelease:release(),architecture:process.arch,logicalCpu:cpus().length,memoryBytes:totalmem(),versions,wheelHashes});
 console.log(JSON.stringify({prepared:true,sourceSha256:digest,sourceBytes:(await stat(archive)).size,normalizedSha256:normalizedRecord.normalizedArchiveSha256,omittedSymlinkFixtures:normalizedRecord.removed,source,tools}));
}
interface Context {run:string;stopFile:string;roots:Set<number>;requestStop:(reason:string)=>Promise<void>;isStopped:()=>boolean;stage:(name:string,argv:string[],cwd:string,timeoutMs:number)=>Promise<any>}
async function measured(root:string,id:string,work:(c:Context)=>Promise<any>){
 if(!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id))throw Error('Invalid run ID');
 const run=join(root,'runs',id);await mkdir(join(root,'runs'),{recursive:true});await mkdir(run,{mode:0o700});
 const lock=join(root,'pilot.lock'),handle=await open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,id}));await handle.close();
 const stopFile=join(run,'STOP'),roots=new Set<number>(),samples:(HostSample&Record<string,any>)[]=[],guard=new Guard();let stopping:string|undefined,done=false,pressure:'normal'|'warning'|'critical'|'unknown'='unknown';
 const pressureLog=await open(join(run,'pressure.jsonl'),'wx',0o600),sampleLog=await open(join(run,'host.jsonl'),'wx',0o600);
 const pressureProcess=platform()==='darwin'?spawn(join(root,'tools','pressure'),[],{env:safeEnv(),stdio:['ignore','pipe','ignore']}):undefined;
 let pressureBuffer='';pressureProcess?.on('error',()=>{pressure='unknown';});pressureProcess?.stdout?.on('data',(data:Buffer)=>{pressureBuffer+=data.toString();let cut;while((cut=pressureBuffer.indexOf('\n'))>=0){const line=pressureBuffer.slice(0,cut);pressureBuffer=pressureBuffer.slice(cut+1);try{const e=JSON.parse(line);if(['normal','warning','critical','unknown'].includes(e.pressure))pressure=e.pressure;void pressureLog.write(line+'\n').catch(()=>{});}catch{}}});
 const stop=async(reason:string)=>{if(!stopping){stopping=reason;try{await writeFile(stopFile,reason,{mode:0o600});}catch{for(const pid of roots)try{process.kill(pid,'SIGTERM');}catch{}}}};
 const signal=()=>{void stop('operator-signal');};process.on('SIGINT',signal);process.on('SIGTERM',signal);
 const sampler=createHostSampler(()=>[...roots],join(root,'probe'));
 let missingCritical=0;const monitor=(async()=>{try{while(!done){const s:HostSample&Record<string,any>=await sampler();if(platform()==='darwin')try{const level=Number((await command('/usr/sbin/sysctl',['-n','kern.memorystatus_vm_pressure_level'])).trim());pressure=level===1?'normal':level===2?'warning':level===4?'critical':'unknown';}catch{s.unavailable.push('pressure-current');}s.pressureState=pressure;s.pressureSource='macOS DispatchSource and current sysctl';
  if(platform()==='darwin')try{Object.assign(s,parseVm(await command('/usr/bin/vm_stat',[])));}catch{s.unavailable.push('vm-bytes');}
  try{const fs=await statfs(root);s.diskFreeBytes=fs.bavail*fs.bsize;}catch{s.unavailable.push('disk');}
  const missing=!Number.isFinite(s.diskFreeBytes)||(platform()==='darwin'&&(!Number.isFinite(s.swapOutBytes)||pressure==='unknown'));missingCritical=missing?missingCritical+1:0;if(missingCritical>=3)await stop('critical-metrics-unavailable');
  const decision=guard.observe({at:Date.parse(s.timestamp),pressure,nodeMs:s.nodeProbeMs,diskFree:s.diskFreeBytes,swapOutBytes:s.swapOutBytes});if(decision)await stop(decision);
  samples.push(s);await sampleLog.write(JSON.stringify(s)+'\n');if(!done)await sleep(1000);
 }}catch{await stop('host-monitor-failed');}})();
 const startedAt=Date.now();const stages:any[]=[];
 const stage:Context['stage']=async(name,argv,cwd,timeoutMs)=>{
  if(stopping)throw Error('Pilot resource guard stopped work');
  const spec=join(run,name+'.spec.json'),receipt=join(run,name+'.json');await atomicJson(spec,{argv,cwd,timeoutMs,stopFile,stdout:join(run,name+'.stdout.log'),stderr:join(run,name+'.stderr.log')});
  const child=spawn('python3',[join(HERE,'supervise.py'),spec,receipt],{env:safeEnv(),stdio:['ignore','ignore','ignore']});if(child.pid)roots.add(child.pid);
  const code=await new Promise<number|null>((ok,no)=>{child.once('error',no);child.once('close',ok);});if(child.pid)roots.delete(child.pid);
  const r=await readJson(receipt);r.name=name;stages.push(r);await atomicJson(join(run,'stages.json'),stages);if(code!==0||!r.passed)throw Error('Pilot stage failed: '+name);return r;
 };
 let outcome:any,status='FAILED';
 try{outcome=await work({run,stopFile,roots,requestStop:stop,isStopped:()=>!!stopping,stage});status=stopping?'STOPPED':'SUCCEEDED';}
 catch(error){if(stopping)status='STOPPED';outcome={error:error instanceof Error&&/^Pilot/.test(error.message)?error.message:'Pilot operation failed'};}
 finally{done=true;await monitor;if(pressureProcess&&pressureProcess.exitCode===null){const closed=new Promise<void>(ok=>pressureProcess.once('close',()=>ok()));pressureProcess.kill('SIGTERM');await closed;}await pressureLog.close();await sampleLog.close();process.off('SIGINT',signal);process.off('SIGTERM',signal);await unlink(lock);}
 const first=samples[0],last=samples.at(-1),summary={...summarizeHost(samples),pressureStates:[...new Set(samples.map(s=>s.pressureState))],swapOutDeltaBytes:first?.swapOutBytes!==undefined&&last?.swapOutBytes!==undefined?last.swapOutBytes-first.swapOutBytes:null,compressedDeltaBytes:first?.compressedBytes!==undefined&&last?.compressedBytes!==undefined?last.compressedBytes-first.compressedBytes:null,minDiskFreeBytes:samples.length?Math.min(...samples.map(s=>s.diskFreeBytes).filter(Number.isFinite)):null};
 const result={version:1,id,status,startedAt,finishedAt:Date.now(),stopReason:stopping,stages,host:summary,outcome};await atomicJson(join(run,'result.json'),result);console.log(JSON.stringify({id,status,seconds:(result.finishedAt-startedAt)/1000,stopReason:stopping}));if(status!=='SUCCEEDED')throw Error('Pilot did not complete');return result;
}
async function build(root:string,id:string,config:string,jobs:number){
 if(!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id))throw Error('Invalid run ID');const p=profile(config);if(!Number.isSafeInteger(jobs)||jobs<1||jobs>10)throw Error('Invalid compiler concurrency');
 const sdk=await selectMacSdk(process.env.DUCKDB_PILOT_OSX_SYSROOT);const source=join(root,'source'),build=join(root,'builds',id);await mkdir(build,{recursive:true});if((await readdir(build)).length)throw Error('Build directory must be empty');
 return measured(root,id,async c=>{
  const args=['-S',source,'-B',build,'-G','Ninja','-DCMAKE_MAKE_PROGRAM='+join(root,'tools','bin','ninja'),'-DCMAKE_BUILD_TYPE=Release','-DENABLE_SANITIZER=OFF','-DENABLE_UBSAN=OFF','-DBUILD_UNITTESTS=ON','-DBUILD_SHELL=ON','-DBUILD_EXTENSIONS=tpch','-DTREAT_WARNINGS_AS_ERRORS=OFF','-DDISABLE_UNITY='+(p.disableUnity?'ON':'OFF'),'-DFORCE_ASSERT='+(p.forceAssert?'ON':'OFF'),'-DCMAKE_C_COMPILER_LAUNCHER=','-DCMAKE_CXX_COMPILER_LAUNCHER=','-DOVERRIDE_GIT_DESCRIBE=v1.4.2-0-g68d7555f68','-DDUCKDB_EXPLICIT_VERSION=v1.4.2'];
  if(sdk)args.push('-DCMAKE_OSX_SYSROOT='+sdk.path);
  const environment=await readJson(join(root,'environment.json'));
  await atomicJson(join(c.run,'environment.json'),{...environment,requestedMacSdk:sdk??null});
  await atomicJson(join(c.run,'build-settings.json'),{sourceCommit:COMMIT,config,jobs,configure:args,requestedMacSdk:sdk??null});await c.stage('configure',[join(root,'tools','bin','cmake'),...args],source,120000);
  const cache=await readFile(join(build,'CMakeCache.txt'),'utf8'),cacheSdk=/^CMAKE_OSX_SYSROOT:[^=]+=([^\r\n]*)$/m.exec(cache)?.[1];
  const actualSdk=cacheSdk&&platform()==='darwin'?await selectMacSdk(cacheSdk):undefined;
  if(sdk&&actualSdk?.path!==sdk.path)throw Error('Pilot configured SDK differs from selected SDK');
  await atomicJson(join(c.run,'environment.json'),{...environment,requestedMacSdk:sdk??null,actualMacSdk:actualSdk?{...actualSdk,selection:sdk?'explicit':'cmake-resolved-default'}:null});
  await atomicJson(join(c.run,'build-settings.json'),{sourceCommit:COMMIT,config,jobs,configure:args,requestedMacSdk:sdk??null,actualMacSdk:actualSdk??null});
  await c.stage('build',[join(root,'tools','bin','cmake'),'--build',build,'--parallel',String(jobs)],source,3600000);
  await c.stage('test-inventory',['python3',join(HERE,'inventory.py'),join(build,'test','unittest'),'[projection]',source,join(c.run,'inventory-tmp')],source,30000);
  const list=(await readFile(join(c.run,'test-inventory.stdout.log'),'utf8')).trim();if(!list||/No test cases matched/i.test(list))throw Error('Pilot test inventory is empty');
  await c.stage('test',[join(build,'test','unittest'),'--test-dir',source,'--test-temp-dir',join(c.run,'test-tmp'),'[projection]'],source,600000);
  const testLog=await readFile(join(c.run,'test.stdout.log'),'utf8');if(!/All tests passed/.test(testLog))throw Error('Pilot test success evidence missing');
  const ninja=await readFile(join(build,'.ninja_log'),'utf8');const actions=ninja.split('\n').slice(1).flatMap(line=>{const a=line.split('\t');return a.length>=5?[{startMs:Number(a[0]),finishMs:Number(a[1]),output:a[3]}]:[];});await atomicJson(join(c.run,'ninja-actions.json'),actions);
  return {buildDirectory:build,config,jobs,actualMacSdk:actualSdk??null,testInventorySha256:createHash('sha256').update(list).digest('hex'),testInventoryLines:list.split('\n').length,ninjaActions:actions.length};
 });
}
async function buildBatch(root:string,id:string,configs:string[],concurrency:number,jobs:number){
 if(!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id))throw Error('Invalid run ID');
 const settings=validateBuildBatch(configs,concurrency,jobs),sdk=await selectMacSdk(process.env.DUCKDB_PILOT_OSX_SYSROOT);
 const source=join(root,'source'),batchRoot=join(root,'builds',id),environment=await readJson(join(root,'environment.json'));
 return measured(root,id,async c=>{
  await mkdir(join(root,'builds'),{recursive:true});
  await mkdir(batchRoot,{mode:0o700});
  await atomicJson(join(c.run,'batch-settings.json'),{sourceCommit:COMMIT,...settings,requestedMacSdk:sdk??null,purpose:'P0 capacity gate; not the main comparison'});
  await atomicJson(join(c.run,'environment.json'),{...environment,requestedMacSdk:sdk??null});
  const manifest=join(HERE,'projection-tests.txt');
  const expected=(await readFile(manifest,'utf8')).trim().split('\n');
  const records=await executeBatch(settings.profiles,concurrency,async p=>{
   const prefix=p.config.toLowerCase(),build=join(batchRoot,prefix);await mkdir(build,{mode:0o700});
   const args=['-S',source,'-B',build,'-G','Ninja','-DCMAKE_MAKE_PROGRAM='+join(root,'tools','bin','ninja'),'-DCMAKE_BUILD_TYPE=Release','-DENABLE_SANITIZER=OFF','-DENABLE_UBSAN=OFF','-DBUILD_UNITTESTS=ON','-DBUILD_SHELL=ON','-DBUILD_EXTENSIONS=tpch','-DTREAT_WARNINGS_AS_ERRORS=OFF','-DDISABLE_UNITY='+(p.disableUnity?'ON':'OFF'),'-DFORCE_ASSERT='+(p.forceAssert?'ON':'OFF'),'-DCMAKE_C_COMPILER_LAUNCHER=','-DCMAKE_CXX_COMPILER_LAUNCHER=','-DOVERRIDE_GIT_DESCRIBE=v1.4.2-0-g68d7555f68','-DDUCKDB_EXPLICIT_VERSION=v1.4.2'];
   if(process.env.DUCKDB_SKIP_JEMALLOC==='1')args.push('-DSKIP_EXTENSIONS=jemalloc');
   if(sdk)args.push('-DCMAKE_OSX_SYSROOT='+sdk.path);
   await atomicJson(join(c.run,prefix+'-build-settings.json'),{sourceCommit:COMMIT,config:p.config,jobs,configure:args,requestedMacSdk:sdk??null});
   await c.stage(prefix+'-configure',[join(root,'tools','bin','cmake'),...args],source,120000);
   const cache=await readFile(join(build,'CMakeCache.txt'),'utf8'),cacheSdk=/^CMAKE_OSX_SYSROOT:[^=]+=([^\r\n]*)$/m.exec(cache)?.[1];
   const actualSdk=cacheSdk&&platform()==='darwin'?await selectMacSdk(cacheSdk):undefined;
   if(sdk&&actualSdk?.path!==sdk.path)throw Error('Pilot configured SDK differs from selected SDK');
   await atomicJson(join(c.run,prefix+'-environment.json'),{...environment,requestedMacSdk:sdk??null,actualMacSdk:actualSdk??null});
   await c.stage(prefix+'-build',[join(root,'tools','bin','cmake'),'--build',build,'--parallel',String(jobs)],source,3600000);
   await c.stage(prefix+'-test-inventory',['python3',join(HERE,'inventory.py'),join(build,'test','unittest'),'[projection]',source,join(c.run,prefix+'-inventory-tmp')],source,30000);
   const list=(await readFile(join(c.run,prefix+'-test-inventory.stdout.log'),'utf8')).trim();if(!list||/No test cases matched/i.test(list))throw Error('Pilot test inventory is empty');
   if(JSON.stringify(list.split('\n').sort())!==JSON.stringify(expected))throw Error('Projection manifest differs');
   await c.stage(prefix+'-test',[join(build,'test','unittest'),'--test-dir',source,'--test-temp-dir',join(c.run,prefix+'-test-tmp'),'--input-file',manifest,'--order','lexical'],source,600000);
   if(!/All tests passed \(\d+ assertions in 16 test cases\)/.test(await readFile(join(c.run,prefix+'-test.stdout.log'),'utf8')))throw Error('Pilot test success evidence missing');
   const ninja=await readFile(join(build,'.ninja_log'),'utf8');const actions=ninja.split('\n').slice(1).flatMap(line=>{const a=line.split('\t');return a.length>=5?[{startMs:Number(a[0]),finishMs:Number(a[1]),output:a[3]}]:[];});await atomicJson(join(c.run,prefix+'-ninja-actions.json'),actions);
   return {buildDirectory:build,config:p.config,jobs,actualMacSdk:actualSdk??null,testInventorySha256:createHash('sha256').update(list).digest('hex'),testInventoryLines:list.split('\n').length,ninjaActions:actions.length};
  },reason=>c.requestStop(reason),records=>atomicJson(join(c.run,'batch-state.json'),{records}),c.isStopped);
  return {purpose:'P0 capacity gate',sourceCommit:COMMIT,concurrency,jobs,profiles:configs,records,passed:records.every(r=>r.status==='SUCCEEDED')};
 });
}
async function memory(root:string,id:string,buildId:string,sf:number,memoryGiB:number,threads:number,queryIds:number[],concurrency:number){
 if(!/^[a-z0-9][a-z0-9-]{0,80}$/.test(buildId))throw Error('Invalid build ID');validateMemoryOptions(sf,memoryGiB,threads);if(![1,2,4].includes(concurrency)||!queryIds.length||new Set(queryIds).size!==queryIds.length||queryIds.some(q=>!Number.isInteger(q)||q<1||q>22))throw Error('Invalid query batch');
 const binary=join(root,'builds',buildId,'duckdb'),data=join(root,'datasets');await mkdir(data,{recursive:true});const database=join(data,`sf${sf}.duckdb`);
 return measured(root,id,async c=>{
  await atomicJson(join(c.run,'memory-settings.json'),{sf,memoryGiB,threads,queryIds,concurrency,database});
  const completedPath=database+'.complete.json';
  if(await exists(database)!==await exists(completedPath))throw Error('Pilot dataset lacks matching completion metadata; preserve it for inspection');
  if(!await exists(database)){
   const partial=join(data,`sf${sf}.${id}.partial.duckdb`);if(await exists(partial))throw Error('Pilot partial dataset already exists');
   await c.stage('generate',[binary,partial,'-c',`SET threads=${threads}; SET memory_limit='${memoryGiB}GiB'; LOAD tpch; CALL dbgen(sf=${sf}); CHECKPOINT;`],data,3600000);
   if(await exists(partial+'.wal'))throw Error('Pilot dataset checkpoint is incomplete');
   const hashStartedAt=Date.now(),sha256=await fileHash(partial);await atomicJson(join(c.run,'dataset-generation-hash.json'),{startedAt:hashStartedAt,finishedAt:Date.now(),sha256});
   await rename(partial,database);await atomicJson(completedPath,{sf,sourceCommit:COMMIT,sha256,bytes:(await stat(database)).size,completedAt:Date.now()});
  }
  const hashBeforeStartedAt=Date.now(),inputSha256=await fileHash(database),completed=await readJson(completedPath);
  if(completed.sha256!==inputSha256||completed.sf!==sf||completed.sourceCommit!==COMMIT||completed.bytes!==(await stat(database)).size)throw Error('Pilot completed dataset changed');
  await atomicJson(join(c.run,'dataset.json'),{sf,bytes:completed.bytes,sha256:inputSha256,hashStartedAt:hashBeforeStartedAt,hashFinishedAt:Date.now()});
  let cursor=0;
  const outcomes=await Promise.allSettled(Array.from({length:concurrency},async()=>{while(cursor<queryIds.length){const q=queryIds[cursor++]!;const spill=join(c.run,'spill-'+q);await mkdir(spill);const profilePath=join(c.run,'query-'+q+'.profile.json');const escape=(s:string)=>s.replaceAll("'","''");
   const sql=`SET threads=${threads}; SET memory_limit='${memoryGiB}GiB'; SET temp_directory='${escape(spill)}'; SET max_temp_directory_size='4GiB'; LOAD tpch; PRAGMA enable_profiling='json'; SET profiling_output='${escape(profilePath)}'; PRAGMA tpch(${q});`;
   await c.stage('query-'+q,[binary,'-readonly',database,'-json','-c',sql],data,900000);
  }}));
  if(outcomes.some(x=>x.status==='rejected'))throw Error('Pilot query batch failed');
  const hashAfterStartedAt=Date.now(),afterSha256=await fileHash(database);await atomicJson(join(c.run,'dataset-after-hash.json'),{startedAt:hashAfterStartedAt,finishedAt:Date.now(),sha256:afterSha256});const unchanged=afterSha256===inputSha256;if(!unchanged)throw Error('Pilot input database changed');
  return {sf,memoryGiB,threads,queryIds,concurrency,datasetSha256:inputSha256,sourceUnchanged:true,quality:'SQL execution only; large-SF reference-result oracle still required before main experiment'};
 });
}
async function memoryBatch(root:string,id:string,buildId:string,sf:number,memoryGiB:number,threads:number,concurrency:number){
 if(!/^[a-z0-9][a-z0-9-]{0,80}$/.test(buildId))throw Error('Invalid build ID');
 const settings=validateMemoryBatch(sf,memoryGiB,threads,concurrency),source=join(root,'source'),binary=join(root,'builds',buildId,'duckdb'),database=join(root,'datasets',`sf${sf}.duckdb`);
 if(!await exists(database)||!await exists(database+'.complete.json'))throw Error('Pilot memory batch requires a completed dataset; generate it first');
 const completed=await readJson(database+'.complete.json');if(completed.sf!==sf||completed.sourceCommit!==COMMIT)throw Error('Pilot dataset identity differs');
 const normalization=await readJson(join(root,'normalization.json'));if(normalization.commit!==COMMIT||!Array.isArray(normalization.files))throw Error('Pilot source normalization metadata is invalid');
 const querySources:Record<string,{sql:string;sha256:string}>={};
 for(let q=1;q<=22;q++){
  const relative=`extension/tpch/dbgen/queries/q${String(q).padStart(2,'0')}.sql`,entries=normalization.files.filter((x:any)=>x.path===relative);if(entries.length!==1)throw Error('Pilot query source metadata missing');
  const sql=await readFile(join(source,relative),'utf8'),sha256=createHash('sha256').update(sql).digest('hex');if(entries[0].sha256!==sha256)throw Error('Pilot query source changed');querySources[String(q)]={sql,sha256};
 }
 return measured(root,id,async c=>{
  const before=Date.now(),datasetSha256=await fileHash(database);if(datasetSha256!==completed.sha256||(await stat(database)).size!==completed.bytes)throw Error('Pilot completed dataset changed');
  await atomicJson(join(c.run,'dataset-before-hash.json'),{startedAt:before,finishedAt:Date.now(),sha256:datasetSha256,bytes:completed.bytes});
  const binarySha256=await fileHash(binary),querySourceSha256=Object.fromEntries(Object.entries(querySources).map(([q,v])=>[q,v.sha256]));
  await atomicJson(join(c.run,'memory-batch-settings.json'),{sourceCommit:COMMIT,buildId,binarySha256,datasetSha256,datasetBytes:completed.bytes,...settings,querySourceSha256,purpose:'P0 capacity gate; crosscheck against the same batch at concurrency 1'});
  const tasks=settings.shards.map((queries,index)=>({index,queries}));
  const records=await executeBatch(tasks,concurrency,async task=>{
   const prefix=`shard-${task.index}`,spill=join(c.run,prefix+'-spill');await mkdir(spill,{mode:0o700});
   const queries=task.queries.map(q=>({id:q,sql:querySources[String(q)]!.sql,resultPath:join(c.run,`query-${String(q).padStart(2,'0')}.json`),schemaPath:join(c.run,`query-${String(q).padStart(2,'0')}.schema.json`),profilePath:join(c.run,`query-${String(q).padStart(2,'0')}.profile.json`)}));
   const script=join(c.run,prefix+'.sql');await writeFile(script,shardScript(queries,memoryGiB,threads,spill),{mode:0o600,flag:'wx'});
   // One persistent read-only database connection executes all queries in this shard.
   await c.stage(prefix,[binary,'-bail','-readonly','-init',script,database],join(root,'datasets'),900000);
   // The same Python policy is used by compare-memory.py, including proven zero-row CLI outputs.
   const validation=JSON.parse(await command('python3',[join(HERE,'query_output.py'),'--run',c.run,'--queries',task.queries.join(',')]));
   const outputs=validation.outputs;
   if(!Array.isArray(outputs)||outputs.length!==task.queries.length||outputs.some((x:any,i:number)=>x.query!==task.queries[i]))throw Error('Pilot query output validation failed');
   for(const output of outputs)if(output.normalization)await atomicJson(join(c.run,`query-${String(output.query).padStart(2,'0')}.normalization.json`),output.normalization);
   await atomicJson(join(c.run,prefix+'-outputs.json'),outputs);return {queries:task.queries,outputs};
  },reason=>c.requestStop(reason),records=>atomicJson(join(c.run,'memory-batch-state.json'),{records}),c.isStopped);
  if(c.isStopped()||records.some(r=>r.status!=='SUCCEEDED'))return {purpose:'P0 memory capacity gate',sf,memoryGiB,threads,concurrency,queryCount:22,shards:settings.shards,records,datasetSha256,sourceUnchanged:null,passed:false,quality:'Partial execution; after-hash and equivalence are not verified'};
  const after=Date.now(),afterSha256=await fileHash(database);await atomicJson(join(c.run,'dataset-after-hash.json'),{startedAt:after,finishedAt:Date.now(),sha256:afterSha256});
  if(afterSha256!==datasetSha256)throw Error('Pilot input database changed');
  return {purpose:'P0 memory capacity gate',sf,memoryGiB,threads,concurrency,queryCount:22,shards:settings.shards,records,datasetSha256,sourceUnchanged:true,passed:records.every(r=>r.status==='SUCCEEDED'),quality:'SQL execution and schema captured; compare-memory.py is required for baseline result equivalence'};
 });
}
export async function main(args:string[]){
 const [mode,directory,...rest]=args;if(!directory)throw Error('Usage: pilot.ts prepare ROOT | baseline ROOT ID SECONDS | build ROOT ID C1..C4 JOBS | build-batch ROOT ID C1,C2,.. CONCURRENCY JOBS | memory ROOT ID BUILD_ID SF MEM_GIB THREADS QUERY_IDS CONCURRENCY | memory-batch ROOT ID BUILD_ID SF MEM_GIB THREADS CONCURRENCY');const root=resolve(directory);
 if(mode==='prepare')return prepare(root);
 if(!await exists(join(root,'environment.json')))throw Error('Run prepare first');
 if(mode==='baseline'){const [id='baseline',seconds='600']=rest;const duration=Number(seconds);if(!Number.isInteger(duration)||duration<1||duration>600)throw Error('Invalid baseline duration');return measured(root,id,async c=>{const until=Date.now()+duration*1000;while(Date.now()<until){if(await exists(c.stopFile))throw Error('Pilot resource guard stopped baseline');await sleep(500);}return {durationSeconds:duration};});}
 if(mode==='build')return build(root,rest[0]!,rest[1]!,Number(rest[2]));
 if(mode==='build-batch'){if(rest.length!==4)throw Error('Invalid build batch arguments');return buildBatch(root,rest[0]!,rest[1]!.split(','),Number(rest[2]),Number(rest[3]));}
 if(mode==='memory-batch'){if(rest.length!==6)throw Error('Invalid memory batch arguments');return memoryBatch(root,rest[0]!,rest[1]!,Number(rest[2]),Number(rest[3]),Number(rest[4]),Number(rest[5]));}
 if(mode==='memory')return memory(root,rest[0]!,rest[1]!,Number(rest[2]),Number(rest[3]),Number(rest[4]),rest[5]!.split(',').map(Number),Number(rest[6]));
 throw Error('Unknown pilot command');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).catch(e=>{console.error(e instanceof Error?e.message:'Pilot failed');process.exitCode=1;});
