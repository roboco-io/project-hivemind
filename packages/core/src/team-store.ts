import { DatabaseSync } from 'node:sqlite';
import { validateTeamState } from '../../contracts/src/team.js';
import type { TeamState } from '../../contracts/src/team.js';
import { TeamEngine } from './team.js';
/** 전역 저장 예산의 복구 여유 사용 여부. 생략 시 false이며, Node·메모리에서는 사용하지 않는다. */
export interface TeamMutationOptions {
    recovery?: boolean;
}
/** 콜백은 동기 전용이다. 네트워크 작업을 콜백에 넣지 않는다. */
export interface TeamRepository {
    read(id: string): Promise<TeamState | undefined>;
    mutate<T>(id: string, fn: (engine: TeamEngine) => T, options?: TeamMutationOptions): Promise<T>;
}
function run<T>(id: string, state: TeamState | undefined, fn: (engine: TeamEngine) => T) {
    if (fn.constructor.name === 'AsyncFunction')
        throw Error('synchronous mutator required');
    const e = new TeamEngine(state);
    const result = fn(e);
    if (result && typeof (result as {
        then?: unknown;
    }).then === 'function') {
        // 이미 시작한 잘못된 비동기 콜백의 rejection도 외부로 누출하지 않는다.
        void Promise.resolve(result).catch(() => { });
        throw Error('synchronous mutator required');
    }
    const next = e.snapshot();
    if (!next || next.spec.workflowId !== id)
        throw Error('team identity mismatch');
    return { result: structuredClone(result), next: validateTeamState(next) };
}
export class MemoryTeamRepository implements TeamRepository {
    private states = new Map<string, TeamState>();
    async read(id: string) { return structuredClone(this.states.get(id)); }
    async mutate<T>(id: string, fn: (engine: TeamEngine) => T, _options?: TeamMutationOptions): Promise<T> { const { result, next } = run(id, this.states.get(id), fn); this.states.set(id, next); return result; }
    close() { }
}
/** trusted controller 전용. 워커에는 DB 경로를 전달하지 않는다. */
export class SqliteTeamRepository implements TeamRepository {
    private db: DatabaseSync;
    constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS team_state (id TEXT PRIMARY KEY, state TEXT NOT NULL)'); }
    private load(id: string): TeamState | undefined { const row = this.db.prepare('SELECT state FROM team_state WHERE id=?').get(id); return row ? JSON.parse(String(row.state)) as TeamState : undefined; }
    async read(id: string) { const state = this.load(id); if (state && state.spec.workflowId !== id)
        throw Error('stored team identity mismatch'); return new TeamEngine(state).snapshot(); }
    async mutate<T>(id: string, fn: (engine: TeamEngine) => T, _options?: TeamMutationOptions): Promise<T> { this.db.exec('BEGIN IMMEDIATE'); try {
        const { result, next } = run(id, this.load(id), fn);
        this.db.prepare('INSERT INTO team_state (id,state) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(id, JSON.stringify(next));
        this.db.exec('COMMIT');
        return result;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } }
    close() { this.db.close(); }
}
