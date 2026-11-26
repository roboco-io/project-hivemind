import type { DeliveryTask } from '../../contracts/src/delivery.js';
import type { DeliveryEventDraft } from '../../core/src/delivery-repository.js';
import { DsqlDocumentRepository, type DsqlDocumentRepositoryOptions } from './aws-dsql-documents.js';

/**
 * Amazon Aurora DSQL repository of DeliveryStore (tables `hm_delivery_jobs`, `hm_delivery_events`,
 * `hm_delivery_meta`). The documents table keeps the generic `_jobs` suffix of DsqlDocumentRepository; it
 * holds delivery tasks.
 */
export class DsqlDeliveryRepository extends DsqlDocumentRepository<DeliveryTask, DeliveryEventDraft> {
  constructor(options: DsqlDocumentRepositoryOptions) {
    super(options, { defaultPrefix: 'hm_delivery', eventOwnerColumn: 'task_id', eventOwnerId: (event) => event.taskId });
  }
}
