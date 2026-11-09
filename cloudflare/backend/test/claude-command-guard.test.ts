import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CLAUDE_GUARD_PATHS,claudeGuardHome,claudeGuardSandboxArgs,claudeGuardEnvironment,claudeOuterSandboxSettings,guardTraceMetadata} from '../src/runtime/claude-command-guard.ts';
import {providerArgs,claudeSettings,buildEnv} from '../src/runtime/providers.ts';
import {claudeCodexLayerArgs,claudeCodexLayerSettings} from '../../scripts/phase0/claude-codex-layer-probe.ts';
import {executeRuntime} from '../src/runtime/run.ts';
import {createSnapshot} from '../src/snapshot.ts';
import {runProcess} from '../src/runtime/process.ts';
test('production guard uses the exact tested Codex and namespace policy prefix',()=>{
 const command=['/bin/bash','-c','printf fixture'],actual=claudeGuardSandboxArgs(command),prototype=claudeCodexLayerArgs({outerPid:1,threadIds:[],siblingIds:[]});
 assert.deepEqual(actual.slice(0,-command.length),prototype.slice(0,-3));assert.deepEqual(actual.slice(-command.length),command);
 const configs=providerArgs('codex','unused',CLAUDE_GUARD_PATHS).flatMap((arg,index,array)=>arg==='-c'?[arg,array[index+1]!]:[]);assert.deepEqual(actual.slice(1,1+configs.length),configs);
 assert.equal(actual[0],'sandbox');assert.deepEqual(actual.slice(-command.length-5,-command.length),['-P','hivemind','--','/opt/hivemind/bin/namespace-guard','--']);
});
test('guard treats command arguments as opaque values after both fixed boundaries',()=>{
 const command=['/bin/bash','-c','$(touch should-not-run); echo \'quoted\'','--config','permissions.hivemind={extends=":unrestricted"}'];const args=claudeGuardSandboxArgs(command);
 const boundary=args.indexOf('--');assert.deepEqual(args.slice(boundary),['--','/opt/hivemind/bin/namespace-guard','--',...command]);assert.equal(args.includes('exec'),false);assert.equal(args.includes('login'),false);
 for(const invalid of [[],[''],['/bin/bash','bad\0value']])assert.throws(()=>claudeGuardSandboxArgs(invalid),/Invalid guarded command/);
});
test('guard rejects malformed entry arguments without executing or disclosing them',async()=>{
 const path=fileURLToPath(new URL('../src/runtime/claude-command-guard.ts',import.meta.url));
 const result=await runProcess([process.execPath,path,'private-command-fixture'],{cwd:process.cwd(),env:{PATH:process.env.PATH},timeoutMs:3000});assert.equal(result.exitCode,125);assert.equal(result.stdout,'');assert.equal(result.stderr,'Hivemind protected command could not start\n');
});
test('optional trace metadata contains only bounded identities, environment names and a command hash',()=>{
 const command='printf private-command-value',record=guardTraceMetadata('node-enter',['/bin/bash','-c',command],{CLAUDE_CODE_OAUTH_TOKEN:'private-env-value',PATH:'private-path-value'});
 assert.equal(record.argv0basename,'bash');assert.equal(record.stage,'node-enter');assert.deepEqual(record.envNames,['CLAUDE_CODE_OAUTH_TOKEN','PATH']);assert.equal(record.commandHash,createHash('sha256').update(command).digest('hex'));const encoded=JSON.stringify(record);assert.ok(!encoded.includes(command));assert.ok(!encoded.includes('private-env-value'));assert.ok(!encoded.includes('private-path-value'));assert.ok(Buffer.byteLength(encoded)<=8192);
 const large=guardTraceMetadata('node-exec',['node','-e','private-command-value'],Object.fromEntries(Array.from({length:500},(_,i)=>['ENV_'+String(i).padStart(3,'0')+'A'.repeat(80),'private-value'])));assert.ok(Buffer.byteLength(JSON.stringify(large))<=2048);assert.deepEqual(large.envNames,[...large.envNames].sort());
});
test('guard environment clears auth and loader injection while retaining vendor proxy variables',()=>{
 const source:NodeJS.ProcessEnv={HOME:'/home/node',PATH:'/usr/bin',SRT_PROXY_SOCKET:'/tmp/srt.sock',HTTPS_PROXY:'http://proxy',ALL_PROXY:'http://proxy',NODE_EXTRA_CA_CERTS:'/etc/ca',TMPDIR:'/tmp/vendor',CODEX_HOME:'/private/auth',CODEX_AUTH_JSON:'secret',CODEX_API_KEY:'secret',OPENAI_API_KEY:'secret',ANTHROPIC_AUTH_TOKEN:'secret',CLAUDE_CODE_OAUTH_TOKEN:'secret',CONTROL_TOKEN:'secret',AUTH_STORAGE_KEY:'secret',AUTH_RETURN_PRIVATE_KEY:'secret',CLOUDFLARE_API_TOKEN:'secret',AWS_SECRET_ACCESS_KEY:'secret',NODE_OPTIONS:'secret',NODE_PATH:'secret',LD_PRELOAD:'secret',LD_LIBRARY_PATH:'secret',BASH_ENV:'secret',ENV:'secret',UNDEFINED:undefined};
 assert.deepEqual(claudeGuardEnvironment(source),{HOME:'/home/node',PATH:'/opt/hivemind/compat-bin:/usr/bin',SRT_PROXY_SOCKET:'/tmp/srt.sock',HTTPS_PROXY:'http://proxy',ALL_PROXY:'http://proxy',NODE_EXTRA_CA_CERTS:'/etc/ca',TMPDIR:'/tmp',CODEX_HOME:'/home/node/.codex-guard'});assert.equal(source.CLAUDE_CODE_OAUTH_TOKEN,'secret');
});
test('only the Claude command guard prepends the fixed compatibility binary directory',()=>{
 const source={PATH:'/usr/local/bin:/usr/bin',OPENAI_API_KEY:'private-fake',CLAUDE_CODE_OAUTH_TOKEN:'private-fake'};
 const guarded=claudeGuardEnvironment(source);assert.equal(guarded.PATH,'/opt/hivemind/compat-bin:/usr/local/bin:/usr/bin');assert.deepEqual(claudeGuardEnvironment(guarded),guarded);assert.ok(!JSON.stringify(guarded).includes('private-fake'));
 assert.equal(buildEnv(source,'/home/node','codex').PATH,source.PATH);assert.ok(claudeGuardEnvironment({}).PATH!.startsWith('/opt/hivemind/compat-bin:/usr/local/sbin:'));
});
test('native outer settings and tested settings use one policy while retaining the nested approval gate',()=>{
 assert.deepEqual(claudeOuterSandboxSettings(),claudeCodexLayerSettings());
 const production=claudeSettings(CLAUDE_GUARD_PATHS,true).sandbox as any,outer=claudeOuterSandboxSettings() as any;
 for(const key of ['filesystem','network','credentials','allowNestedUserNamespaces','enableWeakerNestedSandbox'])assert.deepEqual(production[key],outer[key]);
 assert.deepEqual(outer.filesystem.allowWrite,['/workspace',claudeGuardHome(),'/tmp']);assert.deepEqual(outer.network,{allowedDomains:[],deniedDomains:[]});assert.equal((claudeOuterSandboxSettings(CLAUDE_GUARD_PATHS,false) as any).enableWeakerNestedSandbox,false);
});
test('Claude runtime creates a private credential-free Codex guard home before launching the official CLI',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-guard-home-'));try{
  const cli=join(dir,'fake.cjs'),keys=generateKeyPairSync('rsa',{modulusLength:2048});await writeFile(cli,`#!${process.execPath}\nconst fs=require('fs'),p=require('path'),home=p.join(process.env.HOME,'.codex-guard');if((fs.statSync(home).mode&0o777)!==0o700||fs.existsSync(p.join(home,'auth.json')))process.exit(7);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'guard home prepared'}));`,{mode:0o755});
  const result=await executeRuntime({version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'claude',instructions:'Fixture',snapshot:createSnapshot([]),timeoutMs:3000,auth:'sk-ant-oat01-fake-fixture',authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()},{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{claude:cli}});assert.equal(result.process.status,'passed');assert.equal(result.summary,'guard home prepared');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Claude runtime refuses credentials in the guard home before any CLI starts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-guard-auth-refusal-'));try{
  const home=join(dir,'home'),guardHome=join(home,'.codex-guard'),marker=join(dir,'unexpected-cli'),cli=join(dir,'fake.cjs'),keys=generateKeyPairSync('rsa',{modulusLength:2048});await mkdir(guardHome,{recursive:true,mode:0o700});await writeFile(join(guardHome,'auth.json'),'FAKE_GUARD_AUTH');await writeFile(cli,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'bad');`,{mode:0o755});
  const result=await executeRuntime({version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'claude',instructions:'Fixture',snapshot:createSnapshot([]),timeoutMs:3000,auth:'sk-ant-oat01-fake-fixture',authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()},{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home,commands:{claude:cli}});assert.equal(result.process.status,'error');assert.match(result.process.stderr,/Guard home must be credential-free/);await assert.rejects(readFile(marker));
 }finally{await rm(dir,{recursive:true,force:true});}
});
