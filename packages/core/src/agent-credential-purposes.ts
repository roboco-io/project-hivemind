import { createHash } from 'node:crypto';
import { DEFAULT_PROJECT_ID, validateProjectId } from './projects.js';
import { DomainError } from './store.js';

/**
 * Purposes an agent may ask scoped AWS credentials for. Each purpose has a fixed policy template here;
 * which purposes are enabled is set by the operator in the Control Plane configuration and narrowed further
 * by each hosted project's policy. The agent sends a purpose and target arguments, never a policy.
 */
export const AGENT_CREDENTIAL_PURPOSES = [
  'spot-placement-read',
  'project-inputs-upload',
  'project-artifacts-read',
  'model-inputs-upload',
  'model-artifacts-read',
] as const;
export type AgentCredentialPurpose = (typeof AGENT_CREDENTIAL_PURPOSES)[number];

/** Upper bound on the lifetime of issued credentials. The parent role enforces the same bound in IAM. */
export const AGENT_CREDENTIAL_MAX_SECONDS = 900;
export const AGENT_CREDENTIAL_DEFAULT_SECONDS = 900;
/** GetScopedCredentials accepts a policy of at most 2,048 characters. */
export const SCOPED_POLICY_MAX_CHARS = 2048;

export interface AgentCredentialCatalogConfig {
  enabledPurposes: readonly AgentCredentialPurpose[];
  artifactsBucket: string;
  artifactsKmsKeyArn: string;
  /** Regions Spot placement reads may target. */
  allowedRegions: readonly string[];
}

export interface AgentCredentialProjectScope {
  projectId: string;
  allowedPrefixes: readonly string[];
  allowedRegions: readonly string[];
  allowedPurposes: readonly AgentCredentialPurpose[];
}

export interface AgentCredentialRequestInput {
  purpose?: unknown;
  projectId?: unknown;
  workloadId?: unknown;
  /** Legacy alias for workloadId (used with model-inputs-upload / model-artifacts-read). */
  modelId?: unknown;
  durationSeconds?: unknown;
}

export interface AgentCredentialPlan {
  purpose: AgentCredentialPurpose;
  target: { projectId: string | null; workloadId: string | null; modelId: string | null; s3Prefix: string | null };
  policy: string;
  policyHash: string;
  durationSeconds: number;
  /** Recorded in CloudTrail as `ScopedSessionDescription`. */
  description: string;
}

const WORKLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d+$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KMS_KEY_ARN = /^arn:aws:kms:[a-z]{2}-[a-z]+-\d+:\d{12}:key\/[a-f0-9-]{36}$/;

/** Reads the enabled purposes from a comma-separated setting. An unknown name fails closed. */
export function parseEnabledPurposes(raw: string | undefined): AgentCredentialPurpose[] {
  if (!raw?.trim()) return [];
  const names = raw.split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!(AGENT_CREDENTIAL_PURPOSES as readonly string[]).includes(name)) {
      throw new Error(`Unknown agent credential purpose in configuration: ${name}`);
    }
  }
  return [...new Set(names)] as AgentCredentialPurpose[];
}

export function validateCatalogConfig(config: AgentCredentialCatalogConfig): AgentCredentialCatalogConfig {
  if (!BUCKET.test(config.artifactsBucket)) throw new Error('Invalid artifacts bucket for agent credentials');
  if (!KMS_KEY_ARN.test(config.artifactsKmsKeyArn)) throw new Error('Invalid artifacts KMS key ARN for agent credentials');
  if (config.allowedRegions.length === 0 || config.allowedRegions.some((r) => !REGION.test(r))) {
    throw new Error('Invalid allowed regions for agent credentials');
  }
  return config;
}

function resolveWorkloadId(input: AgentCredentialRequestInput): string {
  const candidate = input.workloadId ?? input.modelId;
  if (typeof candidate !== 'string' || !WORKLOAD_ID.test(candidate)) {
    throw new DomainError('workloadId (or modelId) must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$', 400);
  }
  return candidate;
}

function s3Policy(
  config: AgentCredentialCatalogConfig,
  prefix: string,
  writable: boolean,
): object {
  const bucketArn = `arn:aws:s3:::${config.artifactsBucket}`;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: writable ? ['s3:PutObject', 's3:GetObject'] : 's3:GetObject',
        Resource: `${bucketArn}/${prefix}*`,
      },
      {
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: bucketArn,
        Condition: { StringLike: { 's3:prefix': `${prefix}*` } },
      },
      {
        Effect: 'Allow',
        Action: writable ? ['kms:GenerateDataKey', 'kms:Decrypt'] : 'kms:Decrypt',
        Resource: config.artifactsKmsKeyArn,
      },
    ],
  };
}

/**
 * Checks an agent request against the host catalog and optional project scope, and fills the purpose's
 * policy template. Throws a 400/403 DomainError for anything outside the catalog or project boundary.
 */
export function planAgentCredentials(
  config: AgentCredentialCatalogConfig,
  input: AgentCredentialRequestInput,
  projectScope?: AgentCredentialProjectScope,
): AgentCredentialPlan {
  const purpose = input.purpose;
  if (typeof purpose !== 'string' || !(AGENT_CREDENTIAL_PURPOSES as readonly string[]).includes(purpose)) {
    throw new DomainError(`Unknown credential purpose. Known purposes: ${AGENT_CREDENTIAL_PURPOSES.join(', ')}`, 400);
  }
  const typed = purpose as AgentCredentialPurpose;
  if (!config.enabledPurposes.includes(typed)) {
    throw new DomainError(`Credential purpose '${typed}' is not enabled on this Control Plane`, 403);
  }
  if (projectScope && !projectScope.allowedPurposes.includes(typed)) {
    throw new DomainError(`Credential purpose '${typed}' is not enabled for project '${projectScope.projectId}'`, 403);
  }

  let durationSeconds = AGENT_CREDENTIAL_DEFAULT_SECONDS;
  if (input.durationSeconds !== undefined) {
    const value = input.durationSeconds;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 60 || value > AGENT_CREDENTIAL_MAX_SECONDS) {
      throw new DomainError(`durationSeconds must be an integer between 60 and ${AGENT_CREDENTIAL_MAX_SECONDS}`, 400);
    }
    durationSeconds = value;
  }

  let projectId: string | null = projectScope?.projectId ?? null;
  if (input.projectId !== undefined) {
    const requestedProject = input.projectId === DEFAULT_PROJECT_ID ? DEFAULT_PROJECT_ID : validateProjectId(input.projectId);
    if (projectScope && requestedProject !== projectScope.projectId) {
      throw new DomainError(`Project token for '${projectScope.projectId}' cannot request credentials for '${requestedProject}'`, 403);
    }
    projectId = requestedProject;
  }

  let workloadId: string | null = null;
  let s3Prefix: string | null = null;
  let policyObject: object;

  if (typed === 'spot-placement-read') {
    if (input.modelId !== undefined || input.workloadId !== undefined) {
      throw new DomainError('spot-placement-read takes no workloadId or modelId', 400);
    }
    const effectiveRegions = projectScope
      ? config.allowedRegions.filter((r) => projectScope.allowedRegions.includes(r))
      : [...config.allowedRegions];
    if (effectiveRegions.length === 0) {
      throw new DomainError(`Project '${projectScope?.projectId}' has no allowed regions overlapping the host catalog`, 403);
    }
    policyObject = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['ec2:GetSpotPlacementScores', 'ec2:DescribeSpotPriceHistory', 'ec2:DescribeInstanceTypeOfferings'],
          Resource: '*',
          Condition: { StringEquals: { 'aws:RequestedRegion': effectiveRegions } },
        },
      ],
    };
  } else {
    workloadId = resolveWorkloadId(input);
    const isUpload = typed === 'project-inputs-upload' || typed === 'model-inputs-upload';
    const isProjectScopedPurpose = typed === 'project-inputs-upload' || typed === 'project-artifacts-read';
    if (isProjectScopedPurpose) {
      const effectiveProject = projectId ?? DEFAULT_PROJECT_ID;
      projectId = effectiveProject;
      s3Prefix = `projects/${effectiveProject}/${workloadId}/${isUpload ? 'inputs' : 'runs'}/`;
    } else {
      s3Prefix = `models/${workloadId}/${isUpload ? 'inputs' : 'runs'}/`;
    }
    if (projectScope) {
      const prefixAllowed = projectScope.allowedPrefixes.some((allowed) => s3Prefix!.startsWith(allowed));
      if (!prefixAllowed) {
        throw new DomainError(
          `S3 prefix '${s3Prefix}' is outside allowed prefixes for project '${projectScope.projectId}'`,
          403,
        );
      }
    }
    policyObject = s3Policy(config, s3Prefix, isUpload);
  }

  const policy = JSON.stringify(policyObject);
  if (policy.length > SCOPED_POLICY_MAX_CHARS) {
    throw new DomainError(`Scoped policy for '${typed}' exceeds ${SCOPED_POLICY_MAX_CHARS} characters`, 400);
  }
  const descParts = ['hivemind-agent', typed, projectId, workloadId].filter(Boolean);
  return {
    purpose: typed,
    target: { projectId, workloadId, modelId: workloadId, s3Prefix },
    policy,
    policyHash: createHash('sha256').update(policy).digest('hex'),
    durationSeconds,
    description: descParts.join(' '),
  };
}
