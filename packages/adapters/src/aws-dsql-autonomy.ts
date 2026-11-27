import type { AutonomyTrigger, AutonomyTriggerEventDraft } from '../../core/src/autonomy-trigger.js';
import { DsqlDocumentRepository, type DsqlDocumentRepositoryOptions } from './aws-dsql-documents.js';

/** Amazon Aurora DSQL repository of AutonomyTriggerStore (tables `hm_trig_jobs`, `hm_trig_events`, `hm_trig_meta`). */
export class DsqlAutonomyTriggerRepository extends DsqlDocumentRepository<AutonomyTrigger, AutonomyTriggerEventDraft> {
  constructor(options: DsqlDocumentRepositoryOptions) {
    super(options, { defaultPrefix: 'hm_trig', eventOwnerColumn: 'trigger_id', eventOwnerId: (event) => event.triggerId });
  }
}
