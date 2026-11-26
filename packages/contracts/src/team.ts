/** 고정 팀 계약. Actor와 observation은 서버가 구성한다. */
export interface TeamMember {
    id: string;
    role: 'worker' | 'verifier';
    writes: string[];
    jobId?: string;
    attempt?: string;
    stopped?: boolean;
}
export interface TeamTaskInput {
    id: string;
    title: string;
    dependencies: string[];
    writes: string[];
    assignee?: string;
}
export interface TeamSpec {
    id: string;
    workflowId: string;
    contractHash: string;
    members: TeamMember[];
    tasks: TeamTaskInput[];
    maxConcurrentClaims: number;
    endsAt: number;
}
export interface TeamActor {
    teamId: string;
    memberId: string;
    jobId: string;
    attempt: string;
}
export interface TeamLease {
    taskId: string;
    memberId: string;
    token: string;
    generation: number;
    expiresAt: number;
}
export type TeamTaskStatus = 'pending' | 'claimed' | 'submitted' | 'verified' | 'failed' | 'recovery_required';
export interface TeamTask extends TeamTaskInput {
    status: TeamTaskStatus;
    evidenceRef?: string;
    verification?: TeamObservation;
}
export interface TeamEvent {
    sequence: number;
    at: number;
    type: string;
    taskId?: string;
    source: 'gateway_observed' | 'worker_report' | 'operator';
}
export interface TeamNote {
    source: 'worker_report';
    sequence: number;
    at: number;
    memberId: string;
    taskId?: string;
    text: string;
}
export type TeamSecurityCategory = 'sandbox_escape' | 'credential_scope' | 'monitor_tampering' | 'identity_mismatch';
export interface TeamBlockInput {
    category: TeamSecurityCategory;
    reason: string;
    evidenceRef: string;
}
export interface TeamReviewInput {
    reason: string;
}
export interface TeamSubmitInput {
    evidenceRef: string;
    outcome: 'candidate' | 'failed';
}
export interface TeamPage {
    after?: number;
    limit?: number;
}
export interface TeamObservation {
    taskId?: string;
    memberId: string;
    jobId: string;
    attempt: string;
    status: 'running' | 'candidate' | 'verified' | 'failed' | 'stopped';
    evidenceRef?: string;
    snapshotId?: string;
    checksPassed?: boolean;
    containerStopped?: boolean;
    authSynced?: boolean;
    requiresAuthSync?: boolean;
}
export interface TeamSummary {
    id: string;
    workflowId: string;
    status: 'active' | 'blocked' | 'completed' | 'expired' | 'failed';
    blocked: boolean;
    recoveryRequired: boolean;
    taskCounts: Record<TeamTaskStatus, number>;
    block?: TeamBlockInput;
    reviewed: boolean;
    endsAt: number;
}
export interface TeamState {
    version: 1;
    spec: TeamSpec;
    status: TeamSummary['status'];
    tasks: TeamTask[];
    leases: TeamLease[];
    generations: Record<string, number>;
    events: TeamEvent[];
    notes: TeamNote[];
    block?: TeamBlockInput;
    review?: TeamReviewInput;
    sequence: number;
    observations?: TeamObservation[];
    leaseTokens?: string[];
}
/** 일반 기록: 2,048 events·512KiB. 복구 여유: 512 events·512KiB. 전체 1MiB, 이력 삭제 없음. */
export const TEAM_LIMITS = { tasks: 128, members: 16, paths: 32, notes: 256, noteBytes: 2048, events: 2048, recoveryEvents: 512, bytes: 1048576, normalBytes: 524288 } as const;
import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const path = z.string().min(1).max(512).refine(s => !s.startsWith('/') && !s.includes('\\') && !s.split('/').some(p => p === '..' || p === '.') && !s.includes('\0') && !s.includes(':') && !/[\p{Cc}\p{Cf}]/u.test(s) && s === s.normalize('NFC') && !s.includes('//'));
export const TeamTaskInputSchema = z.strictObject({ id, title: z.string().min(1).max(512), dependencies: z.array(id).max(128), writes: z.array(path).max(32), assignee: id.optional() });
export const TeamActorSchema = z.strictObject({ teamId: id, memberId: id, jobId: id, attempt: id });
export const TeamLeaseSchema = z.strictObject({ taskId: id, memberId: id, token: z.string().min(1).max(128), generation: z.number().int().positive(), expiresAt: z.number().int().nonnegative() });
export const TeamSpecSchema = z.strictObject({ id, workflowId: z.uuid(), contractHash: z.string().regex(/^[a-fA-F0-9]{64}$/), members: z.array(z.strictObject({ id, role: z.enum(['worker', 'verifier']), writes: z.array(path).max(32), jobId: id.optional(), attempt: id.optional(), stopped: z.boolean().optional() })).min(1).max(16), tasks: z.array(TeamTaskInputSchema).min(1).max(128), maxConcurrentClaims: z.number().int().min(1).max(16), endsAt: z.number().int().positive() });
export const TeamBlockInputSchema = z.strictObject({ category: z.enum(['sandbox_escape', 'credential_scope', 'monitor_tampering', 'identity_mismatch']), reason: z.string().min(1).max(2048), evidenceRef: id });
export const TeamReviewInputSchema = z.strictObject({ reason: z.string().min(1).max(2048) });
export const TeamSubmitInputSchema = z.strictObject({ evidenceRef: id, outcome: z.enum(['candidate', 'failed']) });
export const TeamNoteInputSchema = z.strictObject({ taskId: id.optional(), text: z.string().min(1).refine(s => new TextEncoder().encode(s).length <= 2048) });
export const TeamPageSchema = z.strictObject({ after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(256).optional() });
export const TeamObservationSchema = z.strictObject({ taskId: id.optional(), memberId: id, jobId: id, attempt: id, status: z.enum(['running', 'candidate', 'verified', 'failed', 'stopped']), evidenceRef: id.optional(), snapshotId: id.optional(), checksPassed: z.boolean().optional(), containerStopped: z.boolean().optional(), authSynced: z.boolean().optional(), requiresAuthSync: z.boolean().optional() });
export function validateTeamSpec(input: unknown): TeamSpec {
    const spec = TeamSpecSchema.parse(input);
    const members = new Map(spec.members.map(m => [m.id, m]));
    const tasks = new Map(spec.tasks.map(t => [t.id, t]));
    if (members.size !== spec.members.length || tasks.size !== spec.tasks.length)
        throw Error('duplicate identity');
    for (const m of spec.members)
        if (Boolean(m.jobId) !== Boolean(m.attempt))
            throw Error('incomplete binding');
    const covered = (writes: string[], scope: string[]) => writes.every(p => scope.some(s => p === s || (s.endsWith('/') && p.startsWith(s))));
    for (const t of spec.tasks) {
        if (new Set(t.dependencies).size !== t.dependencies.length || t.dependencies.some(d => !tasks.has(d)))
            throw Error('unknown dependency');
        const eligible = t.assignee ? [members.get(t.assignee)] : spec.members;
        if (!eligible.some(m => m && covered(t.writes, m.writes)))
            throw Error('write scope');
    }
    const done = new Set<string>(), visiting = new Set<string>();
    const visit = (name: string) => { if (visiting.has(name))
        throw Error('cycle'); if (done.has(name))
        return; visiting.add(name); for (const d of tasks.get(name)!.dependencies)
        visit(d); visiting.delete(name); done.add(name); };
    for (const t of spec.tasks)
        visit(t.id);
    return spec;
}
const status = z.enum(['pending', 'claimed', 'submitted', 'verified', 'failed', 'recovery_required']);
export const TeamTaskSchema = TeamTaskInputSchema.extend({ status, evidenceRef: id.optional(), verification: TeamObservationSchema.optional() });
export const TeamEventSchema = z.strictObject({ sequence: z.number().int().positive(), at: z.number().int().nonnegative(), type: z.enum(['created', 'task_added', 'claimed', 'heartbeat', 'submitted', 'security_blocked', 'reviewed', 'observed_running', 'observed_candidate', 'observed_verified', 'observed_failed', 'observed_stopped', 'failed', 'recovery_required']), taskId: id.optional(), source: z.enum(['gateway_observed', 'worker_report', 'operator']) });
export const TeamNoteSchema = z.strictObject({ sequence: z.number().int().positive(), at: z.number().int().nonnegative(), memberId: id, taskId: id.optional(), text: z.string().min(1).refine(s => new TextEncoder().encode(s).length <= 2048), source: z.literal('worker_report') });
export const TeamSummarySchema = z.strictObject({ id, workflowId: z.uuid(), status: z.enum(['active', 'blocked', 'completed', 'expired', 'failed']), blocked: z.boolean(), recoveryRequired: z.boolean(), taskCounts: z.strictObject({ pending: z.number().int().nonnegative(), claimed: z.number().int().nonnegative(), submitted: z.number().int().nonnegative(), verified: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), recovery_required: z.number().int().nonnegative() }), block: TeamBlockInputSchema.optional(), reviewed: z.boolean(), endsAt: z.number().int().positive() });
export const TeamStateSchema = z.strictObject({ version: z.literal(1), spec: TeamSpecSchema, status: z.enum(['active', 'blocked', 'completed', 'expired', 'failed']), tasks: z.array(TeamTaskSchema).min(1).max(128), leases: z.array(TeamLeaseSchema).max(16), generations: z.record(id, z.number().int().positive()), events: z.array(TeamEventSchema).max(TEAM_LIMITS.events + TEAM_LIMITS.recoveryEvents), notes: z.array(TeamNoteSchema).max(256), block: TeamBlockInputSchema.optional(), review: TeamReviewInputSchema.optional(), sequence: z.number().int().nonnegative(), observations: z.array(TeamObservationSchema).max(144).optional(), leaseTokens: z.array(z.string().min(1).max(128)).max(2048).optional() });
export function validateTeamState(input: unknown): TeamState {
    const s = TeamStateSchema.parse(input);
    validateTeamSpec(s.spec);
    const members = new Map(s.spec.members.map(m => [m.id, m])), tasks = new Map(s.tasks.map(t => [t.id, t]));
    if (tasks.size !== s.tasks.length || s.tasks.length !== s.spec.tasks.length)
        throw Error('task identity mismatch');
    for (const expected of s.spec.tasks) {
        const t = tasks.get(expected.id);
        if (!t || t.title !== expected.title || t.assignee !== expected.assignee || JSON.stringify(t.dependencies) !== JSON.stringify(expected.dependencies) || JSON.stringify(t.writes) !== JSON.stringify(expected.writes))
            throw Error('task spec mismatch');
        if (t.status === 'verified') {
            const v = t.verification;
            if (!v || v.status !== 'verified' || !v.evidenceRef || !v.snapshotId || v.checksPassed !== true || v.containerStopped !== true || v.authSynced !== true || t.evidenceRef !== v.evidenceRef || t.dependencies.some(d => tasks.get(d)?.status !== 'verified'))
                throw Error('unverified restored task');
            // 검증 당시 실행 ID는 이력이다. 현재 actor 결속과 비교하지 않는다.
            const m = members.get(v.memberId);
            if (!m || t.assignee !== m.id || v.taskId !== undefined && v.taskId !== t.id || !t.writes.every(p=>m.writes.some(w=>p===w||w.endsWith('/')&&p.startsWith(w))))
                throw Error('verification binding');
        }
    }
    const leased = new Set<string>(), holders = new Set<string>();
    for (const l of s.leases) {
        const t = tasks.get(l.taskId), m = members.get(l.memberId);
        if (leased.has(l.taskId) || holders.has(l.memberId) || !t || !m || !m.jobId || !m.attempt || m.stopped || t.assignee !== m.id || !['claimed', 'recovery_required'].includes(t.status) || (!Object.hasOwn(s.generations, l.taskId) || s.generations[l.taskId] !== l.generation) || l.expiresAt > s.spec.endsAt)
            throw Error('invalid restored lease');
        leased.add(l.taskId);
        holders.add(l.memberId);
    }
    for (const t of s.tasks)
        if (t.status === 'claimed' && !leased.has(t.id))
            throw Error('missing lease');
    if (Object.keys(s.generations).some(k => !tasks.has(k)) || s.leases.length > s.spec.maxConcurrentClaims)
        throw Error('invalid generations');
    if ((s.status === 'blocked') !== Boolean(s.block) || s.review && !s.block || s.status === 'completed' && !s.tasks.every(t => t.status === 'verified'))
        throw Error('inconsistent status');
    const expectedSource = (type: string) => ['created', 'security_blocked', 'reviewed'].includes(type) ? 'operator' : ['task_added', 'claimed', 'heartbeat', 'submitted'].includes(type) ? 'worker_report' : 'gateway_observed';
    for (const e of s.events)
        if (e.source !== expectedSource(e.type))
            throw Error('event provenance');
    const seq = new Set<number>();
    for (const row of [...s.events, ...s.notes]) {
        if (seq.has(row.sequence) || row.sequence > s.sequence)
            throw Error('invalid sequence');
        seq.add(row.sequence);
        if (row.taskId && !tasks.has(row.taskId))
            throw Error('unknown event task');
    }
    for (const rows of [s.events, s.notes])
        for (let i = 1; i < rows.length; i++)
            if (rows[i]!.sequence <= rows[i - 1]!.sequence)
                throw Error('unordered history');
    for (const n of s.notes)
        if (!members.has(n.memberId))
            throw Error('unknown note member');
    if (seq.size !== s.sequence)
        throw Error('missing history');
    const observed = new Set<string>();
    for (const f of s.observations ?? []) {
        const m = members.get(f.memberId);
        const key=JSON.stringify([f.memberId,f.jobId,f.attempt,f.taskId??null]);
        const task=f.taskId===undefined?undefined:tasks.get(f.taskId);
        if (observed.has(key) || !m || m.jobId !== f.jobId || m.attempt !== f.attempt || f.taskId!==undefined&&(!task||task.assignee!==m.id||!task.writes.every(p=>m.writes.some(w=>p===w||w.endsWith('/')&&p.startsWith(w)))) )
            throw Error('observation binding');
        observed.add(key);
    }
    if(observed.size>s.tasks.length+s.spec.members.length)throw Error('observation quota');
    for (const [i, t] of s.tasks.entries())
        for (const other of s.tasks.slice(i + 1)) {
            const locked = (x: TeamTask) => ['claimed', 'submitted', 'recovery_required', 'failed'].includes(x.status) && !members.get(x.assignee ?? '')?.stopped;
            if (locked(t) && locked(other) && t.writes.some(p => other.writes.some(q => teamPathsOverlap(p, q))))
                throw Error('restored write conflict');
        }
    if (new TextEncoder().encode(JSON.stringify(s)).length > TEAM_LIMITS.bytes)
        throw Error('state quota');
    return s;
}
export function teamPathsOverlap(a: string, b: string): boolean { const x = a.normalize('NFC').toLowerCase().replace(/\/$/, ''), y = b.normalize('NFC').toLowerCase().replace(/\/$/, ''); return x === y || x.startsWith(y + '/') || y.startsWith(x + '/'); }
