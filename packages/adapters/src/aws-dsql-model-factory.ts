import type { ModelFactoryJob } from '../../contracts/src/model-factory.js';
import { importHistoryIfEmpty } from '../../core/src/document-repository.js';
import type { ModelFactoryEventDraft, ModelFactoryRepository } from '../../core/src/model-factory-repository.js';
import { DsqlDocumentRepository, type DsqlDocumentRepositoryOptions } from './aws-dsql-documents.js';

export type { DsqlClientLike, DsqlPoolLike } from './aws-dsql-documents.js';
export type DsqlModelFactoryRepositoryOptions = DsqlDocumentRepositoryOptions;

/**
 * Amazon Aurora DSQL repository of ModelFactoryStore (tables `hm_mf_jobs`, `hm_mf_events`, `hm_mf_meta`).
 * The shared sequence row of DsqlDocumentRepository is what keeps two concurrent training approvals from
 * both passing the central cost cap.
 */
export class DsqlModelFactoryRepository extends DsqlDocumentRepository<ModelFactoryJob, ModelFactoryEventDraft> {
  constructor(options: DsqlModelFactoryRepositoryOptions) {
    super(options, { defaultPrefix: 'hm_mf', eventOwnerColumn: 'job_id', eventOwnerId: (event) => event.jobId });
  }
}

/**
 * Copies the SQLite ledger into an empty DSQL ledger, once. Without it the move to DSQL would reset the
 * reservations and settlements. Returns the number of jobs copied.
 */
export function importModelFactoryHistoryIfEmpty(source: ModelFactoryRepository, target: ModelFactoryRepository): Promise<number> {
  return importHistoryIfEmpty(source, target);
}
