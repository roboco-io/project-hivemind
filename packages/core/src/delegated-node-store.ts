import { DatabaseSync } from 'node:sqlite';
import { createDelegatedSqlStore } from './delegated-store.js';
import type { DelegatedStoreLimits } from './delegated-store.js';
import type { DelegatedLedger, DelegatedStore } from '../../contracts/src/delegated.js';
/** Node-only wrapper. Worker imports delegated-store.ts, which has no node:sqlite dependency. */
export class SqliteDelegatedStore implements DelegatedStore {
    private db: DatabaseSync;
    private store: DelegatedStore;
    constructor(path: string, options: DelegatedStoreLimits = {}) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000'); this.store = createDelegatedSqlStore({ exec: (q, ...b) => { const s = this.db.prepare(q); return s.columns().length ? s.all(...b) : (s.run(...b), []); }, transactionSync: fn => { this.db.exec('BEGIN IMMEDIATE'); try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (e) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            throw e;
        } } }, options); }
    read(key: string) { return this.store.read(key); }
    mutate<T>(key: string, fn: (state: DelegatedLedger | undefined) => {
        state: DelegatedLedger;
        result: T;
    }): Promise<T> { return this.store.mutate(key, fn); }
    close() { if (this.db.isOpen)
        this.db.close(); }
}
