import {test} from 'node:test';import assert from 'node:assert/strict';import {nativeParallelEvidence} from '../src/evidence.ts';
const time=(n:number)=>new Date(1700000000000+n).toISOString();
const claude=(id:string,start:number,end:number,sessionId='root')=>[{event:'SubagentStart',agentId:id,agentType:'worker',sessionId,timestamp:time(start)},{event:'SubagentStop',agentId:id,agentType:'worker',sessionId,timestamp:time(end)}];
const codex=(id:string,start:number,end:number,parent='root')=>({storageThreadId:id,storageSource:{parent_thread_id:parent},malformedRows:0,lifecycle:[{type:'task_started',timestamp:time(start)},{type:'task_complete',timestamp:time(end)}]});
test('Claude needs distinct completed workers from the same session with overlapping intervals',()=>{
 assert.equal(nativeParallelEvidence('claude','root',claude('one',0,100)),null);
 assert.equal(nativeParallelEvidence('claude','root',[...claude('one',0,100),...claude('two',100,200)]),null);
 assert.equal(nativeParallelEvidence('claude','root',[...claude('one',0,100),...claude('two',50,200,'other')]),null);
 assert.equal(nativeParallelEvidence('claude','root',[...claude('one',0,100),...claude('two',50,200)])?.overlapMs,50);
});
test('Codex parent rollout and one child cannot count as two native children',()=>{
 const parent={...codex('root',0,1000),spawnReturns:[{agentId:'one'},{agentId:'two'}]};
 assert.equal(nativeParallelEvidence('codex','root',[parent,codex('one',0,100)]),null);
 assert.equal(nativeParallelEvidence('codex','root',[parent,codex('one',0,100),codex('two',100,200)]),null);
 assert.equal(nativeParallelEvidence('codex','root',[parent,codex('one',0,100),codex('unrelated',50,150,'other')]),null);
 assert.equal(nativeParallelEvidence('codex','root',[parent,codex('one',0,100),codex('two',50,200)])?.overlapMs,50);
 assert.equal(nativeParallelEvidence('codex','root',[parent,{...codex('one',0,100),malformedRows:1},codex('two',50,200)]),null);
});
