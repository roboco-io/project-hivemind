import {mkdir,readFile,writeFile,readlink,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {runBounded} from './run-bounded.ts';
import {claudeSettings} from '../../backend/src/runtime/providers.ts';
const required=['workspaceWrite','outsideWriteDenied','privateReadDenied','runtimeInputReadDenied','procReadDenied','parentProcessInfoDenied','parentRootAliasDenied','parentMemoryDenied','parentEnvironmentDenied','parentReadlinksDenied','threadAliasesDenied','siblingAliasesDenied','privateHardlinkDenied','fixtureCredentialAbsent','managementCredentialsAbsent','networkDenied','devNullWritable','ignoredSpawnWorks','guardApplied','pidNamespaceDifferent'];
export function assessClaudeBoundary(result:Record<string,unknown>){
 const caps=result.capabilities as Record<string,string>|undefined;
 return {passed:result.uid===1000&&result.toolUid===1000&&result.exitCode===0&&result.timedOut===false&&result.captureLimit===false&&result.noNewPrivileges==='1'&&Number(result.guardAbi)>=3&&!!caps&&['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].every(key=>/^0+$/.test(caps[key]??''))&&required.every(key=>result[key]===true),checks:[...required]};
}
export async function runClaudeBoundary(){
 const dir='/home/node/.hivemind-phase0';
 const production=claudeSettings({home:'/home/node',privateDir:dir,workspace:'/workspace',scriptRoot:'/opt/hivemind/scripts/phase0'},true).sandbox as {filesystem:unknown;credentials:unknown;enableWeakerNestedSandbox:boolean};
 await mkdir(dir,{recursive:true,mode:0o700});await writeFile('/home/node/phase0-boundary-outside.txt','before',{mode:0o600});await writeFile(`${dir}/credential.txt`,'NON_SECRET_BOUNDARY_FIXTURE',{mode:0o600});await writeFile('/runtime/input.json','NON_SECRET_RUNTIME_AUTH_FIXTURE',{mode:0o600});
 const settings={filesystem:{...(production.filesystem as object),allowWrite:['/workspace']},network:{allowedDomains:[],deniedDomains:[]},enableWeakerNestedSandbox:production.enableWeakerNestedSandbox,credentials:production.credentials};
 await writeFile(`${dir}/srt.json`,JSON.stringify(settings),{mode:0o600});
 const outerPidNamespace=await readlink('/proc/self/ns/pid').catch(()=>null),outerCmdlineHash=createHash('sha256').update(await readFile('/proc/self/cmdline')).digest('hex');
 const threadIds=(await readdir(`/proc/${process.pid}/task`)).filter(id=>/^\d+$/.test(id)).map(Number);
 const sibling=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{env:{PATH:process.env.PATH,HIVEMIND_PARENT_AUTH_FIXTURE:'NON_SECRET_FIXTURE'},stdio:'ignore'});
 const siblingClosed=new Promise<void>(resolve=>{sibling.once('close',()=>resolve());sibling.once('error',()=>resolve())});
 if(!sibling.pid)throw new Error('Process fixture could not start');
 const siblingIds=[1,sibling.pid];
 const script=`
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),crypto=require('node:crypto');
const codes=['EACCES','EPERM','ENOENT','ENOTDIR'];
const denied=fn=>{try{fn();return false}catch(error){return codes.includes(error.code)||error.code==='EROFS'||error.code==='EXDEV'}};
const noContent=path=>{try{return fs.readFileSync(path).length===0}catch(error){return codes.includes(error.code)}};
const openDenied=path=>denied(()=>{const fd=fs.openSync(path,'r');fs.closeSync(fd)});
const linkDenied=path=>denied(()=>fs.readlinkSync(path));
const hash=path=>{try{return crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')}catch{return null}};
const childPidNamespace=(()=>{try{return fs.readlinkSync('/proc/self/ns/pid')}catch{return null}})();
const parent='/proc/${process.pid}';
const threads=${JSON.stringify(threadIds)},siblings=${JSON.stringify(siblingIds)};
fs.writeFileSync('/workspace/phase0-boundary-inside.txt','inside');
const result={toolUid:process.getuid(),childPid:process.pid,childPidNamespace,pidNamespaceDifferent:childPidNamespace!==null&&childPidNamespace!==${JSON.stringify(outerPidNamespace)},
guardApplied:Number(process.env.HIVEMIND_FS_GUARD_ABI)>=3,guardAbi:Number(process.env.HIVEMIND_FS_GUARD_ABI)||null,
workspaceWrite:fs.readFileSync('/workspace/phase0-boundary-inside.txt','utf8')==='inside',outsideWriteDenied:denied(()=>fs.writeFileSync('/home/node/phase0-boundary-outside.txt','escaped')),
privateReadDenied:noContent('${dir}/credential.txt'),runtimeInputReadDenied:noContent('/runtime/input.json'),procReadDenied:noContent('/proc/self/status'),
parentEnvironmentDenied:noContent(parent+'/environ'),parentProcessInfoDenied:['status','cmdline'].every(f=>noContent(parent+'/'+f)),parentMemoryDenied:openDenied(parent+'/mem'),
parentRootAliasDenied:['${dir}/credential.txt','/runtime/input.json'].every(p=>noContent(parent+'/root'+p)),parentReadlinksDenied:['cwd','exe','root'].every(f=>linkDenied(parent+'/'+f)),
threadAliasesDenied:threads.every(tid=>['status','cmdline','environ'].every(f=>noContent('/proc/'+tid+'/'+f))&&openDenied('/proc/'+tid+'/mem')&&noContent('/proc/'+tid+'/root/runtime/input.json')),
siblingAliasesDenied:siblings.every(pid=>noContent('/proc/'+pid+'/root/runtime/input.json')&&noContent('/proc/'+pid+'/root${dir}/credential.txt')&&noContent('/proc/'+pid+'/root'+parent+'/environ')),
privateHardlinkDenied:denied(()=>fs.linkSync('/proc/'+siblings.at(-1)+'/root/runtime/input.json','/workspace/phase0-private-hardlink')),
fixtureCredentialAbsent:!process.env.CLAUDE_CODE_OAUTH_TOKEN,managementCredentialsAbsent:['CLOUDFLARE_API_TOKEN','CF_API_TOKEN','PROBE_TOKEN','AUTH_WRAP_KEY','CONTROL_TOKEN','AUTH_STORAGE_KEY'].every(k=>!process.env[k]),
devNullWritable:!denied(()=>fs.writeFileSync('/dev/null','fixture')),ignoredSpawnWorks:cp.spawnSync('/bin/true',[],{stdio:'ignore'}).status===0,
outerPidStatVisible:(()=>{try{return fs.statSync(parent).isDirectory()}catch{return false}})(),targetCmdlineMatchesOuter:hash(parent+'/cmdline')==='${outerCmdlineHash}'};
const socket=net.connect({host:'1.1.1.1',port:443});let done=false;const finish=blocked=>{if(done)return;done=true;socket.destroy();fs.writeSync(1,'HIVEMIND_BOUNDARY_RESULT '+JSON.stringify({...result,networkDenied:blocked})+'\\n')};socket.on('connect',()=>finish(false));socket.on('error',()=>finish(true));setTimeout(()=>finish(true),1500);
`;
 const env={...process.env};for(const key of Object.keys(env))if(/^(OPENAI|CODEX|ANTHROPIC|CLAUDE_CODE_OAUTH|CLOUDFLARE|CF_API|PROBE_TOKEN|AUTH_WRAP|CONTROL_TOKEN|AUTH_STORAGE)/.test(key))delete env[key];env.CLAUDE_CODE_OAUTH_TOKEN='NON_SECRET_FIXTURE_VALUE';
 let output;
 try{output=await runBounded('srt',['--settings',`${dir}/srt.json`,'--','/opt/hivemind/bin/proc-guard','--','/usr/local/bin/node','-e',script],{cwd:'/workspace',env,timeoutMs:20000,maxBytes:128000})}finally{sibling.kill('SIGTERM');await siblingClosed}
 const line=output.stdout.split(/\r?\n/).find(line=>line.startsWith('HIVEMIND_BOUNDARY_RESULT '));let observed:Record<string,unknown>={};try{if(line)observed=JSON.parse(line.slice('HIVEMIND_BOUNDARY_RESULT '.length))}catch{}
 const status=await readFile('/proc/self/status','utf8'),capabilities=Object.fromEntries([...status.matchAll(/^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s*(\w+)$/gm)].map(match=>[match[1],match[2]]));
 const report={scope:'cloudflare-no-subscription-claude-nested-boundary',outerPid:process.pid,outerPidNamespace,outerCmdlineHash,threadIds,siblingIds,configuredFilesystem:production.filesystem,configuredCredentials:production.credentials,guard:'/opt/hivemind/bin/proc-guard',uid:process.getuid?.(),noNewPrivileges:status.match(/^NoNewPrivs:\s*(\d+)/m)?.[1],capabilities,...observed,exitCode:output.exitCode,timedOut:output.timedOut,captureLimit:output.captureLimit,stderr:output.stderr.slice(-4000)};
 return {...report,assessment:assessClaudeBoundary(report)};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.stdout.write(JSON.stringify(await runClaudeBoundary()));
