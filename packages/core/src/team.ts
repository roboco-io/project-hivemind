import type { TeamState, TeamSpec, TeamSummary, TeamTask, TeamTaskInput, TeamActor, TeamLease, TeamPage, TeamEvent, TeamNote, TeamBlockInput, TeamReviewInput, TeamSubmitInput, TeamObservation, TeamMember } from '../../contracts/src/team.js';
import { teamPathsOverlap, validateTeamState, validateTeamSpec, TeamActorSchema, TeamLeaseSchema, TeamBlockInputSchema, TeamReviewInputSchema, TeamSubmitInputSchema, TeamNoteInputSchema, TeamPageSchema, TeamObservationSchema, TEAM_LIMITS } from '../../contracts/src/team.js';
const copy = <T>(v: T): T => structuredClone(v);
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
export class TeamError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode = 409) { super(message); this.statusCode = statusCode; this.name = 'TeamError'; }
}
export class TeamEngine {
    private state?: TeamState;
    constructor(state?: TeamState) { if (state)
        this.state = validateTeamState(state); }
    private get(id: string): TeamState { if (!this.state || this.state.spec.id !== id)
        throw new TeamError('team not found', 404); return this.state; }
    private change<T>(id: string, now: number, recovery: boolean, fn: (s: TeamState) => T): T { if (!Number.isSafeInteger(now) || now < 0)
        throw new TeamError('invalid time', 400); const before = copy(this.get(id)); try {
        const result = fn(this.get(id));
        const s = this.get(id);
        if (s.events.length > TEAM_LIMITS.events + (recovery ? TEAM_LIMITS.recoveryEvents : 0) || bytes(s) > (recovery ? TEAM_LIMITS.bytes : TEAM_LIMITS.normalBytes))
            throw new TeamError('team quota', 413);
        return copy(result);
    }
    catch (e) {
        this.state = before;
        if (e instanceof TeamError)
            throw e;
        if (e instanceof Error && e.name === 'ZodError')
            throw new TeamError('invalid input', 400);
        throw new TeamError(e instanceof Error ? e.message : 'team mutation rejected', 409);
    } }
    private safe(s: TeamState, value: unknown) { const text = JSON.stringify(value); if ([...(s.leaseTokens ?? []), ...s.leases.map(l => l.token)].some(token => text.includes(token) || text.includes(btoa(token)) || text.includes(encodeURIComponent(token))))
        throw Error('private lease in public data'); }
    private event(s: TeamState, type: string, at: number, source: TeamEvent['source'], taskId?: string) { s.events.push({ sequence: ++s.sequence, at, type, source, ...(taskId ? { taskId } : {}) }); }
    private active(s: TeamState, now: number) { if (s.status !== 'active' || now >= s.spec.endsAt)
        throw Error('team inactive'); }
    private actor(s: TeamState, input: TeamActor): TeamMember { const a = TeamActorSchema.parse(input); const m = s.spec.members.find(m => m.id === a.memberId); if (a.teamId !== s.spec.id || !m || m.jobId !== a.jobId || m.attempt !== a.attempt || m.stopped)
        throw Error('actor binding'); return m; }
    private task(s: TeamState, id: string) { const t = s.tasks.find(t => t.id === id); if (!t)
        throw new TeamError('task not found', 404); return t; }
    private lease(s: TeamState, actor: TeamActor, input: TeamLease, now: number) { this.actor(s, actor); const l = TeamLeaseSchema.parse(input); const current = s.leases.find(x => x.taskId === l.taskId); if (!current || current.token !== l.token || current.generation !== l.generation || current.memberId !== actor.memberId || l.memberId !== actor.memberId || current.expiresAt <= now || this.task(s, l.taskId).status !== 'claimed')
        throw Error('stale lease'); return current; }
    create(spec: TeamSpec, now: number): TeamSummary { if (this.state)
        throw Error('team exists'); let parsed: TeamSpec; try {
        parsed = validateTeamSpec(spec);
    }
    catch {
        throw new TeamError('invalid team spec', 400);
    } if (!Number.isSafeInteger(now) || now < 0 || now >= parsed.endsAt)
        throw new TeamError('invalid time', 400); const state: TeamState = { version: 1, spec: parsed, status: 'active', tasks: parsed.tasks.map(t => ({ ...copy(t), status: 'pending' })), leases: [], generations: {}, events: [], notes: [], sequence: 0 }; this.event(state, 'created', now, 'operator'); if (bytes(state) > TEAM_LIMITS.normalBytes)
        throw new TeamError('team quota', 413); this.state = state; return this.summary(spec.id); }
    snapshot(): TeamState | undefined { return copy(this.state); }
    /** 서버가 인증한 worker context를 읽기 전에 검사한다. 상태와 이벤트는 변경하지 않는다. */
    authorizeActor(id: string, actor: TeamActor, now: number): void {
        if(!Number.isSafeInteger(now)||now<0)throw new TeamError('invalid time',400);
        const state=this.get(id);
        try {this.active(state,now);this.actor(state,actor);}
        catch(error){
            if(error instanceof Error&&error.name==='ZodError')throw new TeamError('invalid actor',400);
            throw new TeamError('actor not authorized',409);
        }
    }
    summary(id: string): TeamSummary { const s = this.get(id); const taskCounts: TeamSummary['taskCounts'] = { pending: 0, claimed: 0, submitted: 0, verified: 0, failed: 0, recovery_required: 0 }; for (const t of s.tasks)
        taskCounts[t.status]++; return copy({ id: s.spec.id, workflowId: s.spec.workflowId, status: s.status, blocked: s.status === 'blocked', recoveryRequired: taskCounts.recovery_required > 0, taskCounts, ...(s.block ? { block: s.block } : {}), reviewed: !!s.review, endsAt: s.spec.endsAt }); }
    tasks(id: string): TeamTask[] { return copy(this.get(id).tasks); }
    private page<T extends {
        sequence: number;
    }>(rows: T[], page: TeamPage) { let p: TeamPage; try {
        p = TeamPageSchema.parse(page);
    }
    catch {
        throw new TeamError('invalid page', 400);
    } return copy(rows.filter(e => e.sequence > (p.after ?? 0)).slice(0, p.limit ?? 256)); }
    events(id: string, page: TeamPage = {}): TeamEvent[] { return this.page(this.get(id).events, page); }
    notes(id: string, page: TeamPage = {}): TeamNote[] { return this.page(this.get(id).notes, page); }
    addTask(id: string, actor: TeamActor, input: TeamTaskInput, now: number): TeamTask { return this.change(id, now, false, s => { this.active(s, now); const m = this.actor(s, actor); this.safe(s, input); const spec = validateTeamSpec({ ...s.spec, tasks: [...s.tasks.map(({ status: _status, evidenceRef: _evidence, verification: _verification, ...t }) => t), input] }); const t = spec.tasks.at(-1)!; if (t.assignee && t.assignee !== m.id || !t.writes.every(p => m.writes.some(w => p === w || w.endsWith('/') && p.startsWith(w))))
        throw Error('write scope'); s.spec.tasks = spec.tasks; const task: TeamTask = { ...t, status: 'pending' }; s.tasks.push(task); this.event(s, 'task_added', now, 'worker_report', t.id); return task; }); }
    claim(id: string, actor: TeamActor, taskId: string, now: number): TeamLease { return this.change(id, now, false, s => { this.active(s, now); const m = this.actor(s, actor), t = this.task(s, taskId); if (t.status !== 'pending' || t.assignee && t.assignee !== m.id || !t.writes.every(p => m.writes.some(w => p === w || w.endsWith('/') && p.startsWith(w))) || t.dependencies.some(d => this.task(s, d).status !== 'verified') || s.leases.length >= s.spec.maxConcurrentClaims || s.leases.some(l => l.memberId === m.id))
        throw Error('claim rejected'); if (s.tasks.some(other => other.id !== t.id && ['claimed', 'recovery_required', 'submitted', 'failed'].includes(other.status) && !s.spec.members.find(m => m.id === other.assignee)?.stopped && other.writes.some(p => t.writes.some(q => teamPathsOverlap(p, q)))))
        throw Error('write conflict'); const generation = (Object.hasOwn(s.generations, taskId) ? s.generations[taskId]! : 0) + 1; Object.defineProperty(s.generations, taskId, { value: generation, writable: true, enumerable: true, configurable: true }); const l = { taskId, memberId: m.id, token: crypto.randomUUID(), generation, expiresAt: Math.min(now + 30000, s.spec.endsAt) }; s.leases.push(l);
            (s.leaseTokens ??= []).push(l.token); t.assignee = m.id; s.spec.tasks.find(x => x.id === taskId)!.assignee = m.id; t.status = 'claimed'; this.event(s, 'claimed', now, 'worker_report', taskId); return l; }); }
    heartbeat(id: string, actor: TeamActor, lease: TeamLease, now: number): TeamLease { return this.change(id, now, false, s => { this.active(s, now); const l = this.lease(s, actor, lease, now); l.expiresAt = Math.min(now + 30000, s.spec.endsAt); this.event(s, 'heartbeat', now, 'worker_report', l.taskId); return l; }); }
    submit(id: string, actor: TeamActor, lease: TeamLease, input: TeamSubmitInput, now: number): TeamTask { return this.change(id, now, false, s => { this.active(s, now); this.safe(s, input); const l = this.lease(s, actor, lease, now), p = TeamSubmitInputSchema.parse(input), t = this.task(s, l.taskId); t.status = p.outcome === 'candidate' ? 'submitted' : 'failed'; t.evidenceRef = p.evidenceRef; s.leases = s.leases.filter(x => x !== l); this.event(s, 'submitted', now, 'worker_report', t.id); return t; }); }
    addNote(id: string, actor: TeamActor, input: {
        taskId?: string;
        text: string;
    }, now: number): TeamNote { return this.change(id, now, false, s => { this.active(s, now); this.actor(s, actor); this.safe(s, input); const p = TeamNoteInputSchema.parse(input); if (p.taskId)
        this.task(s, p.taskId); if (s.notes.length >= 256)
        throw new TeamError('note quota', 413); const n: TeamNote = { ...p, sequence: ++s.sequence, at: now, memberId: actor.memberId, source: 'worker_report' }; s.notes.push(n); return n; }); }
    block(id: string, input: TeamBlockInput, now: number): TeamSummary { return this.change(id, now, true, s => { this.safe(s, input); const p = TeamBlockInputSchema.parse(input); if (s.block) {
        if(s.block.category!==p.category||s.block.reason!==p.reason||s.block.evidenceRef!==p.evidenceRef)throw new TeamError('block first cause is immutable',409);
        return this.summary(id);
    } s.block = p; s.status = 'blocked'; for (const t of s.tasks)
        if (t.status === 'claimed')
            t.status = 'recovery_required'; this.event(s, 'security_blocked', now, 'operator'); return this.summary(id); }); }
    review(id: string, input: TeamReviewInput, now: number): TeamSummary { return this.change(id, now, true, s => { this.safe(s, input); const p = TeamReviewInputSchema.parse(input); if (!s.block)
        throw Error('review requires block'); if(s.review&&s.review.reason!==p.reason)throw new TeamError('review reason is immutable',409); if (!s.review) {
        s.review = p;
        this.event(s, 'reviewed', now, 'operator');
    } return this.summary(id); }); }
    observe(id: string, facts: TeamObservation[], now: number): TeamSummary {
        const key=(f:TeamObservation)=>JSON.stringify([f.memberId,f.jobId,f.attempt,f.taskId??null]);
        // trusted gateway가 이미 시작한 작업의 결속·정리를 일반 기록 포화가 막지 않는다.
        return this.change(id,now,true,s=>{
            if(!Array.isArray(facts)||facts.length>s.tasks.length+s.spec.members.length)throw new TeamError('observation quota',400);
            if(new Set(facts.map(key)).size!==facts.length)throw new TeamError('duplicate observation',400);
            for(const input of facts){
                this.safe(s,input);
                const f=TeamObservationSchema.parse(input),m=s.spec.members.find(m=>m.id===f.memberId);
                if(!m)throw Error('unknown member');
                const sameBinding=m.jobId===f.jobId&&m.attempt===f.attempt;
                if(m.jobId&&!sameBinding&&!m.stopped)throw Error('binding conflict');
                if(m.stopped&&sameBinding&&f.status==='running')throw Error('stopped execution');
                if(m.stopped&&!sameBinding&&f.status!=='running')throw Error('binding conflict');
                const assigned=s.tasks.filter(t=>t.assignee===m.id);
                const targets=f.taskId===undefined?assigned:[this.task(s,f.taskId)];
                for(const t of targets)if(t.assignee!==m.id||!t.writes.every(p=>m.writes.some(w=>p===w||w.endsWith('/')&&p.startsWith(w))))throw Error('observation task scope');
                if(f.status==='verified'){
                    if(!f.evidenceRef||!f.snapshotId||f.checksPassed!==true||f.containerStopped!==true||f.authSynced!==true)throw Error('verification evidence missing');
                    if(targets.length!==1)throw Error('ambiguous verification');
                    if(s.status==='active'&&targets[0]!.dependencies.some(d=>this.task(s,d).status!=='verified'))throw Error('dependency not verified');
                }
                if(f.status==='stopped'&&(f.containerStopped!==true||f.authSynced!==true))throw Error('stop evidence missing');
                if(s.observations?.some(old=>key(old)===key(f)&&JSON.stringify(old)===JSON.stringify(f)))continue;
                s.observations=(s.observations??[]).filter(old=>old.memberId!==f.memberId||sameBinding&&key(old)!==key(f));
                s.observations.push(copy(f));
                if(s.observations.length>s.tasks.length+s.spec.members.length)throw new TeamError('observation quota',413);
                const stopped=!!(sameBinding&&m.stopped)||f.status==='stopped'||f.containerStopped===true&&f.authSynced===true;
                m.jobId=f.jobId;m.attempt=f.attempt;m.stopped=stopped;
                if(stopped){
                    s.leases=s.leases.filter(l=>l.memberId!==m.id);
                    for(const t of assigned)if(t.status==='claimed'||t.status==='recovery_required')t.status='pending';
                }
                for(const t of targets){
                    if(f.status==='stopped')continue;
                    if(s.status!=='active')continue;
                    if(f.status==='verified'){t.status='verified';t.verification=copy(f);t.evidenceRef=f.evidenceRef;s.leases=s.leases.filter(l=>l.taskId!==t.id);}
                    if(f.status==='candidate'&&t.status!=='verified'){t.status='submitted';s.leases=s.leases.filter(l=>l.taskId!==t.id);}
                    if(f.status==='failed'){t.status='failed';s.leases=s.leases.filter(l=>l.taskId!==t.id);s.status='failed';}
                }
                this.event(s,'observed_'+f.status,now,'gateway_observed',f.taskId);
            }
            if(s.status==='active'&&s.tasks.every(t=>t.status==='verified'))s.status='completed';
            return this.summary(id);
        });
    }
    fail(id: string, input: {
        reason: string;
    }, now: number): TeamSummary { return this.change(id, now, true, s => { this.safe(s, input); TeamReviewInputSchema.parse(input); if (s.status === 'active') {
        s.status = 'failed';
        for (const t of s.tasks)
            if (t.status === 'claimed')
                t.status = 'recovery_required';
        this.event(s, 'failed', now, 'gateway_observed');
    } return this.summary(id); }); }
    tick(id: string, now: number): TeamSummary { return this.change(id, now, true, s => { let changed = false; for (const l of s.leases)
        if (l.expiresAt <= now) {
            const t = this.task(s, l.taskId);
            if (t.status === 'claimed') {
                t.status = 'recovery_required';
                changed = true;
            }
        } if (s.status === 'active' && now >= s.spec.endsAt) {
        s.status = 'expired';
        changed = true;
    } if (changed)
        this.event(s, 'recovery_required', now, 'gateway_observed'); return this.summary(id); }); }
}
