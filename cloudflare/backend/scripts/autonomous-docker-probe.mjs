import {spawnSync} from 'node:child_process';
import {arch,tmpdir} from 'node:os';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
// stdin contains only this public probe. No host paths, credentials or model commands.
const probe=String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');
(async()=>{
 const status=fs.readFileSync('/proc/self/status','utf8');
 const caps=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].every(k=>new RegExp('^'+k+':\\s+0+$','m').test(status));
 const noNewPrivileges=/^NoNewPrivs:\s+1$/m.test(status);
 const uid=process.getuid()===1000;
 const authAbsent=['CONTROL_TOKEN','AUTH_STORAGE_KEY','AUTH_RETURN_PRIVATE_KEY','AUTONOMOUS_SESSION_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','OPENAI_API_KEY'].every(k=>!process.env[k])&&['/home/node/.claude/.credentials.json','/home/node/.codex/auth.json'].every(p=>!fs.existsSync(p));
 const managed='/etc/claude-code/managed-settings.json';
 const settings=JSON.parse(fs.readFileSync(managed,'utf8')),st=fs.statSync(managed);
 let immutable=false;try{fs.accessSync(managed,fs.constants.W_OK);}catch{immutable=true;}
 const sandbox=settings.sandbox?.enabled===true&&settings.sandbox?.failIfUnavailable===true&&settings.sandbox?.allowUnsandboxedCommands===false;
 const prerequisites=['/opt/hivemind/bin/proc-guard','/opt/hivemind/bin/namespace-guard','/opt/hivemind/compat-bin/bwrap','/opt/hivemind/backend/src/runtime/autonomous-tool-hook.ts'].every(p=>{const s=fs.statSync(p);return s.uid===0&&(s.mode&0o022)===0;});
 // Import starts no model. Missing native routes fail the gate instead of relaxing it.
 const {createBootstrap}=await import('/opt/hivemind/backend/src/runtime/bootstrap.ts');
 const server=createBootstrap('/runtime');await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let nativeAuth=false;try{const origin='http://127.0.0.1:'+server.address().port;const state=await fetch(origin+'/autonomous/state');const prepare=await fetch(origin+'/autonomous/prepare',{method:'POST',body:'{'});nativeAuth=state.status===403&&prepare.status===403;}finally{await new Promise(r=>server.close(r));}
 const {runAutonomousBoundaryProbe}=await import('/opt/hivemind/backend/src/runtime/autonomous-boundary-probe.ts');
 const actualBoundary=await runAutonomousBoundaryProbe();const actualSandbox=actualBoundary.passed===true;
 const managedBoundary=immutable&&st.uid===0&&(st.mode&0o022)===0&&sandbox&&prerequisites;
 console.log(JSON.stringify({uid,caps,noNewPrivileges,authAbsent,managedBoundary,nativeAuth,actualSandbox,managedHash:crypto.createHash('sha256').update(fs.readFileSync(managed)).digest('hex'),passed:uid&&caps&&noNewPrivileges&&authAbsent&&managedBoundary&&nativeAuth&&actualSandbox}));
})().catch(()=>{console.log(JSON.stringify({passed:false}));process.exitCode=1;});
`;
export function dockerProbeArgs(image){
 if(typeof image!=='string'||!(/^[a-f0-9]{12,64}$/.test(image)||/^sha256:[a-f0-9]{64}$/.test(image)))throw new Error('Use an immutable local image ID');
 return ['run','--rm','--pull=never','--platform=linux/amd64','--network=none','--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','--read-only','--tmpfs=/runtime:rw,noexec,nosuid,size=16m,uid=1000,gid=1000','--tmpfs=/tmp:rw,nosuid,size=32m,uid=1000,gid=1000','--tmpfs=/home/node:rw,nosuid,size=64m,uid=1000,gid=1000','--tmpfs=/workspace:rw,nosuid,size=16m,uid=1000,gid=1000','-i','--entrypoint=node',image,'-'];
}
export function runDockerProbe(image,runner=spawnSync){
 const args=dockerProbeArgs(image),dir=mkdtempSync(join(tmpdir(),'hivemind-docker-probe-')),cidfile=join(dir,'cid');
 let result;
 try{
  args.splice(1,0,'--cidfile='+cidfile);
  result=runner('docker',args,{input:probe,encoding:'utf8',timeout:60000,maxBuffer:65536});
 }finally{
  if(!result||result.error||result.status!==0){
   try{const cid=readFileSync(cidfile,'utf8').trim();if(/^[a-f0-9]{64}$/.test(cid))runner('docker',['rm','--force',cid],{encoding:'utf8',timeout:10000,maxBuffer:4096});}catch{/* Only the created container ID authorizes cleanup. */}
  }
  rmSync(dir,{recursive:true,force:true});
 }
 let raw={};try{raw=JSON.parse(result.stdout?.trim()??'');}catch{}
 const report={};for(const key of ['uid','caps','noNewPrivileges','authAbsent','managedBoundary','nativeAuth','actualSandbox'])report[key]=raw[key]===true;
 report.localDocker=true;report.cloudflareEvidence=false;report.qemuEmulation=arch()==='arm64';
 if(typeof raw.managedHash==='string'&&/^[a-f0-9]{64}$/.test(raw.managedHash))report.managedHash=raw.managedHash;
 report.passed=!result.error&&!result.signal&&result.status===0&&raw.passed===true&&['uid','caps','noNewPrivileges','authAbsent','managedBoundary','nativeAuth','actualSandbox'].every(k=>report[k]);
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const report=runDockerProbe(process.argv[2]);console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;}catch{console.log(JSON.stringify({localDocker:true,passed:false}));process.exitCode=1;}}
