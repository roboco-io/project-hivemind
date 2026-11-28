import type { ComputeEvent, ComputeJob } from '../../contracts/src/compute.js';
import { SqliteDocumentRepository, type DocumentRepository, type DocumentTxState } from './document-repository.js';

export type ComputeEventDraft = Omit<ComputeEvent, 'sequence'>;
export type ComputeTxState = DocumentTxState<ComputeJob, ComputeEventDraft>;
/** Storage port of ComputeStore. See DocumentRepository for the contract. */
export type ComputeRepository = DocumentRepository<ComputeJob, ComputeEventDraft>;

/**
 * Local SQLite repository of ComputeStore.
 * Uses the existing table names (`model_factory_jobs`, `model_factory_events`) so pre-refactor local SQLite
 * history is preserved seamlessly on upgrade.
 */
export class SqliteComputeRepository extends SqliteDocumentRepository<ComputeJob, ComputeEventDraft> {
  constructor(path = ':memory:') {
    super(path, 'model_factory_jobs', 'model_factory_events');
  }
}
