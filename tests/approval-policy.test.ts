import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import type { ApprovalDecisionRecord } from '../packages/contracts/src/approval-policy.js';
import type { CreateComputeJob } from '../packages/contracts/src/compute.js';
import type { CreateDeliveryTask } from '../packages/contracts/src/delivery.js';
import { computeAcceptanceTestDigest } from '../packages/core/src/delivery.js';

const OP = 'op-approval-policy-token-1234567890';
const WK = 'wk-approval-policy-token-1234567890';
const opHeaders = { authorization: `Bearer ${OP}` };
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

function jobPayload(overrides: Partial<CreateComputeJob> = {}): CreateComputeJob {
  return {
    title: 'LoRA training trial',
    workloadId: 'lora-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g5.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 3_600_000, // 1h
      maxHourlyPriceUsd: 0.45,
      maxTotalCostMicros: 450_000, // $0.45
      s3ArtifactPrefix: 'projects/smf-auto/lora-v1/run-1',
    },
    releasePolicy: {
      mode: 's3_artifact_only',
      visibility: 'private',
      releaseCheckCommand: ['node', 'check.mjs'],
    },
    ...overrides,
  };
}

function deliveryPayload(repository: string, budgetMicros: number): CreateDeliveryTask {
  const baseCommit = 'b'.repeat(40);
  const files = [{ path: 'tests/a.test.ts', sha256: 'c'.repeat(64) }];
  const testCommand = ['npm', 'test'];
  return {
    title: 'Stage step improvement',
    instructions: 'Improve evaluation accuracy.',
    provider: 'codex',
    maxIterations: 2,
    budgetMicros,
    acceptance: { baseCommit, files, testCommand, digest: computeAcceptanceTestDigest({ baseCommit, files, testCommand }) },
    delivery: { mode: 'draft_pr', repository, baseBranch: 'main', branchPrefix: 'agent/', autoMerge: false },
    bundle: { baseCommit, bundleSha256: 'd'.repeat(64), sizeBytes: 512, fileCount: 1, s3Key: 'bundles/t.bundle' },
    spot: { maxSpotRetries: 1, checkpointFlushTimeoutMs: 60_000 },
  };
}

test('model-factory minimal_human policy auto-approves within guardrails, escalates over threshold, and blocks agent bypass', async (t) => {
  const app = buildApp({ operatorToken: OP, workerToken: WK, computeBudgetCapMicros: 500_000_000 });
  t.after(() => app.close());

  // Register a model-factory project with minimal_human policy (auto-approve compute <= $10, lifetime <= 4h).
  const projRes = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'smf-auto',
      name: 'Silicon Model Factory',
      template: 'model-factory',
      delivery: { repositories: ['roboco-io/silicon-model-factory'] },
      budget: { computeBudgetCapMicros: 100_000_000, maxSingleJobCostMicros: 50_000_000 },
      approvalPolicy: {
        autonomyMode: 'minimal_human',
        computeLaunch: {
          maxAutoApproveCostMicros: 10_000_000, // $10 auto-approve limit
          maxAutoApproveLifetimeMs: 14_400_000, // 4h auto-approve limit
          allowedInstanceFamilies: ['g5', 'g6'],
        },
      },
    },
  });
  assert.equal(projRes.statusCode, 201);
  assert.equal(projRes.json().approvalPolicy.autonomyMode, 'minimal_human');

  const token = (
    await app.inject({
      method: 'POST',
      url: '/api/projects/smf-auto/tokens',
      headers: opHeaders,
      payload: { label: 'smf-agent' },
    })
  ).json().token as string;

  // 1. Within policy ($0.45 <= $10, 1h <= 4h, g5 allowed): agent requests approval -> auto_approved and launched!
  const smallJob = (
    await app.inject({ method: 'POST', url: '/api/compute/jobs', headers: bearer(token), payload: jobPayload() })
  ).json();
  const autoRes = await app.inject({
    method: 'POST',
    url: `/api/compute/jobs/${smallJob.id}/request-approval`,
    headers: bearer(token),
    payload: {
      approvalFingerprint: smallJob.approvalFingerprint,
      recommendedOutcome: 'auto_approved',
      rationale: '소규모 LoRA 실험으로 정책 비용·수명 한도 이내입니다.',
    },
  });
  assert.equal(autoRes.statusCode, 200);
  const autoBody = autoRes.json() as { decision: ApprovalDecisionRecord; executed: boolean; job: { status: string; approvalDecisions: ApprovalDecisionRecord[] } };
  assert.equal(autoBody.executed, true);
  assert.equal(autoBody.decision.outcome, 'auto_approved');
  assert.equal(autoBody.decision.actorKind, 'agent');
  assert.equal(autoBody.decision.agentAssessment?.rationale, '소규모 LoRA 실험으로 정책 비용·수명 한도 이내입니다.');
  assert.ok(autoBody.decision.checks.every((c) => c.passed));
  assert.equal(autoBody.job.status, 'queued');

  // 2. Over auto-approve cost limit ($25 > $10, even though < $50 project single-job ceiling): escalates to manual_approval_required!
  const bigJob = (
    await app.inject({
      method: 'POST',
      url: '/api/compute/jobs',
      headers: bearer(token),
      payload: jobPayload({
        title: 'Large pretrain run',
        compute: {
          ...jobPayload().compute,
          maxTotalCostMicros: 25_000_000,
          s3ArtifactPrefix: 'projects/smf-auto/lora-v1/run-big',
        },
      }),
    })
  ).json();

  const escRes = await app.inject({
    method: 'POST',
    url: `/api/compute/jobs/${bigJob.id}/request-approval`,
    headers: bearer(token),
    payload: {
      approvalFingerprint: bigJob.approvalFingerprint,
      recommendedOutcome: 'auto_approved',
      rationale: '대형 학습 자동 승인 시도',
    },
  });
  assert.equal(escRes.statusCode, 202);
  const escBody = escRes.json() as { decision: ApprovalDecisionRecord; executed: boolean; job: { status: string } };
  assert.equal(escBody.executed, false);
  assert.equal(escBody.decision.outcome, 'manual_approval_required');
  assert.equal(escBody.job.status, 'awaiting_launch_approval');
  const costCheck = escBody.decision.checks.find((c) => c.ruleId === 'auto_cost_limit');
  assert.equal(costCheck?.passed, false);
  assert.equal(costCheck?.severity, 'escalate_manual');

  // Direct /approve by the project agent CANNOT bypass the policy!
  const bypassRes = await app.inject({
    method: 'POST',
    url: `/api/compute/jobs/${bigJob.id}/approve`,
    headers: bearer(token),
    payload: { approvalFingerprint: bigJob.approvalFingerprint, reason: 'Try direct bypass' },
  });
  assert.equal(bypassRes.statusCode, 403);
  assert.equal(bypassRes.json().decision.outcome, 'manual_approval_required');

  // Human operator CAN approve it, and the operator decision is recorded in the audit trail.
  const opApprove = await app.inject({
    method: 'POST',
    url: `/api/compute/jobs/${bigJob.id}/approve`,
    headers: opHeaders,
    payload: { approvalFingerprint: bigJob.approvalFingerprint, reason: '대형 학습 비용 검토 후 수동 승인' },
  });
  assert.equal(opApprove.statusCode, 200);
  assert.equal(opApprove.json().status, 'queued');

  // 3. Safety ratchet: agent explicitly escalates a small job -> stays awaiting_launch_approval with agent rationale recorded.
  const ratchetJob = (
    await app.inject({
      method: 'POST',
      url: '/api/compute/jobs',
      headers: bearer(token),
      payload: jobPayload({
        title: 'Novel architecture trial',
        compute: { ...jobPayload().compute, s3ArtifactPrefix: 'projects/smf-auto/lora-v1/run-ratchet' },
      }),
    })
  ).json();
  const ratchetRes = await app.inject({
    method: 'POST',
    url: `/api/compute/jobs/${ratchetJob.id}/request-approval`,
    headers: bearer(token),
    payload: {
      approvalFingerprint: ratchetJob.approvalFingerprint,
      recommendedOutcome: 'manual_approval_required',
      rationale: '새 손실 함수 실험이라 사람 확인이 필요합니다.',
    },
  });
  assert.equal(ratchetRes.statusCode, 202);
  assert.equal(ratchetRes.json().decision.outcome, 'manual_approval_required');
  assert.ok(ratchetRes.json().decision.checks.some((c: { ruleId: string; passed: boolean }) => c.ruleId === 'agent_escalation' && !c.passed));

  // 4. Audit API & Monitor Snapshot expose project policy and all decisions with rule-by-rule evidence!
  const projApprovals = (await app.inject({ method: 'GET', url: '/api/projects/smf-auto/approvals', headers: opHeaders })).json();
  assert.equal(projApprovals.approvalPolicy.autonomyMode, 'minimal_human');
  assert.ok(projApprovals.policyVersion);
  assert.ok(projApprovals.decisions.length >= 5);
  assert.ok(projApprovals.decisions.some((d: ApprovalDecisionRecord) => d.outcome === 'auto_approved'));
  assert.ok(projApprovals.decisions.some((d: ApprovalDecisionRecord) => d.outcome === 'manual_approval_required'));
  assert.ok(projApprovals.decisions.some((d: ApprovalDecisionRecord) => d.outcome === 'manual_approved'));

  const snap = (await app.inject({ method: 'GET', url: '/api/monitor/snapshot', headers: opHeaders })).json();
  assert.ok(Array.isArray(snap.approvals?.decisions));
  assert.ok(snap.approvals.decisions.length >= 5);
});

test('manual_first project requires human approval for delivery execution while minimal_human auto-approves within budget', async (t) => {
  const app = buildApp({ operatorToken: OP, workerToken: WK });
  t.after(() => app.close());

  await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'strict-app',
      name: 'Strict App',
      template: 'sw-delivery',
      delivery: { repositories: ['org/strict-app'] },
      approvalPolicy: { autonomyMode: 'manual_first' },
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'auto-app',
      name: 'Auto App',
      template: 'model-factory',
      delivery: { repositories: ['org/auto-app'] },
    },
  });

  const strictTok = (
    await app.inject({
      method: 'POST',
      url: '/api/projects/strict-app/tokens',
      headers: opHeaders,
      payload: { label: 's', scopes: ['delivery:read', 'delivery:write'] },
    })
  ).json().token as string;
  const autoTok = (
    await app.inject({
      method: 'POST',
      url: '/api/projects/auto-app/tokens',
      headers: opHeaders,
      payload: { label: 'a', scopes: ['delivery:read', 'delivery:write'] },
    })
  ).json().token as string;

  const strictTask = (
    await app.inject({
      method: 'POST',
      url: '/api/delivery/tasks',
      headers: bearer(strictTok),
      payload: deliveryPayload('org/strict-app', 1_000_000),
    })
  ).json();
  const strictReq = await app.inject({
    method: 'POST',
    url: `/api/delivery/tasks/${strictTask.id}/request-approval`,
    headers: bearer(strictTok),
    payload: { approvalFingerprint: strictTask.approvalFingerprint, recommendedOutcome: 'auto_approved', rationale: 'small patch' },
  });
  assert.equal(strictReq.statusCode, 202);
  assert.equal(strictReq.json().decision.outcome, 'manual_approval_required');
  assert.equal(strictReq.json().task.status, 'awaiting_approval');

  const autoTask = (
    await app.inject({
      method: 'POST',
      url: '/api/delivery/tasks',
      headers: bearer(autoTok),
      payload: deliveryPayload('org/auto-app', 5_000_000),
    })
  ).json();
  const autoReq = await app.inject({
    method: 'POST',
    url: `/api/delivery/tasks/${autoTask.id}/request-approval`,
    headers: bearer(autoTok),
    payload: { approvalFingerprint: autoTask.approvalFingerprint, recommendedOutcome: 'auto_approved', rationale: '모델 팩토리 정책 범위 내 패치' },
  });
  assert.equal(autoReq.statusCode, 200);
  assert.equal(autoReq.json().decision.outcome, 'auto_approved');
  assert.equal(autoReq.json().task.status, 'queued');

  // Filter /api/approvals by outcome=auto_approved returns only auto_approved decisions.
  const autoOnly = (await app.inject({ method: 'GET', url: '/api/approvals?outcome=auto_approved', headers: opHeaders })).json();
  assert.equal(autoOnly.decisions.length, 1);
  assert.equal(autoOnly.decisions[0].projectId, 'auto-app');
});
