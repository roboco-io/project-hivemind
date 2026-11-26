import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryTeamRepository, SqliteTeamRepository } from '../packages/core/src/team-store.js';
const spec = { id: 'team', workflowId: '12345678-1234-4234-8234-123456789abc', contractHash: 'a'.repeat(64), endsAt: 1000000, maxConcurrentClaims: 1, members: [{ id: 'a', role: 'worker' as const, writes: ['src/'], jobId: 'job', attempt: 'attempt' }], tasks: [{ id: 'a', title: 'root', dependencies: [], writes: ['src/a'], assignee: 'a' }] };
const actor = { teamId: 'team', memberId: 'a', jobId: 'job', attempt: 'attempt' };
for (const mode of ['memory', 'sqlite'])
    test(mode + ' atomic race rollback and sync-only callback', async () => { const dir = mkdtempSync(join(tmpdir(), 'team-')); const repo = mode === 'memory' ? new MemoryTeamRepository() : new SqliteTeamRepository(join(dir, 'team.db')); try {
        await repo.mutate(spec.workflowId, e => e.create(spec, 0));
        const results = await Promise.allSettled([repo.mutate(spec.workflowId, e => e.claim('team', actor, 'a', 1)), repo.mutate(spec.workflowId, e => e.claim('team', actor, 'a', 1))]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const before = await repo.read(spec.workflowId);
        await assert.rejects(repo.mutate(spec.workflowId, e => { e.block('team', { category: 'sandbox_escape', reason: 'stop', evidenceRef: 'ref' }, 2); throw Error('rollback'); }));
        assert.deepEqual(await repo.read(spec.workflowId), before);
        await assert.rejects(repo.mutate(spec.workflowId, async (e) => { e.block('team', { category: 'sandbox_escape', reason: 'stop', evidenceRef: 'ref' }, 2); }));
        assert.deepEqual(await repo.read(spec.workflowId), before);
    }
    finally {
        repo.close();
        rmSync(dir, { recursive: true, force: true });
    } });
test('sqlite reopens private state and cross-connection claim is exclusive', async () => { const dir = mkdtempSync(join(tmpdir(), 'team-')), file = join(dir, 'team.db'); const a = new SqliteTeamRepository(file), b = new SqliteTeamRepository(file); try {
    await a.mutate(spec.workflowId, e => e.create(spec, 0));
    const r = await Promise.allSettled([a.mutate(spec.workflowId, e => e.claim('team', actor, 'a', 1)), b.mutate(spec.workflowId, e => e.claim('team', actor, 'a', 1))]);
    assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
    a.close();
    const c = new SqliteTeamRepository(file);
    assert.equal((await c.read(spec.workflowId))?.leases.length, 1);
    c.close();
}
finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('async mutator is rejected before its body starts', async () => { const repo = new MemoryTeamRepository(); await repo.mutate(spec.workflowId, e => e.create(spec, 0)); let started = false; await assert.rejects(repo.mutate(spec.workflowId, async () => { started = true; })); assert.equal(started, false); });
test('historical verification survives member rebind SQLite reopen and pending claim',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'team-history-')),file=join(dir,'team.db');
    let repo=new SqliteTeamRepository(file);
    try{
        const plan={...spec,tasks:[...spec.tasks,{id:'pending',title:'next',dependencies:['a'],writes:['src/pending'],assignee:'a'}]};
        await repo.mutate(spec.workflowId,e=>e.create(plan,0));
        const proof={taskId:'a',memberId:'a',jobId:'job',attempt:'attempt',status:'verified' as const,evidenceRef:'historical-proof',snapshotId:'historical-snapshot',checksPassed:true,containerStopped:true,authSynced:true};
        await repo.mutate(spec.workflowId,e=>e.observe('team',[proof],1));
        await repo.mutate(spec.workflowId,e=>e.observe('team',[{memberId:'a',jobId:'new-job',attempt:'new-attempt',status:'running'}],2));
        repo.close();repo=new SqliteTeamRepository(file);
        const restored=await repo.read(spec.workflowId);
        assert.deepEqual(restored!.tasks.find(t=>t.id==='a')!.verification,proof);
        assert.equal(restored!.spec.members[0]!.jobId,'new-job');
        await assert.rejects(repo.mutate(spec.workflowId,e=>e.claim('team',actor,'pending',3)),{statusCode:409});
        const lease=await repo.mutate(spec.workflowId,e=>e.claim('team',{...actor,jobId:'new-job',attempt:'new-attempt'},'pending',3));
        assert.equal(lease.taskId,'pending');
        repo.close();repo=new SqliteTeamRepository(file);
        assert.deepEqual((await repo.read(spec.workflowId))!.tasks.find(t=>t.id==='a')!.verification,proof);
    }finally{repo.close();rmSync(dir,{recursive:true,force:true});}
});
test('128 submitted tasks finish after normal event and byte saturation and persist block review',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'team-max-')),file=join(dir,'team.db');
    let repo=new SqliteTeamRepository(file);
    const normalBytes=512*1024,hardBytes=1024*1024;
    const memberId='member-'+ 'm'.repeat(121),jobId='job-'+ 'j'.repeat(124),attempt='attempt-'+ 'a'.repeat(120);
    const worker={teamId:'team',memberId,jobId,attempt};
    const tasks=Array.from({length:128},(_,i)=>({id:i===127?'last':('task-'+i+'-').padEnd(128,'t'),title:'task',dependencies:[] as string[],writes:['src/file'+i],assignee:memberId}));
    const members=Array.from({length:16},(_,i)=>({id:i===0?memberId:('member-'+i+'-').padEnd(128,'m'),role:'worker' as const,writes:['src/']}));
    const plan={...spec,members,tasks};
    const facts=tasks.map((t,i)=>({taskId:t.id,memberId,jobId,attempt,status:'verified' as const,evidenceRef:('evidence-'+i+'-').padEnd(128,'e'),snapshotId:('snapshot-'+i+'-').padEnd(128,'s'),checksPassed:true,containerStopped:true,authSynced:true}));
    try{
        await repo.mutate(spec.workflowId,e=>{
            e.create(plan,0);e.observe('team',[{memberId,jobId,attempt,status:'running'}],1);
            for(const t of tasks){
                const lease=e.claim('team',worker,t.id,2);
                if(t.id==='last')for(let n=e.snapshot()!.events.length;n<2047;n++)e.heartbeat('team',worker,lease,3);
                e.submit('team',worker,lease,{outcome:'candidate',evidenceRef:'candidate-proof'},4);
            }
            for(let i=0;i<256;i++){
                const size=new TextEncoder().encode(JSON.stringify(e.snapshot())).length;
                if(size+2400>normalBytes)break;
                e.addNote('team',worker,{text:'x'.repeat(2048)},5);
            }
            assert.equal(e.snapshot()!.tasks.filter(t=>t.status==='submitted').length,128);
            assert.equal(e.snapshot()!.events.length,2048);
            assert.ok(new TextEncoder().encode(JSON.stringify(e.snapshot())).length>normalBytes-2400);
        });
        const before=await repo.read(spec.workflowId);
        await repo.mutate(spec.workflowId,e=>e.observe('team',facts,6));
        await repo.mutate(spec.workflowId,e=>e.block('team',{category:'monitor_tampering',reason:'한'.repeat(2048),evidenceRef:'finding'},7));
        await repo.mutate(spec.workflowId,e=>e.review('team',{reason:'검'.repeat(2048)},8));
        repo.close();repo=new SqliteTeamRepository(file);
        const state=(await repo.read(spec.workflowId))!;
        assert.equal(state.tasks.filter(t=>t.status==='verified').length,128);
        assert.deepEqual(state.events.slice(0,2048),before!.events);
        assert.deepEqual(state.notes,before!.notes);
        assert.equal(state.events.length,2048+128+2);
        assert.ok(new TextEncoder().encode(JSON.stringify(state)).length<=hardBytes);
        assert.equal(state.status,'blocked');assert.ok(state.review);
        await assert.rejects(repo.mutate(spec.workflowId,e=>e.claim('team',worker,'last',9)),{statusCode:409});
    }finally{repo.close();rmSync(dir,{recursive:true,force:true});}
});
test('saturated root verification permits first integration running binding and full DAG persistence',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'team-dag-')),file=join(dir,'team.db');
    let repo=new SqliteTeamRepository(file);
    const plan={...spec,members:[...spec.members,{id:'integration',role:'verifier' as const,writes:['integration/']}],tasks:[...spec.tasks,{id:'integration',title:'integration',dependencies:['a'],writes:['integration/result'],assignee:'integration'}]};
    try{
        await repo.mutate(spec.workflowId,e=>{
            e.create(plan,0);const lease=e.claim('team',actor,'a',1);
            for(let i=e.snapshot()!.events.length;i<2048;i++)e.heartbeat('team',actor,lease,2);
        });
        const history=(await repo.read(spec.workflowId))!.events;
        await repo.mutate(spec.workflowId,e=>e.observe('team',[{taskId:'a',memberId:'a',jobId:'job',attempt:'attempt',status:'verified',evidenceRef:'root-proof',snapshotId:'root-snapshot',checksPassed:true,containerStopped:true,authSynced:true}],3));
        const running={taskId:'integration',memberId:'integration',jobId:'integration-job',attempt:'integration-attempt',status:'running' as const};
        await repo.mutate(spec.workflowId,e=>e.observe('team',[running],4));
        repo.close();repo=new SqliteTeamRepository(file);
        await repo.mutate(spec.workflowId,e=>e.observe('team',[running],5));
        assert.equal((await repo.read(spec.workflowId))!.events.length,2050);
        await repo.mutate(spec.workflowId,e=>e.observe('team',[{...running,status:'verified',evidenceRef:'integration-proof',snapshotId:'integration-snapshot',checksPassed:true,containerStopped:true,authSynced:true}],6));
        repo.close();repo=new SqliteTeamRepository(file);
        const state=(await repo.read(spec.workflowId))!;
        assert.equal(state.status,'completed');assert.equal(state.tasks.filter(t=>t.status==='verified').length,2);
        assert.deepEqual(state.events.slice(0,2048),history);assert.equal(state.events.length,2051);
    }finally{repo.close();rmSync(dir,{recursive:true,force:true});}
});
