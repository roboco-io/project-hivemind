import {mkdir,readFile,writeFile,rm,realpath,readlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {providerArgs,buildEnv} from '../../backend/src/runtime/providers.ts';
import {runBounded} from './run-bounded.ts';

const paths={home:'/home/node',privateDir:'/home/node/.hivemind-phase0',workspace:'/workspace',scriptRoot:'/opt/hivemind/scripts/phase0'};
const receipt='/workspace/phase0-codex-boundary-result.json';
const checks=['workspaceWrite','outsideWriteDenied','outsideSentinelUnchanged','privateAuthReadDenied','privateMetadataReadDenied','runtimeInputReadDenied','procReadDenied','parentEnvironmentDenied','parentCommandLineDenied','parentStatusDenied','parentRootAuthReadDenied','parentRootMetadataReadDenied','parentRootRuntimeReadDenied','parentMemoryDenied','selectedCredentialsAbsent','managementCredentialsAbsent'];
const capabilityNames=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'];
const capabilitiesZero=(value:unknown):boolean=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const caps=value as Record<string,unknown>;
 return Object.keys(caps).length===capabilityNames.length&&capabilityNames.every(key=>typeof caps[key]==='string'&&/^0+$/.test(caps[key]));
};
export function assessCodexBoundary(result:Record<string,unknown>) {
 return {passed:result.uid===1000&&result.toolUid===1000&&result.noNewPrivileges==='1'&&capabilitiesZero(result.capabilities)&&result.exitCode===0&&result.timedOut===false&&result.captureLimit===false&&checks.every(key=>result[key]===true),checks:[...checks]};
}

const script=(outerPid:number)=>`
const fs=require('node:fs');
const outerPid=${outerPid};
const readCheck=(path,emptyIsNoInfo=true)=>{try{const bytes=fs.readFileSync(path).length;return {denied:emptyIsNoInfo&&bytes===0,bytes}}catch(error){return {denied:['EACCES','EPERM','ENOENT'].includes(error.code),bytes:null,error:typeof error.code==='string'?error.code:'UNKNOWN'}}};
const privateReads={auth:readCheck('/home/node/.codex/auth.json',false),metadata:readCheck('/home/node/.hivemind-phase0/codex-boundary-private.txt',false),runtime:readCheck('/runtime/codex-boundary-input.json',false)};
const procReads={selfStatus:readCheck('/proc/self/status',false),
parentEnvironment:readCheck('/proc/'+outerPid+'/environ'),parentCommandLine:readCheck('/proc/'+outerPid+'/cmdline'),parentStatus:readCheck('/proc/'+outerPid+'/status'),
parentRootAuth:readCheck('/proc/'+outerPid+'/root/home/node/.codex/auth.json'),parentRootMetadata:readCheck('/proc/'+outerPid+'/root/home/node/.hivemind-phase0/codex-boundary-private.txt'),parentRootRuntime:readCheck('/proc/'+outerPid+'/root/runtime/codex-boundary-input.json'),parentMemory:readCheck('/proc/'+outerPid+'/mem')};
const inside='/workspace/phase0-codex-boundary-inside.txt';
fs.writeFileSync(inside,'inside');
const outsideWrite=(()=>{try{fs.writeFileSync('/home/node/phase0-codex-boundary-outside.txt','escaped');return {denied:false,error:null}}catch(error){return {denied:['EACCES','EPERM','ENOENT','EROFS'].includes(error.code),error:typeof error.code==='string'?error.code:'UNKNOWN'}}})();
const result={toolUid:process.getuid(),workspaceWrite:fs.readFileSync(inside,'utf8')==='inside',
outsideWriteDenied:outsideWrite.denied,
privateAuthReadDenied:privateReads.auth.denied,
privateMetadataReadDenied:privateReads.metadata.denied,
runtimeInputReadDenied:privateReads.runtime.denied,
procReadDenied:procReads.selfStatus.denied,
parentEnvironmentDenied:procReads.parentEnvironment.denied,parentCommandLineDenied:procReads.parentCommandLine.denied,parentStatusDenied:procReads.parentStatus.denied,
parentRootAuthReadDenied:procReads.parentRootAuth.denied,parentRootMetadataReadDenied:procReads.parentRootMetadata.denied,parentRootRuntimeReadDenied:procReads.parentRootRuntime.denied,parentMemoryDenied:procReads.parentMemory.denied,
selectedCredentialsAbsent:Object.keys(process.env).every(key=>!(/^(OPENAI_|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CODEX_(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN)$)/.test(key)&&process.env[key])),
managementCredentialsAbsent:Object.keys(process.env).every(key=>!(/^(CLOUDFLARE_|CF_API_|AWS_|PROBE_TOKEN$|AUTH_WRAP_KEY$|HIVEMIND_FIXTURE_TOKEN$)/.test(key)&&process.env[key]))};
const receipt=${JSON.stringify(receipt)};
const writeDiagnostic=(fd,label)=>{try{return {bytes:fs.writeSync(fd,label+String.fromCharCode(10))}}catch(error){return {bytes:0,error:typeof error.code==='string'?error.code:'UNKNOWN'}}};
const stdio={stdout:writeDiagnostic(1,'HIVEMIND_CODEX_STDOUT_CONTROL'),stderr:writeDiagnostic(2,'HIVEMIND_CODEX_STDERR_CONTROL')};
const childPidNamespace=(()=>{try{return {inode:fs.readlinkSync('/proc/self/ns/pid')}}catch(error){return {inode:null,error:typeof error.code==='string'?error.code:'UNKNOWN'}}})();
const encoded=JSON.stringify({...result,outsideWrite,procReads,privateReads,childCwd:process.cwd(),childPid:process.pid,childParentPid:process.ppid,childPidNamespace,stdio});
fs.writeFileSync(receipt,encoded,{flag:'r+',mode:0o600});
console.log('HIVEMIND_CODEX_BOUNDARY_RESULT '+encoded);
if(!Object.entries(result).every(([key,value])=>key==='toolUid'?value===1000:value===true))process.exitCode=31;
`;

export function codexBoundaryArgs(outerPid=process.pid,profile:'hivemind'|':workspace'='hivemind'):string[] {
 if(!Number.isSafeInteger(outerPid)||outerPid<1)throw new Error('Invalid outer process identity');
 if(profile!=='hivemind'&&profile!==':workspace')throw new Error('Invalid diagnostic profile');
 const production=providerArgs('codex','unused',paths);
 const configs=production.flatMap((arg,index)=>arg==='-c'?[arg,production[index+1]!]:[]);
 return ['sandbox',...configs,'-P',profile,'--','node','-e',script(outerPid)];
}

export function parseCodexBoundaryObservation(stdout:string,workspaceReceipt:string) {
 const lines=stdout.split(/\r?\n/).filter(line=>line.startsWith('HIVEMIND_CODEX_BOUNDARY_RESULT '));
 const observationSource=lines.length===1?'stdout':lines.length===0&&workspaceReceipt?'workspace-receipt':'none';
 const raw=observationSource==='stdout'?lines[0]!.slice('HIVEMIND_CODEX_BOUNDARY_RESULT '.length):workspaceReceipt;
 const observed:Record<string,unknown>={};
 if(observationSource==='none'||raw.length>128000)return {observationSource:'none' as const,observed};
 try {
  const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid observation');
  const record=value as Record<string,unknown>;
  if(Number.isSafeInteger(record.toolUid))observed.toolUid=record.toolUid;
  if(typeof record.childCwd==='string'&&record.childCwd.startsWith('/')&&record.childCwd.length<1000)observed.childCwd=record.childCwd;
  for(const key of ['childPid','childParentPid'])if(Number.isSafeInteger(record[key])&&Number(record[key])>=0)observed[key]=record[key];
  if(record.childPidNamespace&&typeof record.childPidNamespace==='object'){
   const namespace=record.childPidNamespace as Record<string,unknown>;
   observed.childPidNamespace={inode:typeof namespace.inode==='string'&&/^pid:\[\d+\]$/.test(namespace.inode)?namespace.inode:null,...(typeof namespace.error==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(namespace.error)?{error:namespace.error}:{})};
  }
  for(const key of checks)if(typeof record[key]==='boolean')observed[key]=record[key];
  if(record.outsideWrite&&typeof record.outsideWrite==='object'&&!Array.isArray(record.outsideWrite)){
   const write=record.outsideWrite as Record<string,unknown>;
   if(typeof write.denied==='boolean')observed.outsideWrite={denied:write.denied,error:typeof write.error==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(write.error)?write.error:null};
  }
  const labels=['auth','metadata','runtime','selfStatus','parentEnvironment','parentCommandLine','parentStatus','parentRootAuth','parentRootMetadata','parentRootRuntime','parentMemory'];
  for(const group of ['procReads','privateReads']){
   const reads=record[group];if(!reads||typeof reads!=='object'||Array.isArray(reads))continue;
   const measurements:Record<string,unknown>={};
   for(const label of labels){
    const reading=(reads as Record<string,unknown>)[label];if(!reading||typeof reading!=='object'||Array.isArray(reading))continue;
    const item=reading as Record<string,unknown>;if(typeof item.denied!=='boolean'||!(item.bytes===null||Number.isSafeInteger(item.bytes)&&Number(item.bytes)>=0))continue;
    measurements[label]={denied:item.denied,bytes:item.bytes,...(typeof item.error==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(item.error)?{error:item.error}:{})};
   }
   observed[group]=measurements;
  }
  if(record.stdio&&typeof record.stdio==='object'&&!Array.isArray(record.stdio)){
   const stdio:Record<string,unknown>={};
   for(const label of ['stdout','stderr']){
    const raw=(record.stdio as Record<string,unknown>)[label];if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    const item=raw as Record<string,unknown>;if(!Number.isSafeInteger(item.bytes)||Number(item.bytes)<0)continue;
    stdio[label]={bytes:item.bytes,...(typeof item.error==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(item.error)?{error:item.error}:{})};
   }
   observed.stdio=stdio;
  }
  return {observationSource,observed};
 }catch{return {observationSource:'none' as const,observed:{}};}
}

export async function runCodexBoundary(options:{builtinControl?:boolean}={}) {
 const status=await readFile('/proc/self/status','utf8').catch(()=>'');
 const capabilities=Object.fromEntries([...status.matchAll(/^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s*([0-9a-fA-F]+)$/gm)].map(match=>[match[1],match[2]]));
 const baseline={scope:'cloudflare-no-subscription-codex-workspace-boundary',uid:process.getuid?.(),noNewPrivileges:status.match(/^NoNewPrivs:\s*(\d+)$/m)?.[1],capabilities,authProvided:false,modelCalled:false,parentCwd:process.cwd(),parentPid:process.pid,parentPidNamespace:await readlink('/proc/self/ns/pid').catch(()=>null),requestedCwd:paths.workspace,workspaceRealpath:await realpath(paths.workspace).catch(()=>null),homeRealpath:await realpath(paths.home).catch(()=>null)};
 const owned:string[]=[];
 let report:Record<string,unknown>={...baseline,exitCode:null,timedOut:false,captureLimit:false};
 try {
  if(baseline.uid!==1000||baseline.noNewPrivileges!=='1'||!capabilitiesZero(capabilities))throw new Error('Unsafe execution boundary');
  await mkdir(paths.home+'/.codex',{recursive:true,mode:0o700});await mkdir(paths.privateDir,{recursive:true,mode:0o700});
  const fixtures=[
   [paths.home+'/.codex/auth.json',JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'NON_SECRET_BOUNDARY_ACCESS_FIXTURE',refresh_token:'NON_SECRET_BOUNDARY_REFRESH_FIXTURE'}})],
   [paths.privateDir+'/codex-boundary-private.txt','NON_SECRET_BOUNDARY_PRIVATE_FIXTURE'],
   ['/runtime/codex-boundary-input.json','{"fixture":true}'],
   ['/home/node/phase0-codex-boundary-outside.txt','before'],
   ['/workspace/phase0-codex-boundary-inside.txt','before'],
   [receipt,'']
  ];
  for(const [path,value] of fixtures){await writeFile(path!,value!,{flag:'wx',mode:0o600});owned.push(path!);}
  const env=buildEnv({...process.env,OPENAI_API_KEY:'NON_SECRET_ENV_FIXTURE',CLAUDE_CODE_OAUTH_TOKEN:'NON_SECRET_ENV_FIXTURE',CLOUDFLARE_API_TOKEN:'NON_SECRET_ENV_FIXTURE',AWS_SECRET_ACCESS_KEY:'NON_SECRET_ENV_FIXTURE',HIVEMIND_FIXTURE_TOKEN:'NON_SECRET_ENV_FIXTURE'},paths.home,'codex');
  const runOne=async(profile:'hivemind'|':workspace')=>{
   const processResult=await runBounded('codex',codexBoundaryArgs(process.pid,profile),{cwd:paths.workspace,env,timeoutMs:20000,maxBytes:128000});
   const workspaceReceipt=await readFile(receipt,'utf8').catch(()=>'');
   const observation=parseCodexBoundaryObservation(processResult.stdout,workspaceReceipt);
   const outsideFixtureChanged=await readFile('/home/node/phase0-codex-boundary-outside.txt','utf8').then(value=>value!=='before',()=>null);
   return {...observation.observed,profile,outsideFixtureChanged,outsideSentinelUnchanged:outsideFixtureChanged===null?null:!outsideFixtureChanged,observationSource:observation.observationSource,receiptBytes:Buffer.byteLength(workspaceReceipt),stdoutBytes:Buffer.byteLength(processResult.stdout),stderrBytes:Buffer.byteLength(processResult.stderr),exitCode:processResult.exitCode,timedOut:processResult.timedOut,captureLimit:processResult.captureLimit,stderr:processResult.stderr.slice(-4000)};
  };
  report={...baseline,...await runOne('hivemind')};
  if(options.builtinControl){
   await writeFile(receipt,'');await writeFile('/home/node/phase0-codex-boundary-outside.txt','before');
   report.builtinControl=await runOne(':workspace');
  }
 }catch{
  report={...report,error:'Boundary preparation or bounded launch failed'};
 }finally{
  await Promise.all(owned.map(path=>rm(path,{force:true}).catch(()=>undefined)));
 }
 return {...report,assessment:assessCodexBoundary(report)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.stdout.write(JSON.stringify(await runCodexBoundary({builtinControl:process.argv.includes('--builtin-control')})));
