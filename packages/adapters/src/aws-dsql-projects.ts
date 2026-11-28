import type { ProjectRecord } from '../../contracts/src/projects.js';
import { importHistoryIfEmpty } from '../../core/src/document-repository.js';
import type { ProjectEventDraft, ProjectRepository } from '../../core/src/projects.js';
import { DsqlDocumentRepository, type DsqlDocumentRepositoryOptions } from './aws-dsql-documents.js';

export type DsqlProjectRepositoryOptions = DsqlDocumentRepositoryOptions;

/**
 * Amazon Aurora DSQL repository of ProjectStore (tables `hm_projects_jobs`, `hm_projects_events`, `hm_projects_meta`).
 */
export class DsqlProjectRepository extends DsqlDocumentRepository<ProjectRecord, ProjectEventDraft> {
  constructor(options: DsqlProjectRepositoryOptions) {
    super(options, { defaultPrefix: 'hm_projects', eventOwnerColumn: 'project_id', eventOwnerId: (event) => event.projectId });
  }
}

export function importProjectHistoryIfEmpty(source: ProjectRepository, target: ProjectRepository): Promise<number> {
  return importHistoryIfEmpty(source, target);
}
