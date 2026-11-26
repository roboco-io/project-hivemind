import type { ModelFactoryEvent, ModelFactoryJob } from '../../contracts/src/model-factory.js';
import { SqliteDocumentRepository, type DocumentRepository, type DocumentTxState } from './document-repository.js';

export type ModelFactoryEventDraft = Omit<ModelFactoryEvent, 'sequence'>;
export type ModelFactoryTxState = DocumentTxState<ModelFactoryJob, ModelFactoryEventDraft>;
/** Storage port of ModelFactoryStore. See DocumentRepository for the contract. */
export type ModelFactoryRepository = DocumentRepository<ModelFactoryJob, ModelFactoryEventDraft>;

/** Local SQLite repository of ModelFactoryStore, with the table names the store has always used. */
export class SqliteModelFactoryRepository extends SqliteDocumentRepository<ModelFactoryJob, ModelFactoryEventDraft> {
  constructor(path = ':memory:') {
    super(path, 'model_factory_jobs', 'model_factory_events');
  }
}
