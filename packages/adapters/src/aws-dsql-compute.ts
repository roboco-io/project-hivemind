import type { ComputeJob } from '../../contracts/src/compute.js';
import { importHistoryIfEmpty } from '../../core/src/document-repository.js';
import type { ComputeEventDraft, ComputeRepository } from '../../core/src/compute-repository.js';
import { DsqlDocumentRepository, type DsqlDocumentRepositoryOptions } from './aws-dsql-documents.js';

export type { DsqlClientLike, DsqlPoolLike } from './aws-dsql-documents.js';
export type DsqlComputeRepositoryOptions = DsqlDocumentRepositoryOptions;

/**
 * Amazon Aurora DSQL repository of ComputeStore (tables `hm_mf_jobs`, `hm_mf_events`, `hm_mf_meta`).
 * Keeps the existing `hm_mf` table prefix so live Aurora DSQL history is preserved seamlessly across the
 * Model Factory -> Universal Compute refactor.
 */
export class DsqlComputeRepository extends DsqlDocumentRepository<ComputeJob, ComputeEventDraft> {
  constructor(options: DsqlComputeRepositoryOptions) {
    super(options, { defaultPrefix: 'hm_mf', eventOwnerColumn: 'job_id', eventOwnerId: (event) => event.jobId });
  }
}

export function importComputeHistoryIfEmpty(source: ComputeRepository, target: ComputeRepository): Promise<number> {
  return importHistoryIfEmpty(source, target);
}
