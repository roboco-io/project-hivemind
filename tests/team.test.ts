import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamEngine } from '../packages/core/src/team.js';
import type { TeamSpec, TeamActor } from '../packages/contracts/src/team.js';
export const spec: TeamSpec = { id: 'team', workflowId: '12345678-1234-4234-8234-123456789abc', contractHash: 'a'.repeat(64), endsAt: 1000000, maxConcurrentClaims: 2, members: [{ id: 'a', role: 'worker', writes: ['src/'] }, { id: 'v', role: 'verifier', writes: ['src/'] }], tasks: [{ id: 'a', title: 'root', dependencies: [], writes: ['src/a'], assignee: 'a' }, { id: 'v', title: 'verify', dependencies: ['a'], writes: ['src/v'], assignee: 'v' }] };
export const actor: TeamActor = { teamId: 'team', memberId: 'a', jobId: 'job', attempt: 'attempt-1' };
function ready() { const e = new TeamEngine(); e.create(spec, 0); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'running' }], 1); return e; }
test('creates single persistent state with safe public views', () => { const e = ready(); assert.equal(e.snapshot()?.spec.id, 'team'); const l = e.claim('team', actor, 'a', 2); assert.ok(l.token); assert.ok(!JSON.stringify([e.summary('team'), e.tasks('team'), e.events('team')]).includes(l.token)); });
test('DAG requires trusted complete evidence', () => { const e = ready(); const v = { ...actor, memberId: 'v', jobId: 'verify' }; e.observe('team', [{ memberId: 'v', jobId: 'verify', attempt: 'attempt-1', status: 'running' }], 2); assert.throws(() => e.claim('team', v, 'v', 3)); const l = e.claim('team', actor, 'a', 3); e.submit('team', actor, l, { outcome: 'candidate', evidenceRef: 'proof' }, 4); assert.throws(() => e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'verified' }], 5)); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'verified', evidenceRef: 'proof', snapshotId: 'snap', checksPassed: true, containerStopped: true, authSynced: true }], 5); assert.ok(e.claim('team', v, 'v', 6)); });
test('expired lease requires trusted stop before recovery and fences stale completion', () => { const e = ready(); const l = e.claim('team', actor, 'a', 2); e.tick('team', 40000); assert.equal(e.tasks('team')[0]?.status, 'recovery_required'); assert.throws(() => e.claim('team', actor, 'a', 40001)); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'stopped', containerStopped: true, authSynced: true }], 40002); e.observe('team', [{ memberId: 'a', jobId: 'job2', attempt: 'attempt-2', status: 'running' }], 40003); const next = e.claim('team', { ...actor, jobId: 'job2', attempt: 'attempt-2' }, 'a', 40004); assert.ok(next.generation > l.generation); assert.throws(() => e.submit('team', actor, l, { outcome: 'candidate', evidenceRef: 'old' }, 40005)); });
test('errors rollback and identity cannot cross bindings', () => { const e = ready(); const before = e.snapshot(); assert.throws(() => e.claim('team', { ...actor, attempt: 'attempt-2' }, 'a', 2)); assert.deepEqual(e.snapshot(), before); assert.throws(() => e.addTask('team', actor, { id: 'bad', title: 'bad', dependencies: [], writes: ['../x'] }, 2)); assert.deepEqual(e.snapshot(), before); });
test('security block and review remain terminal and replay is idempotent', () => { const e = ready(); const b = { category: 'sandbox_escape' as const, reason: 'escape', evidenceRef: 'finding' }; e.block('team', b, 2); const n = e.events('team').length; e.block('team', b, 3); assert.equal(e.events('team').length, n); e.review('team', { reason: 'reviewed' }, 4); assert.equal(e.summary('team').blocked, true); assert.throws(() => e.claim('team', actor, 'a', 5)); });
test('normal event saturation preserves block review and stopped cleanup', () => { const e = ready(); const l = e.claim('team', actor, 'a', 2); for (let i = e.snapshot()!.events.length; i < 2048; i++)
    e.heartbeat('team', actor, l, 3); assert.throws(() => e.heartbeat('team', actor, l, 3)); const beforeRead=e.snapshot();e.authorizeActor('team',actor,3);assert.deepEqual(e.snapshot(),beforeRead); e.block('team', { category: 'monitor_tampering', reason: 'stop', evidenceRef: 'finding' }, 4); e.review('team', { reason: 'review' }, 5); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'stopped', containerStopped: true, authSynced: true }], 6); assert.equal(e.summary('team').blocked, true); assert.throws(() => e.claim('team', actor, 'a', 7)); assert.ok(e.snapshot()!.events.length > 2048); });
test('strict spec rejects cycles unknown fields and escaping paths', () => { for (const patch of [{ endsAt: NaN }, { unexpected: true }, { tasks: [{ ...spec.tasks[0]!, dependencies: ['a'] }] }, { tasks: [{ ...spec.tasks[0]!, writes: ['/escape'] }] }])
    assert.throws(() => new TeamEngine().create({ ...spec, ...patch }, 0)); });
test('notes bounded and pages use numeric cursor', () => { const e = ready(); assert.throws(() => e.addNote('team', actor, { text: '한'.repeat(1000) }, 2)); for (let i = 0; i < 256; i++)
    e.addNote('team', actor, { text: 'note' }, 2); assert.throws(() => e.addNote('team', actor, { text: 'over' }, 3)); assert.equal(e.notes('team', { after: 2, limit: 2 }).length, 2); e.block('team', { category: 'credential_scope', reason: 'scope', evidenceRef: 'finding' }, 4); });
test('known lease secrets cannot enter public notes or block reasons', () => { const e = ready(); const l = e.claim('team', actor, 'a', 2); assert.throws(() => e.addNote('team', actor, { text: l.token }, 3)); assert.throws(() => e.block('team', { category: 'credential_scope', reason: l.token, evidenceRef: 'ref' }, 3)); });
test('byte saturation still reserves recovery space without trimming history', () => { const e = new TeamEngine(); const large = { ...spec, tasks: Array.from({ length: 25 }, (_, i) => ({ id: 'task' + i, title: 'x'.repeat(512), dependencies: [], assignee: 'a', writes: Array.from({ length: 32 }, (_, j) => 'src/' + i + '/' + j + 'x'.repeat(230)) })) }; e.create(large, 0); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'running' }], 1); let saturated = false; for (let i = 0; i < 256; i++) {
    try {
        e.addNote('team', actor, { text: 'x'.repeat(2048) }, 2);
    }
    catch {
        saturated = true;
        break;
    }
} assert.equal(saturated, true); const before = e.snapshot()!.events.length; e.block('team', { category: 'monitor_tampering', reason: 'stop', evidenceRef: 'ref' }, 3); e.review('team', { reason: 'review' }, 4); assert.equal(e.snapshot()!.events.length, before + 2); assert.ok(new TextEncoder().encode(JSON.stringify(e.snapshot())).length <= 1048576); });
test('trusted failure ends team without security finding', () => { const e = ready(); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'failed' }], 2); assert.equal(e.summary('team').status, 'failed'); assert.equal(e.summary('team').block, undefined); });
test('restored state rejects invalid private lease', () => { const e = ready(); e.claim('team', actor, 'a', 2); const s = e.snapshot()!; s.leases[0]!.expiresAt = NaN; assert.throws(() => new TeamEngine(s)); });
test('claims fence overlapping paths including submitted ownership', () => { const s = structuredClone(spec); s.members[1]!.role = 'worker'; s.tasks[1]!.dependencies = []; s.tasks[1]!.writes = ['src/A']; const e = new TeamEngine(); e.create(s, 0); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'running' }, { memberId: 'v', jobId: 'other', attempt: 'other-attempt', status: 'running' }], 1); const a = e.claim('team', actor, 'a', 2); const v = { ...actor, memberId: 'v', jobId: 'other', attempt: 'other-attempt' }; assert.throws(() => e.claim('team', v, 'v', 3)); e.submit('team', actor, a, { outcome: 'candidate', evidenceRef: 'ref' }, 3); assert.throws(() => e.claim('team', v, 'v', 4)); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'stopped', containerStopped: true, authSynced: true }], 5); assert.ok(e.claim('team', v, 'v', 6)); });
test('trusted verifier cannot bypass unverified dependencies', () => { const e = ready(); assert.throws(() => e.observe('team', [{ memberId: 'v', jobId: 'verify', attempt: 'v-attempt', status: 'verified', evidenceRef: 'ref', snapshotId: 'snap', checksPassed: true, containerStopped: true, authSynced: true }], 2)); assert.equal(e.tasks('team')[1]!.status, 'pending'); });
test('verified stopped members cannot resume worker authority', () => { const e = ready(); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'verified', evidenceRef: 'ref', snapshotId: 'snap', checksPassed: true, containerStopped: true, authSynced: true }], 2); assert.throws(() => e.addNote('team', actor, { text: 'late' }, 3)); assert.throws(() => e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'running' }], 4)); });
test('strict paths reject empty control and noncanonical segments', () => { for (const p of ['src//x', 'src/\nx', 'src/e\u0301'])
    assert.throws(() => new TeamEngine().create({ ...spec, tasks: [{ ...spec.tasks[0]!, writes: [p] }] }, 0)); });
test('lease member field is checked', () => { const e = ready(); const l = e.claim('team', actor, 'a', 2); assert.throws(() => e.heartbeat('team', actor, { ...l, memberId: 'v' }, 3)); });
test('observation replay survives restart without consuming history', () => { let e = ready(); const f = { memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'running' as const }; const before = e.snapshot()!.events.length; e = new TeamEngine(e.snapshot()); for (let i = 0; i < 2100; i++)
    e.observe('team', [f], 2); assert.equal(e.snapshot()!.events.length, before); });
test('trusted failure never clears block and terminal replays do not append', () => { const e = ready(); e.fail('team', { reason: 'deadline' }, 2); const n = e.snapshot()!.events.length; e.fail('team', { reason: 'deadline' }, 3); assert.equal(e.snapshot()!.events.length, n); e.block('team', { category: 'sandbox_escape', reason: 'stop', evidenceRef: 'ref' }, 4); e.fail('team', { reason: 'late' }, 5); assert.equal(e.summary('team').status, 'blocked'); });
test('constructor task ID is fenced as an own generation key', () => { const e = new TeamEngine(); e.create({ ...spec, tasks: [{ ...spec.tasks[0]!, id: 'constructor' }] }, 0); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'running' }], 1); assert.equal(e.claim('team', actor, 'constructor', 2).generation, 1); assert.ok(new TeamEngine(e.snapshot()).snapshot()); });
test('tampered state rejects task mismatch duplicated lease sequence and provenance', () => { const e = ready(); e.claim('team', actor, 'a', 2); for (const mutate of [(s: ReturnType<typeof e.snapshot>) => s!.tasks.push({ ...s!.tasks[0]!, id: 'extra' }), (s: ReturnType<typeof e.snapshot>) => s!.leases.push(s!.leases[0]!), (s: ReturnType<typeof e.snapshot>) => s!.events.push(s!.events[0]!), (s: ReturnType<typeof e.snapshot>) => { s!.events[0]!.source = 'worker_report'; }]) {
    const s = e.snapshot();
    mutate(s);
    assert.throws(() => new TeamEngine(s));
} });
test('late verified cleanup stays blocked and restores without private active lease', () => { const e = ready(); e.claim('team', actor, 'a', 2); e.block('team', { category: 'sandbox_escape', reason: 'stop', evidenceRef: 'ref' }, 3); e.observe('team', [{ memberId: 'a', jobId: 'job', attempt: 'attempt-1', status: 'verified', evidenceRef: 'proof', snapshotId: 'snap', checksPassed: true, containerStopped: true, authSynced: true }], 4); assert.equal(new TeamEngine(e.snapshot()).summary('team').blocked, true); assert.equal(e.snapshot()!.leases.length, 0); });
test('expected errors expose safe HTTP status codes', () => { const e = ready(); assert.throws(() => e.summary('missing'), { statusCode: 404 }); assert.throws(() => e.events('team', { limit: 0 }), { statusCode: 400 }); const l = e.claim('team', actor, 'a', 2); assert.throws(() => e.claim('team', actor, 'a', 3), { statusCode: 409 }); assert.throws(() => e.submit('team', actor, { ...l, token: 'wrong' }, { outcome: 'candidate', evidenceRef: 'ref' }, 3), { statusCode: 409 }); });
test('retired lease tokens cannot be copied into later public notes', () => { const e = ready(); const l = e.claim('team', actor, 'a', 2); e.submit('team', actor, l, { outcome: 'candidate', evidenceRef: 'ref' }, 3); assert.throws(() => e.addNote('team', actor, { text: l.token }, 4)); });
test('task-specific root proof survives added subtask without verifying child', () => {
    const e = ready();
    e.addTask('team', actor, {id:'child',title:'child',dependencies:[],writes:['src/child'],assignee:'a'}, 2);
    const lease=e.claim('team',actor,'child',3);
    e.submit('team',actor,lease,{outcome:'candidate',evidenceRef:'child-proof'},4);
    const proof={memberId:'a',jobId:'job',attempt:'attempt-1',taskId:'a',status:'verified' as const,evidenceRef:'root-proof',snapshotId:'root-snapshot',checksPassed:true,containerStopped:true,authSynced:true};
    e.observe('team',[proof],5);
    assert.equal(e.tasks('team').find(t=>t.id==='a')!.status,'verified');
    assert.equal(e.tasks('team').find(t=>t.id==='child')!.status,'submitted');
    const restored=new TeamEngine(e.snapshot()), count=restored.snapshot()!.events.length;
    restored.observe('team',[proof],6);
    assert.equal(restored.snapshot()!.events.length,count);
});
test('task-specific observations reject wrong owner unknown task and unresolved dependency',()=>{
    const e=ready();
    const proof={memberId:'a',jobId:'job',attempt:'attempt-1',taskId:'v',status:'verified' as const,evidenceRef:'proof',snapshotId:'snapshot',checksPassed:true,containerStopped:true,authSynced:true};
    const before=e.snapshot();
    assert.throws(()=>e.observe('team',[proof],2));
    assert.throws(()=>e.observe('team',[{...proof,taskId:'missing'}],2));
    assert.throws(()=>e.observe('team',[{...proof,memberId:'v',jobId:'verifier',attempt:'v-attempt'}],2));
    assert.deepEqual(e.snapshot(),before);
});
test('multi-task verification remains ambiguous without task ID',()=>{
    const e=ready();e.addTask('team',actor,{id:'child',title:'child',dependencies:[],writes:['src/child'],assignee:'a'},2);
    assert.throws(()=>e.observe('team',[{memberId:'a',jobId:'job',attempt:'attempt-1',status:'verified',evidenceRef:'proof',snapshotId:'snapshot',checksPassed:true,containerStopped:true,authSynced:true}],3),/ambiguous/);
});
test('task observation dedup is bounded by tasks and members and survives restore',()=>{
    const e=ready();for(let i=0;i<17;i++)e.addTask('team',actor,{id:'child'+i,title:'child',dependencies:[],writes:['src/child'+i],assignee:'a'},2);
    const facts=Array.from({length:17},(_,i)=>({memberId:'a',jobId:'job',attempt:'attempt-1',taskId:'child'+i,status:'candidate' as const,evidenceRef:'proof'+i}));
    e.observe('team',facts,3);const restored=new TeamEngine(e.snapshot()),before=restored.snapshot()!;
    restored.observe('team',facts,4);assert.equal(restored.snapshot()!.events.length,before.events.length);
    assert.equal(restored.snapshot()!.observations!.length,18);
});
test('private state requires persisted format version 1', () => {
    const e=ready();
    assert.equal((e.snapshot() as unknown as {version?:number}).version,1);
    for(const version of [undefined,0,2,'1']){
        const state=structuredClone(e.snapshot()) as unknown as Record<string,unknown>;
        if(version===undefined)delete state.version;else state.version=version;
        assert.throws(()=>new TeamEngine(state as unknown as NonNullable<ReturnType<typeof e.snapshot>>));
    }
});
test('block replays preserve immutable first cause and reject different findings',()=>{
    const e=ready(), input={category:'sandbox_escape' as const,reason:'first cause',evidenceRef:'first-proof'};
    e.block('team',input,2);const before=e.snapshot();
    e.block('team',{...input},3);assert.deepEqual(e.snapshot(),before);
    for(const changed of [{...input,category:'credential_scope' as const},{...input,reason:'different cause'},{...input,evidenceRef:'different-proof'}]){
        assert.throws(()=>e.block('team',changed,4),{statusCode:409});assert.deepEqual(e.snapshot(),before);
    }
});
test('review replays preserve immutable reason and reject changes',()=>{
    const e=ready();e.block('team',{category:'sandbox_escape',reason:'cause',evidenceRef:'proof'},2);
    e.review('team',{reason:'first review'},3);const before=e.snapshot();
    e.review('team',{reason:'first review'},4);assert.deepEqual(e.snapshot(),before);
    assert.throws(()=>e.review('team',{reason:'different review'},5),{statusCode:409});assert.deepEqual(e.snapshot(),before);
});
for(const status of ['candidate','verified','failed'] as const)test('normal event saturation permits trusted '+status+' finish and auth persistence',()=>{
    const e=ready(),lease=e.claim('team',actor,'a',2);
    while(e.snapshot()!.events.length<2048)e.heartbeat('team',actor,lease,3);
    const before=e.snapshot()!.events;
    e.observe('team',[{memberId:'a',jobId:'job',attempt:'attempt-1',taskId:'a',status,evidenceRef:'finish-proof',snapshotId:'finish-snapshot',checksPassed:true,containerStopped:true,authSynced:true}],4);
    const restored=new TeamEngine(e.snapshot()),state=restored.snapshot()!;
    assert.equal(state.tasks.find(t=>t.id==='a')!.status,status==='candidate'?'submitted':status);
    assert.equal(state.spec.members.find(m=>m.id==='a')!.stopped,true);
    assert.equal(state.leases.length,0);
    assert.deepEqual(state.events.slice(0,2048),before);
    assert.equal(state.events.length,2049);
    restored.block('team',{category:'monitor_tampering',reason:'stop',evidenceRef:'finding'},5);
    restored.review('team',{reason:'review'},6);
    assert.equal(restored.summary('team').blocked,true);
    assert.throws(()=>restored.claim('team',actor,'a',7));
});
test('worker read authorization accepts only current own-team actor without mutation',()=>{
    const e=ready(),before=e.snapshot();
    assert.equal(e.authorizeActor('team',actor,2),undefined);
    assert.deepEqual(e.snapshot(),before);
    for(const invalid of [{...actor,teamId:'other'},{...actor,memberId:'v'},{...actor,jobId:'other'},{...actor,attempt:'old'}]){
        assert.throws(()=>e.authorizeActor('team',invalid,2),{statusCode:409});
        assert.deepEqual(e.snapshot(),before);
    }
    assert.throws(()=>e.authorizeActor('missing',actor,2),{statusCode:404});
    assert.throws(()=>e.authorizeActor('team',actor,NaN),{statusCode:400});
    assert.throws(()=>e.authorizeActor('team',actor,spec.endsAt),{statusCode:409});
    assert.deepEqual(e.snapshot(),before);
});
test('worker read authorization rejects stopped replaced and blocked actors',()=>{
    const e=ready();e.observe('team',[{memberId:'a',jobId:'job',attempt:'attempt-1',status:'stopped',containerStopped:true,authSynced:true}],2);
    assert.throws(()=>e.authorizeActor('team',actor,3),{statusCode:409});
    e.observe('team',[{memberId:'a',jobId:'new-job',attempt:'new-attempt',status:'running'}],4);
    assert.throws(()=>e.authorizeActor('team',actor,5),{statusCode:409});
    const current={...actor,jobId:'new-job',attempt:'new-attempt'};
    e.authorizeActor('team',current,5);
    e.block('team',{category:'identity_mismatch',reason:'stop',evidenceRef:'finding'},6);
    const before=e.snapshot();assert.throws(()=>e.authorizeActor('team',current,7),{statusCode:409});assert.deepEqual(e.snapshot(),before);
});
