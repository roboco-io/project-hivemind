import {spawn} from 'node:child_process';
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const marker='NON_SECRET_INHERITED_FD_FIXTURE';
export async function runLandlockProbe(){
 await mkdir('/home/node/.hivemind-phase0',{recursive:true,mode:0o700});
 await writeFile('/home/node/.hivemind-phase0/fd-fixture',marker,{mode:0o600});
 const fd=await open('/home/node/.hivemind-phase0/fd-fixture','r');
 const script=`const fs=require('node:fs');const cp=require('node:child_process');const denied=f=>{try{f();return false}catch{return true}};let inheritedPrivateFdAbsent=true;try{if(fs.fstatSync(3).isFile())inheritedPrivateFdAbsent=!fs.readFileSync(3,'utf8').includes('${marker}')}catch{};fs.writeFileSync('/workspace/landlock-inside.txt','inside');const result={guardAbi:Number(process.env.HIVEMIND_FS_GUARD_ABI),uid:process.getuid(),inheritedPrivateFdAbsent,workspaceWrite:fs.readFileSync('/workspace/landlock-inside.txt','utf8')==='inside',privateReadDenied:denied(()=>fs.readFileSync('/home/node/.hivemind-phase0/fd-fixture')),procReadDenied:denied(()=>fs.readFileSync('/proc/self/status')),devNullWritable:!denied(()=>fs.writeFileSync('/dev/null','fixture')),ignoredSpawnWorks:cp.spawnSync('/bin/true',[],{stdio:'ignore'}).status===0};fs.writeSync(1,JSON.stringify(result));`;
 let stdout='',stderr='',timedOut=false;let exitCode:number|null=null;
 try{
  const child=spawn('/opt/hivemind/bin/proc-guard',['--','/usr/local/bin/node','-e',script],{cwd:'/workspace',env:{PATH:process.env.PATH,HOME:'/home/node'},stdio:['ignore','pipe','pipe',fd.fd],detached:true});
  const timer=setTimeout(()=>{timedOut=true;if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}},10000);
  child.stdout.on('data',data=>{if(stdout.length<64000)stdout+=String(data)});child.stderr.on('data',data=>{if(stderr.length<4000)stderr+=String(data)});
  exitCode=await new Promise<number|null>(resolve=>{child.once('error',()=>resolve(127));child.once('close',resolve)});clearTimeout(timer);
 }finally{await fd.close();}
 let observed:Record<string,unknown>={};try{observed=JSON.parse(stdout)}catch{}
 const checks=['inheritedPrivateFdAbsent','workspaceWrite','privateReadDenied','procReadDenied','devNullWritable','ignoredSpawnWorks'];
 return {scope:'cloudflare-no-subscription-landlock-guard',...observed,exitCode,timedOut,stderr,assessment:{passed:exitCode===0&&!timedOut&&observed.uid===1000&&Number(observed.guardAbi)>=3&&checks.every(key=>observed[key]===true),checks}};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.stdout.write(JSON.stringify(await runLandlockProbe()));
