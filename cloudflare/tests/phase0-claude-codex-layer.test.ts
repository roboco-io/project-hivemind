import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as layer from '../scripts/phase0/claude-codex-layer-probe.ts';
import {providerArgs} from '../backend/src/runtime/providers.ts';
import {CLAUDE_GUARD_PATHS,claudeOuterSandboxSettings,claudeGuardSandboxArgs,claudeGuardEnvironment} from '../backend/src/runtime/claude-command-guard.ts';

const required=['workspaceWrite','outsideWriteDenied','outsideSentinelUnchanged','guardCacheWriteDenied','guardCacheSentinelUnchanged','guardCacheCredentialsAbsent','claudeAuthReadDenied','claudeConfigReadDenied','privateReadDenied','runtimeInputReadDenied','procReadDenied','parentProcessInfoDenied','parentRootAliasDenied','parentMemoryDenied','parentEnvironmentDenied','parentReadlinksDenied','threadAliasesDenied','siblingAliasesDenied','privateHardlinkDenied','fixtureCredentialAbsent','managementCredentialsAbsent','devNullWritable','ignoredSpawnWorks','unshareBlocked','mountNamespaceBlocked','bubblewrapBlocked','namespaceSyscallsBlocked','networkDenied','namespaceGuardApplied'];
const good=()=>({uid:1000,toolUid:1000,noNewPrivileges:'1',capabilities:{CapInh:'0',CapPrm:'0',CapEff:'0',CapBnd:'0',CapAmb:'0'},exitCode:0,timedOut:false,captureLimit:false,authProvided:false,modelCalled:false,...Object.fromEntries(required.map(key=>[key,true]))});
test('Claude/Codex prototype cannot pass with missing defenses or real authentication',()=>{
 const assess=(layer as any).assessClaudeCodexLayer;assert.equal(typeof assess,'function');assert.equal(assess(good()).passed,true);
 for(const key of required){const missing:Record<string,unknown>=good();delete missing[key];assert.equal(assess(missing).passed,false,key);assert.equal(assess({...good(),[key]:false}).passed,false,key);}
 for(const patch of [{authProvided:true},{modelCalled:true},{uid:0},{toolUid:0},{noNewPrivileges:'0'},{capabilities:{CapEff:'0'}},{exitCode:31},{timedOut:true},{captureLimit:true}])assert.equal(assess({...good(),...patch}).passed,false);
});
test('prototype permits outer nesting only around the exact inner production permission profile',()=>{
 const settings=(layer as any).claudeCodexLayerSettings;const args=(layer as any).claudeCodexLayerArgs;assert.equal(typeof settings,'function');assert.equal(typeof args,'function');
 const outer=settings();assert.equal(outer.enableWeakerNestedSandbox,true);assert.equal(outer.allowNestedUserNamespaces,true);assert.ok(outer.filesystem.allowWrite.includes('/home/node/.codex-guard'));assert.ok(outer.filesystem.allowWrite.includes('/workspace'));assert.ok(outer.filesystem.allowWrite.includes('/tmp'),'trusted Codex bubblewrap builder needs normal system temporary files');assert.deepEqual(outer.credentials.envVars,[{name:'CLAUDE_CODE_OAUTH_TOKEN',mode:'deny'}]);
 const inner=args({outerPid:12345,threadIds:[12345,12346],siblingIds:[1,12347]});assert.equal(inner[0],'sandbox');assert.equal(inner[inner.indexOf('-P')+1],'hivemind');assert.ok(!inner.includes('exec'));assert.ok(!inner.includes('login'));
 const production=providerArgs('codex','unused',{home:'/home/node',privateDir:'/home/node/.hivemind-phase0',workspace:'/workspace',scriptRoot:'/opt/hivemind/scripts/phase0'});
 for(let i=0;i<production.length;i++)if(production[i]==='-c')assert.ok(inner.includes(production[i+1]));
 const profiles=inner.filter((arg:string)=>arg.startsWith('permissions.hivemind='));assert.equal(profiles.length,2);
 const original=production.find((arg:string)=>arg.startsWith('permissions.hivemind='))!;assert.equal(profiles[0],original);
 const override=profiles[1];assert.ok(override.startsWith(original.slice(0,-2)+','));assert.ok(override.endsWith('}}'));
 for(const setting of ['"/home/node/.claude"="deny"','"/home/node/.claude.json"="deny"','"/home/node/.codex-guard"="read"'])assert.ok(override.includes(setting));
 assert.ok(!inner.some((arg:string)=>arg.startsWith('permissions.hivemind.filesystem.')));
 assert.equal(inner[inner.lastIndexOf('-c')+1],override,'full profile override is the last config argument');
 const script=inner.at(-1);assert.ok(script.includes("['-Ur','/bin/true']"));assert.ok(script.includes("'bwrap'"));assert.ok(script.includes('const outerPid=12345;'));assert.ok(script.includes('const threadIds=[12345,12346],siblingIds=[1,12347];'));
 assert.ok(script.includes("'/opt/hivemind/bin/namespace-probe'"));assert.ok(script.includes('No space left on device'));assert.ok(script.includes("host:'1.1.1.1',port:443"));
 assert.doesNotThrow(()=>new Function(script));
});
test('native namespace evidence requires successful complete syscall and privilege observations',()=>{
 const assess=(layer as any).assessNativeNamespaceProbe;assert.equal(typeof assess,'function');
 const observed={passed:true,uid:1000,capabilitiesZero:true,noNewPrivileges:true,unshareDenied:true,unshareErrno:1,cloneUserDenied:true,cloneErrno:13,cloneUserMountDenied:true,cloneMountErrno:28,clone3Denied:true,clone3Errno:38};
 const process={status:0,stdout:JSON.stringify(observed)};assert.equal(assess(process).passed,true);
 for(const patch of [{status:1},{error:{code:'ENOENT'}},{stdout:''},{stdout:'malformed'},{stdout:JSON.stringify({...observed,passed:false})},{stdout:JSON.stringify({...observed,cloneUserMountDenied:false})},{stdout:JSON.stringify({...observed,cloneErrno:22})},{stdout:JSON.stringify({...observed,cloneErrno:true})}])assert.equal(assess({...process,...patch}).passed,false);
 assert.equal(assess({...process,stdout:JSON.stringify({passed:true})}).passed,false);
});
test('layer command bridges SRT temporary directory to normal tmp without exposing guard cache writes',()=>{
 const command=(layer as any).claudeCodexLayerCommand;assert.equal(typeof command,'function');
 const context={outerPid:12345,threadIds:[12345],siblingIds:[1,12346]};const argv=command(context);
 assert.deepEqual(argv.slice(0,4),['/opt/hivemind/backend/src/runtime/claude-command-guard.ts','--','node','-e']);assert.equal(argv.at(-1),(layer as any).claudeCodexLayerArgs(context).at(-1));
 assert.ok(!argv.some((arg:string)=>arg.startsWith('TMPDIR=/home/node/.codex-guard')));assert.ok(argv.at(-1).includes('innerTmpdir:process.env.TMPDIR'));
});
test('diagnostic consumes the shared production guard policy and keeps only the fake SRT token challenge',()=>{
 assert.deepEqual((layer as any).claudeCodexLayerSettings(),claudeOuterSandboxSettings(CLAUDE_GUARD_PATHS,true));
 const context={outerPid:12345,threadIds:[12345],siblingIds:[1,12346]};const args=(layer as any).claudeCodexLayerArgs(context);
 assert.deepEqual(args,claudeGuardSandboxArgs(['node','-e',args.at(-1)],CLAUDE_GUARD_PATHS));
 const environment=(layer as any).claudeCodexLayerEnvironment;assert.equal(typeof environment,'function');
 const env=environment({PATH:'/bin',CLAUDE_CODE_OAUTH_TOKEN:'real-value-must-not-survive',OPENAI_API_KEY:'private',AWS_SECRET_ACCESS_KEY:'private'});
 assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,'NON_SECRET_CLAUDE_ENV_FIXTURE');assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.AWS_SECRET_ACCESS_KEY,undefined);
 assert.equal(env.CODEX_HOME,claudeGuardEnvironment({}).CODEX_HOME);assert.equal(env.TMPDIR,'/tmp');
});
