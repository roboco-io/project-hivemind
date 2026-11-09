import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as probe from '../scripts/phase0/codex-boundary-probe.ts';
import {providerArgs} from '../backend/src/runtime/providers.ts';
import {runInNewContext} from 'node:vm';

const checks=['workspaceWrite','outsideWriteDenied','outsideSentinelUnchanged','privateAuthReadDenied','privateMetadataReadDenied','runtimeInputReadDenied','procReadDenied','parentEnvironmentDenied','parentCommandLineDenied','parentStatusDenied','parentRootAuthReadDenied','parentRootMetadataReadDenied','parentRootRuntimeReadDenied','parentMemoryDenied','selectedCredentialsAbsent','managementCredentialsAbsent'];
const good=()=>({uid:1000,toolUid:1000,noNewPrivileges:'1',capabilities:{CapInh:'0000000000000000',CapPrm:'0000000000000000',CapEff:'0000000000000000',CapBnd:'0000000000000000',CapAmb:'0000000000000000'},exitCode:0,timedOut:false,captureLimit:false,...Object.fromEntries(checks.map(key=>[key,true]))});
test('Codex boundary assessment rejects any missing or failed access check',()=>{
 const assess=(probe as any).assessCodexBoundary;assert.equal(typeof assess,'function');
 assert.equal(assess(good()).passed,true);
 for(const key of checks){
  const missing=good();delete missing[key as keyof typeof missing];assert.equal(assess(missing).passed,false,key+' is required');
  assert.equal(assess({...good(),[key]:false}).passed,false,key+' must pass');
  assert.equal(assess({...good(),[key]:'true'}).passed,false,key+' must be boolean');
 }
});
test('Codex boundary assessment requires all five capabilities and successful settled execution',()=>{
 const assess=(probe as any).assessCodexBoundary;assert.equal(typeof assess,'function');
 for(const key of Object.keys(good().capabilities)){
  const caps={...good().capabilities};delete caps[key as keyof typeof caps];assert.equal(assess({...good(),capabilities:caps}).passed,false);
  assert.equal(assess({...good(),capabilities:{...good().capabilities,[key]:'0001'}}).passed,false);
 }
 for(const patch of [{uid:0},{toolUid:0},{noNewPrivileges:'0'},{exitCode:1},{timedOut:true},{captureLimit:true},{capabilities:{}},{capabilities:{...good().capabilities,Other:'0'}}])assert.equal(assess({...good(),...patch}).passed,false);
 for(const key of ['uid','toolUid','noNewPrivileges','exitCode','timedOut','captureLimit']){const missing:Record<string,unknown>=good();delete missing[key];assert.equal(assess(missing).passed,false);}
});
test('Codex boundary sandbox uses exact production configs without an agent invocation',()=>{
 const build=(probe as any).codexBoundaryArgs;assert.equal(typeof build,'function');
 const args=build(12345);const paths={home:'/home/node',privateDir:'/home/node/.hivemind-phase0',workspace:'/workspace',scriptRoot:'/opt/hivemind/scripts/phase0'};
 const production=providerArgs('codex','unused',paths);const configs=(argv:string[])=>argv.flatMap((arg,index)=>arg==='-c'?[argv[index+1]]:[]);
 assert.deepEqual(configs(args),configs(production));assert.equal(args[0],'sandbox');assert.ok(!args.includes('exec'));assert.ok(!args.includes('login'));assert.ok(args.includes('hivemind'));assert.ok(args.includes('--'));assert.ok(!args.some((arg:string)=>arg.includes('dangerously-skip')||arg.includes('bypass')));
 const script=args.at(-1);assert.ok(script.includes('const outerPid=12345;'));assert.ok(!script.includes("'/proc/'+process.ppid"));assert.ok(script.includes("'/proc/'+outerPid+'/root/home/node/.hivemind-phase0/codex-boundary-private.txt'"));
});
test('Codex boundary reads an owned workspace receipt when standard output is absent',()=>{
 const parse=(probe as any).parseCodexBoundaryObservation;assert.equal(typeof parse,'function');
 const receipt=JSON.stringify({toolUid:1000,privateAuthReadDenied:false,privateReads:{auth:{denied:false,bytes:0},runtime:{denied:true,bytes:null,error:'EACCES'}}});
 const fallback=parse('',receipt);assert.equal(fallback.observationSource,'workspace-receipt');assert.equal(fallback.observed.privateAuthReadDenied,false);assert.equal(fallback.observed.privateReads.auth.bytes,0);
 const standard=parse('HIVEMIND_CODEX_BOUNDARY_RESULT '+JSON.stringify({toolUid:1000,privateAuthReadDenied:true}),receipt);assert.equal(standard.observationSource,'stdout');assert.equal(standard.observed.privateAuthReadDenied,true);
 assert.equal(parse('','').observationSource,'none');assert.equal(parse('', '{malformed}').observationSource,'none');
 assert.equal(parse('HIVEMIND_CODEX_BOUNDARY_RESULT {malformed}',receipt).observationSource,'none');
 const script=(probe as any).codexBoundaryArgs(12345).at(-1) as string;
 assert.ok(script.indexOf('fs.writeFileSync(receipt,')<script.indexOf("console.log('HIVEMIND_CODEX_BOUNDARY_RESULT "));
 for(const file of ['/home/node/.codex/auth.json','/home/node/.hivemind-phase0/codex-boundary-private.txt','/runtime/codex-boundary-input.json'])assert.ok(script.includes(`readCheck('${file}',false)`));
});
test('Codex diagnostic records cwd and direct stdio while builtin control stays separate',()=>{
 const named=(probe as any).codexBoundaryArgs(12345);const builtin=(probe as any).codexBoundaryArgs(12345,':workspace');
 assert.equal(builtin[builtin.indexOf('-P')+1],':workspace');assert.equal(named[named.indexOf('-P')+1],'hivemind');
 assert.equal(named.at(-1),builtin.at(-1));assert.throws(()=>(probe as any).codexBoundaryArgs(12345,':danger-full-access'));
 const script=named.at(-1);assert.ok(script.includes('childCwd:process.cwd()'));assert.ok(script.includes('fs.writeSync('));
 assert.ok(script.includes("fs.readlinkSync('/proc/self/ns/pid')"));assert.ok(script.includes('childPid:process.pid'));
 const parse=(probe as any).parseCodexBoundaryObservation;
 const measured=parse('',JSON.stringify({childCwd:'/workspace',stdio:{stdout:{bytes:0,error:'EACCES'},stderr:{bytes:12}}}));
 assert.equal(measured.observed.childCwd,'/workspace');assert.deepEqual(measured.observed.stdio,{stdout:{bytes:0,error:'EACCES'},stderr:{bytes:12}});
 assert.equal((probe as any).assessCodexBoundary({...good(),outsideWriteDenied:false,builtinControl:good()}).passed,false);
});
test('fixed Codex probe records EROFS as write denial and refuses unexpected failures',()=>{
 const execute=(code:string)=>{
  let receipt='';const denied=()=>{throw Object.assign(new Error('fixture'),{code:'EACCES'});};
  const fs={readFileSync:(path:string,encoding?:string)=>path.endsWith('phase0-codex-boundary-inside.txt')?(encoding==='utf8'?'inside':Buffer.from('inside')):denied(),readlinkSync:denied,writeSync:(_fd:number,text:string)=>Buffer.byteLength(text),writeFileSync:(path:string,content:string)=>{if(path.endsWith('phase0-codex-boundary-outside.txt'))throw Object.assign(new Error('fixture'),{code});if(path.endsWith('phase0-codex-boundary-result.json'))receipt=content;}};
  const child={getuid:()=>1000,pid:2,ppid:1,cwd:()=>'/workspace',env:{},exitCode:undefined as number|undefined};
  runInNewContext((probe as any).codexBoundaryArgs(12345).at(-1),{require:()=>fs,process:child,console:{log:()=>undefined}});
  return {receipt:JSON.parse(receipt),exitCode:child.exitCode};
 };
 const readOnly=execute('EROFS');assert.equal(readOnly.receipt.outsideWriteDenied,true);assert.deepEqual(readOnly.receipt.outsideWrite,{denied:true,error:'EROFS'});assert.equal(readOnly.exitCode,undefined);
 const parsed=(probe as any).parseCodexBoundaryObservation('',JSON.stringify(readOnly.receipt));assert.deepEqual(parsed.observed.outsideWrite,{denied:true,error:'EROFS'});
 const unexpected=execute('EIO');assert.equal(unexpected.receipt.outsideWriteDenied,false);assert.deepEqual(unexpected.receipt.outsideWrite,{denied:false,error:'EIO'});assert.equal(unexpected.exitCode,31);
 assert.equal((probe as any).assessCodexBoundary({...good(),outsideSentinelUnchanged:false}).passed,false);
});
