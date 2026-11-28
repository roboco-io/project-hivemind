import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PROJECT_CAPABILITIES,
  PROJECT_CREDENTIAL_PURPOSES,
  PROJECT_STATUSES,
  PROJECT_TEMPLATES,
  PROJECT_TOKEN_SCOPES,
  type CreateProjectInput,
  type IssueProjectTokenInput,
  type IssuedProjectToken,
  type ProjectAgentTokenPublic,
  type ProjectAgentTokenRecord,
  type ProjectBudgetPolicy,
  type ProjectCapability,
  type ProjectComputePolicy,
  type ProjectCredentialPurpose,
  type ProjectDeliveryPolicy,
  type ProjectEvent,
  type ProjectPublicView,
  type ProjectRecord,
  type ProjectStatus,
  type ProjectTemplateId,
  type ProjectTokenScope,
  type UpdateProjectInput,
} from '../../contracts/src/projects.js';
import { SqliteDocumentRepository, type DocumentRepository, type DocumentTxState } from './document-repository.js';
import { DomainError, equalSecret, text } from './store.js';

export const DEFAULT_PROJECT_ID = 'default';
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const HF_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/$/;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,60}$/;
const S3_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*\/$/;
const MAX_TOKENS_PER_PROJECT = 20;
const MAX_LIFETIME_MS = 604_800_000; // 7 days

export type ProjectEventDraft = Omit<ProjectEvent, 'sequence'>;
export type ProjectTxState = DocumentTxState<ProjectRecord, ProjectEventDraft>;
export type ProjectRepository = DocumentRepository<ProjectRecord, ProjectEventDraft>;

export class SqliteProjectRepository extends SqliteDocumentRepository<ProjectRecord, ProjectEventDraft> {
  constructor(path = ':memory:') {
    super(path, 'projects_docs', 'projects_events');
  }
}

export interface ProjectTemplateDefaults {
  capabilities: ProjectCapability[];
  budget: ProjectBudgetPolicy;
  delivery: Omit<ProjectDeliveryPolicy, 'repositories' | 'autoMergeRepositories'>;
  compute: Omit<ProjectComputePolicy, 's3ArtifactPrefixes'> & { includeLegacyModelsPrefix?: boolean };
  defaultTokenScopes: ProjectTokenScope[];
}

export const PROJECT_TEMPLATE_PRESETS: Record<ProjectTemplateId, ProjectTemplateDefaults> = {
  generic: {
    capabilities: ['delivery', 'compute', 'collab', 'scoped_credentials', 'notifications'],
    budget: {
      computeBudgetCapMicros: 100_000_000, // $100
      maxSingleJobCostMicros: 50_000_000,  // $50
      maxDeliveryTaskBudgetMicros: 25_000_000,
    },
    delivery: {
      defaultBranchPrefix: 'agent/',
      defaultProtectedPaths: [],
      allowAgentAccess: true,
      allowedWebHosts: [],
    },
    compute: {
      allowedRegions: ['ap-northeast-2', 'us-east-2'],
      autoPublishHfRepoPrefixes: [],
      credentialPurposes: ['spot-placement-read', 'project-inputs-upload', 'project-artifacts-read'],
      maxLifetimeMs: 28_800_000, // 8h
    },
    defaultTokenScopes: ['compute:read', 'compute:write', 'delivery:read', 'collab:read', 'collab:write', 'autonomy:read', 'credentials:issue', 'notifications:send'],
  },
  'model-factory': {
    capabilities: ['delivery', 'compute', 'collab', 'autonomy_triggers', 'scoped_credentials', 'hf_release', 'notifications'],
    budget: {
      computeBudgetCapMicros: 500_000_000, // $500
      maxSingleJobCostMicros: 150_000_000, // $150
      maxDeliveryTaskBudgetMicros: 50_000_000,
    },
    delivery: {
      defaultBranchPrefix: 'agent/',
      defaultProtectedPaths: ['ops/autonomy/policy.json'],
      allowAgentAccess: true,
      allowedWebHosts: ['arxiv.org', 'github.com', 'huggingface.co'],
    },
    compute: {
      allowedRegions: ['ap-northeast-2', 'us-east-2', 'us-east-1', 'us-west-2', 'ap-northeast-1'],
      autoPublishHfRepoPrefixes: [],
      credentialPurposes: ['spot-placement-read', 'project-inputs-upload', 'project-artifacts-read', 'model-inputs-upload', 'model-artifacts-read'],
      maxLifetimeMs: 86_400_000, // 24h
      includeLegacyModelsPrefix: true,
    },
    defaultTokenScopes: ['compute:read', 'compute:write', 'delivery:read', 'collab:read', 'collab:write', 'autonomy:read', 'credentials:issue', 'notifications:send'],
  },
  'sw-delivery': {
    capabilities: ['delivery', 'autonomy_triggers', 'notifications'],
    budget: {
      computeBudgetCapMicros: 0,
      maxSingleJobCostMicros: null,
      maxDeliveryTaskBudgetMicros: 50_000_000,
    },
    delivery: {
      defaultBranchPrefix: 'agent/',
      defaultProtectedPaths: [],
      allowAgentAccess: false,
      allowedWebHosts: [],
    },
    compute: {
      allowedRegions: ['ap-northeast-2', 'us-east-2'],
      autoPublishHfRepoPrefixes: [],
      credentialPurposes: [],
      maxLifetimeMs: 14_400_000,
    },
    defaultTokenScopes: ['delivery:read', 'autonomy:read', 'notifications:send'],
  },
  'research-collab': {
    capabilities: ['delivery', 'compute', 'collab', 'scoped_credentials', 'notifications'],
    budget: {
      computeBudgetCapMicros: 150_000_000, // $150
      maxSingleJobCostMicros: 50_000_000,
      maxDeliveryTaskBudgetMicros: 50_000_000,
    },
    delivery: {
      defaultBranchPrefix: 'research/',
      defaultProtectedPaths: [],
      allowAgentAccess: true,
      allowedWebHosts: ['arxiv.org', 'github.com', 'huggingface.co'],
    },
    compute: {
      allowedRegions: ['ap-northeast-2', 'us-east-2'],
      autoPublishHfRepoPrefixes: [],
      credentialPurposes: ['spot-placement-read', 'project-inputs-upload', 'project-artifacts-read'],
      maxLifetimeMs: 28_800_000,
    },
    defaultTokenScopes: ['compute:read', 'compute:write', 'delivery:read', 'collab:read', 'collab:write', 'credentials:issue', 'notifications:send'],
  },
};

export function hashProjectToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function validateProjectId(raw: unknown): string {
  const id = text(raw, 'projectId', 64).toLowerCase();
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new DomainError('projectId must match ^[a-z0-9][a-z0-9-]{1,48}$', 400);
  }
  return id;
}

export function toProjectPublicView(record: ProjectRecord): ProjectPublicView {
  return {
    ...structuredClone(record),
    tokens: record.tokens.map(({ tokenHash: _hash, ...rest }) => structuredClone(rest)),
  };
}

function uniqueStringList(
  raw: unknown,
  label: string,
  maxItems: number,
  normalize: (item: string) => string,
): string[] {
  if (!Array.isArray(raw) || raw.length > maxItems) {
    throw new DomainError(`${label} must be an array of at most ${maxItems} items`, 400);
  }
  return [...new Set(raw.map((item) => normalize(text(item, `${label}[]`, 256))))];
}

function validateCapabilities(raw: unknown): ProjectCapability[] {
  const allowed = new Set<string>(PROJECT_CAPABILITIES);
  return uniqueStringList(raw, 'capabilities', PROJECT_CAPABILITIES.length, (item) => {
    if (!allowed.has(item)) throw new DomainError(`Unknown capability: ${item}`, 400);
    return item;
  }) as ProjectCapability[];
}

function validateTokenScopes(raw: unknown): ProjectTokenScope[] {
  const allowed = new Set<string>(PROJECT_TOKEN_SCOPES);
  const scopes = uniqueStringList(raw, 'scopes', PROJECT_TOKEN_SCOPES.length, (item) => {
    if (!allowed.has(item)) throw new DomainError(`Unknown token scope: ${item}`, 400);
    return item;
  }) as ProjectTokenScope[];
  if (scopes.length === 0) throw new DomainError('Token requires at least one scope', 400);
  return scopes;
}

function validateCredentialPurposes(raw: unknown): ProjectCredentialPurpose[] {
  const allowed = new Set<string>(PROJECT_CREDENTIAL_PURPOSES);
  return uniqueStringList(raw, 'compute.credentialPurposes', PROJECT_CREDENTIAL_PURPOSES.length, (item) => {
    if (!allowed.has(item)) throw new DomainError(`Unknown credential purpose: ${item}`, 400);
    return item;
  }) as ProjectCredentialPurpose[];
}

function validateS3Prefix(raw: string): string {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const withSlash = cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
  if (!S3_PREFIX_PATTERN.test(withSlash) || withSlash.includes('..') || withSlash.startsWith('staging/')) {
    throw new DomainError(`Invalid S3 prefix: ${raw}`, 400);
  }
  return withSlash;
}

function validateExtensions(raw: unknown): Record<string, string | number | boolean> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('extensions must be a flat object of primitive values', 400);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 32) throw new DomainError('extensions supports at most 32 entries', 400);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      throw new DomainError(`Invalid extension key: ${key}`, 400);
    }
    if (typeof value === 'string') {
      if (value.length > 500) throw new DomainError(`Extension value for ${key} exceeds 500 chars`, 400);
      out[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      throw new DomainError(`Extension value for ${key} must be string, finite number, or boolean`, 400);
    }
  }
  return out;
}

function validateBudget(input: Partial<ProjectBudgetPolicy> | undefined, base: ProjectBudgetPolicy): ProjectBudgetPolicy {
  const computeBudgetCapMicros = input?.computeBudgetCapMicros ?? base.computeBudgetCapMicros;
  if (!Number.isSafeInteger(computeBudgetCapMicros) || computeBudgetCapMicros < 0 || computeBudgetCapMicros > 10_000_000_000) {
    throw new DomainError('budget.computeBudgetCapMicros must be an integer between 0 and 10000000000', 400);
  }
  const maxSingleJobCostMicros =
    input?.maxSingleJobCostMicros === undefined ? base.maxSingleJobCostMicros : input.maxSingleJobCostMicros;
  if (
    maxSingleJobCostMicros !== null &&
    (!Number.isSafeInteger(maxSingleJobCostMicros) || maxSingleJobCostMicros < 1 || maxSingleJobCostMicros > 10_000_000_000)
  ) {
    throw new DomainError('budget.maxSingleJobCostMicros must be null or an integer between 1 and 10000000000', 400);
  }
  const maxDeliveryTaskBudgetMicros = input?.maxDeliveryTaskBudgetMicros ?? base.maxDeliveryTaskBudgetMicros;
  if (!Number.isSafeInteger(maxDeliveryTaskBudgetMicros) || maxDeliveryTaskBudgetMicros < 0 || maxDeliveryTaskBudgetMicros > 1_000_000_000) {
    throw new DomainError('budget.maxDeliveryTaskBudgetMicros must be an integer between 0 and 1000000000', 400);
  }
  return { computeBudgetCapMicros, maxSingleJobCostMicros, maxDeliveryTaskBudgetMicros };
}

function validateDelivery(input: Partial<ProjectDeliveryPolicy> | undefined, base: ProjectDeliveryPolicy): ProjectDeliveryPolicy {
  const repositories =
    input?.repositories === undefined
      ? [...base.repositories]
      : uniqueStringList(input.repositories, 'delivery.repositories', 32, (repo) => {
          if (!REPO_PATTERN.test(repo)) throw new DomainError(`Invalid repository: ${repo}`, 400);
          return repo;
        });
  const repoSet = new Set(repositories);
  const autoMergeRepositories =
    input?.autoMergeRepositories === undefined
      ? base.autoMergeRepositories.filter((r) => repoSet.has(r))
      : uniqueStringList(input.autoMergeRepositories, 'delivery.autoMergeRepositories', 32, (repo) => {
          if (!REPO_PATTERN.test(repo)) throw new DomainError(`Invalid autoMerge repository: ${repo}`, 400);
          if (!repoSet.has(repo)) {
            throw new DomainError(`autoMerge repository ${repo} must also be listed in delivery.repositories`, 400);
          }
          return repo;
        });
  const defaultBranchPrefix = input?.defaultBranchPrefix ?? base.defaultBranchPrefix;
  if (!BRANCH_PREFIX_PATTERN.test(defaultBranchPrefix) || defaultBranchPrefix.includes('..')) {
    throw new DomainError(`Invalid delivery.defaultBranchPrefix: ${defaultBranchPrefix}`, 400);
  }
  const defaultProtectedPaths =
    input?.defaultProtectedPaths === undefined
      ? [...base.defaultProtectedPaths]
      : uniqueStringList(input.defaultProtectedPaths, 'delivery.defaultProtectedPaths', 64, (p) => {
          const clean = p.replace(/\\/g, '/').replace(/^\/+/, '');
          if (!clean || clean.includes('..') || clean.includes('\0')) {
            throw new DomainError(`Invalid protected path: ${p}`, 400);
          }
          return clean;
        });
  const allowAgentAccess = input?.allowAgentAccess ?? base.allowAgentAccess;
  if (typeof allowAgentAccess !== 'boolean') throw new DomainError('delivery.allowAgentAccess must be boolean', 400);
  const allowedWebHosts =
    input?.allowedWebHosts === undefined
      ? [...base.allowedWebHosts]
      : uniqueStringList(input.allowedWebHosts, 'delivery.allowedWebHosts', 32, (host) => {
          const clean = host.toLowerCase();
          if (!HOST_PATTERN.test(clean)) throw new DomainError(`Invalid allowedWebHost: ${host}`, 400);
          return clean;
        });
  return {
    repositories,
    autoMergeRepositories,
    defaultBranchPrefix,
    defaultProtectedPaths,
    allowAgentAccess,
    allowedWebHosts,
  };
}

function validateCompute(
  projectId: string,
  input: Partial<ProjectComputePolicy> | undefined,
  base: ProjectComputePolicy,
): ProjectComputePolicy {
  const allowedRegions =
    input?.allowedRegions === undefined
      ? [...base.allowedRegions]
      : uniqueStringList(input.allowedRegions, 'compute.allowedRegions', 12, (r) => {
          const clean = r.toLowerCase();
          if (!REGION_PATTERN.test(clean)) throw new DomainError(`Invalid AWS region: ${r}`, 400);
          return clean;
        });
  if (allowedRegions.length === 0) throw new DomainError('compute.allowedRegions must contain at least one region', 400);
  const s3ArtifactPrefixes =
    input?.s3ArtifactPrefixes === undefined
      ? [...base.s3ArtifactPrefixes]
      : uniqueStringList(input.s3ArtifactPrefixes, 'compute.s3ArtifactPrefixes', 16, validateS3Prefix);
  if (s3ArtifactPrefixes.length === 0) {
    s3ArtifactPrefixes.push(`projects/${projectId}/`);
  }
  const autoPublishHfRepoPrefixes =
    input?.autoPublishHfRepoPrefixes === undefined
      ? [...base.autoPublishHfRepoPrefixes]
      : uniqueStringList(input.autoPublishHfRepoPrefixes, 'compute.autoPublishHfRepoPrefixes', 16, (p) => {
          if (!HF_PREFIX_PATTERN.test(p)) {
            throw new DomainError(`Invalid HF repo prefix (must look like "org/"): ${p}`, 400);
          }
          return p;
        });
  const credentialPurposes =
    input?.credentialPurposes === undefined
      ? [...base.credentialPurposes]
      : validateCredentialPurposes(input.credentialPurposes);
  const maxLifetimeMs = input?.maxLifetimeMs ?? base.maxLifetimeMs;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000 || maxLifetimeMs > MAX_LIFETIME_MS) {
    throw new DomainError(`compute.maxLifetimeMs must be between 60000 and ${MAX_LIFETIME_MS}`, 400);
  }
  return {
    allowedRegions,
    s3ArtifactPrefixes,
    autoPublishHfRepoPrefixes,
    credentialPurposes,
    maxLifetimeMs,
  };
}

export interface AuthenticatedProjectToken {
  project: ProjectPublicView;
  token: ProjectAgentTokenPublic;
  scopes: ReadonlySet<ProjectTokenScope>;
}

/**
 * Central multi-project registry and policy store.
 * Owns project manifests, per-project budget & capability policies, and SHA-256 hashed scoped agent tokens.
 * Raw agent tokens are returned once at issuance and never persisted, logged, or returned again.
 */
export class ProjectStore {
  private readonly repository: ProjectRepository;
  private readonly now: () => number;
  private activeTx: ProjectTxState | null = null;

  constructor(storage: string | ProjectRepository = ':memory:', options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.repository = typeof storage === 'string' ? new SqliteProjectRepository(storage) : storage;
  }

  get storageBackend(): ProjectRepository['storageBackend'] {
    return this.repository.storageBackend;
  }

  close(): Promise<void> {
    return this.repository.close();
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private tx<T>(fn: () => T): Promise<T> {
    return this.repository.transaction((state) => {
      this.activeTx = state;
      try {
        return fn();
      } finally {
        this.activeTx = null;
      }
    });
  }

  private state(): ProjectTxState {
    if (!this.activeTx) throw new Error('ProjectStore used outside a repository transaction');
    return this.activeTx;
  }

  private load(id: string): ProjectRecord {
    const doc = this.state().docs.get(id);
    if (!doc) throw new DomainError(`Project '${id}' not found`, 404);
    return structuredClone(doc);
  }

  private save(doc: ProjectRecord): ProjectRecord {
    doc.updatedAt = this.timestamp();
    this.state().docs.set(doc.id, structuredClone(doc));
    this.state().dirtyIds.add(doc.id);
    return structuredClone(doc);
  }

  private emit(projectId: string, type: string, data: Record<string, unknown>): void {
    this.state().newEvents.push({ projectId, type, at: this.timestamp(), data });
  }

  async list(): Promise<ProjectPublicView[]> {
    return (await this.repository.listDocs()).map(toProjectPublicView);
  }

  async get(id: string): Promise<ProjectPublicView> {
    const doc = await this.repository.getDoc(id);
    if (!doc) throw new DomainError(`Project '${id}' not found`, 404);
    return toProjectPublicView(doc);
  }

  async find(id: string): Promise<ProjectPublicView | null> {
    const doc = await this.repository.getDoc(id);
    return doc ? toProjectPublicView(doc) : null;
  }

  async events(projectId?: string, limit = 100): Promise<ProjectEvent[]> {
    const all = (await this.repository.listEvents(limit)) as ProjectEvent[];
    return projectId ? all.filter((e) => e.projectId === projectId) : all;
  }

  async create(input: CreateProjectInput): Promise<ProjectPublicView> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DomainError('Invalid project payload', 400);
    }
    const id = validateProjectId(input.id);
    if (id === DEFAULT_PROJECT_ID || id === 'me') {
      throw new DomainError(`Project id '${id}' is reserved`, 400);
    }
    const template: ProjectTemplateId = input.template ?? 'generic';
    if (!(PROJECT_TEMPLATES as readonly string[]).includes(template)) {
      throw new DomainError(`Unknown project template: ${template}`, 400);
    }
    const preset = PROJECT_TEMPLATE_PRESETS[template];
    const name = text(input.name, 'name', 120);
    const description = input.description === undefined ? '' : text(input.description, 'description', 1000);
    const capabilities = input.capabilities === undefined ? [...preset.capabilities] : validateCapabilities(input.capabilities);
    const budget = validateBudget(input.budget, preset.budget);
    const defaultDelivery: ProjectDeliveryPolicy = {
      repositories: [],
      autoMergeRepositories: [],
      ...preset.delivery,
    };
    const delivery = validateDelivery(input.delivery, defaultDelivery);
    const defaultPrefixes = [`projects/${id}/`, ...(preset.compute.includeLegacyModelsPrefix ? ['models/'] : [])];
    const defaultCompute: ProjectComputePolicy = {
      allowedRegions: [...preset.compute.allowedRegions],
      s3ArtifactPrefixes: defaultPrefixes,
      autoPublishHfRepoPrefixes: [...preset.compute.autoPublishHfRepoPrefixes],
      credentialPurposes: [...preset.compute.credentialPurposes],
      maxLifetimeMs: preset.compute.maxLifetimeMs,
    };
    const compute = validateCompute(id, input.compute, defaultCompute);
    const notificationChannel =
      input.notificationChannel === undefined || input.notificationChannel === null || input.notificationChannel === ''
        ? null
        : text(input.notificationChannel, 'notificationChannel', 256);
    const extensions = validateExtensions(input.extensions);

    return this.tx(() => {
      if (this.state().docs.has(id)) {
        throw new DomainError(`Project '${id}' already exists`, 409);
      }
      const at = this.timestamp();
      const record: ProjectRecord = {
        id,
        name,
        description,
        template,
        status: 'active',
        capabilities,
        budget,
        delivery,
        compute,
        notificationChannel,
        extensions,
        tokens: [],
        createdAt: at,
        updatedAt: at,
      };
      const saved = this.save(record);
      this.emit(id, 'project.created', {
        name: saved.name,
        template: saved.template,
        capabilities: saved.capabilities,
        computeBudgetCapMicros: saved.budget.computeBudgetCapMicros,
        repositories: saved.delivery.repositories,
      });
      return toProjectPublicView(saved);
    });
  }

  async update(id: string, input: UpdateProjectInput): Promise<ProjectPublicView> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DomainError('Invalid project update payload', 400);
    }
    return this.tx(() => {
      const existing = this.load(id);
      if (input.name !== undefined) existing.name = text(input.name, 'name', 120);
      if (input.description !== undefined) {
        existing.description = input.description === '' ? '' : text(input.description, 'description', 1000);
      }
      if (input.status !== undefined) {
        if (!(PROJECT_STATUSES as readonly string[]).includes(input.status)) {
          throw new DomainError(`Invalid project status: ${input.status}`, 400);
        }
        existing.status = input.status as ProjectStatus;
      }
      if (input.capabilities !== undefined) existing.capabilities = validateCapabilities(input.capabilities);
      if (input.budget !== undefined) existing.budget = validateBudget(input.budget, existing.budget);
      if (input.delivery !== undefined) existing.delivery = validateDelivery(input.delivery, existing.delivery);
      if (input.compute !== undefined) existing.compute = validateCompute(id, input.compute, existing.compute);
      if (input.notificationChannel !== undefined) {
        existing.notificationChannel =
          input.notificationChannel === null || input.notificationChannel === ''
            ? null
            : text(input.notificationChannel, 'notificationChannel', 256);
      }
      if (input.extensions !== undefined) existing.extensions = validateExtensions(input.extensions);
      const saved = this.save(existing);
      this.emit(id, 'project.updated', {
        status: saved.status,
        capabilities: saved.capabilities,
        computeBudgetCapMicros: saved.budget.computeBudgetCapMicros,
        repositories: saved.delivery.repositories,
      });
      return toProjectPublicView(saved);
    });
  }

  /**
   * Issues a project-scoped agent bearer token.
   * The raw secret is returned once to the caller and only its SHA-256 hash is stored.
   */
  async issueToken(projectId: string, input: IssueProjectTokenInput): Promise<IssuedProjectToken> {
    const label = text(input?.label, 'label', 80);
    return this.tx(() => {
      const project = this.load(projectId);
      if (project.status === 'archived') {
        throw new DomainError(`Cannot issue token for archived project '${projectId}'`, 409);
      }
      const activeTokens = project.tokens.filter((t) => t.revokedAt === null);
      if (activeTokens.length >= MAX_TOKENS_PER_PROJECT) {
        throw new DomainError(`Project '${projectId}' reached max active tokens (${MAX_TOKENS_PER_PROJECT})`, 409);
      }
      const scopes =
        input.scopes === undefined
          ? [...PROJECT_TEMPLATE_PRESETS[project.template].defaultTokenScopes]
          : validateTokenScopes(input.scopes);
      const rawToken = `hmproj_${randomBytes(24).toString('hex')}`;
      const tokenHash = hashProjectToken(rawToken);
      const record: ProjectAgentTokenRecord = {
        tokenId: `ptok-${randomUUID().slice(0, 12)}`,
        label,
        tokenPrefix: rawToken.slice(0, 13),
        tokenHash,
        scopes,
        createdAt: this.timestamp(),
        lastUsedAt: null,
        revokedAt: null,
      };
      project.tokens.push(record);
      this.save(project);
      this.emit(projectId, 'project.token_issued', {
        tokenId: record.tokenId,
        label: record.label,
        tokenPrefix: record.tokenPrefix,
        scopes: record.scopes,
      });
      const { tokenHash: _hash, ...metadata } = record;
      return { projectId, token: rawToken, metadata };
    });
  }

  async revokeToken(projectId: string, tokenId: string, reason = 'Revoked by operator'): Promise<ProjectPublicView> {
    const cleanReason = text(reason, 'reason', 500);
    return this.tx(() => {
      const project = this.load(projectId);
      const token = project.tokens.find((t) => t.tokenId === tokenId);
      if (!token) throw new DomainError(`Token '${tokenId}' not found on project '${projectId}'`, 404);
      if (!token.revokedAt) {
        token.revokedAt = this.timestamp();
        this.save(project);
        this.emit(projectId, 'project.token_revoked', {
          tokenId: token.tokenId,
          label: token.label,
          reason: cleanReason,
        });
      }
      return toProjectPublicView(project);
    });
  }

  /**
   * Constant-time authentication of a raw project agent bearer token.
   * Rejects revoked tokens and tokens belonging to paused or archived projects.
   */
  async authenticateToken(rawToken: string): Promise<AuthenticatedProjectToken | null> {
    if (!rawToken || !rawToken.startsWith('hmproj_') || rawToken.length < 32) return null;
    const candidateHash = hashProjectToken(rawToken);
    const docs = await this.repository.listDocs();
    for (const project of docs) {
      if (project.status !== 'active') continue;
      for (const token of project.tokens) {
        if (token.revokedAt !== null) continue;
        if (equalSecret(token.tokenHash, candidateHash)) {
          const { tokenHash: _hash, ...publicToken } = token;
          return {
            project: toProjectPublicView(project),
            token: structuredClone(publicToken),
            scopes: new Set(token.scopes),
          };
        }
      }
    }
    return null;
  }

  /** Finds a registered active project that owns the given GitHub repository, if any. */
  async findByRepository(repository: string): Promise<ProjectPublicView | null> {
    const docs = await this.repository.listDocs();
    const match = docs.find((p) => p.status !== 'archived' && p.delivery.repositories.includes(repository));
    return match ? toProjectPublicView(match) : null;
  }

  /** Returns all auto-merge repositories across active projects. */
  async allAutoMergeRepositories(): Promise<string[]> {
    const docs = await this.repository.listDocs();
    const repos = new Set<string>();
    for (const p of docs) {
      if (p.status !== 'active') continue;
      for (const repo of p.delivery.autoMergeRepositories) repos.add(repo);
    }
    return [...repos];
  }

  /** Returns all Hugging Face auto-publish prefixes across active projects (or one project). */
  async autoPublishPrefixesFor(projectId?: string): Promise<string[]> {
    if (projectId && projectId !== DEFAULT_PROJECT_ID) {
      const p = await this.find(projectId);
      return p && p.status === 'active' && p.capabilities.includes('hf_release')
        ? [...p.compute.autoPublishHfRepoPrefixes]
        : [];
    }
    const docs = await this.repository.listDocs();
    const prefixes = new Set<string>();
    for (const p of docs) {
      if (p.status !== 'active' || !p.capabilities.includes('hf_release')) continue;
      for (const prefix of p.compute.autoPublishHfRepoPrefixes) prefixes.add(prefix);
    }
    return [...prefixes];
  }
}

/** Central policy guards evaluated in core/control-plane so neither UI nor adapters can bypass them. */
export function assertProjectActive(project: ProjectPublicView): void {
  if (project.status !== 'active') {
    throw new DomainError(`Project '${project.id}' is ${project.status} and cannot execute new work`, 409);
  }
}

export function assertProjectCapability(project: ProjectPublicView, capability: ProjectCapability): void {
  assertProjectActive(project);
  if (!project.capabilities.includes(capability)) {
    throw new DomainError(`Project '${project.id}' does not have capability '${capability}'`, 403);
  }
}

export function assertProjectRepository(project: ProjectPublicView, repository: string): void {
  if (project.delivery.repositories.length > 0 && !project.delivery.repositories.includes(repository)) {
    throw new DomainError(`Repository '${repository}' is not registered under project '${project.id}'`, 403);
  }
}

export function assertProjectComputePrefix(project: ProjectPublicView, s3Prefix: string): void {
  const normalized = s3Prefix.replace(/^\/+/, '');
  const ok = project.compute.s3ArtifactPrefixes.some((allowed) => normalized.startsWith(allowed));
  if (!ok) {
    throw new DomainError(
      `S3 prefix '${s3Prefix}' is outside allowed prefixes for project '${project.id}' (${project.compute.s3ArtifactPrefixes.join(', ')})`,
      403,
    );
  }
}

export function assertProjectRegions(project: ProjectPublicView, regions: readonly string[]): void {
  const allowed = new Set(project.compute.allowedRegions);
  for (const r of regions) {
    if (!allowed.has(r)) {
      throw new DomainError(`Region '${r}' is not allowed for project '${project.id}'`, 403);
    }
  }
}
