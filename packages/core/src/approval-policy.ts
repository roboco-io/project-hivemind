import { createHash, randomUUID } from 'node:crypto';
import {
  APPROVAL_AUTONOMY_MODES,
  APPROVAL_GATE_MODES,
  type ApprovalActorKind,
  type ApprovalAgentAssessment,
  type ApprovalAutonomyMode,
  type ApprovalDecisionOutcome,
  type ApprovalDecisionRecord,
  type ApprovalGate,
  type ApprovalGateMode,
  type ApprovalRuleCheck,
  type ProjectApprovalPolicy,
  type ProjectApprovalPolicyPatch,
} from '../../contracts/src/approval-policy.js';
import type { ComputeJob } from '../../contracts/src/compute.js';
import type { DeliveryTask } from '../../contracts/src/delivery.js';
import type { ProjectPublicView, ProjectTemplateId } from '../../contracts/src/projects.js';
import { DomainError, text } from './store.js';

const INSTANCE_FAMILY_PATTERN = /^[a-z][a-z0-9]{0,15}$/;
const MAX_LIFETIME_MS = 604_800_000;
const MAX_BUDGET_MICROS = 10_000_000_000;

export const TEMPLATE_APPROVAL_POLICIES: Record<ProjectTemplateId, ProjectApprovalPolicy> = {
  'model-factory': {
    autonomyMode: 'minimal_human',
    summary:
      '사람 개입 최소화: 프로젝트 예산·리전·수명 범위 내 학습 기동과 독립 검증 통과 릴리즈는 자동 승인하며, 한도 초과·비독립 검증·보호 경로 변경·에이전트 에스컬레이션만 수동 승인을 요청합니다.',
    computeLaunch: {
      mode: 'auto_within_policy',
      maxAutoApproveCostMicros: 150_000_000, // $150
      maxAutoApproveLifetimeMs: 86_400_000, // 24h
      allowedInstanceFamilies: [],
    },
    computeRelease: {
      mode: 'auto_within_policy',
      requireIndependentVerifier: true,
      allowPrivateAutoApprove: true,
      allowPublicAutoApprove: true,
    },
    deliveryExecute: {
      mode: 'auto_within_policy',
      maxAutoApproveBudgetMicros: 50_000_000, // $50
    },
    deliveryMerge: {
      mode: 'auto_within_policy',
      requireIndependentVerifier: true,
      requireCleanProtectedPaths: true,
    },
  },
  generic: {
    autonomyMode: 'balanced',
    summary:
      '균형 정책: 소규모 Spot 컴퓨팅($10 이하, 4시간 이하)과 소규모 SW 전달($10 이하)은 자동 승인하고, 고비용 실행·외부 공개·PR 병합은 사람 승인을 요구합니다.',
    computeLaunch: {
      mode: 'auto_within_policy',
      maxAutoApproveCostMicros: 10_000_000, // $10
      maxAutoApproveLifetimeMs: 14_400_000, // 4h
      allowedInstanceFamilies: [],
    },
    computeRelease: {
      mode: 'manual_required',
      requireIndependentVerifier: true,
      allowPrivateAutoApprove: false,
      allowPublicAutoApprove: false,
    },
    deliveryExecute: {
      mode: 'auto_within_policy',
      maxAutoApproveBudgetMicros: 10_000_000, // $10
    },
    deliveryMerge: {
      mode: 'manual_required',
      requireIndependentVerifier: true,
      requireCleanProtectedPaths: true,
    },
  },
  'sw-delivery': {
    autonomyMode: 'manual_first',
    summary:
      '수동 승인 우선: SW 전달 실행과 PR 병합을 포함한 모든 유료·외부 변경 작업은 운영자의 명시적 수동 승인을 거칩니다.',
    computeLaunch: {
      mode: 'deny',
      maxAutoApproveCostMicros: 0,
      maxAutoApproveLifetimeMs: 60_000,
      allowedInstanceFamilies: [],
    },
    computeRelease: {
      mode: 'deny',
      requireIndependentVerifier: true,
      allowPrivateAutoApprove: false,
      allowPublicAutoApprove: false,
    },
    deliveryExecute: {
      mode: 'manual_required',
      maxAutoApproveBudgetMicros: 0,
    },
    deliveryMerge: {
      mode: 'manual_required',
      requireIndependentVerifier: true,
      requireCleanProtectedPaths: true,
    },
  },
  'research-collab': {
    autonomyMode: 'balanced',
    summary:
      '리서치 균형 정책: 중간 규모 실험($25 이하, 8시간 이하)과 비공개 산출물 정리는 자동 승인하고, 고비용 GPU 실행 및 외부 공개는 수동 승인을 요청합니다.',
    computeLaunch: {
      mode: 'auto_within_policy',
      maxAutoApproveCostMicros: 25_000_000, // $25
      maxAutoApproveLifetimeMs: 28_800_000, // 8h
      allowedInstanceFamilies: [],
    },
    computeRelease: {
      mode: 'auto_within_policy',
      requireIndependentVerifier: true,
      allowPrivateAutoApprove: true,
      allowPublicAutoApprove: false,
    },
    deliveryExecute: {
      mode: 'auto_within_policy',
      maxAutoApproveBudgetMicros: 15_000_000, // $15
    },
    deliveryMerge: {
      mode: 'manual_required',
      requireIndependentVerifier: true,
      requireCleanProtectedPaths: true,
    },
  },
};

/** Default fallback policy for legacy/default projects when no explicit project record exists. */
export const DEFAULT_HOST_APPROVAL_POLICY: ProjectApprovalPolicy = structuredClone(TEMPLATE_APPROVAL_POLICIES.generic);

export function defaultApprovalPolicyForTemplate(template: ProjectTemplateId): ProjectApprovalPolicy {
  return structuredClone(TEMPLATE_APPROVAL_POLICIES[template] ?? TEMPLATE_APPROVAL_POLICIES.generic);
}

/** Applies an autonomy mode preset when changing autonomyMode without overriding individual gates. */
export function approvalPolicyPresetForMode(mode: ApprovalAutonomyMode): ProjectApprovalPolicy {
  if (mode === 'minimal_human') return structuredClone(TEMPLATE_APPROVAL_POLICIES['model-factory']);
  if (mode === 'manual_first') {
    return {
      autonomyMode: 'manual_first',
      summary:
        '수동 승인 우선: 모든 컴퓨팅 기동, 릴리즈 공개, SW 전달 실행 및 PR 병합에 운영자의 명시적 수동 승인이 필요합니다.',
      computeLaunch: {
        mode: 'manual_required',
        maxAutoApproveCostMicros: 0,
        maxAutoApproveLifetimeMs: 60_000,
        allowedInstanceFamilies: [],
      },
      computeRelease: {
        mode: 'manual_required',
        requireIndependentVerifier: true,
        allowPrivateAutoApprove: false,
        allowPublicAutoApprove: false,
      },
      deliveryExecute: {
        mode: 'manual_required',
        maxAutoApproveBudgetMicros: 0,
      },
      deliveryMerge: {
        mode: 'manual_required',
        requireIndependentVerifier: true,
        requireCleanProtectedPaths: true,
      },
    };
  }
  return structuredClone(TEMPLATE_APPROVAL_POLICIES.generic);
}

function validateGateMode(raw: unknown, field: string): ApprovalGateMode {
  if (typeof raw !== 'string' || !(APPROVAL_GATE_MODES as readonly string[]).includes(raw)) {
    throw new DomainError(`${field} must be one of: ${APPROVAL_GATE_MODES.join(', ')}`, 400);
  }
  return raw as ApprovalGateMode;
}

function validateNonNegInt(raw: unknown, field: string, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > max) {
    throw new DomainError(`${field} must be an integer between 0 and ${max}`, 400);
  }
  return raw;
}

export function validateApprovalPolicy(
  input: ProjectApprovalPolicyPatch | undefined,
  base: ProjectApprovalPolicy,
): ProjectApprovalPolicy {
  if (!input) return structuredClone(base);
  const modeChanged = input.autonomyMode !== undefined && input.autonomyMode !== base.autonomyMode;
  let effectiveBase = base;
  if (input.autonomyMode !== undefined) {
    if (!(APPROVAL_AUTONOMY_MODES as readonly string[]).includes(input.autonomyMode)) {
      throw new DomainError(`approvalPolicy.autonomyMode must be one of: ${APPROVAL_AUTONOMY_MODES.join(', ')}`, 400);
    }
    if (modeChanged) {
      effectiveBase = approvalPolicyPresetForMode(input.autonomyMode);
    }
  }

  const autonomyMode = input.autonomyMode ?? effectiveBase.autonomyMode;
  const summary =
    input.summary === undefined ? effectiveBase.summary : text(input.summary, 'approvalPolicy.summary', 500);

  const clIn = input.computeLaunch;
  const allowedFamiliesRaw = clIn?.allowedInstanceFamilies ?? effectiveBase.computeLaunch.allowedInstanceFamilies;
  if (!Array.isArray(allowedFamiliesRaw) || allowedFamiliesRaw.length > 32) {
    throw new DomainError('approvalPolicy.computeLaunch.allowedInstanceFamilies must be an array of at most 32 items', 400);
  }
  const allowedInstanceFamilies = [
    ...new Set(
      allowedFamiliesRaw.map((f) => {
        const cleaned = text(f, 'allowedInstanceFamilies[]', 24).toLowerCase();
        if (!INSTANCE_FAMILY_PATTERN.test(cleaned)) {
          throw new DomainError(`Invalid EC2 instance family: ${cleaned}`, 400);
        }
        return cleaned;
      }),
    ),
  ];

  const computeLaunch = {
    mode:
      clIn?.mode === undefined
        ? effectiveBase.computeLaunch.mode
        : validateGateMode(clIn.mode, 'approvalPolicy.computeLaunch.mode'),
    maxAutoApproveCostMicros:
      clIn?.maxAutoApproveCostMicros === undefined
        ? effectiveBase.computeLaunch.maxAutoApproveCostMicros
        : validateNonNegInt(
            clIn.maxAutoApproveCostMicros,
            'approvalPolicy.computeLaunch.maxAutoApproveCostMicros',
            MAX_BUDGET_MICROS,
          ),
    maxAutoApproveLifetimeMs:
      clIn?.maxAutoApproveLifetimeMs === undefined
        ? effectiveBase.computeLaunch.maxAutoApproveLifetimeMs
        : validateNonNegInt(
            clIn.maxAutoApproveLifetimeMs,
            'approvalPolicy.computeLaunch.maxAutoApproveLifetimeMs',
            MAX_LIFETIME_MS,
          ),
    allowedInstanceFamilies,
  };

  const crIn = input.computeRelease;
  const computeRelease = {
    mode:
      crIn?.mode === undefined
        ? effectiveBase.computeRelease.mode
        : validateGateMode(crIn.mode, 'approvalPolicy.computeRelease.mode'),
    requireIndependentVerifier:
      crIn?.requireIndependentVerifier === undefined
        ? effectiveBase.computeRelease.requireIndependentVerifier
        : Boolean(crIn.requireIndependentVerifier),
    allowPrivateAutoApprove:
      crIn?.allowPrivateAutoApprove === undefined
        ? effectiveBase.computeRelease.allowPrivateAutoApprove
        : Boolean(crIn.allowPrivateAutoApprove),
    allowPublicAutoApprove:
      crIn?.allowPublicAutoApprove === undefined
        ? effectiveBase.computeRelease.allowPublicAutoApprove
        : Boolean(crIn.allowPublicAutoApprove),
  };

  const deIn = input.deliveryExecute;
  const deliveryExecute = {
    mode:
      deIn?.mode === undefined
        ? effectiveBase.deliveryExecute.mode
        : validateGateMode(deIn.mode, 'approvalPolicy.deliveryExecute.mode'),
    maxAutoApproveBudgetMicros:
      deIn?.maxAutoApproveBudgetMicros === undefined
        ? effectiveBase.deliveryExecute.maxAutoApproveBudgetMicros
        : validateNonNegInt(
            deIn.maxAutoApproveBudgetMicros,
            'approvalPolicy.deliveryExecute.maxAutoApproveBudgetMicros',
            1_000_000_000,
          ),
  };

  const dmIn = input.deliveryMerge;
  const deliveryMerge = {
    mode:
      dmIn?.mode === undefined
        ? effectiveBase.deliveryMerge.mode
        : validateGateMode(dmIn.mode, 'approvalPolicy.deliveryMerge.mode'),
    requireIndependentVerifier:
      dmIn?.requireIndependentVerifier === undefined
        ? effectiveBase.deliveryMerge.requireIndependentVerifier
        : Boolean(dmIn.requireIndependentVerifier),
    requireCleanProtectedPaths:
      dmIn?.requireCleanProtectedPaths === undefined
        ? effectiveBase.deliveryMerge.requireCleanProtectedPaths
        : Boolean(dmIn.requireCleanProtectedPaths),
  };

  return {
    autonomyMode,
    summary,
    computeLaunch,
    computeRelease,
    deliveryExecute,
    deliveryMerge,
  };
}

/** Backfills approvalPolicy transparently for pre-existing ProjectRecords read from DSQL/SQLite. */
export function normalizeApprovalPolicy(
  raw: ProjectApprovalPolicy | undefined,
  template: ProjectTemplateId,
): ProjectApprovalPolicy {
  const base = defaultApprovalPolicyForTemplate(template);
  if (!raw || typeof raw !== 'object') return base;
  try {
    return validateApprovalPolicy(raw, base);
  } catch {
    return base;
  }
}

export function approvalPolicyVersion(policy: ProjectApprovalPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 12);
}

function fmtUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60}시간`;
  if (mins >= 60) return `${Math.floor(mins / 60)}시간 ${mins % 60}분`;
  return `${mins}분`;
}

function instanceFamilyOf(instanceType: string): string {
  return instanceType.split('.')[0]?.toLowerCase() ?? instanceType.toLowerCase();
}

function normalizeAgentAssessment(input?: ApprovalAgentAssessment | null): ApprovalAgentAssessment | null {
  if (!input) return null;
  const out: ApprovalAgentAssessment = {};
  if (input.recommendedOutcome === 'auto_approved' || input.recommendedOutcome === 'manual_approval_required') {
    out.recommendedOutcome = input.recommendedOutcome;
  }
  if (typeof input.rationale === 'string' && input.rationale.trim()) {
    out.rationale = input.rationale.trim().slice(0, 1000);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildDecisionRecord(params: {
  projectId: string;
  policy: ProjectApprovalPolicy;
  gate: ApprovalGate;
  targetKind: 'compute_job' | 'delivery_task';
  targetId: string;
  targetTitle: string;
  approvalFingerprint: string | null;
  actorKind: ApprovalActorKind;
  actorId: string;
  agentAssessment: ApprovalAgentAssessment | null;
  checks: ApprovalRuleCheck[];
  decidedAt: string;
  overrideOutcome?: ApprovalDecisionOutcome;
  overrideSummary?: string;
}): ApprovalDecisionRecord {
  const hardFailures = params.checks.filter((c) => !c.passed && c.severity === 'hard_reject');
  const escalations = params.checks.filter((c) => !c.passed && c.severity === 'escalate_manual');

  let outcome: ApprovalDecisionOutcome;
  let summary: string;

  if (params.overrideOutcome) {
    outcome = params.overrideOutcome;
    summary = params.overrideSummary ?? '운영자 판단이 기록되었습니다.';
  } else if (hardFailures.length > 0) {
    outcome = 'rejected';
    summary = `정책 위반으로 거부됨: ${hardFailures.map((f) => f.detail).join(' / ')}`;
  } else if (escalations.length > 0) {
    outcome = 'manual_approval_required';
    summary = `수동 승인 필요: ${escalations.map((e) => e.detail).join(' / ')}`;
  } else {
    outcome = 'auto_approved';
    summary = `프로젝트 승인 정책(${params.policy.autonomyMode})의 모든 자동 승인 기준(${params.checks.length}개 항목)을 충족하여 자동 승인되었습니다.`;
  }

  return {
    id: `apv-${randomUUID().slice(0, 12)}`,
    projectId: params.projectId,
    gate: params.gate,
    targetKind: params.targetKind,
    targetId: params.targetId,
    targetTitle: params.targetTitle,
    approvalFingerprint: params.approvalFingerprint,
    outcome,
    actorKind: params.actorKind,
    actorId: params.actorId,
    policyVersion: approvalPolicyVersion(params.policy),
    policyMode: params.policy.autonomyMode,
    policySummary: params.policy.summary,
    agentAssessment: params.agentAssessment,
    summary,
    checks: params.checks,
    decidedAt: params.decidedAt,
  };
}

export function evaluateComputeLaunchApproval(params: {
  project: ProjectPublicView | null;
  job: ComputeJob;
  approvalFingerprint: string;
  actorKind: ApprovalActorKind;
  actorId: string;
  agentAssessment?: ApprovalAgentAssessment | null;
  remainingProjectBudgetMicros?: number;
  nowIso: string;
}): ApprovalDecisionRecord {
  const policy = params.project?.approvalPolicy ?? DEFAULT_HOST_APPROVAL_POLICY;
  const rule = policy.computeLaunch;
  const assessment = normalizeAgentAssessment(params.agentAssessment);
  const checks: ApprovalRuleCheck[] = [];

  if (params.project) {
    const active = params.project.status === 'active';
    checks.push({
      ruleId: 'project_active',
      label: '프로젝트 활성 상태',
      passed: active,
      severity: 'hard_reject',
      actual: params.project.status,
      threshold: 'active',
      detail: active ? '프로젝트가 active 상태입니다.' : `프로젝트 상태가 '${params.project.status}'이어서 실행할 수 없습니다.`,
    });
  }

  const fpOk = params.approvalFingerprint === params.job.approvalFingerprint;
  checks.push({
    ruleId: 'approval_fingerprint',
    label: '승인 지문 일치',
    passed: fpOk,
    severity: 'hard_reject',
    actual: params.approvalFingerprint.slice(0, 12),
    threshold: params.job.approvalFingerprint.slice(0, 12),
    detail: fpOk ? '등록된 작업 사양 지문과 일치합니다.' : '승인 지문(approvalFingerprint)이 현재 작업 사양과 다릅니다.',
  });

  if (rule.mode === 'deny') {
    checks.push({
      ruleId: 'gate_mode',
      label: '컴퓨팅 기동 게이트 정책',
      passed: false,
      severity: 'hard_reject',
      actual: 'deny',
      threshold: 'auto_within_policy | manual_required',
      detail: '프로젝트 정책에서 컴퓨팅 기동이 차단(deny)되어 있습니다.',
    });
  } else {
    const autoAllowed = rule.mode === 'auto_within_policy';
    checks.push({
      ruleId: 'gate_mode',
      label: '컴퓨팅 기동 게이트 정책',
      passed: autoAllowed,
      severity: 'escalate_manual',
      actual: rule.mode,
      threshold: 'auto_within_policy',
      detail: autoAllowed
        ? '정책 범위 내 자동 승인이 허용되어 있습니다.'
        : '프로젝트 정책상 컴퓨팅 기동은 항상 운영자 수동 승인이 필요합니다.',
    });
  }

  const costOk = params.job.compute.maxTotalCostMicros <= rule.maxAutoApproveCostMicros;
  checks.push({
    ruleId: 'auto_cost_limit',
    label: '자동 승인 비용 상한',
    passed: costOk,
    severity: 'escalate_manual',
    actual: fmtUsd(params.job.compute.maxTotalCostMicros),
    threshold: `<= ${fmtUsd(rule.maxAutoApproveCostMicros)}`,
    detail: costOk
      ? `요청 상한(${fmtUsd(params.job.compute.maxTotalCostMicros)})이 자동 승인 한도(${fmtUsd(rule.maxAutoApproveCostMicros)}) 이내입니다.`
      : `요청 상한(${fmtUsd(params.job.compute.maxTotalCostMicros)})이 자동 승인 한도(${fmtUsd(rule.maxAutoApproveCostMicros)})를 초과했습니다.`,
  });

  if (params.remainingProjectBudgetMicros !== undefined) {
    const budgetOk = params.job.compute.maxTotalCostMicros <= params.remainingProjectBudgetMicros;
    checks.push({
      ruleId: 'remaining_budget',
      label: '잔여 예산 여유',
      passed: budgetOk,
      severity: 'hard_reject',
      actual: fmtUsd(params.job.compute.maxTotalCostMicros),
      threshold: `<= ${fmtUsd(params.remainingProjectBudgetMicros)}`,
      detail: budgetOk
        ? `잔여 예산(${fmtUsd(params.remainingProjectBudgetMicros)}) 범위 내입니다.`
        : `잔여 예산(${fmtUsd(params.remainingProjectBudgetMicros)})을 초과하여 실행할 수 없습니다.`,
    });
  }

  const lifeOk = params.job.compute.maxLifetimeMs <= rule.maxAutoApproveLifetimeMs;
  checks.push({
    ruleId: 'auto_lifetime_limit',
    label: '자동 승인 실행 수명 상한',
    passed: lifeOk,
    severity: 'escalate_manual',
    actual: fmtDuration(params.job.compute.maxLifetimeMs),
    threshold: `<= ${fmtDuration(rule.maxAutoApproveLifetimeMs)}`,
    detail: lifeOk
      ? `최대 수명(${fmtDuration(params.job.compute.maxLifetimeMs)})이 자동 승인 한도(${fmtDuration(rule.maxAutoApproveLifetimeMs)}) 이내입니다.`
      : `최대 수명(${fmtDuration(params.job.compute.maxLifetimeMs)})이 자동 승인 한도(${fmtDuration(rule.maxAutoApproveLifetimeMs)})를 초과했습니다.`,
  });

  if (rule.allowedInstanceFamilies.length > 0) {
    const family = instanceFamilyOf(params.job.compute.instanceType);
    const familyOk = rule.allowedInstanceFamilies.includes(family);
    checks.push({
      ruleId: 'instance_family',
      label: '자동 승인 허용 인스턴스 패밀리',
      passed: familyOk,
      severity: 'escalate_manual',
      actual: params.job.compute.instanceType,
      threshold: rule.allowedInstanceFamilies.join(', '),
      detail: familyOk
        ? `인스턴스 패밀리 '${family}'가 자동 승인 허용 목록에 포함됩니다.`
        : `인스턴스 패밀리 '${family}'가 자동 승인 목록(${rule.allowedInstanceFamilies.join(', ')}) 밖에 있습니다.`,
    });
  }

  // Safety ratchet: an agent may ALWAYS escalate a job to manual review even if numeric rules pass.
  if (assessment?.recommendedOutcome === 'manual_approval_required') {
    checks.push({
      ruleId: 'agent_escalation',
      label: '에이전트 수동 검토 요청',
      passed: false,
      severity: 'escalate_manual',
      actual: 'manual_approval_required',
      threshold: 'auto_approved',
      detail: assessment.rationale
        ? `에이전트가 수동 승인을 요청했습니다: ${assessment.rationale}`
        : '에이전트가 사람 검토를 요청했습니다.',
    });
  }

  return buildDecisionRecord({
    projectId: params.job.projectId,
    policy,
    gate: 'compute_launch',
    targetKind: 'compute_job',
    targetId: params.job.id,
    targetTitle: params.job.title,
    approvalFingerprint: params.job.approvalFingerprint,
    actorKind: params.actorKind,
    actorId: params.actorId,
    agentAssessment: assessment,
    checks,
    decidedAt: params.nowIso,
  });
}

export function evaluateComputeReleaseApproval(params: {
  project: ProjectPublicView | null;
  job: ComputeJob;
  actorKind: ApprovalActorKind;
  actorId: string;
  agentAssessment?: ApprovalAgentAssessment | null;
  autoPublishEligible: boolean;
  nowIso: string;
}): ApprovalDecisionRecord {
  const policy = params.project?.approvalPolicy ?? DEFAULT_HOST_APPROVAL_POLICY;
  const rule = policy.computeRelease;
  const assessment = normalizeAgentAssessment(params.agentAssessment);
  const checks: ApprovalRuleCheck[] = [];

  if (rule.mode === 'deny') {
    checks.push({
      ruleId: 'gate_mode',
      label: '릴리즈 공개 게이트 정책',
      passed: false,
      severity: 'hard_reject',
      actual: 'deny',
      threshold: 'auto_within_policy | manual_required',
      detail: '프로젝트 정책에서 릴리즈 공개가 차단(deny)되어 있습니다.',
    });
  } else {
    const autoAllowed = rule.mode === 'auto_within_policy';
    checks.push({
      ruleId: 'gate_mode',
      label: '릴리즈 공개 게이트 정책',
      passed: autoAllowed,
      severity: 'escalate_manual',
      actual: rule.mode,
      threshold: 'auto_within_policy',
      detail: autoAllowed
        ? '독립 검증 통과 시 자동 공개 승인이 허용됩니다.'
        : '프로젝트 정책상 릴리즈 공개는 운영자 수동 승인이 필요합니다.',
    });
  }

  const attest = params.job.releaseAttestation;
  const passedCheck = Boolean(attest?.releaseCheckPassed);
  checks.push({
    ruleId: 'release_check_passed',
    label: '릴리즈 검증 테스트 통과',
    passed: passedCheck,
    severity: 'hard_reject',
    actual: attest ? (attest.releaseCheckPassed ? 'passed' : 'failed') : 'missing',
    threshold: 'passed',
    detail: passedCheck ? '릴리즈 검증 스크립트가 통과했습니다.' : '통과한 릴리즈 검증 결과가 없습니다.',
  });

  if (rule.requireIndependentVerifier) {
    const isIndependent = attest?.attestationSource === 'independent_verifier';
    checks.push({
      ruleId: 'independent_verifier',
      label: '독립 검증기 서명 필수',
      passed: isIndependent,
      severity: 'escalate_manual',
      actual: attest?.attestationSource ?? 'none',
      threshold: 'independent_verifier',
      detail: isIndependent
        ? '독립 검증기(independent_verifier)가 산출물 매니페스트를 검증했습니다.'
        : '운영자 자체 보고이거나 독립 검증 서명이 없어 수동 승인이 필요합니다.',
    });
  }

  const isPublic = params.job.releasePolicy.visibility === 'public' && params.job.releasePolicy.mode === 'hf_release';
  const visibilityOk = isPublic ? rule.allowPublicAutoApprove : rule.allowPrivateAutoApprove;
  checks.push({
    ruleId: 'release_visibility',
    label: '공개 범위 자동 승인 허용',
    passed: visibilityOk,
    severity: 'escalate_manual',
    actual: `${params.job.releasePolicy.mode}:${params.job.releasePolicy.visibility}`,
    threshold: isPublic ? 'allowPublicAutoApprove=true' : 'allowPrivateAutoApprove=true',
    detail: visibilityOk
      ? `${isPublic ? '공개 HF 릴리즈' : '비공개/S3 릴리즈'} 자동 승인이 프로젝트 정책에 허용되어 있습니다.`
      : `${isPublic ? '공개 HF 릴리즈' : '비공개 릴리즈'}는 프로젝트 정책상 수동 승인이 필요합니다.`,
  });

  if (params.job.releasePolicy.mode === 'hf_release') {
    checks.push({
      ruleId: 'hf_prefix_allowlist',
      label: 'HF 자동 공개 저장소 접두사 검증',
      passed: params.autoPublishEligible,
      severity: 'escalate_manual',
      actual: params.job.releasePolicy.hfRepository ?? '(미지정)',
      threshold: 'autoPublish=true & 허용 접두사 일치',
      detail: params.autoPublishEligible
        ? 'HF 대상 저장소가 프로젝트·호스트 자동 공개 접두사 정책과 일치합니다.'
        : 'HF 자동 공개 플래그 또는 허용 저장소 접두사 조건을 충족하지 않아 수동 승인이 필요합니다.',
    });
  }

  if (assessment?.recommendedOutcome === 'manual_approval_required') {
    checks.push({
      ruleId: 'agent_escalation',
      label: '에이전트 수동 검토 요청',
      passed: false,
      severity: 'escalate_manual',
      actual: 'manual_approval_required',
      threshold: 'auto_approved',
      detail: assessment.rationale
        ? `에이전트가 수동 릴리즈 검토를 요청했습니다: ${assessment.rationale}`
        : '에이전트가 수동 릴리즈 검토를 요청했습니다.',
    });
  }

  return buildDecisionRecord({
    projectId: params.job.projectId,
    policy,
    gate: 'compute_release',
    targetKind: 'compute_job',
    targetId: params.job.id,
    targetTitle: params.job.title,
    approvalFingerprint: params.job.approvalFingerprint,
    actorKind: params.actorKind,
    actorId: params.actorId,
    agentAssessment: assessment,
    checks,
    decidedAt: params.nowIso,
  });
}

export function evaluateDeliveryExecuteApproval(params: {
  project: ProjectPublicView | null;
  task: DeliveryTask;
  approvalFingerprint: string;
  actorKind: ApprovalActorKind;
  actorId: string;
  agentAssessment?: ApprovalAgentAssessment | null;
  nowIso: string;
}): ApprovalDecisionRecord {
  const policy = params.project?.approvalPolicy ?? DEFAULT_HOST_APPROVAL_POLICY;
  const rule = policy.deliveryExecute;
  const assessment = normalizeAgentAssessment(params.agentAssessment);
  const checks: ApprovalRuleCheck[] = [];

  if (params.project) {
    const active = params.project.status === 'active';
    checks.push({
      ruleId: 'project_active',
      label: '프로젝트 활성 상태',
      passed: active,
      severity: 'hard_reject',
      actual: params.project.status,
      threshold: 'active',
      detail: active ? '프로젝트가 active 상태입니다.' : `프로젝트 상태가 '${params.project.status}'이어서 실행할 수 없습니다.`,
    });
  }

  const fpOk = params.approvalFingerprint === params.task.approvalFingerprint;
  checks.push({
    ruleId: 'approval_fingerprint',
    label: '승인 지문 일치',
    passed: fpOk,
    severity: 'hard_reject',
    actual: params.approvalFingerprint.slice(0, 12),
    threshold: params.task.approvalFingerprint.slice(0, 12),
    detail: fpOk ? '고정된 수용 테스트·전달 정책 지문과 일치합니다.' : '승인 지문(approvalFingerprint)이 현재 작업과 다릅니다.',
  });

  if (rule.mode === 'deny') {
    checks.push({
      ruleId: 'gate_mode',
      label: 'SW 전달 실행 게이트 정책',
      passed: false,
      severity: 'hard_reject',
      actual: 'deny',
      threshold: 'auto_within_policy | manual_required',
      detail: '프로젝트 정책에서 SW 전달 실행이 차단(deny)되어 있습니다.',
    });
  } else {
    const autoAllowed = rule.mode === 'auto_within_policy';
    checks.push({
      ruleId: 'gate_mode',
      label: 'SW 전달 실행 게이트 정책',
      passed: autoAllowed,
      severity: 'escalate_manual',
      actual: rule.mode,
      threshold: 'auto_within_policy',
      detail: autoAllowed
        ? '예산 한도 내 SW 전달 자동 승인이 허용되어 있습니다.'
        : '프로젝트 정책상 SW 전달 실행은 운영자 수동 승인이 필요합니다.',
    });
  }

  const budgetOk = params.task.budgetMicros <= rule.maxAutoApproveBudgetMicros;
  checks.push({
    ruleId: 'auto_budget_limit',
    label: 'SW 전달 자동 승인 예산 상한',
    passed: budgetOk,
    severity: 'escalate_manual',
    actual: fmtUsd(params.task.budgetMicros),
    threshold: `<= ${fmtUsd(rule.maxAutoApproveBudgetMicros)}`,
    detail: budgetOk
      ? `작업 예산(${fmtUsd(params.task.budgetMicros)})이 자동 승인 한도(${fmtUsd(rule.maxAutoApproveBudgetMicros)}) 이내입니다.`
      : `작업 예산(${fmtUsd(params.task.budgetMicros)})이 자동 승인 한도(${fmtUsd(rule.maxAutoApproveBudgetMicros)})를 초과했습니다.`,
  });

  if (assessment?.recommendedOutcome === 'manual_approval_required') {
    checks.push({
      ruleId: 'agent_escalation',
      label: '에이전트 수동 검토 요청',
      passed: false,
      severity: 'escalate_manual',
      actual: 'manual_approval_required',
      threshold: 'auto_approved',
      detail: assessment.rationale
        ? `에이전트가 수동 승인을 요청했습니다: ${assessment.rationale}`
        : '에이전트가 사람 검토를 요청했습니다.',
    });
  }

  return buildDecisionRecord({
    projectId: params.task.projectId ?? 'default',
    policy,
    gate: 'delivery_execute',
    targetKind: 'delivery_task',
    targetId: params.task.id,
    targetTitle: params.task.title,
    approvalFingerprint: params.task.approvalFingerprint,
    actorKind: params.actorKind,
    actorId: params.actorId,
    agentAssessment: assessment,
    checks,
    decidedAt: params.nowIso,
  });
}

export function makeOperatorDecisionRecord(params: {
  project: ProjectPublicView | null;
  gate: ApprovalGate;
  targetKind: 'compute_job' | 'delivery_task';
  targetId: string;
  targetTitle: string;
  projectId: string;
  approvalFingerprint: string | null;
  approved: boolean;
  reason: string;
  extraChecks?: ApprovalRuleCheck[];
  nowIso: string;
}): ApprovalDecisionRecord {
  const policy = params.project?.approvalPolicy ?? DEFAULT_HOST_APPROVAL_POLICY;
  const checks: ApprovalRuleCheck[] = [
    {
      ruleId: 'operator_explicit_decision',
      label: '운영자 명시적 결정',
      passed: params.approved,
      severity: 'info',
      actual: params.approved ? 'approve' : 'reject',
      threshold: 'operator_review',
      detail: params.reason.trim() || (params.approved ? '운영자 승인' : '운영자 거부'),
    },
    ...(params.extraChecks ?? []),
  ];
  return buildDecisionRecord({
    projectId: params.projectId,
    policy,
    gate: params.gate,
    targetKind: params.targetKind,
    targetId: params.targetId,
    targetTitle: params.targetTitle,
    approvalFingerprint: params.approvalFingerprint,
    actorKind: 'operator',
    actorId: 'operator',
    agentAssessment: null,
    checks,
    decidedAt: params.nowIso,
    overrideOutcome: params.approved ? 'manual_approved' : 'rejected',
    overrideSummary: params.approved
      ? `운영자 수동 승인: ${params.reason.trim()}`
      : `운영자 거부: ${params.reason.trim()}`,
  });
}
