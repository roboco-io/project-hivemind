import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {computeSandboxArgs} from '../../backend/src/runtime/compute-sandbox.ts';
import {runProcess} from '../../backend/src/runtime/process.ts';
import {buildEnv} from '../../backend/src/runtime/providers.ts';
import type {ProcessResult} from '../../backend/src/contracts.ts';

export function computeStdioArgs():string[]{
 return [...computeSandboxArgs(),'node','--test','--test-reporter=tap','stdio.test.mjs'];
}
export function computeStdioTestSource(){return `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const descriptor=fd=>{const stat=fs.fstatSync(fd);return {regularFile:stat.isFile(),pipe:stat.isFIFO(),socket:stat.isSocket(),character:stat.isCharacterDevice()}};
fs.writeSync(1,'HIVEMIND_STDIO_FD '+JSON.stringify({stdout:descriptor(1),stderr:descriptor(2)})+String.fromCharCode(10));
fs.writeSync(2,'HIVEMIND_STDERR_CONTROL'+String.fromCharCode(10));
test('fixed arithmetic assertion',()=>assert.equal(2+2,4));
test('fixed source assertion',()=>assert.deepEqual(['worker','test'].join('-'),'worker-test'));
`;}
export function assessComputeStdio(result:ProcessResult){
 const lines=result.stdout.split(/\r?\n/);
 const total=(label:string,expected:number)=>{const rows=lines.filter(line=>new RegExp('^# '+label+' \\d+$').test(line));return rows.length===1&&rows[0]==='# '+label+' '+expected;};
 const checks={exitSucceeded:result.status==='passed'&&result.exitCode===0,outputComplete:result.truncated===false,tapVersion:lines.filter(line=>line==='TAP version 13').length===1,tests:total('tests',2),pass:total('pass',2),fail:total('fail',0)};
 return {passed:Object.values(checks).every(Boolean),checks};
}
export async function runComputeStdioProbe(){
 const workspace='/workspace',home='/runtime/stdio-home',captureDirectory='/runtime/stdio-files',testFile=workspace+'/stdio.test.mjs';
 const status=await readFile('/proc/self/status','utf8').catch(()=>'');
 const capabilities=Object.fromEntries([...status.matchAll(/^(Cap(?:Inh|Prm|Eff|Bnd|Amb)):\s*([0-9a-fA-F]+)$/gm)].map(match=>[match[1],match[2]]));
 const baseline={scope:'cloudflare-no-auth-compute-stdio',authProvided:false,modelCalled:false,uid:process.getuid?.(),noNewPrivileges:status.match(/^NoNewPrivs:\s*(\d+)$/m)?.[1],capabilities,home,captureDirectory,argv:computeStdioArgs()};
 let result:ProcessResult={status:'error',exitCode:null,stdout:'',stderr:'Compute stdio probe did not start',durationMs:0,truncated:false};let ownedTest=false,credentialsAbsent=false;let legacyControl:ProcessResult|undefined,negativeControl:ProcessResult|undefined;
 try{
  const capNames=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'];
  if(baseline.uid!==1000||baseline.noNewPrivileges!=='1'||Object.keys(capabilities).length!==5||!capNames.every(key=>/^0+$/.test(capabilities[key]??'')))throw new Error('Unsafe process boundary');
  await mkdir(home,{mode:0o700});
  await writeFile(testFile,computeStdioTestSource(),{flag:'wx',mode:0o600});ownedTest=true;
  const env=buildEnv(process.env,home);
  credentialsAbsent=Object.keys(env).every(key=>!(/^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLOUDFLARE_|CF_API_|AWS_|PROBE_TOKEN$|AUTH_WRAP_KEY$|CONTROL_TOKEN$|AUTH_STORAGE_KEY$)/.test(key)&&env[key]));
  if(!credentialsAbsent)throw new Error('Compute environment contains credentials');
  legacyControl=await runProcess(['codex','sandbox','-c','sandbox_workspace_write.network_access=true','-P',':workspace','--','node','--test','--test-reporter=tap','stdio.test.mjs'],{cwd:workspace,env,captureDirectory:captureDirectory+'-legacy',timeoutMs:20000,maxBytes:32768});
  result=await runProcess(computeStdioArgs(),{cwd:workspace,env,captureDirectory,timeoutMs:20000,maxBytes:32768});
  await writeFile(testFile,computeStdioTestSource().replace('assert.equal(2+2,4)','assert.equal(2+2,5)'));
  negativeControl=await runProcess(computeStdioArgs(),{cwd:workspace,env,captureDirectory:captureDirectory+'-negative',timeoutMs:20000,maxBytes:32768});
 }catch{result={...result,status:'error',exitCode:null,stderr:'Compute stdio preparation or bounded execution failed'};}
 finally{if(ownedTest)await rm(testFile,{force:true}).catch(()=>undefined);}
 let descriptorObservation:unknown=null;
 const marker=result.stdout.match(/HIVEMIND_STDIO_FD (\{[^\r\n]*\})/);
 if(marker){try{descriptorObservation=JSON.parse(marker[1]!);}catch{/* Actual TAP remains the required proof. */}}
 const assessment=assessComputeStdio(result);
 const failingAssertionObserved=negativeControl?.status==='failed'&&negativeControl.exitCode!==0&&/^# tests 2$/m.test(negativeControl.stdout)&&/^# fail 1$/m.test(negativeControl.stdout);
 return {...baseline,credentialsAbsent,descriptorObservation,legacyControl,negativeControl,failingAssertionObserved,stdoutBytes:Buffer.byteLength(result.stdout),stderrBytes:Buffer.byteLength(result.stderr),process:result,assessment:{...assessment,passed:credentialsAbsent&&assessment.passed&&failingAssertionObserved}};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.stdout.write(JSON.stringify(await runComputeStdioProbe()));
