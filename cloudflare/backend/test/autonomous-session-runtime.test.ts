import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshot} from '../src/snapshot.ts';
import {validateAutonomousSession} from '../src/runtime/autonomous-session.ts';
const id='12345678-1234-4234-8234-123456789abc';
const bundle={version:1,sessionId:id,model:'claude-sonnet-4-6',workspacePath:'/workspace',snapshot:createSnapshot([]),transcripts:[{path:id+'.jsonl',content:'{}\n'}]};
test('synthetic bundle validates exact project/session and rejects traversal and auth',()=>{
 assert.doesNotThrow(()=>validateAutonomousSession(bundle,id,bundle.model));
 for(const path of ['../auth.json',id+'/subagents/../../auth.json','.credentials.json'])assert.throws(()=>validateAutonomousSession({...bundle,transcripts:[{path,content:'{}'}]},id,bundle.model));
 assert.throws(()=>validateAutonomousSession({...bundle,workspacePath:'/other'},id,bundle.model));
 assert.throws(()=>validateAutonomousSession({...bundle,transcripts:[{path:id+'.jsonl',content:'sk-ant-oat01-secret'}]},id,bundle.model));
});
import {mkdtemp,mkdir,writeFile,symlink,link,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectAutonomousSession,autonomousProjectDirectory,rejectSessionSecrets} from '../src/runtime/autonomous-session.ts';
test('ordinary credential identifiers are source text, actual token bytes are refused',()=>{
 assert.doesNotThrow(()=>rejectSessionSecrets('CONTROL_TOKEN AUTH_STORAGE_KEY access_token refresh_token CLAUDE_CODE_OAUTH_TOKEN'));
 assert.throws(()=>rejectSessionSecrets('value secret-value-here',['secret-value-here']));
 assert.throws(()=>rejectSessionSecrets('sk-ant-oat01-live-token'));
});
test('synthetic collection excludes dependency links and rejects included transcript/workspace links',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'session-fake-')),paths={home:join(root,'home'),workspace:join(root,'workspace')};
 try{const project=autonomousProjectDirectory(paths.home);await mkdir(project,{recursive:true});await mkdir(paths.workspace);await writeFile(join(project,id+'.jsonl'),'{}\n');
 await mkdir(join(paths.workspace,'node_modules','.bin'),{recursive:true});await symlink('/unreadable',join(paths.workspace,'node_modules','.bin/tool'));await writeFile(join(paths.workspace,'source.ts'),'const tokenName = "access_token CONTROL_TOKEN";');
 assert.equal((await collectAutonomousSession(paths,id,bundle.model)).snapshot.files.length,1);
 await link(join(paths.workspace,'source.ts'),join(paths.workspace,'linked.ts'));await assert.rejects(collectAutonomousSession(paths,id,bundle.model));await rm(join(paths.workspace,'linked.ts'));
 await rm(join(project,id+'.jsonl'));await symlink(join(paths.workspace,'source.ts'),join(project,id+'.jsonl'));await assert.rejects(collectAutonomousSession(paths,id,bundle.model));
 }finally{await rm(root,{recursive:true,force:true});}
});
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
test('workspace replaced by hardlink between preflight and snapshot read is refused',async(t)=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'session-race-')),paths={home:join(root,'home'),workspace:join(root,'workspace')};
 const original=fsPromises.lstat;let visits=0;
 try{const project=autonomousProjectDirectory(paths.home);await mkdir(project,{recursive:true});await mkdir(paths.workspace);await writeFile(join(project,id+'.jsonl'),'{}\n');
 const source=join(paths.workspace,'source.ts'),outside=join(root,'outside.txt');await writeFile(source,'approved');await writeFile(outside,'outside private file');
 t.mock.method(fsPromises,'lstat',async(...args:Parameters<typeof original>)=>{if(String(args[0])===source&&++visits===2){await rm(source);await link(outside,source);}return original(...args);});syncBuiltinESMExports();
 await assert.rejects(collectAutonomousSession(paths,id,bundle.model));assert.ok(visits>=2);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});
test('real Claude Code 2.1.319 subagent sidecar files are skipped, transcripts kept, unknown files still refused',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'session-sidecar-')),paths={home:join(root,'home'),workspace:join(root,'workspace')};
 try{const project=autonomousProjectDirectory(paths.home),children=join(project,id,'subagents');await mkdir(children,{recursive:true});await mkdir(paths.workspace);await writeFile(join(project,id+'.jsonl'),'{}\n');
 // 2.1.319 writes agent-<id>.meta.json beside each foreground subagent transcript.
 await writeFile(join(children,'agent-a1b2c3.jsonl'),'{"type":"user"}\n');await writeFile(join(children,'agent-a1b2c3.meta.json'),'{"agentType":"worker","description":"Check counter value"}');
 await writeFile(join(children,'agent-a1b2c3.prefix.json'),'{}');
 const b=await collectAutonomousSession(paths,id,bundle.model);
 assert.deepEqual(b.transcripts.map(t=>t.path).sort(),[id+'.jsonl',id+'/subagents/agent-a1b2c3.jsonl']);
 for(const name of ['notes.txt','agent-a1b2c3.jsonl.bak','agent-a1b2c3.Info.json','agent-a1b2c3.a.b.c.json']){
  await writeFile(join(children,name),'{}');await assert.rejects(collectAutonomousSession(paths,id,bundle.model));await rm(join(children,name));
 }
 await mkdir(join(children,'agent-dir.meta.json'));await assert.rejects(collectAutonomousSession(paths,id,bundle.model));
 }finally{await rm(root,{recursive:true,force:true});}
});
