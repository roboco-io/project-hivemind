import type { ProjectApprovalPolicy, ProjectApprovalPolicyPatch } from './approval-policy.js';

export const PROJECT_CAPABILITIES = [
  'delivery',
  'compute',
  'collab',
  'autonomy_triggers',
  'scoped_credentials',
  'hf_release',
  'notifications',
] as const;

export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

export const PROJECT_TEMPLATES = ['generic', 'model-factory', 'sw-delivery', 'research-collab'] as const;
export type ProjectTemplateId = (typeof PROJECT_TEMPLATES)[number];

export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TOKEN_SCOPES = [
  'compute:read',
  'compute:write',
  'delivery:read',
  'delivery:write',
  'collab:read',
  'collab:write',
  'autonomy:read',
  'credentials:issue',
  'notifications:send',
] as const;

export type ProjectTokenScope = (typeof PROJECT_TOKEN_SCOPES)[number];

export const PROJECT_CREDENTIAL_PURPOSES = [
  'spot-placement-read',
  'project-inputs-upload',
  'project-artifacts-read',
  'model-inputs-upload',
  'model-artifacts-read',
] as const;

export type ProjectCredentialPurpose = (typeof PROJECT_CREDENTIAL_PURPOSES)[number];

export interface ProjectBudgetPolicy {
  /** Per-project hard Spot compute cap in USD micros (bounded by host global ceiling). */
  computeBudgetCapMicros: number;
  /** Optional per-job ceiling in USD micros for this project (null = bounded only by project cap). */
  maxSingleJobCostMicros: number | null;
  /** Per-delivery-task ceiling in USD micros. */
  maxDeliveryTaskBudgetMicros: number;
}

export interface ProjectDeliveryPolicy {
  /** GitHub repositories this project may target ("owner/repo"). */
  repositories: string[];
  /** Subset of repositories allowed to auto-merge when protectedPaths are untouched. */
  autoMergeRepositories: string[];
  /** Default branch prefix for autonomous/delivery tasks (e.g. "agent/"). */
  defaultBranchPrefix: string;
  /** Default protected paths enforced on auto-merge & periodic triggers. */
  defaultProtectedPaths: string[];
  /** Whether delivery workers for this project may receive a project-scoped agent token. */
  allowAgentAccess: boolean;
  /** Allowed read-only web hosts for research/delivery workers. */
  allowedWebHosts: string[];
}

export interface ProjectComputePolicy {
  /** Allowed AWS regions for this project's Spot compute instances. */
  allowedRegions: string[];
  /** Allowed S3 artifact prefixes (e.g. ["projects/<id>/"], or ["projects/<id>/", "models/"]). */
  s3ArtifactPrefixes: string[];
  /** Allowed Hugging Face repository prefixes for auto-publish (e.g. ["roboco-io/"]). */
  autoPublishHfRepoPrefixes: string[];
  /** Enabled STS GetScopedCredentials purposes for this project's agent tokens. */
  credentialPurposes: ProjectCredentialPurpose[];
  /** Maximum EC2 Spot lifetime in milliseconds for this project (60_000..604_800_000). */
  maxLifetimeMs: number;
}

export interface ProjectAgentTokenRecord {
  tokenId: string;
  label: string;
  /** Non-secret prefix for identification in UI/logs (e.g. "hmproj_a1b2c"). */
  tokenPrefix: string;
  /** SHA-256 hex hash of the raw bearer token. Never exposed in public views. */
  tokenHash: string;
  scopes: ProjectTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type ProjectAgentTokenPublic = Omit<ProjectAgentTokenRecord, 'tokenHash'>;

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  template: ProjectTemplateId;
  status: ProjectStatus;
  capabilities: ProjectCapability[];
  budget: ProjectBudgetPolicy;
  delivery: ProjectDeliveryPolicy;
  compute: ProjectComputePolicy;
  /** Per-project policy defining when agents may auto-approve vs require manual human approval. */
  approvalPolicy: ProjectApprovalPolicy;
  notificationChannel: string | null;
  /** Non-secret project-defined extension metadata for future workload/runtime slots. */
  extensions: Record<string, string | number | boolean>;
  tokens: ProjectAgentTokenRecord[];
  createdAt: string;
  updatedAt: string;
}

export type ProjectPublicView = Omit<ProjectRecord, 'tokens'> & {
  tokens: ProjectAgentTokenPublic[];
};

export interface CreateProjectInput {
  id: string;
  name: string;
  description?: string;
  template?: ProjectTemplateId;
  capabilities?: ProjectCapability[];
  budget?: Partial<ProjectBudgetPolicy>;
  delivery?: Partial<ProjectDeliveryPolicy>;
  compute?: Partial<ProjectComputePolicy>;
  approvalPolicy?: ProjectApprovalPolicyPatch;
  notificationChannel?: string | null;
  extensions?: Record<string, string | number | boolean>;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  capabilities?: ProjectCapability[];
  budget?: Partial<ProjectBudgetPolicy>;
  delivery?: Partial<ProjectDeliveryPolicy>;
  compute?: Partial<ProjectComputePolicy>;
  approvalPolicy?: ProjectApprovalPolicyPatch;
  notificationChannel?: string | null;
  extensions?: Record<string, string | number | boolean>;
}

export interface IssueProjectTokenInput {
  label: string;
  scopes?: ProjectTokenScope[];
}

export interface IssuedProjectToken {
  projectId: string;
  token: string;
  metadata: ProjectAgentTokenPublic;
}

export interface ProjectEvent {
  sequence: number;
  projectId: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
