import type { DeliveryEvent, DeliveryTask } from '../../contracts/src/delivery.js';
import { SqliteDocumentRepository, type DocumentRepository, type DocumentTxState } from './document-repository.js';

export type DeliveryEventDraft = Omit<DeliveryEvent, 'sequence'>;
export type DeliveryTxState = DocumentTxState<DeliveryTask, DeliveryEventDraft>;
/** Storage port of DeliveryStore. See DocumentRepository for the contract. */
export type DeliveryRepository = DocumentRepository<DeliveryTask, DeliveryEventDraft>;

/** Local SQLite repository of DeliveryStore, with the table names the store has always used. */
export class SqliteDeliveryRepository extends SqliteDocumentRepository<DeliveryTask, DeliveryEventDraft> {
  constructor(path = ':memory:') {
    super(path, 'delivery_tasks', 'delivery_events');
  }
}
