export const APPROVAL_AUTONOMY_MODES = ['minimal_human', 'balanced', 'manual_first'] as const;
export type ApprovalAutonomyMode = (typeof APPROVAL_AUTONOMY_MODES)[number];

export const APPROVAL_GATE_MODES = ['auto_within_policy', 'manual_required', 'deny'] as const;
export type ApprovalGateMode = (typeof APPROVAL_GATE_MODES)[number];

export const APPROVAL_GATES = [
  'compute_launch',
  'compute_release',
  'delivery_execute',
  'delivery_merge',
] as const;
export type ApprovalGate = (typeof APPROVAL_GATES)[number];

export const APPROVAL_DECISION_OUTCOMES = [
  'auto_approved',
  'manual_approved',
  'manual_approval_required',
  'rejected',
] as const;
export type ApprovalDecisionOutcome = (typeof APPROVAL_DECISION_OUTCOMES)[number];

export type ApprovalActorKind = 'agent' | 'operator' | 'system_policy';

export interface ComputeLaunchApprovalRule {
  mode: ApprovalGateMode;
  /** Maximum single-job cost (USD micros) eligible for automatic approval without a human. */
  maxAutoApproveCostMicros: number;
  /** Maximum Spot instance lifetime (ms) eligible for automatic approval without a human. */
  maxAutoApproveLifetimeMs: number;
  /** Optional EC2 instance family allowlist for auto-approval (empty = any family permitted by project). */
  allowedInstanceFamilies: string[];
}

export interface ComputeReleaseApprovalRule {
  mode: ApprovalGateMode;
  /** When true, only an independent verifier attestation may auto-approve a release. */
  requireIndependentVerifier: boolean;
  /** Whether private releases (S3-only or private HF) may auto-approve once verified. */
  allowPrivateAutoApprove: boolean;
  /** Whether public HF releases inside autoPublishHfRepoPrefixes may auto-approve once verified. */
  allowPublicAutoApprove: boolean;
}

export interface DeliveryExecuteApprovalRule {
  mode: ApprovalGateMode;
  /** Maximum delivery task budget (USD micros) eligible for automatic approval without a human. */
  maxAutoApproveBudgetMicros: number;
}

export interface DeliveryMergeApprovalRule {
  mode: ApprovalGateMode;
  /** Independent verification must pass before auto-merge is permitted. */
  requireIndependentVerifier: boolean;
  /** Protected paths must remain untouched for auto-merge; touching them escalates to manual review. */
  requireCleanProtectedPaths: boolean;
}

export interface ProjectApprovalPolicy {
  autonomyMode: ApprovalAutonomyMode;
  /** Concise human-readable description of when human approval is required vs automated. */
  summary: string;
  computeLaunch: ComputeLaunchApprovalRule;
  computeRelease: ComputeReleaseApprovalRule;
  deliveryExecute: DeliveryExecuteApprovalRule;
  deliveryMerge: DeliveryMergeApprovalRule;
}

export interface ProjectApprovalPolicyPatch {
  autonomyMode?: ApprovalAutonomyMode;
  summary?: string;
  computeLaunch?: Partial<ComputeLaunchApprovalRule>;
  computeRelease?: Partial<ComputeReleaseApprovalRule>;
  deliveryExecute?: Partial<DeliveryExecuteApprovalRule>;
  deliveryMerge?: Partial<DeliveryMergeApprovalRule>;
}

export interface ApprovalRuleCheck {
  ruleId: string;
  label: string;
  passed: boolean;
  severity: 'hard_reject' | 'escalate_manual' | 'info';
  actual: string;
  threshold: string;
  detail: string;
}

export interface ApprovalAgentAssessment {
  recommendedOutcome?: 'auto_approved' | 'manual_approval_required';
  rationale?: string;
}

export interface ApprovalDecisionRecord {
  id: string;
  projectId: string;
  gate: ApprovalGate;
  targetKind: 'compute_job' | 'delivery_task';
  targetId: string;
  targetTitle: string;
  approvalFingerprint: string | null;
  outcome: ApprovalDecisionOutcome;
  actorKind: ApprovalActorKind;
  actorId: string;
  policyVersion: string;
  policyMode: ApprovalAutonomyMode;
  policySummary: string;
  agentAssessment: ApprovalAgentAssessment | null;
  /** Central-core authoritative reason summarizing why this outcome was decided. */
  summary: string;
  /** Structured per-rule evaluation evidence displayed in the HUD. */
  checks: ApprovalRuleCheck[];
  decidedAt: string;
}

export interface RequestApprovalInput {
  approvalFingerprint: string;
  recommendedOutcome?: 'auto_approved' | 'manual_approval_required';
  rationale?: string;
}
