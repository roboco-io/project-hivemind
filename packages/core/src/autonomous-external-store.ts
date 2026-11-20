import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createExternalSqlStore,type ExternalDurableStore} from './autonomous-external-sql.ts';
export type {ExternalDurableStore,ExternalJournal} from './autonomous-external-sql.ts';
/** Local adapter only. Workers import autonomous-external-sql directly. */
export function createExternalStore(path:string):ExternalDurableStore {
 if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
 const db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
 return createExternalSqlStore({
  exec(query,...bindings){const statement=db.prepare(query);if(statement.columns().length)return statement.iterate(...bindings);statement.run(...bindings);return [];},
  transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
  close:()=>db.close(),
 });
}
