import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {workflowApproval, workflowDraft, workflowId, type CloudWorkflowControl, type CloudWorkflowPort, type WorkflowBinding} from '../../contracts/src/workflow.js';
import {DomainError} from './store.js';

interface SavedWorkflow extends WorkflowBinding {
  title: string;
  contractPath: string;
  baseCommit: string;
  codexWrites: string[];
  claudeWrites: string[];
}

export function createCloudWorkflowControl(dbPath: string, scope: string, port: CloudWorkflowPort): CloudWorkflowControl {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS cloud_workflows (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      data TEXT NOT NULL, UNIQUE(scope, request_id)
    )`);
  const byRequest = db.prepare('SELECT data,fingerprint FROM cloud_workflows WHERE scope=? AND request_id=?');
  const byId = db.prepare('SELECT data FROM cloud_workflows WHERE scope=? AND id=?');
  const find = (id: string): SavedWorkflow => {
    if (!workflowId.safeParse(id).success) throw new DomainError('Invalid workflow ID',400);
    const row = byId.get(scope,id);
    if (!row) throw new DomainError('Workflow is not registered in this configuration',404);
    return JSON.parse(String(row.data)) as SavedWorkflow;
  };
  return {
    async draft(raw) {
      const validated = workflowDraft.safeParse(raw);
      if (!validated.success) throw new DomainError('Invalid workflow draft',400);
      const input = validated.data;
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = byRequest.get(scope,input.requestId);
      if (previous && previous.fingerprint !== fingerprint) throw new DomainError('Request ID already binds another plan',409);
      if (previous) return {...JSON.parse(String(previous.data)), ...await port.read(JSON.parse(String(previous.data)),false,false)};
      const key = 'mcp-' + createHash('sha256').update(scope + ':' + input.requestId).digest('hex');
      const binding = await port.draft(input,key);
      const entry: SavedWorkflow = {...binding,title:input.title,baseCommit:input.baseCommit,contractPath:input.contractPath,
        codexWrites:input.codex.writes,claudeWrites:input.claude.writes};
      db.prepare('INSERT OR IGNORE INTO cloud_workflows VALUES (?,?,?,?,?)').run(entry.id,scope,input.requestId,fingerprint,JSON.stringify(entry));
      const saved = byRequest.get(scope,input.requestId);
      if (saved?.fingerprint !== fingerprint || JSON.parse(String(saved.data)).id !== entry.id) throw new DomainError('Workflow binding conflict',409);
      return {...entry,status:'DRAFT'};
    },
    async approve(id,body) {
      const input = workflowApproval.safeParse({workflowId:id,contractHash:(body as {contractHash?:unknown}|null)?.contractHash});
      if (!input.success) throw new DomainError('Invalid workflow approval',400);
      const entry = find(id);
      if (entry.contractHash !== input.data.contractHash) throw new DomainError('Workflow contract hash differs',409);
      return {...entry,...await port.approve(entry)};
    },
    list() {
      return db.prepare('SELECT data FROM cloud_workflows WHERE scope=? ORDER BY rowid DESC LIMIT 20').all(scope)
        .map(row => JSON.parse(String(row.data)) as Record<string,unknown>);
    },
    async read(id,result,includeDiff) {
      const entry = find(id);
      return {...entry,...await port.read(entry,result,includeDiff)};
    },
    close() {db.close();},
  };
}
