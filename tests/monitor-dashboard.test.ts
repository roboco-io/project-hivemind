import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { buildApp } from '../apps/control-plane/src/app.js';

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, ((event: any) => unknown)[]>();
  parent: Element | null = null;
  hidden = false;
  disabled = false;
  checked = false;
  className = '';
  type = '';
  href = '';
  target = '';
  rel = '';
  colSpan = 1;
  dateTime = '';
  private text = '';
  private currentValue = '';
  constructor(readonly tagName: string, readonly id = '') {}
  set innerHTML(_value: string) {
    throw new Error('Untrusted HTML must not be inserted');
  }
  set textContent(value: string) {
    this.text = String(value);
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set value(value: string) {
    this.currentValue = value;
  }
  get value(): string {
    return this.currentValue || (this.tagName === 'select' ? this.children[0]?.value || '' : '');
  }
  get firstChild() {
    return this.children[0]!;
  }
  get lastChild() {
    return this.children.at(-1)!;
  }
  append(...elements: Element[]) {
    for (const element of elements) {
      element.parent = this;
      this.children.push(element);
    }
  }
  replaceChildren(...elements: Element[]) {
    this.children = [];
    this.text = '';
    this.append(...elements);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  setAttribute(_name: string, _value: string) {}
  focus() {}
  reset() {}
  addEventListener(name: string, listener: (event: any) => unknown) {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(selector === 'button' ? child.tagName === 'button' : child.className.split(' ').includes(selector.slice(1)))
        ? [child]
        : [],
      ...child.querySelectorAll(selector),
    ]);
  }
  findTag(tag: string): Element[] {
    return this.children.flatMap((child) => [...(child.tagName === tag ? [child] : []), ...child.findTag(tag)]);
  }
  async dispatch(name: string, extra: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(name) ?? []) {
      await listener({ preventDefault() {}, ...extra });
    }
  }
}

const sampleDeliveryTask = () => ({
  id: 'dlv-11111111-1111-1111-1111-111111111111',
  title: 'SW 전달 <img src=x onerror=alert(1)>',
  instructions: '안전하게 구현하세요',
  provider: 'codex',
  status: 'awaiting_approval',
  approvalFingerprint: 'a'.repeat(64),
  maxIterations: 3,
  currentIteration: 0,
  budgetMicros: 2_500_000,
  acceptance: {
    baseCommit: '1'.repeat(40),
    files: [{ path: 'tests/accept.test.ts', sha256: '2'.repeat(64) }],
    testCommand: ['npm', 'run', 'check'],
    digest: '3'.repeat(64),
  },
  delivery: {
    mode: 'draft_pr',
    repository: 'roboco-io/project-hivemind',
    baseBranch: 'main',
    branchPrefix: 'hivemind/',
    autoMerge: false,
  },
  spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 },
  executionPolicy: {},
  activeRegion: 'us-east-2',
  lastPlacement: {
    selectedRegion: 'us-east-2',
    selectedAzId: 'use2-az3',
    selectedAzName: 'us-east-2c',
    primaryRegion: 'ap-northeast-2',
    workloadClass: 'c.xlarge-arm',
    instanceMembers: ['c7g.xlarge'],
    latestScore: 9,
    windowAvgScore: 8.8,
    trendDirection: 'stable',
    latestPriceUsd: 0.0412,
    primaryPriceUsd: 0.0555,
    savingsVsPrimaryPercent: 25.8,
    fallbackChain: [],
    candidates: [],
    feedGeneratedAt: '2026-11-27T00:00:00Z',
    feedStaleFallback: false,
    reason: 'Ohio Spot score 9 saves 25.8%',
    decidedAt: '2026-11-27T00:05:00Z',
  },
  waitReason: null,
  lastPreflight: null,
  spotRetriesUsed: 0,
  activeRunId: null,
  activeWorkerId: null,
  activeEcsTaskArn: null,
  latestCheckpointRef: null,
  latestWorkerSummary: null,
  spotInterruptions: [],
  attestations: [],
  latestAttestation: null,
  publication: null,
  humanDecision: null,
  createdAt: '2026-11-27T00:00:00Z',
  updatedAt: '2026-11-27T00:05:00Z',
  approvedAt: null,
  approvalReason: null,
  cancelReason: null,
  failureReason: null,
});

const sampleMfJob = () => ({
  id: 'mf-22222222-2222-2222-2222-222222222222',
  title: 'LoRA 학습 <script>alert(1)</script>',
  modelId: 'demo-lora-v1',
  repository: 'roboco-io/project-hivemind',
  baseCommit: '4'.repeat(40),
  status: 'awaiting_training_approval',
  waitReason: 'awaiting_training_approval',
  diagnostics: ['placement ranked ok'],
  approvalFingerprint: 'b'.repeat(64),
  compute: {
    region: 'us-east-2',
    instanceType: 'g6e.2xlarge',
    amiId: 'ami-0123456789abcdef0',
    maxLifetimeMs: 3_600_000,
    maxHourlyPriceUsd: 1.85,
    maxTotalCostMicros: 5_000_000,
    s3ArtifactPrefix: 'models/demo-lora-v1/out',
  },
  releasePolicy: {
    mode: 'hf_release',
    hfRepository: 'roboco-io/demo-lora-v1',
    visibility: 'private',
    releaseCheckCommand: ['python3', 'eval.py'],
  },
  cost: {
    reservedMicros: 5_000_000,
    settledMicros: null,
    hourlyRateUsd: 1.85,
    instanceSeconds: null,
    settledAt: null,
  },
  instance: {
    region: 'us-east-2',
    availabilityZone: 'use2-az3',
    instanceId: 'i-0123456789abcdef0',
    instanceType: 'g6e.2xlarge',
    amiId: 'ami-0123456789abcdef0',
    launchedAt: '2026-11-27T01:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    state: 'running',
    terminatedAt: null,
    forcedTerminationReason: null,
  },
  nextWakeAt: null,
  receipt: {
    version: 1,
    jobId: 'mf-22222222-2222-2222-2222-222222222222',
    s3Bucket: 'hivemind-artifacts',
    s3Prefix: 'models/demo-lora-v1/out',
    manifestDigest: '5'.repeat(64),
    files: [{ path: 'adapter.safetensors', sha256: '6'.repeat(64), sizeBytes: 4_096_000 }],
    recordedAt: '2026-11-27T01:30:00Z',
  },
  releaseAttestation: {
    manifestDigest: '5'.repeat(64),
    releaseCheckPassed: true,
    metrics: { loss: 0.42 },
    summary: 'Self-reported metrics',
    verifiedAt: '2026-11-27T01:35:00Z',
    attestationSource: 'operator_self_reported',
    verificationDisclaimer: '이 검사 결과는 운영자/호출자가 직접 보고한 값이며 독립 검증이 아닙니다.',
  },
  placementPlan: {
    status: 'ranked',
    note: 'Ranked by Spot placement score',
    feedUrl: 'https://example.com/data.json',
    feedGeneratedAt: '2026-11-27T00:00:00Z',
    feedPool: 'g6e.2xlarge',
    feedPoolMembers: ['g6e.2xlarge'],
    liveScoredAt: null,
    trendWindowHours: 48,
    regions: [
      {
        region: 'us-east-2',
        trend: { latest: 9, min: 8, avg: 8.7, slope: 0.2, samples: 8 },
        priceUsd: 1.52,
        azs: [{ azId: 'use2-az3', trend: { latest: 9, min: 8, avg: 8.8, slope: 0.1, samples: 8 } }],
      },
    ],
    plannedAt: '2026-11-27T00:01:00Z',
  },
  releaseDecision: null,
  publication: null,
  createdAt: '2026-11-27T00:00:00Z',
  updatedAt: '2026-11-27T01:35:00Z',
  approvedAt: null,
  approvalReason: null,
  cancelReason: null,
  failureReason: null,
});

const sampleCollabSession = () => ({
  id: 'ses-33333333-3333-3333-3333-333333333333',
  title: '병렬 리팩터링 세션',
  goal: 'API와 UI를 동시에 개선합니다',
  provider: 'claude',
  status: 'active',
  maxParallelWorkers: 3,
  allowedRegions: ['ap-northeast-2', 'us-east-2'],
  repository: 'roboco-io/project-hivemind',
  baseCommit: '7'.repeat(40),
  latestOrchestratorRun: null,
  createdAt: '2026-11-27T00:00:00Z',
  updatedAt: '2026-11-27T02:00:00Z',
});

async function loadDashboardWithMonitor(options?: {
  deliveryTasks?: any[];
  mfJobs?: any[];
  mfLedger?: any;
  collabSessions?: any[];
  collabSnapshot?: any;
  spotStatus?: number;
  failErrorCanary?: boolean;
}) {
  const [html, auditScript, appScript, chartsScript, monitorScript] = await Promise.all(
    ['index.html', 'tool-audit.js', 'app.js', 'charts.js', 'monitor.js'].map((name) =>
      readFile(new URL('../apps/dashboard/public/' + name, import.meta.url).pathname.replace('/dist/', '/'), 'utf8'),
    ),
  );
  const elements = new Map<string, Element>();
  for (const match of html!.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
    elements.set(match[2]!, new Element(match[1]!, match[2]!));
  }
  const get = (id: string) => {
    const el = elements.get(id);
    assert.ok(el, `missing element #${id}`);
    return el;
  };
  get('operator-token').value = 'OPERATOR_SECRET_CANARY';
  get('task-provider').append(Object.assign(new Element('option'), { value: 'mock' }));
  get('task-runtime').append(Object.assign(new Element('option'), { value: 'local' }));
  get('clb-msg-kind').append(Object.assign(new Element('option'), { value: 'decision' }));
  get('dlv-action-form').append(
    get('dlv-btn-approve'),
    get('dlv-btn-human-approve'),
    get('dlv-btn-human-reject'),
    get('dlv-btn-cancel'),
  );
  get('mf-action-form').append(
    get('mf-btn-approve-training'),
    get('mf-btn-approve-release'),
    get('mf-btn-reject-release'),
    get('mf-btn-cancel'),
  );

  let deliveryTasks = options?.deliveryTasks ?? [sampleDeliveryTask()];
  let mfJobs = options?.mfJobs ?? [sampleMfJob()];
  let mfLedger = options?.mfLedger ?? {
    globalBudgetCapMicros: 500_000_000,
    totalReservedMicros: 5_000_000,
    totalSettledMicros: 12_500_000,
    remainingBudgetMicros: 482_500_000,
    activeReservations: 1,
    settledJobs: 2,
    jobs: [
      {
        jobId: mfJobs[0]?.id ?? 'mf-1',
        modelId: 'demo-lora-v1',
        status: 'awaiting_training_approval',
        region: 'us-east-2',
        instanceType: 'g6e.2xlarge',
        reservedMicros: 5_000_000,
        settledMicros: null,
        createdAt: '2026-11-27T00:00:00Z',
        settledAt: null,
      },
    ],
  };
  let collabSessions = options?.collabSessions ?? [sampleCollabSession()];
  let collabSnapshot = options?.collabSnapshot ?? {
    storageBackend: 'aurora-dsql',
    session: collabSessions[0],
    subtasks: [
      {
        id: 'sub-1',
        sessionId: collabSessions[0]?.id ?? 'ses-1',
        title: '하위 작업 <b>A</b>',
        instructions: 'do A',
        provider: 'claude',
        dependsOn: [],
        status: 'running',
        assignedAgentId: 'agent-1',
        region: 'us-east-2',
        ecsTaskArn: 'arn:aws:ecs:us-east-2:123456789012:task/hivemind/abc',
        artifactS3Prefix: null,
        resultSummary: null,
        failureReason: null,
        createdAt: '2026-11-27T00:10:00Z',
        updatedAt: '2026-11-27T00:20:00Z',
      },
    ],
    messages: [
      {
        id: 'msg-1',
        sessionId: collabSessions[0]?.id ?? 'ses-1',
        seq: 1,
        sender: 'agent-1',
        recipient: null,
        threadId: null,
        kind: 'chat',
        body: '진행 중 <img src=x>',
        artifactRefs: [],
        createdAt: '2026-11-27T00:25:00Z',
      },
    ],
    workLogs: [
      {
        id: 'log-1',
        sessionId: collabSessions[0]?.id ?? 'ses-1',
        subtaskId: 'sub-1',
        agentId: 'agent-1',
        kind: 'progress',
        summary: '테스트 통과',
        s3Uri: 's3://hivemind-artifacts/collab/out.json',
        sha256: null,
        createdAt: '2026-11-27T00:30:00Z',
      },
    ],
  };

  const localStoreMap = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => localStoreMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      localStoreMap.set(k, String(v));
    },
    removeItem: (k: string) => {
      localStoreMap.delete(k);
    },
  };
  const docElement = new Element('html');
  const docObj: any = {
    title: '',
    documentElement: docElement,
    getElementById: get,
    createElement: (tag: string) => new Element(tag),
    createElementNS: (_ns: string, tag: string) => new Element(tag),
    addEventListener() {},
    hidden: false,
  };
  const calls: { path: string; method: string; body: any; auth?: string }[] = [];
  const context: any = createContext({
    document: docObj,
    localStorage,
    URL,
    URLSearchParams,
    AbortSignal,
    setInterval() {},
    clearInterval() {},
    fetch: async (path: string, init: any = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, method: init.method ?? 'GET', body, auth: init.headers?.Authorization });
      if (options?.failErrorCanary && path === '/api/monitor/snapshot') {
        return { ok: false, status: 500, json: async () => ({ error: 'Failed with OPERATOR_SECRET_CANARY and ghp_secret12345' }) };
      }
      if (path === '/api/monitor/snapshot') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            health: { status: 'ok', mode: 'aws-runtime' },
            delivery: {
              storageBackend: 'aurora-dsql',
              tasks: deliveryTasks,
              events: [
                { sequence: 1, taskId: deliveryTasks[0]?.id ?? 'dlv-1', type: 'delivery.created', at: '2026-11-27T00:00:00Z', data: { provider: 'codex' } },
                { sequence: 2, taskId: deliveryTasks[0]?.id ?? 'dlv-1', type: 'delivery.verification_failed', at: '2026-11-27T00:10:00Z', data: { reason: 'test error' } },
              ],
            },
            modelFactory: {
              storageBackend: 'aurora-dsql',
              jobs: mfJobs,
              events: [
                { sequence: 1, jobId: mfJobs[0]?.id ?? 'mf-1', type: 'model_factory.created', at: '2026-11-27T00:05:00Z', data: { modelId: 'demo-lora-v1' } },
              ],
              ledger: mfLedger,
            },
            collab: { storageBackend: 'aurora-dsql', sessions: collabSessions },
          }),
        };
      }
      if (path === '/health') return { ok: true, status: 200, json: async () => ({ status: 'ok', mode: 'local-workers' }) };
      if (path === '/api/state') return { ok: true, status: 200, json: async () => ({ tasks: [], workers: [], events: [] }) };
      if (path === '/api/capabilities') return { ok: true, status: 200, json: async () => ({ providers: ['mock'], repository: null }) };
      if (path.startsWith('/api/cloudflare/autonomous-tasks')) return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
      if (path === '/api/delivery/tasks') {
        return { ok: true, status: 200, json: async () => ({ storageBackend: 'aurora-dsql', tasks: deliveryTasks, events: [] }) };
      }
      if (path === '/api/delivery/spot-placement') {
        if ((options?.spotStatus ?? 503) === 503) {
          return { ok: false, status: 503, json: async () => ({ error: 'AWS Spot placement advisor is unavailable in local mock mode' }) };
        }
        return { ok: true, status: 200, json: async () => sampleDeliveryTask().lastPlacement };
      }
      if (path === '/api/delivery/reconcile') {
        return { ok: true, status: 200, json: async () => ({ checked: 1, failed: [], untouched: [] }) };
      }
      if (path.startsWith('/api/delivery/tasks/')) {
        return { ok: true, status: 200, json: async () => deliveryTasks[0] };
      }
      if (path === '/api/model-factory/jobs') {
        return { ok: true, status: 200, json: async () => ({ storageBackend: 'aurora-dsql', jobs: mfJobs, events: [] }) };
      }
      if (path === '/api/model-factory/ledger') {
        return { ok: true, status: 200, json: async () => mfLedger };
      }
      if (path.startsWith('/api/model-factory/')) {
        return { ok: true, status: 200, json: async () => mfJobs[0] };
      }
      if (path === '/api/collab/sessions') {
        return { ok: true, status: 200, json: async () => ({ storageBackend: 'aurora-dsql', sessions: collabSessions }) };
      }
      if (path.match(/^\/api\/collab\/sessions\/[^/]+$/)) {
        return { ok: true, status: 200, json: async () => collabSnapshot };
      }
      if (path.startsWith('/api/collab/sessions/')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    },
  });

  // Load all four scripts into the SAME global context to verify zero identifier collisions!
  runInContext(auditScript!, context);
  runInContext(appScript!, context);
  runInContext(chartsScript!, context);
  runInContext(monitorScript!, context);
  await new Promise((r) => setImmediate(r));

  return {
    get,
    calls,
    doc: docObj,
    localStoreMap,
    monitor: context.hivemindMonitor,
    setDeliveryTasks: (v: any[]) => {
      deliveryTasks = v;
    },
    setMfJobs: (v: any[]) => {
      mfJobs = v;
    },
  };
}

test('monitor.js loads cleanly alongside app.js and tool-audit.js and renders overview KPIs and budget ledger', async () => {
  const ui = await loadDashboardWithMonitor();
  assert.equal(ui.get('panel-overview').hidden, false);
  assert.equal(ui.get('panel-legacy').hidden, true);
  assert.equal(ui.get('monitor-mode-badge').textContent, 'Control Plane · AWS 운영 · Aurora DSQL');
  assert.equal(ui.get('monitor-backend-delivery').textContent, 'Aurora DSQL');
  assert.equal(ui.get('monitor-backend-mf').textContent, 'Aurora DSQL');
  assert.equal(ui.get('monitor-backend-collab').textContent, 'Aurora DSQL');
  assert.equal(ui.get('kpi-attention-total').textContent, '2');
  assert.equal(ui.get('kpi-active-total').textContent, '1');
  assert.equal(ui.get('kpi-mf-remaining').textContent, '$482.50');
  assert.equal(ui.get('kpi-mf-committed').textContent, '$17.50');
  assert.match(ui.get('budget-utilization-pill').textContent, /3\.5%/);
  assert.match(ui.get('monitor-ledger-body').textContent, /demo-lora-v1/);
  assert.match(ui.get('monitor-ledger-body').textContent, /미정산/);
});

test('untrusted HTML and secrets are safely rendered as text and redacted in error banners', async () => {
  const ui = await loadDashboardWithMonitor({ failErrorCanary: true });
  assert.ok(!ui.get('monitor-error').textContent.includes('OPERATOR_SECRET_CANARY'));
  assert.ok(!ui.get('monitor-error').textContent.includes('ghp_secret12345'));
  assert.match(ui.get('monitor-error').textContent, /\[REDACTED\]/);
});

test('delivery detail renders safe links, hash verification, fingerprint drift guard, and explicit approval', async () => {
  const task = sampleDeliveryTask();
  const ui = await loadDashboardWithMonitor({ deliveryTasks: [task] });
  ui.monitor.switchTab('delivery');
  ui.monitor.selectDelivery(task.id);
  assert.equal(ui.get('dlv-title').textContent, task.title);
  assert.match(ui.get('dlv-fingerprint-row').textContent, new RegExp('a'.repeat(64)));

  // Submitting without reason is blocked
  await ui.get('dlv-action-form').dispatch('submit', { submitter: { value: 'approve' } });
  assert.ok(!ui.calls.some((c) => c.path.endsWith('/approve')));

  // Submitting with explicit reason sends approvalFingerprint + reason
  ui.get('dlv-reason').value = '운영자 검토 완료';
  await ui.get('dlv-action-form').dispatch('submit', { submitter: { value: 'approve' } });
  const approveCall = ui.calls.find((c) => c.path.endsWith('/approve'));
  assert.ok(approveCall);
  assert.deepEqual(approveCall.body, { approvalFingerprint: 'a'.repeat(64), reason: '운영자 검토 완료' });

  // Fingerprint drift clears typed reason
  ui.get('dlv-reason').value = '이전 사유';
  ui.setDeliveryTasks([{ ...task, approvalFingerprint: 'f'.repeat(64) }]);
  await ui.monitor.refresh();
  assert.equal(ui.get('dlv-reason').value, '');
  assert.match(ui.get('monitor-error').textContent, /approvalFingerprint/);

  // Draft PR with javascript: URL must NOT become an anchor; valid https: URL becomes a safe link + 3-way hash match
  const hash = '9'.repeat(40);
  ui.setDeliveryTasks([
    {
      ...task,
      status: 'draft_pr_published',
      latestAttestation: {
        runId: 'run-1',
        iteration: 1,
        baseCommit: '1'.repeat(40),
        acceptanceTestDigest: '3'.repeat(64),
        verifiedTreeHash: hash,
        patchSha256: '8'.repeat(64),
        checksPassed: true,
        acceptancePathsUnmodified: true,
        durationMs: 1200,
        exitCode: 0,
        summary: 'All tests passed',
        verifiedAt: '2026-11-27T01:00:00Z',
      },
      publication: {
        branchName: 'hivemind/test',
        commitSha: hash,
        prTreeHash: hash,
        prNumber: 42,
        prUrl: 'javascript:alert(1)',
        verifiedTreeHash: hash,
        acceptanceTestDigest: '3'.repeat(64),
        patchSha256: '8'.repeat(64),
        publishedAt: '2026-11-27T01:01:00Z',
      },
    },
  ]);
  await ui.monitor.refresh();
  assert.equal(ui.get('dlv-hash-match').textContent, '트리 해시 3자 일치');
  assert.equal(ui.get('dlv-pr-link').findTag('a').length, 0);

  ui.setDeliveryTasks([
    {
      ...task,
      status: 'draft_pr_published',
      latestAttestation: {
        runId: 'run-1',
        iteration: 1,
        baseCommit: '1'.repeat(40),
        acceptanceTestDigest: '3'.repeat(64),
        verifiedTreeHash: hash,
        patchSha256: '8'.repeat(64),
        checksPassed: true,
        acceptancePathsUnmodified: true,
        durationMs: 1200,
        exitCode: 0,
        summary: 'All tests passed',
        verifiedAt: '2026-11-27T01:00:00Z',
      },
      publication: {
        branchName: 'hivemind/test',
        commitSha: hash,
        prTreeHash: hash,
        prNumber: 42,
        prUrl: 'https://github.com/roboco-io/project-hivemind/pull/42',
        verifiedTreeHash: hash,
        acceptanceTestDigest: '3'.repeat(64),
        patchSha256: '8'.repeat(64),
        publishedAt: '2026-11-27T01:01:00Z',
      },
    },
  ]);
  await ui.monitor.refresh();
  const anchors = ui.get('dlv-pr-link').findTag('a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0]!.href, 'https://github.com/roboco-io/project-hivemind/pull/42');
  assert.equal(anchors[0]!.rel, 'noopener noreferrer');

  // Reconcile & Spot placement 503 handling
  await ui.get('delivery-reconcile-btn').dispatch('click');
  assert.ok(ui.calls.some((c) => c.path === '/api/delivery/reconcile' && c.method === 'POST'));
  await ui.monitor.querySpotPlacement();
  assert.match(ui.get('spot-advisor-status').textContent, /503|로컬 모의/);
});

test('model factory panel surfaces self-reported attestation warning, instance TTL, and explicit training approval', async () => {
  const job = sampleMfJob();
  const ui = await loadDashboardWithMonitor({ mfJobs: [job] });
  ui.monitor.switchTab('model-factory');
  ui.monitor.selectMfJob(job.id);

  assert.equal(ui.get('mf-attest-source').textContent, '운영자 직접 보고 (비독립)');
  assert.equal(ui.get('mf-attest-disclaimer').hidden, false);
  assert.match(ui.get('mf-inst-expires').textContent, /남은 수명/);
  assert.match(ui.get('mf-plan-regions').textContent, /us-east-2/);

  ui.get('mf-reason').value = '예산과 배치 계획 확인 완료';
  await ui.get('mf-action-form').dispatch('submit', { submitter: { value: 'approve_training' } });
  const call = ui.calls.find((c) => c.path.endsWith('/approve-training'));
  assert.ok(call);
  assert.deepEqual(call.body, { approvalFingerprint: 'b'.repeat(64), reason: '예산과 배치 계획 확인 완료' });
});

test('collab panel loads session snapshot, renders subtasks/messages safely, and posts operator messages', async () => {
  const session = sampleCollabSession();
  const ui = await loadDashboardWithMonitor({ collabSessions: [session] });
  ui.monitor.switchTab('collab');
  await ui.monitor.selectCollab(session.id);

  assert.match(ui.get('clb-subtasks').textContent, /하위 작업 <b>A<\/b>/);
  assert.match(ui.get('clb-messages').textContent, /진행 중 <img src=x>/);
  assert.match(ui.get('clb-worklogs').textContent, /테스트 통과/);

  ui.get('clb-msg-body').value = '작업 A 먼저 마무리하세요';
  await ui.get('clb-message-form').dispatch('submit');
  const postCall = ui.calls.find((c) => c.path.endsWith('/messages') && c.method === 'POST');
  assert.ok(postCall);
  assert.deepEqual(postCall.body, { sender: 'operator', kind: 'decision', body: '작업 A 먼저 마무리하세요' });
});

test('control-plane serves /monitor.js with CSP and without exposing operator credentials', async (t) => {
  const app = buildApp({ operatorToken: 'super-secret-monitor-token' });
  t.after(() => app.close());

  const res = await app.inject('/monitor.js');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /application\/javascript/);
  assert.ok(res.headers['content-security-policy']);
  assert.ok(!res.body.includes('super-secret-monitor-token'));

  const chartsRes = await app.inject('/charts.js');
  assert.equal(chartsRes.statusCode, 200);
  assert.match(String(chartsRes.headers['content-type']), /application\/javascript/);
  assert.ok(chartsRes.headers['content-security-policy']);
  assert.ok(!chartsRes.body.includes('super-secret-monitor-token'));

  const html = await app.inject('/');
  assert.equal(html.statusCode, 200);
  assert.ok(html.body.includes('/charts.js'));
  assert.ok(html.body.includes('/monitor.js'));
  assert.ok(!html.body.includes('super-secret-monitor-token'));

  const awsApp = buildApp({
    operatorToken: 'super-secret-monitor-token',
    deliveryOrchestratorFactory: () => ({}) as never,
  });
  t.after(() => awsApp.close());
  assert.deepEqual((await awsApp.inject('/health')).json(), { status: 'ok', mode: 'aws-runtime' });

  // /api/monitor/snapshot requires operator auth and returns aggregated read-only state in one request
  assert.equal((await awsApp.inject('/api/monitor/snapshot')).statusCode, 401);
  const snapRes = await awsApp.inject({
    url: '/api/monitor/snapshot',
    headers: { authorization: 'Bearer super-secret-monitor-token' },
  });
  assert.equal(snapRes.statusCode, 200);
  assert.equal(snapRes.headers.connection, 'close');
  const snap = snapRes.json() as any;
  assert.deepEqual(snap.health, { status: 'ok', mode: 'aws-runtime' });
  assert.equal(snap.delivery.storageBackend, 'sqlite');
  assert.equal(snap.modelFactory.storageBackend, 'sqlite');
  assert.equal(snap.collab.storageBackend, 'sqlite');
  assert.ok(!snapRes.body.includes('super-secret-monitor-token'));
});

test('monitor.js consumes #token fragment into tab sessionStorage, survives reload, strips URL hash, and ignores ?token query string', async () => {
  const [html, auditScript, appScript, chartsScript, monitorScript] = await Promise.all(
    ['index.html', 'tool-audit.js', 'app.js', 'charts.js', 'monitor.js'].map((name) =>
      readFile(new URL('../apps/dashboard/public/' + name, import.meta.url).pathname.replace('/dist/', '/'), 'utf8'),
    ),
  );
  const makeSessionStorage = (initial: Record<string, string> = {}) => {
    const map = new Map<string, string>(Object.entries(initial));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      snapshot: () => Object.fromEntries(map),
    };
  };
  const runWithUrl = async (
    loc: { pathname: string; search: string; hash: string },
    storage = makeSessionStorage(),
  ) => {
    const elements = new Map<string, Element>();
    for (const match of html!.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
      elements.set(match[2]!, new Element(match[1]!, match[2]!));
    }
    const get = (id: string) => elements.get(id)!;
    get('operator-token').value = 'local-development-only';
    get('task-provider').append(Object.assign(new Element('option'), { value: 'mock' }));
    get('task-runtime').append(Object.assign(new Element('option'), { value: 'local' }));
    get('clb-msg-kind').append(Object.assign(new Element('option'), { value: 'decision' }));
    const replaced: string[] = [];
    const seenAuth: string[] = [];
    const context: any = createContext({
      document: {
        getElementById: get,
        createElement: (t: string) => new Element(t),
        createElementNS: (_ns: string, t: string) => new Element(t),
        documentElement: new Element('html'),
        title: '',
        addEventListener() {},
        hidden: false,
      },
      location: loc,
      history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
      sessionStorage: storage,
      URL,
      URLSearchParams,
      AbortSignal,
      setInterval() {},
      clearInterval() {},
      fetch: async (_path: string, init: any = {}) => {
        if (init.headers?.Authorization) seenAuth.push(init.headers.Authorization);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            health: { status: 'ok', mode: 'aws-runtime' },
            delivery: { storageBackend: 'aurora-dsql', tasks: [], events: [] },
            modelFactory: { storageBackend: 'aurora-dsql', jobs: [], events: [], ledger: { globalBudgetCapMicros: 500_000_000, totalReservedMicros: 0, totalSettledMicros: 0, remainingBudgetMicros: 500_000_000, activeReservations: 0, settledJobs: 0, jobs: [] } },
            collab: { storageBackend: 'aurora-dsql', sessions: [] },
          }),
        };
      },
    });
    runInContext(auditScript!, context);
    runInContext(appScript!, context);
    runInContext(chartsScript!, context);
    runInContext(monitorScript!, context);
    await new Promise((r) => setImmediate(r));
    return { tokenValue: get('operator-token').value, replaced, seenAuth, storage };
  };

  // #token fragment works, saves to tab sessionStorage, and is immediately stripped from the URL bar
  const sharedTabStorage = makeSessionStorage();
  const fromHash = await runWithUrl({ pathname: '/', search: '', hash: '#token=HASH_TOKEN_999&tab=overview' }, sharedTabStorage);
  assert.equal(fromHash.tokenValue, 'HASH_TOKEN_999');
  assert.deepEqual(fromHash.replaced, ['/#tab=overview']);
  assert.ok(fromHash.seenAuth.includes('Bearer HASH_TOKEN_999'));

  // Reloading the same tab (without #token in URL) restores the token from sessionStorage cleanly
  const afterReload = await runWithUrl({ pathname: '/', search: '', hash: '' }, sharedTabStorage);
  assert.equal(afterReload.tokenValue, 'HASH_TOKEN_999');
  assert.ok(afterReload.seenAuth.includes('Bearer HASH_TOKEN_999'));

  // ?token query string is ignored in a fresh tab
  const fromQuery = await runWithUrl({ pathname: '/', search: '?token=QUERY_TOKEN_BAD', hash: '' });
  assert.equal(fromQuery.tokenValue, 'local-development-only');
  assert.deepEqual(fromQuery.replaced, []);
  assert.ok(!fromQuery.seenAuth.includes('Bearer QUERY_TOKEN_BAD'));
});

test('HUD renders SVG cost charts without innerHTML, inbox cards, slide-over drawer, event filters, shortcuts, and non-secret UI prefs', async () => {
  const ui = await loadDashboardWithMonitor();

  // Dynamic browser tab title reflects pending approvals and active runs
  assert.equal(ui.doc.title, '(2 대기 · 1 실행) HIVEMIND 관제실');

  // Pure SVG cost trend & breakdown charts render via createElementNS (zero innerHTML)
  assert.ok(ui.get('overview-cost-chart').findTag('svg').length === 1);
  assert.ok(ui.get('costs-trend-chart').findTag('svg').length === 1);
  assert.match(ui.get('costs-by-model').textContent, /demo-lora-v1/);
  assert.match(ui.get('costs-by-region').textContent, /us-east-2/);
  assert.match(ui.get('costs-by-instance').textContent, /g6e\.2xlarge/);
  assert.match(ui.get('costs-live-ec2').textContent, /i-0123456789abcdef0/);

  // Live strip & Approval Inbox populated
  assert.match(ui.get('live-strip-list').textContent, /병렬 리팩터링 세션/);
  assert.equal(ui.get('tab-badge-inbox').textContent, '2');
  assert.match(ui.get('overview-inbox-list').textContent, /SW 전달/);
  assert.match(ui.get('inbox-list').textContent, /LoRA 학습/);

  // Slide-over Detail Drawer opens with pipeline stepper & closes via Escape key
  ui.monitor.openDrawer('mf', 'mf-22222222-2222-2222-2222-222222222222');
  assert.equal(ui.get('detail-drawer').hidden, false);
  assert.equal(ui.get('drawer-title').textContent, 'LoRA 학습 <script>alert(1)</script>');
  assert.match(ui.get('drawer-stepper').textContent, /학습 승인/);
  ui.monitor.handleKeydown({ key: 'Escape' });
  assert.equal(ui.get('detail-drawer').hidden, true);

  // Number shortcuts switch views, but are ignored while typing in INPUT
  ui.monitor.handleKeydown({ key: '6', target: { tagName: 'BODY' } });
  assert.equal(ui.monitor.state.activeTab, 'costs');
  ui.monitor.handleKeydown({ key: '1', target: { tagName: 'INPUT' } });
  assert.equal(ui.monitor.state.activeTab, 'costs');
  ui.monitor.handleKeydown({ key: '1', target: { tagName: 'BODY' } });
  assert.equal(ui.monitor.state.activeTab, 'overview');

  // Event timeline filters by errors-only and keyword search
  assert.match(ui.get('monitor-recent-events').textContent, /delivery\.created/);
  ui.get('events-errors-only').checked = true;
  await ui.get('events-errors-only').dispatch('change');
  assert.match(ui.get('monitor-recent-events').textContent, /delivery\.verification_failed/);
  assert.ok(!ui.get('monitor-recent-events').textContent.includes('delivery.created'));

  // Theme & density toggles persist non-secret UI prefs only; operator token NEVER enters localStorage
  await ui.get('monitor-theme-toggle').dispatch('click');
  await ui.get('monitor-density-toggle').dispatch('click');
  assert.equal(ui.doc.documentElement.dataset.theme, 'light');
  assert.equal(ui.doc.documentElement.dataset.density, 'compact');
  const savedPrefs = ui.localStoreMap.get('hivemind.uiPrefs') ?? '';
  assert.match(savedPrefs, /"theme":"light"/);
  assert.match(savedPrefs, /"density":"compact"/);
  assert.ok(!savedPrefs.includes('OPERATOR_SECRET_CANARY'));
});
