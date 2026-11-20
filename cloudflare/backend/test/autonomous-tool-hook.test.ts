import {test} from 'node:test';
import assert from 'node:assert/strict';
import {autonomousToolGate} from '../src/runtime/autonomous-tool-hook.ts';
const policy={version:1 as const,tools:['Bash','Agent'],model:'claude-sonnet-4-6',subagentModel:'claude-sonnet-4-6'};
test('synthetic managed gate permits only approved worker and model',()=>{
 assert.doesNotThrow(()=>autonomousToolGate({tool_name:'Agent',tool_input:{subagent_type:'worker',prompt:'work',description:'work'}},policy));
 for(const input of [{subagent_type:'Explore',model:policy.model},{subagent_type:'worker',model:'opus'},{subagent_type:'worker',model:policy.model}])assert.throws(()=>autonomousToolGate({tool_name:'Agent',tool_input:input},policy));
 assert.throws(()=>autonomousToolGate({tool_name:'Bash',tool_input:{}},{...policy,tools:['Agent']}));
 assert.doesNotThrow(()=>autonomousToolGate({tool_name:'Agent'},undefined));
});
test('managed policy rejects duplicate and Agent-only tools, permits safe model identifier',()=>{
 for(const tools of [[],['Agent'],['Bash','Bash'],['Bash','Agent','Agent']])assert.throws(()=>autonomousToolGate({tool_name:'Bash'},{...policy,tools}));
 assert.doesNotThrow(()=>autonomousToolGate({tool_name:'Bash'},{...policy,model:'Fable-1',subagentModel:'Fable-1'}));
 for(const option of [{run_in_background:true},{isolation:'worktree'},{team_name:'x'},{max_turns:0},{model:policy.model}])assert.throws(()=>autonomousToolGate({tool_name:'Agent',tool_input:{subagent_type:'worker',prompt:'work',description:'work',...option}},policy));
});
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('policy FIFO fails closed without waiting for a writer',async()=>{
 if(process.platform==='win32')return;
 const root=await mkdtemp(join(await realpath(tmpdir()),'policy-fifo-'));
 try{const dir=join(root,'private');await mkdir(dir,{mode:0o700});const path=join(dir,'policy.json');assert.equal(spawnSync('mkfifo',[path]).status,0);
 const module=fileURLToPath(new URL('../src/runtime/autonomous-tool-hook.ts',import.meta.url));
 const script=`import {loadAutonomousPolicy} from ${JSON.stringify('file://'+module)};try{await loadAutonomousPolicy(${JSON.stringify(path)});process.exit(1);}catch{process.exit(0);}`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:1500});assert.equal(child.error,undefined);assert.equal(child.status,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
