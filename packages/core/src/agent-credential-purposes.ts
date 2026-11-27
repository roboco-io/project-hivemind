import { createHash } from 'node:crypto';
import { DomainError } from './store.js';

/**
 * Purposes an agent may ask scoped AWS credentials for. Each purpose has a fixed policy template here;
 * which purposes are enabled is set by the operator in the Control Plane configuration (CDK), never by
 * the agent. The agent sends a purpose and target arguments, never a policy.
 */
export const AGENT_CREDENTIAL_PURPOSES = ['spot-placement-read', 'model-inputs-upload', 'model-artifacts-read'] as const;
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

export interface AgentCredentialRequestInput {
  purpose?: unknown;
  modelId?: unknown;
  durationSeconds?: unknown;
}

export interface AgentCredentialPlan {
  purpose: AgentCredentialPurpose;
  target: { modelId: string | null };
  policy: string;
  policyHash: string;
  durationSeconds: number;
  /** Recorded in CloudTrail as `ScopedSessionDescription`. */
  description: string;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
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

function modelIdOf(input: AgentCredentialRequestInput): string {
  if (typeof input.modelId !== 'string' || !MODEL_ID.test(input.modelId)) {
    throw new DomainError('modelId must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$', 400);
  }
  return input.modelId;
}

function policyFor(config: AgentCredentialCatalogConfig, purpose: AgentCredentialPurpose, modelId: string | null): object {
  const bucketArn = `arn:aws:s3:::${config.artifactsBucket}`;
  switch (purpose) {
    case 'spot-placement-read':
      return {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['ec2:GetSpotPlacementScores', 'ec2:DescribeSpotPriceHistory', 'ec2:DescribeInstanceTypeOfferings'],
            Resource: '*',
            Condition: { StringEquals: { 'aws:RequestedRegion': [...config.allowedRegions] } },
          },
        ],
      };
    case 'model-inputs-upload': {
      const prefix = `models/${modelId}/inputs/`;
      return {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: `${bucketArn}/${prefix}*` },
          { Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketArn, Condition: { StringLike: { 's3:prefix': `${prefix}*` } } },
          { Effect: 'Allow', Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: config.artifactsKmsKeyArn },
        ],
      };
    }
    case 'model-artifacts-read': {
      const prefix = `models/${modelId}/runs/`;
      return {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 's3:GetObject', Resource: `${bucketArn}/${prefix}*` },
          { Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketArn, Condition: { StringLike: { 's3:prefix': `${prefix}*` } } },
          { Effect: 'Allow', Action: 'kms:Decrypt', Resource: config.artifactsKmsKeyArn },
        ],
      };
    }
  }
}

/**
 * Checks an agent request against the enabled purposes and fills the purpose's policy template.
 * Throws a 400/403 DomainError for anything outside the catalog; nothing here talks to AWS.
 */
export function planAgentCredentials(config: AgentCredentialCatalogConfig, input: AgentCredentialRequestInput): AgentCredentialPlan {
  const purpose = input.purpose;
  if (typeof purpose !== 'string' || !(AGENT_CREDENTIAL_PURPOSES as readonly string[]).includes(purpose)) {
    throw new DomainError(`Unknown credential purpose. Known purposes: ${AGENT_CREDENTIAL_PURPOSES.join(', ')}`, 400);
  }
  if (!config.enabledPurposes.includes(purpose as AgentCredentialPurpose)) {
    throw new DomainError(`Credential purpose '${purpose}' is not enabled on this Control Plane`, 403);
  }
  const typed = purpose as AgentCredentialPurpose;
  let durationSeconds = AGENT_CREDENTIAL_DEFAULT_SECONDS;
  if (input.durationSeconds !== undefined) {
    const value = input.durationSeconds;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 60 || value > AGENT_CREDENTIAL_MAX_SECONDS) {
      throw new DomainError(`durationSeconds must be an integer between 60 and ${AGENT_CREDENTIAL_MAX_SECONDS}`, 400);
    }
    durationSeconds = value;
  }
  let modelId: string | null = null;
  if (typed === 'spot-placement-read') {
    if (input.modelId !== undefined) throw new DomainError('spot-placement-read takes no modelId', 400);
  } else {
    modelId = modelIdOf(input);
  }
  const policy = JSON.stringify(policyFor(config, typed, modelId));
  if (policy.length > SCOPED_POLICY_MAX_CHARS) {
    throw new DomainError(`Scoped policy for '${typed}' exceeds ${SCOPED_POLICY_MAX_CHARS} characters`, 400);
  }
  return {
    purpose: typed,
    target: { modelId },
    policy,
    policyHash: createHash('sha256').update(policy).digest('hex'),
    durationSeconds,
    description: `hivemind-agent ${typed}${modelId ? ` ${modelId}` : ''}`,
  };
}
