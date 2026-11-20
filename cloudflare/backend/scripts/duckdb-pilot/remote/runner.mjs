import {packNinja} from './build-evidence.mjs';
import {parseCacheStats} from './cache-stats.ts';
import {parseToolchainEvidence} from './toolchain.ts';
import {classifyBoundaryError} from './probe-policy.ts';
import {readFile,writeFile,mkdir,mkdtemp,readdir,lstat,stat,rm,open,statfs} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const config=JSON.parse(await readFile(new URL('./runner-config.json',import.meta.url),'utf8'));
const profile=process.argv[2]??'C1';
const profiles={C1:[false,false],C2:[false,true],C3:[true,false],C4:[true,true]};
if(!Object.hasOwn(profiles,profile))throw Error('Unknown build profile');
const [disableUnity,forceAssert]=profiles[profile];
const COMMIT='68d7555f68bd25c1a251ccca2e6338949c33986a';
const children=new Set();
const kill=pid=>{if(pid)try{process.kill(-pid,'SIGKILL')}catch{}};
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.once(signal,()=>{for(const pid of children)kill(pid);process.exit(143)});
process.once('exit',()=>{for(const pid of children)kill(pid)});
const digest=text=>createHash('sha256').update(text).digest('hex');
async function fileHash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex')}
function safeError(error){const code=String(error?.code??'');return ['EACCES','EPERM','EROFS','ENOENT','ENOSPC','ENOMEM','ETIMEDOUT'].includes(code)?code:'UNCLASSIFIED';}
async function treeHash(root){const records=[];async function visit(dir,prefix=''){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const relative=prefix+entry.name,path=join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Source symlink rejected');if(entry.isDirectory())await visit(path,relative+'/');else if(entry.isFile()){const s=await stat(path);records.push({path:relative,sha256:await fileHash(path),bytes:s.size,executable:!!(s.mode&0o111)});}else throw Error('Source special file rejected');}}await visit(root);return {sha256:digest(JSON.stringify(records)),files:records.length,bytes:records.reduce((n,r)=>n+r.bytes,0)}}
const sourceRoot=process.env.HIVEMIND_ARTIFACT_SOURCE;
if(!sourceRoot||config.commit!==COMMIT||!['boundary','build'].includes(config.phase))throw Error('Invalid runner configuration');
const cacheEnabled=config.ccache===true,cacheMode=process.argv[3],cacheDirectory=process.env.HIVEMIND_CCACHE_DIR;
if(cacheEnabled&&(config.phase!=='build'||config.jemallocOff!==true||!['C3','C4'].includes(profile)||
 !['seed','cold','warm'].includes(cacheMode)||!cacheDirectory?.startsWith('/')))throw Error('Invalid cache runner configuration');
if(!cacheEnabled&&cacheMode!==undefined)throw Error('Unexpected cache runner argument');
const source=join(sourceRoot,'duckdb-'+COMMIT);
const scratch=cacheEnabled?'/tmp/hivemind-duckdb-ccache':await mkdtemp(join(tmpdir(),'hivemind-duckdb-'));
if(cacheEnabled)await mkdir(scratch,{mode:0o700});
const cacheEnv=cacheEnabled?{
 CCACHE_DIR:cacheDirectory,
 CCACHE_CONFIGPATH:join(scratch,'ccache.conf'),
 CCACHE_TEMPDIR:join(scratch,'ccache-tmp'),
 CCACHE_COMPILERCHECK:'content',
 CCACHE_MAXSIZE:'5G',
}:{};
const phases=[];const startedAt=Date.now();
let probeStep;
async function denied(name,operation,kind='mutation'){try{await operation();return {name,blocked:false,classification:'unexpected-access'}}catch(error){return {name,...classifyBoundaryError(kind,error?.code)}}}
async function boundary(){
 probeStep='read-source-marker';
 const marker=join(source,'CMakeLists.txt');const before=await fileHash(marker);
 probeStep='check-source-and-private-paths';
 const checks=[await denied('source-write',()=>writeFile(marker,'unexpected-write')),await denied('source-delete',()=>rm(marker)),await denied('runtime-input-read',()=>readFile('/runtime/input.json'),'private-read'),await denied('proc-root-runtime-input-read',()=>readFile('/proc/self/root/runtime/input.json'),'private-read')];
 const data=process.env.HIVEMIND_ARTIFACT_DATA;
 let dataReceipt;
 probeStep='check-data-access-and-integrity';
 if(data){const before=await fileHash(data),beforeBytes=(await stat(data)).size;checks.push(await denied('data-write',()=>writeFile(data,'unexpected-write')),await denied('data-delete',()=>rm(data)));let postconditionError;const after=await fileHash(data).catch(error=>{postconditionError=safeError(error);return null});const afterBytes=await stat(data).then(s=>s.size,error=>{postconditionError=safeError(error);return null});dataReceipt={sha256:before,bytes:beforeBytes,afterSha256:after,afterBytes,unchanged:after===before&&afterBytes===beforeBytes,...(postconditionError?{postconditionError}:{})};}
 const forbidden=['CONTROL_TOKEN','AUTH_STORAGE_KEY','AUTH_RETURN_PRIVATE_KEY','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','GEMINI_API_KEY','GOOGLE_API_KEY','CLOUDFLARE_API_TOKEN','CF_API_TOKEN'];
 const credentialsAbsent=forbidden.every(key=>!process.env[key])&&!Object.keys(process.env).some(key=>/TOKEN|SECRET|API_KEY|AUTHORIZATION/i.test(key))&&!Object.values(process.env).some(v=>/^hma_[a-f0-9]{64}$/.test(v??''));
 probeStep='check-scratch';
 const writable=join(scratch,'write-ok');await writeFile(writable,'ok');const scratchWritable=await readFile(writable,'utf8')==='ok';
 const unchanged=await fileHash(marker).catch(()=>null)===before;probeStep='hash-source-tree';const tree=await treeHash(source);probeStep=undefined;
 return {checks,credentialsAbsent,scratchWritable,sourceUnchanged:unchanged,sourceTree:tree,data:dataReceipt,passed:checks.every(c=>c.blocked)&&credentialsAbsent&&scratchWritable&&unchanged&&(!dataReceipt||dataReceipt.unchanged)&&tree.files===14010};
}
function errors(text){const patterns=[[/permission denied|EACCES|read.only file system|EROFS/i,'filesystem-denied'],[/no space left|ENOSPC/i,'disk-full'],[/out of memory|cannot allocate|killed/i,'memory-or-kill'],[/CMake Error/i,'cmake-error'],[/fatal error:|error:/i,'compiler-or-tool-error'],[/No test cases matched/i,'empty-test-inventory'],[/failed|FAILED/i,'tool-failed']];return patterns.filter(([p])=>p.test(text)).map(([,name])=>name);}
async function stage(name,argv,cwd,limitMs=3600000){
 const outPath=join(scratch,name+'.stdout.log'),errPath=join(scratch,name+'.stderr.log'),out=await open(outPath,'wx',0o600),err=await open(errPath,'wx',0o600);const start=Date.now();let timedOut=false,diskStopped=false,logStopped=false;
 const env={PATH:process.env.PATH,HOME:join(scratch,'home'),TMPDIR:scratch,LANG:'C.UTF-8',CI:'1',SSL_CERT_FILE:process.env.SSL_CERT_FILE,NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,...cacheEnv};await mkdir(env.HOME,{recursive:true});
 const record=await new Promise((ok,no)=>{const child=spawn(argv[0],argv.slice(1),{cwd,env,detached:true,stdio:['ignore',out.fd,err.fd]});if(child.pid)children.add(child.pid);const timer=setTimeout(()=>{timedOut=true;kill(child.pid)},limitMs);const disk=setInterval(()=>{void statfs(scratch).then(s=>{if(Number(s.bavail)*Number(s.bsize)<3*1024**3){diskStopped=true;kill(child.pid)}}).catch(()=>{});void Promise.all([stat(outPath),stat(errPath)]).then(values=>{if(values.some(s=>s.size>128*1024**2)){logStopped=true;kill(child.pid)}}).catch(()=>{})},1000);child.once('error',()=>{clearTimeout(timer);clearInterval(disk);children.delete(child.pid);ok({name,startedAt:start,finishedAt:Date.now(),exitCode:null,signal:null,timedOut,diskStopped,logStopped,spawnFailed:true})});child.once('close',(exitCode,signal)=>{clearTimeout(timer);clearInterval(disk);kill(child.pid);children.delete(child.pid);ok({name,startedAt:start,finishedAt:Date.now(),exitCode,signal,timedOut,diskStopped,logStopped})});});
 await out.close();await err.close();
 const tail=async p=>{const h=await open(p,'r');try{const size=(await h.stat()).size,b=Buffer.alloc(Math.min(size,4096));await h.read(b,0,b.length,Math.max(0,size-b.length));return b.toString()}finally{await h.close()}};
 Object.assign(record,{durationMs:record.finishedAt-record.startedAt,stdoutSha256:await fileHash(outPath),stderrSha256:await fileHash(errPath),stdoutBytes:(await stat(outPath)).size,stderrBytes:(await stat(errPath)).size,errorCodes:errors(await tail(outPath)+'\n'+await tail(errPath))});phases.push(record);
 if(record.exitCode!==0||record.signal||timedOut||diskStopped||logStopped)throw Error('Phase failed: '+name);return {outPath,errPath};
}
let receipt={version:1,kind:config.phase,commit:COMMIT,profile,phases,startedAt,passed:false};
try{
 const boundaries=await boundary();receipt.boundaries=boundaries;if(!boundaries.passed)throw Error('Boundary probe failed');
 if(config.phase==='build'){
  const build=join(scratch,'build');
  const controlled=config.jemallocOff===true;
  let cmake='cmake',ninjaBin='ninja',ccache='';
  if(controlled){
   const tools=join(scratch,'tools');
   await stage('prepare-tools',['python3',resolve('install-build-tools.py'),process.env.HIVEMIND_ARTIFACT_DATA,tools,...(cacheEnabled?['ccache']:[])],scratch,120000);
   cmake=join(tools,'cmake/data/bin/cmake');
   ninjaBin=join(tools,'bin/ninja');
   if(cacheEnabled)ccache=join(tools,'bin/ccache');
  }
  if(cacheEnabled){
   probeStep='ccache-input';
   if(!(await lstat(cacheDirectory)).isDirectory()||((await readdir(cacheDirectory)).length>0)!==(cacheMode==='warm'))throw Error('Cache directory does not match condition');
   await writeFile(cacheEnv.CCACHE_CONFIGPATH,'',{flag:'wx',mode:0o600});
   const version=await stage('ccache-version',[ccache,'--print-version'],scratch,10000);
   if((await readFile(version.outPath,'utf8')).trim()!=='4.14.3')throw Error('Unexpected ccache version');
   probeStep=undefined;
  }
  const opts=['-S',source,'-B',build,'-G','Ninja','-DCMAKE_C_COMPILER=/usr/bin/clang','-DCMAKE_CXX_COMPILER=/usr/bin/clang++','-DCMAKE_BUILD_TYPE=Release','-DENABLE_SANITIZER=OFF','-DENABLE_UBSAN=OFF','-DBUILD_UNITTESTS=ON','-DBUILD_SHELL=ON','-DBUILD_EXTENSIONS=tpch','-DTREAT_WARNINGS_AS_ERRORS=OFF','-DDISABLE_UNITY='+(disableUnity?'ON':'OFF'),'-DFORCE_ASSERT='+(forceAssert?'ON':'OFF'),'-DCMAKE_C_COMPILER_LAUNCHER='+ccache,'-DCMAKE_CXX_COMPILER_LAUNCHER='+ccache,'-DOVERRIDE_GIT_DESCRIBE=v1.4.2-0-g68d7555f68','-DDUCKDB_EXPLICIT_VERSION=v1.4.2'];
  if(controlled)opts.push('-DSKIP_EXTENSIONS=jemalloc','-DCMAKE_MAKE_PROGRAM='+ninjaBin);
  const cmakeVersionLog=await stage('cmake-version',[cmake,'--version'],scratch,10000),ninjaVersionLog=await stage('ninja-version',[ninjaBin,'--version'],scratch,10000);
  await stage('configure',[cmake,...opts],source,120000);
  const bounded=async(path,max=262144)=>{if((await stat(path)).size>max)throw Error('Toolchain metadata too large');return readFile(path,'utf8')};
  const versionDirs=(await readdir(join(build,'CMakeFiles'),{withFileTypes:true})).filter(d=>d.isDirectory()&&/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.]{1,32})?$/.test(d.name));
  if(versionDirs.length!==1)throw Error('Compiler metadata directory ambiguous');
  const compilerPath=join(build,'CMakeFiles',versionDirs[0].name,'CMakeCXXCompiler.cmake'),cachePath=join(build,'CMakeCache.txt');
  probeStep='toolchain-evidence';
  receipt.toolchain={...parseToolchainEvidence({compiler:await bounded(compilerPath),cache:await bounded(cachePath),cmake:await bounded(cmakeVersionLog.outPath,4096),ninja:await bounded(ninjaVersionLog.outPath,4096),platform:process.platform,arch:process.arch}),compilerConfigSha256:await fileHash(compilerPath),cmakeCacheSha256:await fileHash(cachePath)};
  if(receipt.toolchain.compiler.id!=='Clang'||receipt.toolchain.compiler.path!=='/usr/bin/clang++')throw Error('Requested Clang compiler was not selected');
  probeStep=undefined;
  const cpuPath=join(scratch,'build-cpu.json');
  const buildCommand=[cmake,'--build',build,'--parallel','4'];
  if(cacheEnabled)await stage('ccache-zero-stats',[ccache,'--zero-stats'],scratch,10000);
  await stage('build',controlled?['python3',resolve('build-cpu.py'),cpuPath,...buildCommand]:buildCommand,source);
  if(cacheEnabled){
   const {outPath}=await stage('ccache-stats',[ccache,'--format=json','--print-stats'],scratch,10000);
   receipt.cacheStats=parseCacheStats(await bounded(outPath,16384));
  }
  if(controlled)receipt.buildCpu=JSON.parse(await readFile(cpuPath,'utf8'));
  if(controlled)receipt.ninja=packNinja(await readFile(join(build,'.ninja_log'),'utf8'));
  const binary=join(build,'test','unittest'),inventory=await stage('inventory',['python3',resolve('inventory.py'),binary,'[projection]',source,join(scratch,'inventory-tmp')],scratch,30000);
  const names=(await readFile(inventory.outPath,'utf8')).trim().split('\n');if(!names.length||names.some(n=>!n.trim()))throw Error('Inventory missing');
  const manifest=resolve('projection-tests.txt');
  const expected=(await readFile(manifest,'utf8')).trim().split('\n');
  receipt.test={inventoryNames:names,inventorySha256:digest(names.join('\n')),inventoryCount:names.length,passed:false};
  if(JSON.stringify([...names].sort())!==JSON.stringify(expected))throw Error('Projection manifest differs');
  const tested=await stage('projection',[binary,'--test-dir',source,'--test-temp-dir',join(scratch,'projection-tmp'),'--input-file',manifest,'--order','lexical'],scratch,600000);
  const testLog=await readFile(tested.outPath,'utf8');if(!/All tests passed \(\d+ assertions in 16 test cases\)/.test(testLog))throw Error('Test pass marker missing');
  receipt.test={...receipt.test,passed:true,manifestSha256:await fileHash(manifest)};
  const ninja=(await readFile(join(build,'.ninja_log'),'utf8')).split('\n').slice(1).map(l=>l.split('\t')).filter(x=>x.length>=5);
  if(!controlled)receipt.ninja={actions:ninja.length,sumActionMs:ninja.reduce((n,x)=>n+Number(x[1])-Number(x[0]),0)};
  const data=process.env.HIVEMIND_ARTIFACT_DATA;
  if(data&&!controlled){const q=await stage('query9',[join(build,'duckdb'),'-readonly',data,'-json','-c',`SET threads=4; SET memory_limit='6GiB'; SET temp_directory='${scratch}/spill'; SET max_temp_directory_size='4GiB'; LOAD tpch; PRAGMA tpch(9);`],scratch,900000);const raw=await readFile(q.outPath,'utf8'),rows=JSON.parse(raw);if(!Array.isArray(rows)||!rows.length)throw Error('Query result missing');const columns=Object.keys(rows[0]),compact={columns,rows:rows.map(row=>columns.map(c=>row[c]))};const json=JSON.stringify(compact);if(Buffer.byteLength(json)>9000)throw Error('Query result exceeds receipt limit');receipt.query9={...compact,sha256:digest(json),stdoutSha256:digest(raw),dataSha256:await fileHash(data)};if(receipt.query9.dataSha256!==boundaries.data.sha256)throw Error('Readonly data changed');}
 }
 receipt.passed=true;
}catch(error){receipt??={version:1,kind:config.phase,commit:COMMIT,startedAt,phases,passed:false};receipt.error=String(error?.message??'Runner failed').startsWith('Phase failed: ')?error.message:'Probe or validation failed';if(probeStep)receipt.probeFailure={step:probeStep,code:safeError(error)};process.exitCode=1;
}finally{
 receipt.finishedAt=Date.now();
 const data=receipt.ninja?.data;
 if(data){
  const prefix='NINJA_EVIDENCE_V1 ';
  receipt.ninja.data='';
  const channelLimit=cacheEnabled?47_800:15_800;
  const available=channelLimit-Buffer.byteLength(JSON.stringify(receipt));
  if(available<0||data.length>available+channelLimit-prefix.length){
   receipt.passed=false;receipt.error='Ninja evidence exceeds capture limits';process.exitCode=1;
  }else{
   receipt.ninja.data=data.slice(0,available);
   const remainder=data.slice(available);
   if(remainder)console.error(prefix+remainder);
  }
 }
 console.log(JSON.stringify(receipt));
 await rm(scratch,{recursive:true,force:true});
}
