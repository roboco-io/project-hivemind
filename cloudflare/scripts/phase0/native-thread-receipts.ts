import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';

export type NativeThreadReceipt = { threadId: string; rolloutFile: string; source: unknown };

export function readNativeThreads(databasePath: string): NativeThreadReceipt[] {
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 1000 });
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
    if (!columns.has('id') || !columns.has('rollout_path')) return [];
    const selected = columns.has('source') ? 'id, rollout_path, source' : 'id, rollout_path';
    return db.prepare(`SELECT ${selected} FROM threads LIMIT 16`).all().flatMap(row => {
      if (typeof row.id !== 'string' || typeof row.rollout_path !== 'string') return [];
      let source: unknown = row.source ?? null;
      if (typeof source === 'string') { try { source = JSON.parse(source); } catch { /* Plain enum value. */ } }
      return [{ threadId: row.id, rolloutFile: basename(row.rollout_path), source }];
    });
  } finally { db.close(); }
}
