import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * In-memory view of a whole document set inside one repository transaction.
 * A store's domain logic reads and changes this view synchronously; the repository then writes the dirty
 * documents and the new events and commits. Loading every document is deliberate: some rules (the Model
 * Factory central cost cap) are sums over all documents, so a mutating transaction must see all of them.
 */
export interface DocumentTxState<TDoc, TEventDraft> {
  /** Documents keyed by id, in the repository listing order. */
  docs: Map<string, TDoc>;
  dirtyIds: Set<string>;
  newEvents: TEventDraft[];
}

/**
 * Storage port shared by the document stores (ModelFactoryStore, DeliveryStore). Implementations: local
 * SQLite (this file) and Amazon Aurora DSQL (packages/adapters). A store never issues SQL itself.
 */
export interface DocumentRepository<TDoc, TEventDraft> {
  readonly storageBackend: 'sqlite' | 'aurora-dsql';
  /**
   * Runs `fn` atomically. `fn` is synchronous and must have no side effect outside `state`, because a
   * backend with optimistic concurrency control re-runs it on a serialization conflict. When `fn` throws,
   * nothing is written.
   */
  transaction<T>(fn: (state: DocumentTxState<TDoc, TEventDraft>) => T): Promise<T>;
  /** Documents in listing order (most recently written first). */
  listDocs(): Promise<TDoc[]>;
  getDoc(id: string): Promise<TDoc | null>;
  /** The newest `limit` events, newest first. */
  listEvents(limit: number): Promise<(TEventDraft & { sequence: number })[]>;
  close(): Promise<void>;
}

export function newDocumentTxState<TDoc extends { id: string }, TEventDraft>(docs: TDoc[]): DocumentTxState<TDoc, TEventDraft> {
  return { docs: new Map(docs.map((doc) => [doc.id, doc])), dirtyIds: new Set(), newEvents: [] };
}

const SQLITE_TABLE_NAME = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * Local SQLite repository: one `(id, data)` table for documents and one auto-increment table for events.
 * This is the layout the stores used before the port existed, so an existing database file keeps working.
 */
export class SqliteDocumentRepository<TDoc extends { id: string }, TEventDraft> implements DocumentRepository<TDoc, TEventDraft> {
  readonly storageBackend = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly docsTable: string,
    private readonly eventsTable: string,
  ) {
    // Table names are interpolated into SQL, so they are restricted to a fixed safe alphabet.
    if (!SQLITE_TABLE_NAME.test(docsTable) || !SQLITE_TABLE_NAME.test(eventsTable)) {
      throw new Error('Invalid SQLite table name');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ${docsTable} (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${eventsTable} (sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);`);
  }

  private readDocs(): TDoc[] {
    return this.db
      .prepare(`SELECT data FROM ${this.docsTable} ORDER BY rowid DESC`)
      .all()
      .map((row) => JSON.parse(row.data as string) as TDoc);
  }

  // The whole body is synchronous, so no other transaction of this process can interleave with it.
  async transaction<T>(fn: (state: DocumentTxState<TDoc, TEventDraft>) => T): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = newDocumentTxState<TDoc, TEventDraft>(this.readDocs());
      const result = fn(state);
      const saveDoc = this.db.prepare(`INSERT OR REPLACE INTO ${this.docsTable} (id, data) VALUES (?, ?)`);
      for (const id of state.dirtyIds) {
        const doc = state.docs.get(id);
        if (doc) saveDoc.run(id, JSON.stringify(doc));
      }
      const saveEvent = this.db.prepare(`INSERT INTO ${this.eventsTable} (data) VALUES (?)`);
      for (const event of state.newEvents) saveEvent.run(JSON.stringify(event));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async listDocs(): Promise<TDoc[]> {
    return this.readDocs();
  }

  async getDoc(id: string): Promise<TDoc | null> {
    const row = this.db.prepare(`SELECT data FROM ${this.docsTable} WHERE id=?`).get(id);
    return row ? (JSON.parse(row.data as string) as TDoc) : null;
  }

  async listEvents(limit: number): Promise<(TEventDraft & { sequence: number })[]> {
    return this.db
      .prepare(`SELECT sequence, data FROM ${this.eventsTable} ORDER BY sequence DESC LIMIT ?`)
      .all(limit)
      .map((row) => ({ sequence: row.sequence as number, ...(JSON.parse(row.data as string) as TEventDraft) }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Copies every document and event of `source` into `target` in one transaction, but only when `target`
 * holds no document yet. Used once when a store moves from the local SQLite file to Aurora DSQL, so its
 * history is not reset by the move. Returns the number of documents copied.
 */
export async function importHistoryIfEmpty<TDoc extends { id: string }, TEventDraft>(
  source: DocumentRepository<TDoc, TEventDraft>,
  target: DocumentRepository<TDoc, TEventDraft>,
): Promise<number> {
  const docs = (await source.listDocs()).reverse(); // oldest write first, so listing order is kept
  if (docs.length === 0) return 0;
  const events = (await source.listEvents(1000)).reverse();
  return target.transaction((state) => {
    if (state.docs.size > 0) return 0;
    for (const doc of docs) {
      state.docs.set(doc.id, doc);
      state.dirtyIds.add(doc.id);
    }
    for (const event of events) {
      const { sequence: _sequence, ...draft } = event;
      state.newEvents.push(draft as unknown as TEventDraft);
    }
    return docs.length;
  });
}
