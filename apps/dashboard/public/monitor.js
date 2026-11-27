(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  const DELIVERY_STATUS = {
    awaiting_approval: '실행 승인 대기',
    queued: '배정 대기',
    running: '실행 중',
    verified: '검증 완료',
    draft_pr_published: 'Draft PR 검토 대기',
    approved: '승인 완료',
    rejected: '반려',
    failed: '실패',
    cancelled: '중단',
  };
  const DELIVERY_ACTIVE = new Set(['queued', 'running', 'verified']);
  const DELIVERY_ATTENTION = new Set(['awaiting_approval', 'draft_pr_published']);
  const DELIVERY_TERMINAL = new Set(['approved', 'rejected', 'failed', 'cancelled']);

  const MF_STATUS = {
    awaiting_training_approval: '학습 승인 대기',
    training_queued: '학습 배정 대기',
    training_running: '학습 실행 중',
    evaluating: '산출물 평가 중',
    awaiting_release_approval: '공개 승인 대기',
    release_approved: '공개 승인됨',
    released: '공개 완료',
    failed: '실패',
    cancelled: '중단',
    rejected: '반려',
  };
  const MF_ACTIVE = new Set(['training_queued', 'training_running', 'evaluating', 'release_approved']);
  const MF_ATTENTION = new Set(['awaiting_training_approval', 'awaiting_release_approval']);
  const MF_TERMINAL = new Set(['released', 'failed', 'cancelled', 'rejected']);

  const COLLAB_STATUS = {
    active: '진행 중',
    completed: '완료',
    failed: '실패',
    cancelled: '중단',
  };
  const SUBTASK_STATUS = {
    pending: '대기',
    queued: '배정 대기',
    running: '실행 중',
    completed: '완료',
    failed: '실패',
    cancelled: '중단',
  };
  const EC2_STATE = {
    pending: '시작 중',
    running: '실행 중',
    stopping: '중지 중',
    stopped: '중지됨',
    'shutting-down': '종료 중',
    terminated: '종료됨',
    unknown: '확인 필요',
  };
  const WAIT_REASON = {
    awaiting_training_approval: '사람의 학습 승인을 기다립니다.',
    training_in_progress: 'EC2 스팟 인스턴스에서 학습을 진행하고 있습니다.',
    awaiting_cost_settlement: '인스턴스 종료 및 비용 정산을 기다립니다.',
    awaiting_release_approval: '검증 통과 후 사람의 공개 승인을 기다립니다.',
    credential_busy: '자격 증명 세션을 기다립니다.',
    spot_capacity_retry: '스팟 용량 확보를 재시도하고 있습니다.',
    awaiting_independent_verification: '독립 검증기 결과를 기다립니다.',
    awaiting_draft_pr_publication: 'Draft PR 게시를 기다립니다.',
    spot_interrupted_requeued: '스팟 중단 후 재실행을 대기하고 있습니다.',
    queued_for_next_iteration: '다음 Ralph 루프 반복을 대기하고 있습니다.',
    preflight_failed: '워커 프리플라이트 검사에서 실패했습니다.',
  };
  const MODE_LABEL = {
    'aws-runtime': 'AWS 운영',
    'mock-local': '모의 · 로컬',
    'local-workers': '로컬 워커',
    'hybrid-workers': '하이브리드 워커',
    'cloudflare-bridge': '원격 브리지',
  };
  const BACKEND_LABEL = {
    'aurora-dsql': 'Aurora DSQL',
    sqlite: 'SQLite',
  };

  const state = {
    activeTab: 'overview',
    autoRefresh: true,
    health: null,
    delivery: { storageBackend: null, tasks: [], events: [] },
    deliveryFilter: 'all',
    selectedDeliveryId: null,
    selectedDeliveryFingerprint: null,
    spotPlacement: null,
    spotStatusText: null,
    spotChecking: false,
    mf: { storageBackend: null, jobs: [], events: [], ledger: null },
    mfFilter: 'all',
    selectedMfId: null,
    selectedMfFingerprint: null,
    collab: { storageBackend: null, sessions: [], selectedId: null, snapshot: null, epoch: 0 },
    busy: false,
    refreshing: false,
    error: null,
    notice: null,
  };

  function safeText(value, max = 4000) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    const token = byId('operator-token')?.value;
    if (token) text = text.split(token).join('[REDACTED]');
    return text
      .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/(?:sk-ant-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]+|gh[ps]_[A-Za-z0-9]+)/g, '[REDACTED]')
      .slice(0, max);
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function safeHttpsLink(url, label) {
    if (typeof url !== 'string' || !url.trim()) return el('span', '없음', 'quiet');
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        const anchor = el('a', safeText(label || url, 300), 'external-link');
        anchor.href = parsed.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        return anchor;
      }
    } catch {
      // Fall through to plain text.
    }
    return el('span', safeText(label || url, 300));
  }

  function formatUsd(micros) {
    if (typeof micros !== 'number' || !Number.isFinite(micros)) return '미확정';
    const dollars = micros / 1_000_000;
    if (micros === 0) return '$0.00';
    if (Math.abs(micros) >= 10_000 && micros % 10_000 === 0) return '$' + dollars.toFixed(2);
    if (Math.abs(micros) >= 1_000 && micros % 100 === 0) return '$' + dollars.toFixed(4);
    return '$' + dollars.toFixed(6);
  }

  function formatDate(value) {
    if (!value) return '미보고';
    const ts = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ts)) return '미보고';
    return new Date(ts).toLocaleString('ko-KR', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatDurationSec(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '미측정';
    const s = Math.round(seconds);
    if (s < 60) return s + '초';
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) return remS ? m + '분 ' + remS + '초' : m + '분';
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM ? h + '시간 ' + remM + '분' : h + '시간';
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '미보고';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function formatTtl(expiresAt) {
    if (!expiresAt) return '미보고';
    const ts = Date.parse(expiresAt);
    if (!Number.isFinite(ts)) return '미보고';
    const diffSec = Math.round((ts - Date.now()) / 1000);
    const base = formatDate(expiresAt);
    if (diffSec <= 0) return base + ' (만료됨)';
    return base + ' (남은 수명 ' + formatDurationSec(diffSec) + ')';
  }

  function pillClass(status) {
    if (['awaiting_approval', 'draft_pr_published', 'awaiting_training_approval', 'awaiting_release_approval'].includes(status)) {
      return 'pill tone-attention';
    }
    if (['running', 'queued', 'verified', 'training_running', 'training_queued', 'evaluating', 'release_approved', 'active', 'pending'].includes(status)) {
      return 'pill tone-running';
    }
    if (['approved', 'released', 'completed'].includes(status)) {
      return 'pill tone-success';
    }
    if (['failed', 'rejected'].includes(status)) {
      return 'pill tone-danger';
    }
    return 'pill';
  }

  function setError(message) {
    state.error = message ? safeText(message, 400) : null;
    const banner = byId('monitor-error');
    if (!banner) return;
    banner.textContent = state.error || '';
    banner.hidden = !state.error;
  }

  function setNotice(message) {
    state.notice = message ? safeText(message, 400) : null;
    const banner = byId('monitor-notice');
    if (!banner) return;
    banner.textContent = state.notice || '';
    banner.hidden = !state.notice;
  }

  async function monitorApi(path, body, timeoutMs = 15000) {
    const token = byId('operator-token')?.value || '';
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        ...(path === '/health' ? {} : { Authorization: 'Bearer ' + token }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || response.redirected) {
      const msg =
        response.status === 401
          ? '운영자 인증 실패 (401) — 관제 연결 설정의 운영자 토큰을 확인하세요.'
          : safeText((payload && (payload.error || payload.message)) || '요청을 처리하지 못했습니다 (' + response.status + ').', 300);
      const err = new Error(msg);
      err.status = response.status;
      throw err;
    }
    return payload;
  }

  function countByStatus(items) {
    const counts = {};
    for (const item of items) {
      if (item && typeof item.status === 'string') {
        counts[item.status] = (counts[item.status] || 0) + 1;
      }
    }
    return counts;
  }

  function renderStatusBadges(container, counts, labels) {
    if (!container) return;
    container.replaceChildren();
    const entries = Object.entries(counts);
    if (!entries.length) {
      container.append(el('span', '기록 없음', 'quiet'));
      return;
    }
    for (const [status, count] of entries) {
      container.append(el('span', (labels[status] || status) + ' ' + count, pillClass(status)));
    }
  }

  function switchTab(tabName) {
    const valid = ['overview', 'delivery', 'model-factory', 'collab', 'legacy'];
    if (!valid.includes(tabName)) return;
    state.activeTab = tabName;
    for (const name of valid) {
      const btn = byId('tab-' + name);
      const panel = byId('panel-' + name);
      const active = name === tabName;
      if (btn) {
        btn.className = active ? 'tab-btn active' : 'tab-btn';
        btn.setAttribute('aria-selected', String(active));
      }
      if (panel) panel.hidden = !active;
    }
  }

  function renderHeader() {
    const modeBadge = byId('monitor-mode-badge');
    if (modeBadge) {
      if (state.health?.status === 'ok') {
        const isAwsDsql = [state.delivery.storageBackend, state.mf.storageBackend, state.collab.storageBackend].includes('aurora-dsql');
        const modeText =
          state.health.mode === 'aws-runtime' || isAwsDsql
            ? isAwsDsql
              ? 'AWS 운영 · Aurora DSQL'
              : 'AWS 운영'
            : MODE_LABEL[state.health.mode] || safeText(state.health.mode, 40);
        modeBadge.textContent = 'Control Plane · ' + modeText;
        modeBadge.className = 'pill tone-success';
      } else {
        modeBadge.textContent = '연결 확인 필요';
        modeBadge.className = 'pill tone-danger';
      }
    }
    const pollBtn = byId('monitor-poll-toggle');
    if (pollBtn) {
      pollBtn.textContent = state.autoRefresh ? '자동 갱신 켜짐' : '자동 갱신 일시정지';
      pollBtn.setAttribute('aria-pressed', String(state.autoRefresh));
    }
    const backendText = (v) => (v && BACKEND_LABEL[v]) || (v ? safeText(v, 32) : '미연결');
    if (byId('monitor-backend-delivery')) byId('monitor-backend-delivery').textContent = backendText(state.delivery.storageBackend);
    if (byId('monitor-backend-mf')) byId('monitor-backend-mf').textContent = backendText(state.mf.storageBackend);
    if (byId('monitor-backend-collab')) byId('monitor-backend-collab').textContent = backendText(state.collab.storageBackend);

    if (byId('tab-badge-delivery')) byId('tab-badge-delivery').textContent = String(state.delivery.tasks.length);
    if (byId('tab-badge-mf')) byId('tab-badge-mf').textContent = String(state.mf.jobs.length);
    if (byId('tab-badge-collab')) byId('tab-badge-collab').textContent = String(state.collab.sessions.length);
    const legacyCount = byId('task-count')?.textContent;
    if (byId('tab-badge-legacy') && legacyCount !== undefined) byId('tab-badge-legacy').textContent = legacyCount;
  }

  function renderOverview() {
    const deliveryActive = state.delivery.tasks.filter((t) => DELIVERY_ACTIVE.has(t.status)).length;
    const deliveryAttention = state.delivery.tasks.filter((t) => DELIVERY_ATTENTION.has(t.status)).length;
    const mfActive = state.mf.jobs.filter((j) => MF_ACTIVE.has(j.status)).length;
    const mfAttention = state.mf.jobs.filter((j) => MF_ATTENTION.has(j.status)).length;
    const collabActive = state.collab.sessions.filter((s) => s.status === 'active').length;

    byId('kpi-active-total').textContent = String(deliveryActive + mfActive + collabActive);
    byId('kpi-active-detail').textContent = 'SW 전달 ' + deliveryActive + ' · 학습 ' + mfActive + ' · 협업 활성 ' + collabActive;

    byId('kpi-attention-total').textContent = String(deliveryAttention + mfAttention);
    byId('kpi-attention-detail').textContent = 'SW 전달 ' + deliveryAttention + ' · Model Factory ' + mfAttention;

    const ledger = state.mf.ledger;
    if (ledger && typeof ledger.globalBudgetCapMicros === 'number') {
      const cap = ledger.globalBudgetCapMicros;
      const settled = ledger.totalSettledMicros;
      const reserved = ledger.totalReservedMicros;
      const remaining = ledger.remainingBudgetMicros;
      const committed = settled + reserved;
      const pct = cap > 0 ? Math.min(100, Math.round((committed / cap) * 1000) / 10) : 0;
      const settledPct = cap > 0 ? Math.min(100, (settled / cap) * 100) : 0;
      const reservedPct = cap > 0 ? Math.min(Math.max(0, 100 - settledPct), (reserved / cap) * 100) : 0;

      byId('kpi-mf-remaining').textContent = formatUsd(remaining);
      byId('kpi-mf-cap-detail').textContent = '중앙 상한 ' + formatUsd(cap) + ' · 사용률 ' + pct.toFixed(1) + '%';
      byId('kpi-mf-committed').textContent = formatUsd(committed);
      byId('kpi-mf-committed-detail').textContent =
        '정산 추정 ' + formatUsd(settled) + ' (' + ledger.settledJobs + '건) · 예약 상한 ' + formatUsd(reserved) + ' (' + ledger.activeReservations + '건)';

      const pill = byId('budget-utilization-pill');
      pill.textContent = '사용률 ' + pct.toFixed(1) + '%';
      pill.className = pct >= 90 ? 'pill tone-danger' : pct >= 75 ? 'pill tone-attention' : 'pill tone-success';

      byId('budget-bar-settled').style.width = settledPct.toFixed(2) + '%';
      byId('budget-bar-reserved').style.width = reservedPct.toFixed(2) + '%';
      byId('legend-settled').textContent = formatUsd(settled);
      byId('legend-reserved').textContent = formatUsd(reserved);
      byId('legend-remaining').textContent = formatUsd(remaining);
      byId('legend-cap').textContent = formatUsd(cap);

      const tbody = byId('monitor-ledger-body');
      tbody.replaceChildren();
      const entries = Array.isArray(ledger.jobs) ? [...ledger.jobs] : [];
      entries.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
      if (!entries.length) {
        const row = el('tr');
        const cell = el('td', '아직 Model Factory 비용 원장 기록이 없습니다.', 'empty-cell');
        cell.colSpan = 7;
        row.append(cell);
        tbody.append(row);
      } else {
        for (const entry of entries) {
          const row = el('tr', undefined, 'clickable-row');
          row.addEventListener('click', () => {
            selectMfJob(entry.jobId);
            switchTab('model-factory');
          });
          row.append(
            el('td', safeText(entry.jobId, 48), 'mono'),
            el('td', safeText(entry.modelId, 64)),
            (() => {
              const td = el('td');
              td.append(el('span', MF_STATUS[entry.status] || safeText(entry.status, 32), pillClass(entry.status)));
              return td;
            })(),
            el('td', safeText(entry.region, 32) + ' · ' + safeText(entry.instanceType, 32)),
            el('td', formatUsd(entry.reservedMicros), 'num mono'),
            el('td', entry.settledMicros === null ? '미정산' : formatUsd(entry.settledMicros), 'num mono'),
            el('td', entry.settledAt ? formatDate(entry.settledAt) : '미정산'),
          );
          tbody.append(row);
        }
      }
    }

    // Subsystem summaries
    const deliveryBudgetSum = state.delivery.tasks.reduce((acc, t) => acc + (typeof t.budgetMicros === 'number' ? t.budgetMicros : 0), 0);
    const prCount = state.delivery.tasks.filter((t) => Boolean(t.publication)).length;
    byId('overview-delivery-budget').textContent =
      '총 ' + state.delivery.tasks.length + '건 · Draft PR ' + prCount + '건 · 승인 예산 합계 ' + formatUsd(deliveryBudgetSum) + ' (모델·Fargate 실청구 미확정)';
    renderStatusBadges(byId('overview-delivery-badges'), countByStatus(state.delivery.tasks), DELIVERY_STATUS);

    const runningInstances = state.mf.jobs.filter((j) => j.instance && ['pending', 'running'].includes(j.instance.state)).length;
    byId('overview-mf-instances').textContent = '총 ' + state.mf.jobs.length + '건 · 실행 중 EC2 스팟 인스턴스 ' + runningInstances + '대';
    renderStatusBadges(byId('overview-mf-badges'), countByStatus(state.mf.jobs), MF_STATUS);

    byId('overview-collab-summary').textContent = '총 ' + state.collab.sessions.length + '개 세션 · 활성 ' + collabActive + '개';
    renderStatusBadges(byId('overview-collab-badges'), countByStatus(state.collab.sessions), COLLAB_STATUS);

    renderSpotAdvisor();
    renderRecentEvents();
  }

  function renderSpotAdvisor() {
    const statusEl = byId('spot-advisor-status');
    const body = byId('spot-advisor-body');
    if (!body) return;
    body.replaceChildren();

    if (state.spotStatusText) {
      statusEl.textContent = state.spotStatusText;
    }

    const decision = state.spotPlacement || state.delivery.tasks.find((t) => t.lastPlacement)?.lastPlacement || null;
    if (!decision) {
      body.append(el('p', '최근 스팟 배치 기록이 없습니다. AWS 오케스트레이터가 연결된 경우 상단 버튼으로 실시간 배치 점수를 조회할 수 있습니다.', 'empty'));
      return;
    }

    const facts = el('dl', undefined, 'repository-facts compact-facts');
    const addFact = (dt, dd) => {
      const wrap = el('div');
      wrap.append(el('dt', dt), el('dd', dd));
      facts.append(wrap);
    };
    addFact('선택 리전 · AZ', safeText(decision.selectedRegion, 32) + (decision.selectedAzId ? ' / ' + safeText(decision.selectedAzId, 32) : ''));
    addFact('워크로드 · 추세', safeText(decision.workloadClass, 40) + ' · ' + safeText(decision.trendDirection, 20));
    addFact(
      '스팟 단가 · 절감률',
      (typeof decision.latestPriceUsd === 'number' ? '$' + decision.latestPriceUsd.toFixed(4) + '/hr' : '미보고') +
        (typeof decision.savingsVsPrimaryPercent === 'number' ? ' (' + decision.savingsVsPrimaryPercent.toFixed(1) + '% 절감)' : ''),
    );
    addFact(
      '배치 점수 (최근 / 평균)',
      (decision.latestScore !== null ? String(decision.latestScore) : '미보고') +
        ' / ' +
        (decision.windowAvgScore !== null ? Number(decision.windowAvgScore).toFixed(1) : '미보고'),
    );
    body.append(facts);
    if (decision.reason) body.append(el('p', safeText(decision.reason, 400), 'help'));
    if (Array.isArray(decision.candidates) && decision.candidates.length) {
      const list = el('ul', undefined, 'diag-list');
      for (const c of decision.candidates.slice(0, 6)) {
        const line =
          safeText(c.region, 24) +
          (c.azId ? ' (' + safeText(c.azId, 24) + ')' : '') +
          ' · 점수 ' +
          (c.latestScore ?? '-') +
          ' · 단가 ' +
          (typeof c.latestPriceUsd === 'number' ? '$' + c.latestPriceUsd.toFixed(4) + '/hr' : '-') +
          (c.eligible ? ' · 적합' : ' · 제외 (' + safeText(c.rejectionReason || '조건 미달', 80) + ')');
        list.append(el('li', line));
      }
      body.append(list);
    }
  }

  function renderRecentEvents() {
    const list = byId('monitor-recent-events');
    if (!list) return;
    const merged = [
      ...state.delivery.events.map((e) => ({ source: 'SW 전달', id: e.taskId, type: e.type, at: e.at, data: e.data })),
      ...state.mf.events.map((e) => ({ source: 'Model Factory', id: e.jobId, type: e.type, at: e.at, data: e.data })),
    ]
      .sort((a, b) => Date.parse(b.at || '') - Date.parse(a.at || ''))
      .slice(0, 25);

    const sig = JSON.stringify(merged.map((e) => [e.source, e.id, e.type, e.at]));
    if (list.dataset.signature === sig) return;
    list.dataset.signature = sig;
    list.replaceChildren();
    if (!merged.length) {
      list.append(el('li', '아직 기록된 AWS 단일 경로 이벤트가 없습니다.', 'empty'));
      return;
    }
    for (const ev of merged) {
      const li = el('li');
      const time = el('time', formatDate(ev.at));
      time.dateTime = safeText(ev.at, 40);
      const body = el('div');
      const titleLine = el('div', undefined, 'event-head');
      titleLine.append(el('span', ev.source, 'pill'), el('strong', safeText(ev.type, 80)), el('span', safeText(ev.id, 48), 'quiet mono'));
      body.append(titleLine);
      if (ev.data && Object.keys(ev.data).length) {
        body.append(el('p', safeText(JSON.stringify(ev.data), 600)));
      }
      li.append(time, body);
      list.append(li);
    }
  }

  // ---------- SW DELIVERY ----------
  function filterDelivery(tasks) {
    if (state.deliveryFilter === 'active') return tasks.filter((t) => DELIVERY_ACTIVE.has(t.status));
    if (state.deliveryFilter === 'attention') return tasks.filter((t) => DELIVERY_ATTENTION.has(t.status));
    if (state.deliveryFilter === 'terminal') return tasks.filter((t) => DELIVERY_TERMINAL.has(t.status));
    return tasks;
  }

  function selectDelivery(id) {
    if (state.busy) return;
    state.selectedDeliveryId = id;
    const task = state.delivery.tasks.find((t) => t.id === id);
    state.selectedDeliveryFingerprint = task?.approvalFingerprint || null;
    if (byId('dlv-reason')) byId('dlv-reason').value = '';
    renderDelivery();
  }

  function renderDelivery() {
    const filtered = filterDelivery(state.delivery.tasks);
    byId('delivery-count-label').textContent = filtered.length + '건 / 전체 ' + state.delivery.tasks.length + '건';

    const list = byId('delivery-list');
    const existing = new Map(Array.from(list.querySelectorAll('button')).map((b) => [b.dataset.taskId, b]));
    list.querySelectorAll('.empty').forEach((n) => n.remove());
    for (const task of filtered) {
      let btn = existing.get(task.id);
      if (!btn) {
        btn = el('button');
        btn.type = 'button';
        btn.dataset.taskId = task.id;
        btn.addEventListener('click', () => selectDelivery(task.id));
        const meta = el('span', undefined, 'task-meta');
        meta.append(el('span'), el('small'));
        btn.append(el('strong'), meta);
        list.append(btn);
      }
      existing.delete(task.id);
      const selected = task.id === state.selectedDeliveryId;
      btn.className = 'task-choice' + (selected ? ' selected' : '');
      btn.setAttribute('aria-pressed', String(selected));
      btn.disabled = state.busy;
      btn.firstChild.textContent = safeText(task.title, 160);
      btn.lastChild.firstChild.className = pillClass(task.status);
      btn.lastChild.firstChild.textContent = DELIVERY_STATUS[task.status] || safeText(task.status, 32);
      btn.lastChild.lastChild.textContent =
        safeText(task.provider, 16) + ' · ' + task.currentIteration + '/' + task.maxIterations + ' · ' + formatUsd(task.budgetMicros);
    }
    existing.forEach((b) => b.remove());
    if (!filtered.length) list.append(el('p', '조건에 맞는 SW 전달 작업이 없습니다.', 'empty'));

    const task = state.delivery.tasks.find((t) => t.id === state.selectedDeliveryId) || null;
    byId('delivery-empty').hidden = Boolean(task);
    byId('delivery-detail').hidden = !task;
    if (!task) return;

    // Guard against approval fingerprint drift while user is reviewing
    if (state.selectedDeliveryFingerprint && state.selectedDeliveryFingerprint !== task.approvalFingerprint) {
      state.selectedDeliveryFingerprint = task.approvalFingerprint;
      byId('dlv-reason').value = '';
      setError('선택한 SW 전달 작업의 승인 지문(approvalFingerprint)이 변경되었습니다. 내용을 다시 검토한 뒤 사유를 입력하세요.');
    }

    byId('dlv-id').textContent = safeText(task.id, 64);
    byId('dlv-title').textContent = safeText(task.title, 200);
    byId('dlv-status').textContent = DELIVERY_STATUS[task.status] || safeText(task.status, 32);
    byId('dlv-status').className = pillClass(task.status);

    const waitEl = byId('dlv-wait-reason');
    waitEl.hidden = !task.waitReason;
    waitEl.textContent = task.waitReason ? '대기 사유: ' + (WAIT_REASON[task.waitReason] || safeText(task.waitReason, 160)) : '';

    byId('dlv-instructions').textContent = safeText(task.instructions, 8000);
    byId('dlv-provider').textContent = safeText(task.provider, 32);
    byId('dlv-iteration').textContent = task.currentIteration + ' / ' + task.maxIterations;
    byId('dlv-budget').textContent = formatUsd(task.budgetMicros) + ' (모델·Fargate 실청구 미확정)';
    byId('dlv-repo').textContent = safeText(task.delivery?.repository, 160) + ' · ' + safeText(task.delivery?.baseBranch, 64);
    byId('dlv-base-commit').textContent = safeText(task.acceptance?.baseCommit, 40);
    byId('dlv-region').textContent = (task.activeRegion ? safeText(task.activeRegion, 32) : '미배정') + ' · 스팟 재시도 ' + task.spotRetriesUsed + '/' + (task.spot?.maxSpotRetries ?? 0);
    byId('dlv-worker').textContent = (task.activeWorkerId ? safeText(task.activeWorkerId, 80) : '없음') + (task.activeRunId ? ' (' + safeText(task.activeRunId, 48) + ')' : '');
    byId('dlv-ecs-arn').textContent = task.activeEcsTaskArn ? safeText(task.activeEcsTaskArn, 200) : '기록 없음';
    byId('dlv-updated').textContent = formatDate(task.updatedAt);

    const outcome = byId('dlv-outcome-banner');
    if (task.failureReason) {
      outcome.textContent = '실패 사유: ' + safeText(task.failureReason, 500);
      outcome.hidden = false;
    } else if (task.cancelReason) {
      outcome.textContent = '중단 사유: ' + safeText(task.cancelReason, 500);
      outcome.hidden = false;
    } else if (task.humanDecision) {
      outcome.textContent =
        '사람 검토 결정: ' +
        (task.humanDecision.decision === 'approve' ? '승인' : '반려') +
        ' · diff 열람 ' +
        (task.humanDecision.openedDiff ? '예' : '아니오') +
        ' · ' +
        task.humanDecision.durationMinutes +
        '분 · ' +
        safeText(task.humanDecision.reason, 400);
      outcome.hidden = false;
    } else {
      outcome.hidden = true;
    }

    // Safe operator controls
    const isTerminal = DELIVERY_TERMINAL.has(task.status);
    byId('dlv-action-section').hidden = isTerminal;
    if (!isTerminal) {
      const awaitingApproval = task.status === 'awaiting_approval';
      const awaitingHuman = task.status === 'draft_pr_published';
      byId('dlv-action-title').textContent = awaitingApproval
        ? '실행 승인이 필요합니다'
        : awaitingHuman
          ? 'Draft PR 결과를 검토해 주세요'
          : '작업을 감독하고 있습니다';
      byId('dlv-action-desc').textContent = awaitingApproval
        ? '승인하면 AWS Fargate Spot 워커가 기동되어 실제 모델 호출 및 독립 검증을 수행합니다.'
        : awaitingHuman
          ? '검증 증명과 변경 요약을 확인한 뒤 승인·반려를 기록하세요. 이 기록은 Git 병합·푸시를 실행하지 않습니다.'
          : '필요 시 사유를 입력해 작업을 중단하고 실행 중인 ECS 작업을 중지할 수 있습니다.';
      const fpRow = byId('dlv-fingerprint-row');
      fpRow.hidden = !awaitingApproval;
      fpRow.textContent = awaitingApproval ? '승인 지문 (approvalFingerprint): ' + safeText(task.approvalFingerprint, 64) : '';
      byId('dlv-human-fields').hidden = !awaitingHuman;
      byId('dlv-btn-approve').hidden = !awaitingApproval;
      byId('dlv-btn-human-approve').hidden = !awaitingHuman;
      byId('dlv-btn-human-reject').hidden = !awaitingHuman;
      byId('dlv-btn-cancel').hidden = false;
      for (const b of byId('dlv-action-form').querySelectorAll('button')) b.disabled = state.busy;
    }

    // Attestation & Draft PR
    byId('dlv-test-cmd').textContent = task.acceptance?.testCommand ? safeText(JSON.stringify(task.acceptance.testCommand), 400) : '미보고';
    byId('dlv-acceptance-digest').textContent = safeText(task.acceptance?.digest, 64) || '미보고';
    const att = task.latestAttestation;
    byId('dlv-attest-status').textContent = att
      ? (att.checksPassed ? '통과' : '실패') +
        ' · 수용 테스트 무수정 ' +
        (att.acceptancePathsUnmodified ? '확인' : '위반') +
        ' · 종료 코드 ' +
        (att.exitCode === null ? '없음' : att.exitCode) +
        ' · ' +
        (att.durationMs / 1000).toFixed(2) +
        '초'
      : '아직 보고되지 않음';
    byId('dlv-verified-hash').textContent = att ? safeText(att.verifiedTreeHash, 40) : '미보고';
    byId('dlv-attest-summary').textContent = att ? safeText(att.summary, 2000) : '아직 보고된 검증 요약이 없습니다.';

    const pub = task.publication;
    const hashPill = byId('dlv-hash-match');
    const prLink = byId('dlv-pr-link');
    prLink.replaceChildren();
    if (pub) {
      const matched = att && pub.prTreeHash === att.verifiedTreeHash && pub.verifiedTreeHash === att.verifiedTreeHash;
      hashPill.textContent = matched ? '트리 해시 3자 일치' : '트리 해시 확인 필요';
      hashPill.className = matched ? 'pill tone-success' : 'pill tone-danger';
      prLink.append(safeHttpsLink(pub.prUrl, 'PR #' + pub.prNumber + ' · ' + pub.branchName + ' (' + pub.prUrl + ')'));
      byId('dlv-pr-hash').textContent = safeText(pub.prTreeHash, 40);
      const cs = pub.changeSummary;
      byId('dlv-change-summary').textContent = cs
        ? cs.totalFiles + '개 파일 · +' + cs.totalInsertions + ' / -' + cs.totalDeletions + (cs.workerSummary ? ' — ' + safeText(cs.workerSummary, 400) : '')
        : '변경 요약 미포함';
      const filesBox = byId('dlv-changed-files');
      filesBox.replaceChildren();
      if (cs && Array.isArray(cs.files) && cs.files.length) {
        const ul = el('ul', undefined, 'diag-list');
        for (const f of cs.files.slice(0, 30)) {
          ul.append(
            el(
              'li',
              safeText(f.path, 200) + (f.binary ? ' (binary)' : ' (+' + (f.insertions ?? 0) + ' / -' + (f.deletions ?? 0) + ')'),
              'mono',
            ),
          );
        }
        filesBox.append(ul);
      }
    } else {
      hashPill.textContent = att?.checksPassed ? '검증 통과 · PR 대기' : '미게시';
      hashPill.className = att?.checksPassed ? 'pill tone-running' : 'pill';
      prLink.append(el('span', '아직 게시된 Draft PR이 없습니다.', 'quiet'));
      byId('dlv-pr-hash').textContent = '미게시';
      byId('dlv-change-summary').textContent = task.latestWorkerSummary ? safeText(task.latestWorkerSummary, 400) : '없음';
      byId('dlv-changed-files').replaceChildren();
    }

    // Spot placement & preflight
    const lp = task.lastPlacement;
    byId('dlv-place-region').textContent = lp ? safeText(lp.selectedRegion, 32) + (lp.selectedAzId ? ' / ' + safeText(lp.selectedAzId, 32) : '') : '미배치';
    byId('dlv-place-metrics').textContent = lp
      ? (typeof lp.latestPriceUsd === 'number' ? '$' + lp.latestPriceUsd.toFixed(4) + '/hr' : '단가 미보고') +
        ' · 점수 ' +
        (lp.latestScore ?? '-') +
        (typeof lp.savingsVsPrimaryPercent === 'number' ? ' · 절감 ' + lp.savingsVsPrimaryPercent.toFixed(1) + '%' : '')
      : '없음';
    byId('dlv-place-reason').textContent = lp ? safeText(lp.reason, 400) : '배치 기록 없음';
    const pf = task.lastPreflight;
    byId('dlv-preflight').textContent = pf
      ? (pf.ok ? '통과' : '실패') +
        ' · CLI ' +
        (pf.cliVersion ? safeText(pf.cliVersion, 64) : '미보고') +
        ' · auth ' +
        (pf.authReady ? 'OK' : '미준비') +
        ' · git ' +
        (pf.gitReady ? 'OK' : '미준비') +
        (pf.reason ? ' · ' + safeText(pf.reason, 200) : '')
      : '프리플라이트 기록 없음';

    // Task events
    const taskEvents = state.delivery.events.filter((e) => e.taskId === task.id).sort((a, b) => b.sequence - a.sequence);
    renderEntityEvents(byId('dlv-events'), taskEvents);
  }

  // ---------- MODEL FACTORY ----------
  function filterMf(jobs) {
    if (state.mfFilter === 'active') return jobs.filter((j) => MF_ACTIVE.has(j.status));
    if (state.mfFilter === 'attention') return jobs.filter((j) => MF_ATTENTION.has(j.status));
    if (state.mfFilter === 'terminal') return jobs.filter((j) => MF_TERMINAL.has(j.status));
    return jobs;
  }

  function selectMfJob(id) {
    if (state.busy) return;
    state.selectedMfId = id;
    const job = state.mf.jobs.find((j) => j.id === id);
    state.selectedMfFingerprint = job?.approvalFingerprint || null;
    if (byId('mf-reason')) byId('mf-reason').value = '';
    renderModelFactory();
  }

  function renderModelFactory() {
    const ledger = state.mf.ledger;
    if (byId('mf-inline-budget')) {
      byId('mf-inline-budget').textContent = ledger
        ? '잔여 ' + formatUsd(ledger.remainingBudgetMicros) + ' / 상한 ' + formatUsd(ledger.globalBudgetCapMicros)
        : '예산 확인 중';
    }

    const filtered = filterMf(state.mf.jobs);
    const list = byId('mf-list');
    const existing = new Map(Array.from(list.querySelectorAll('button')).map((b) => [b.dataset.jobId, b]));
    list.querySelectorAll('.empty').forEach((n) => n.remove());
    for (const job of filtered) {
      let btn = existing.get(job.id);
      if (!btn) {
        btn = el('button');
        btn.type = 'button';
        btn.dataset.jobId = job.id;
        btn.addEventListener('click', () => selectMfJob(job.id));
        const meta = el('span', undefined, 'task-meta');
        meta.append(el('span'), el('small'));
        btn.append(el('strong'), meta);
        list.append(btn);
      }
      existing.delete(job.id);
      const selected = job.id === state.selectedMfId;
      btn.className = 'task-choice' + (selected ? ' selected' : '');
      btn.setAttribute('aria-pressed', String(selected));
      btn.disabled = state.busy;
      btn.firstChild.textContent = safeText(job.title, 160);
      btn.lastChild.firstChild.className = pillClass(job.status);
      btn.lastChild.firstChild.textContent = MF_STATUS[job.status] || safeText(job.status, 32);
      const costText =
        job.cost?.settledMicros !== null && job.cost?.settledMicros !== undefined
          ? '정산 ' + formatUsd(job.cost.settledMicros)
          : '예약 ' + formatUsd(job.cost?.reservedMicros);
      btn.lastChild.lastChild.textContent = safeText(job.compute?.instanceType, 24) + ' · ' + costText;
    }
    existing.forEach((b) => b.remove());
    if (!filtered.length) list.append(el('p', '조건에 맞는 Model Factory 작업이 없습니다.', 'empty'));

    const job = state.mf.jobs.find((j) => j.id === state.selectedMfId) || null;
    byId('mf-empty').hidden = Boolean(job);
    byId('mf-detail').hidden = !job;
    if (!job) return;

    if (state.selectedMfFingerprint && state.selectedMfFingerprint !== job.approvalFingerprint) {
      state.selectedMfFingerprint = job.approvalFingerprint;
      byId('mf-reason').value = '';
      setError('선택한 Model Factory 작업의 승인 지문(approvalFingerprint)이 변경되었습니다. 범위를 다시 검토하세요.');
    }

    byId('mf-id').textContent = safeText(job.id, 64);
    byId('mf-title').textContent = safeText(job.title, 200);
    byId('mf-status').textContent = MF_STATUS[job.status] || safeText(job.status, 32);
    byId('mf-status').className = pillClass(job.status);

    const waitEl = byId('mf-wait-reason');
    waitEl.hidden = !job.waitReason;
    waitEl.textContent = job.waitReason ? '대기 사유: ' + (WAIT_REASON[job.waitReason] || safeText(job.waitReason, 160)) : '';

    byId('mf-model-id').textContent = safeText(job.modelId, 120);
    byId('mf-repo').textContent = safeText(job.repository, 160) + ' @ ' + safeText(job.baseCommit, 12);
    byId('mf-compute').textContent = safeText(job.compute?.instanceType, 40) + ' · ' + safeText(job.compute?.region, 32);
    byId('mf-reserved').textContent = formatUsd(job.cost?.reservedMicros);
    byId('mf-settled').textContent =
      job.cost?.settledMicros === null || job.cost?.settledMicros === undefined
        ? '미정산 (실행 종료 후 정산)'
        : formatUsd(job.cost.settledMicros) + (job.cost.settledAt ? ' · ' + formatDate(job.cost.settledAt) : '');
    byId('mf-rate').textContent =
      '$' +
      Number(job.cost?.hourlyRateUsd ?? job.compute?.maxHourlyPriceUsd ?? 0).toFixed(4) +
      '/hr · ' +
      formatDurationSec(job.cost?.instanceSeconds);
    byId('mf-release-policy').textContent =
      safeText(job.releasePolicy?.mode, 32) +
      ' · ' +
      safeText(job.releasePolicy?.visibility, 16) +
      (job.releasePolicy?.hfRepository ? ' · ' + safeText(job.releasePolicy.hfRepository, 120) : '');
    byId('mf-next-wake').textContent = job.nextWakeAt ? formatDate(job.nextWakeAt) : '예정 없음';
    byId('mf-updated').textContent = formatDate(job.updatedAt);

    const outcome = byId('mf-outcome-banner');
    if (job.failureReason) {
      outcome.textContent = '실패 사유: ' + safeText(job.failureReason, 500);
      outcome.hidden = false;
    } else if (job.cancelReason) {
      outcome.textContent = '중단 사유: ' + safeText(job.cancelReason, 500);
      outcome.hidden = false;
    } else if (job.releaseDecision) {
      outcome.textContent =
        '공개 결정: ' +
        (job.releaseDecision.decision === 'approve' ? '승인' : '반려') +
        ' · 원본 열람 ' +
        (job.releaseDecision.openedRawArtifacts ? '예' : '아니오') +
        ' · ' +
        safeText(job.releaseDecision.reason, 400);
      outcome.hidden = false;
    } else {
      outcome.hidden = true;
    }

    // Safe controls
    const isTerminal = MF_TERMINAL.has(job.status);
    byId('mf-action-section').hidden = isTerminal;
    if (!isTerminal) {
      const awaitingTrain = job.status === 'awaiting_training_approval';
      const runningTrain = job.status === 'training_running';
      const evaluating = job.status === 'evaluating';
      const awaitingRelease = job.status === 'awaiting_release_approval';

      byId('mf-action-title').textContent = awaitingTrain
        ? '학습 승인이 필요합니다'
        : awaitingRelease
          ? '산출물 공개 승인이 필요합니다'
          : evaluating
            ? '산출물 검증 단계입니다'
            : '학습 작업을 감독하고 있습니다';
      byId('mf-action-desc').textContent = awaitingTrain
        ? '승인하면 중앙 예산에서 예약 상한을 확보하고 EC2 스팟 인스턴스를 기동합니다.'
        : awaitingRelease
          ? job.releasePolicy?.mode === 'hf_release' && job.releasePolicy?.visibility === 'public'
            ? '주의: 공개(public) Hugging Face 저장소로 산출물이 게시됩니다. 검증 근거와 다이제스트를 확인한 뒤 승인하세요.'
            : '검증 근거와 다이제스트를 확인한 뒤 공개 승인 또는 반려를 결정하세요.'
          : evaluating
            ? '독립 검증기를 기동해 S3 산출물과 승인된 releaseCheckCommand를 검증할 수 있습니다.'
            : '인스턴스 상태를 확인(Wake)하거나 사유를 적어 작업을 중단하고 인스턴스를 종료할 수 있습니다.';

      const fpRow = byId('mf-fingerprint-row');
      fpRow.hidden = !awaitingTrain;
      fpRow.textContent = awaitingTrain ? '승인 지문 (approvalFingerprint): ' + safeText(job.approvalFingerprint, 64) : '';

      byId('mf-quick-actions').hidden = !runningTrain && !evaluating;
      byId('mf-btn-wake').hidden = !runningTrain;
      byId('mf-btn-wake').disabled = state.busy;
      byId('mf-btn-verifier').hidden = !evaluating || !job.receipt;
      byId('mf-btn-verifier').disabled = state.busy;

      byId('mf-release-fields').hidden = !awaitingRelease;
      byId('mf-btn-approve-training').hidden = !awaitingTrain;
      byId('mf-btn-approve-release').hidden = !awaitingRelease;
      byId('mf-btn-reject-release').hidden = !awaitingRelease;
      byId('mf-btn-cancel').hidden = false;
      for (const b of byId('mf-action-form').querySelectorAll('button')) b.disabled = state.busy;
    }

    // EC2 Spot Instance state
    const inst = job.instance;
    const instPill = byId('mf-instance-state');
    if (inst) {
      instPill.textContent = EC2_STATE[inst.state] || safeText(inst.state, 24);
      instPill.className = inst.state === 'running' ? 'pill tone-running' : inst.state === 'terminated' ? 'pill' : 'pill tone-attention';
      byId('mf-inst-id').textContent = safeText(inst.instanceId, 40) + ' (' + safeText(inst.instanceType, 32) + ')';
      byId('mf-inst-az').textContent = safeText(inst.region, 32) + (inst.availabilityZone ? ' / ' + safeText(inst.availabilityZone, 32) : '');
      byId('mf-inst-launched').textContent = formatDate(inst.launchedAt);
      byId('mf-inst-expires').textContent = formatTtl(inst.expiresAt);
      byId('mf-inst-terminated').textContent = inst.terminatedAt ? formatDate(inst.terminatedAt) : '실행 중 또는 미종료';
      byId('mf-inst-forced').textContent = inst.forcedTerminationReason ? safeText(inst.forcedTerminationReason, 240) : '없음';
    } else {
      instPill.textContent = '미기동';
      instPill.className = 'pill';
      byId('mf-inst-id').textContent = '기동된 인스턴스 없음';
      byId('mf-inst-az').textContent = '미배정';
      byId('mf-inst-launched').textContent = '-';
      byId('mf-inst-expires').textContent = '-';
      byId('mf-inst-terminated').textContent = '-';
      byId('mf-inst-forced').textContent = '없음';
    }

    const diagBlock = byId('mf-diagnostics-block');
    const diagList = byId('mf-diagnostics-list');
    diagList.replaceChildren();
    if (Array.isArray(job.diagnostics) && job.diagnostics.length) {
      diagBlock.hidden = false;
      for (const d of job.diagnostics) diagList.append(el('li', safeText(d, 500)));
    } else {
      diagBlock.hidden = true;
    }

    // Placement plan
    const plan = job.placementPlan;
    const planPill = byId('mf-plan-status');
    const planRegions = byId('mf-plan-regions');
    planRegions.replaceChildren();
    if (plan) {
      planPill.textContent = safeText(plan.status, 32);
      planPill.className = plan.status === 'ranked' ? 'pill tone-success' : 'pill tone-attention';
      byId('mf-plan-note').textContent =
        safeText(plan.note, 300) +
        (plan.feedPool ? ' · 피드 풀 ' + safeText(plan.feedPool, 40) : '') +
        (plan.feedGeneratedAt ? ' · 기준 ' + formatDate(plan.feedGeneratedAt) : '');
      if (Array.isArray(plan.regions) && plan.regions.length) {
        const ul = el('ul', undefined, 'diag-list');
        for (const r of plan.regions) {
          const azText = Array.isArray(r.azs) && r.azs.length ? r.azs.map((a) => safeText(a.azId, 24) + '(' + a.trend.latest + ')').join(', ') : 'AZ 정보 없음';
          ul.append(
            el(
              'li',
              safeText(r.region, 24) +
                ' · 점수 ' +
                (r.trend ? r.trend.latest + ' (평균 ' + r.trend.avg.toFixed(1) + ')' : '미보고') +
                ' · 단가 ' +
                (typeof r.priceUsd === 'number' ? '$' + r.priceUsd.toFixed(4) + '/hr' : '미보고') +
                ' · AZ 순서: ' +
                azText,
            ),
          );
        }
        planRegions.append(ul);
      }
    } else {
      planPill.textContent = '미생성';
      planPill.className = 'pill';
      byId('mf-plan-note').textContent = '배치 계획 기록이 없습니다.';
    }

    // Receipt, Attestation & Publication
    const receipt = job.receipt;
    byId('mf-receipt-path').textContent = receipt ? 's3://' + safeText(receipt.s3Bucket, 128) + '/' + safeText(receipt.s3Prefix, 300) : '아직 영수증이 기록되지 않았습니다.';
    byId('mf-receipt-digest').textContent = receipt ? safeText(receipt.manifestDigest, 64) : '미보고';
    byId('mf-receipt-files').textContent = receipt
      ? receipt.files.length + '개 (' + formatBytes(receipt.files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0)) + ')'
      : '0개';
    byId('mf-verifier-info').textContent = job.releaseVerifier
      ? safeText(job.releaseVerifier.ecsTaskArn, 180) + ' · ' + formatDate(job.releaseVerifier.dispatchedAt)
      : '미기동';

    const att = job.releaseAttestation;
    const attPill = byId('mf-attest-source');
    const attDisc = byId('mf-attest-disclaimer');
    if (att) {
      const independent = att.attestationSource === 'independent_verifier';
      attPill.textContent = independent ? '독립 검증기 증명' : '운영자 직접 보고 (비독립)';
      attPill.className = independent ? 'pill tone-success' : 'pill tone-attention';
      attDisc.hidden = !att.verificationDisclaimer;
      attDisc.textContent = att.verificationDisclaimer ? safeText(att.verificationDisclaimer, 400) : '';
      byId('mf-attest-result').textContent = (att.releaseCheckPassed ? '통과' : '실패') + ' · ' + formatDate(att.verifiedAt);
      const metricsStr = att.metrics && Object.keys(att.metrics).length ? JSON.stringify(att.metrics) + '\n' : '';
      byId('mf-attest-summary').textContent = safeText(metricsStr + att.summary, 2000);
    } else {
      attPill.textContent = '미검증';
      attPill.className = 'pill';
      attDisc.hidden = true;
      byId('mf-attest-result').textContent = '아직 검증 결과가 없습니다.';
      byId('mf-attest-summary').textContent = '없음';
    }

    const pubInfo = byId('mf-pub-info');
    pubInfo.replaceChildren();
    if (job.publication) {
      const p = job.publication;
      pubInfo.append(el('span', safeText(p.mode, 32) + (p.repository ? ' · ' + safeText(p.repository, 120) : '') + (p.commitSha ? ' @ ' + safeText(p.commitSha, 16) : '') + ' · '));
      if (p.url) pubInfo.append(safeHttpsLink(p.url, p.url));
      else pubInfo.append(el('span', formatDate(p.publishedAt), 'quiet'));
    } else {
      pubInfo.append(el('span', '아직 공개되지 않았습니다.', 'quiet'));
    }

    const jobEvents = state.mf.events.filter((e) => e.jobId === job.id).sort((a, b) => b.sequence - a.sequence);
    renderEntityEvents(byId('mf-events'), jobEvents);
  }

  // ---------- COLLAB SESSIONS ----------
  async function selectCollab(id) {
    if (state.busy) return;
    const epoch = ++state.collab.epoch;
    state.collab.selectedId = id;
    state.collab.snapshot = null;
    renderCollab();
    try {
      const snapshot = await monitorApi('/api/collab/sessions/' + encodeURIComponent(id));
      if (epoch === state.collab.epoch && state.collab.selectedId === id) {
        state.collab.snapshot = snapshot;
        renderCollab();
      }
    } catch (err) {
      if (epoch === state.collab.epoch) setError('협업 세션 상세 조회 실패: ' + err.message);
    }
  }

  function renderCollab() {
    byId('collab-count-label').textContent = state.collab.sessions.length + '개 세션';
    const list = byId('collab-list');
    const existing = new Map(Array.from(list.querySelectorAll('button')).map((b) => [b.dataset.sessionId, b]));
    list.querySelectorAll('.empty').forEach((n) => n.remove());
    for (const s of state.collab.sessions) {
      let btn = existing.get(s.id);
      if (!btn) {
        btn = el('button');
        btn.type = 'button';
        btn.dataset.sessionId = s.id;
        btn.addEventListener('click', () => {
          void selectCollab(s.id);
        });
        const meta = el('span', undefined, 'task-meta');
        meta.append(el('span'), el('small'));
        btn.append(el('strong'), meta);
        list.append(btn);
      }
      existing.delete(s.id);
      const selected = s.id === state.collab.selectedId;
      btn.className = 'task-choice' + (selected ? ' selected' : '');
      btn.setAttribute('aria-pressed', String(selected));
      btn.disabled = state.busy;
      btn.firstChild.textContent = safeText(s.title, 160);
      btn.lastChild.firstChild.className = pillClass(s.status);
      btn.lastChild.firstChild.textContent = COLLAB_STATUS[s.status] || safeText(s.status, 24);
      btn.lastChild.lastChild.textContent = safeText(s.provider, 16) + ' · 최대 ' + s.maxParallelWorkers + '워커';
    }
    existing.forEach((b) => b.remove());
    if (!state.collab.sessions.length) list.append(el('p', '등록된 협업 세션이 없습니다.', 'empty'));

    const session = state.collab.snapshot?.session || state.collab.sessions.find((s) => s.id === state.collab.selectedId) || null;
    byId('collab-empty').hidden = Boolean(session);
    byId('collab-detail').hidden = !session;
    if (!session) return;

    byId('clb-id').textContent = safeText(session.id, 64);
    byId('clb-title').textContent = safeText(session.title, 200);
    byId('clb-status').textContent = COLLAB_STATUS[session.status] || safeText(session.status, 24);
    byId('clb-status').className = pillClass(session.status);
    byId('clb-goal').textContent = safeText(session.goal, 4000);
    byId('clb-provider').textContent = safeText(session.provider, 24);
    byId('clb-parallel').textContent = String(session.maxParallelWorkers) + '대';
    byId('clb-regions').textContent = Array.isArray(session.allowedRegions) && session.allowedRegions.length ? session.allowedRegions.map((r) => safeText(r, 24)).join(', ') : '기본 리전';
    byId('clb-repo').textContent = session.repository ? safeText(session.repository, 160) + (session.baseCommit ? ' @ ' + safeText(session.baseCommit, 12) : '') : '지정 없음';
    const orch = session.latestOrchestratorRun;
    byId('clb-orch').textContent = orch
      ? safeText(orch.status, 24) + ' · ' + safeText(orch.provider, 16) + (orch.model ? ' (' + safeText(orch.model, 48) + ')' : '')
      : '실행 기록 없음';
    byId('clb-updated').textContent = formatDate(session.updatedAt);

    const active = session.status === 'active';
    byId('clb-btn-reconcile').disabled = state.busy;
    byId('clb-btn-complete').hidden = !active;
    byId('clb-btn-complete').disabled = state.busy;
    byId('clb-btn-cancel').hidden = !active;
    byId('clb-btn-cancel').disabled = state.busy;
    byId('clb-msg-submit').disabled = state.busy;

    const snap = state.collab.snapshot;
    const subtasksBox = byId('clb-subtasks');
    subtasksBox.replaceChildren();
    if (!snap) {
      byId('clb-subtask-summary').textContent = '불러오는 중…';
      subtasksBox.append(el('p', '하위 작업 정보를 불러오는 중입니다.', 'empty'));
      return;
    }

    const subtasks = Array.isArray(snap.subtasks) ? snap.subtasks : [];
    const runningSub = subtasks.filter((st) => st.status === 'running').length;
    const doneSub = subtasks.filter((st) => st.status === 'completed').length;
    byId('clb-subtask-summary').textContent = '전체 ' + subtasks.length + '건 · 실행 중 ' + runningSub + ' · 완료 ' + doneSub;
    if (!subtasks.length) {
      subtasksBox.append(el('p', '등록된 하위 작업이 없습니다.', 'empty'));
    } else {
      for (const st of subtasks) {
        const card = el('div', undefined, 'subtask-card');
        const head = el('div', undefined, 'subtask-head');
        head.append(el('strong', safeText(st.title, 160)), el('span', SUBTASK_STATUS[st.status] || safeText(st.status, 24), pillClass(st.status)));
        const meta = el(
          'p',
          'ID ' +
            safeText(st.id, 48) +
            ' · 제공자 ' +
            safeText(st.provider, 16) +
            ' · 에이전트 ' +
            (st.assignedAgentId ? safeText(st.assignedAgentId, 48) : '미배정') +
            ' · 리전 ' +
            (st.region ? safeText(st.region, 24) : '-'),
          'help',
        );
        card.append(head, meta);
        if (st.ecsTaskArn) card.append(el('p', 'ECS: ' + safeText(st.ecsTaskArn, 180), 'help mono'));
        if (st.resultSummary) card.append(el('p', '결과: ' + safeText(st.resultSummary, 500)));
        if (st.failureReason) card.append(el('p', '실패: ' + safeText(st.failureReason, 500), 'evidence-warning'));
        subtasksBox.append(card);
      }
    }

    const messages = Array.isArray(snap.messages) ? [...snap.messages].reverse() : [];
    byId('clb-message-count').textContent = messages.length + '건';
    const msgList = byId('clb-messages');
    msgList.replaceChildren();
    if (!messages.length) {
      msgList.append(el('li', '아직 공유 게시판 메시지가 없습니다.', 'empty'));
    } else {
      for (const m of messages) {
        const li = el('li');
        const time = el('time', '#' + m.seq + ' · ' + formatDate(m.createdAt));
        const content = el('div');
        const head = el('div', undefined, 'event-head');
        head.append(
          el('span', safeText(m.kind, 24), 'pill'),
          el('strong', safeText(m.sender, 48) + (m.recipient ? ' → ' + safeText(m.recipient, 48) : ' → 전체')),
        );
        content.append(head, el('p', safeText(m.body, 2000)));
        li.append(time, content);
        msgList.append(li);
      }
    }

    const logs = Array.isArray(snap.workLogs) ? [...snap.workLogs].reverse() : [];
    byId('clb-worklog-count').textContent = logs.length + '건';
    const logList = byId('clb-worklogs');
    logList.replaceChildren();
    if (!logs.length) {
      logList.append(el('li', '아직 기록된 작업 로그가 없습니다.', 'empty'));
    } else {
      for (const w of logs) {
        const li = el('li');
        const time = el('time', formatDate(w.createdAt));
        const content = el('div');
        const head = el('div', undefined, 'event-head');
        head.append(el('span', safeText(w.kind, 24), 'pill'), el('strong', safeText(w.agentId, 48)));
        content.append(head, el('p', safeText(w.summary, 1000) + (w.s3Uri ? '\n' + safeText(w.s3Uri, 240) : '')));
        li.append(time, content);
        logList.append(li);
      }
    }
  }

  function renderEntityEvents(listEl, events) {
    if (!listEl) return;
    const sig = JSON.stringify(events.map((e) => [e.sequence, e.type, e.at]));
    if (listEl.dataset.signature === sig) return;
    listEl.dataset.signature = sig;
    listEl.replaceChildren();
    if (!events.length) {
      listEl.append(el('li', '표시할 이벤트가 없습니다.', 'empty'));
      return;
    }
    for (const ev of events) {
      const li = el('li');
      const time = el('time', formatDate(ev.at));
      time.dateTime = safeText(ev.at, 40);
      const body = el('div');
      body.append(el('strong', safeText(ev.type, 80)));
      if (ev.data && Object.keys(ev.data).length) {
        body.append(el('p', safeText(JSON.stringify(ev.data, null, 2), 1200)));
      }
      li.append(time, body);
      listEl.append(li);
    }
  }

  function renderAll() {
    renderHeader();
    renderOverview();
    renderDelivery();
    renderModelFactory();
    renderCollab();
  }

  function updateConnectionIndicator(ok) {
    const conn = byId('connection-status');
    const sync = byId('last-sync');
    if (conn) {
      conn.textContent = ok ? '관제 연결됨' : '연결 확인 필요';
      conn.style.color = ok ? 'var(--green)' : 'var(--danger)';
    }
    if (sync && ok) {
      sync.textContent = '동기화 ' + new Date().toLocaleTimeString('ko-KR');
    }
  }

  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      let firstError = null;
      let usedSnapshot = false;
      try {
        const snap = await monitorApi('/api/monitor/snapshot', undefined, 20000);
        if (snap && snap.health && snap.delivery && snap.modelFactory && snap.collab) {
          usedSnapshot = true;
          state.health = snap.health;
          state.delivery = {
            storageBackend: snap.delivery.storageBackend ?? null,
            tasks: Array.isArray(snap.delivery.tasks) ? snap.delivery.tasks : [],
            events: Array.isArray(snap.delivery.events) ? snap.delivery.events : [],
          };
          state.mf.storageBackend = snap.modelFactory.storageBackend ?? null;
          state.mf.jobs = Array.isArray(snap.modelFactory.jobs) ? snap.modelFactory.jobs : [];
          state.mf.events = Array.isArray(snap.modelFactory.events) ? snap.modelFactory.events : [];
          state.mf.ledger = snap.modelFactory.ledger ?? null;
          state.collab.storageBackend = snap.collab.storageBackend ?? null;
          state.collab.sessions = Array.isArray(snap.collab.sessions) ? snap.collab.sessions : [];
        }
      } catch (err) {
        if (err.status !== 404) {
          firstError = err;
          usedSnapshot = true;
          if (err.status === 401) {
            const access = byId('connection-access');
            if (access) access.open = true;
            try {
              state.health = await monitorApi('/health', undefined, 8000);
            } catch {
              state.health = null;
            }
          } else {
            state.health = null;
          }
        }
      }

      if (!usedSnapshot) {
        // Fallback for older Control Plane versions without /api/monitor/snapshot (sequential to stay SSM-friendly).
        try {
          state.health = await monitorApi('/health', undefined, 10000);
        } catch {
          state.health = null;
        }
        for (const [path, apply] of [
          [
            '/api/delivery/tasks',
            (v) => {
              state.delivery = {
                storageBackend: v.storageBackend ?? null,
                tasks: Array.isArray(v.tasks) ? v.tasks : [],
                events: Array.isArray(v.events) ? v.events : [],
              };
            },
          ],
          [
            '/api/model-factory/jobs',
            (v) => {
              state.mf.storageBackend = v.storageBackend ?? null;
              state.mf.jobs = Array.isArray(v.jobs) ? v.jobs : [];
              state.mf.events = Array.isArray(v.events) ? v.events : [];
            },
          ],
          [
            '/api/model-factory/ledger',
            (v) => {
              state.mf.ledger = v;
            },
          ],
          [
            '/api/collab/sessions',
            (v) => {
              state.collab.storageBackend = v.storageBackend ?? null;
              state.collab.sessions = Array.isArray(v.sessions) ? v.sessions : [];
            },
          ],
        ]) {
          try {
            apply(await monitorApi(path, undefined, 15000));
          } catch (err) {
            firstError = firstError || err;
            if (err.status === 401) {
              const access = byId('connection-access');
              if (access) access.open = true;
              break;
            }
          }
        }
      }

      if (!firstError && state.collab.selectedId && state.activeTab === 'collab') {
        const id = state.collab.selectedId;
        const epoch = state.collab.epoch;
        try {
          const snap = await monitorApi('/api/collab/sessions/' + encodeURIComponent(id), undefined, 15000);
          if (epoch === state.collab.epoch && state.collab.selectedId === id) state.collab.snapshot = snap;
        } catch {
          // Keep last snapshot on transient poll failure.
        }
      }

      if (firstError) {
        updateConnectionIndicator(false);
        setError('모니터링 동기화 오류: ' + firstError.message);
      } else {
        updateConnectionIndicator(true);
        if (state.error && state.error.startsWith('모니터링 동기화 오류:')) {
          setError(null);
        }
      }

      renderAll();
    } finally {
      state.refreshing = false;
    }
  }

  async function querySpotPlacement() {
    if (state.spotChecking) return;
    state.spotChecking = true;
    const btn = byId('spot-check-button');
    if (btn) btn.disabled = true;
    state.spotStatusText = '스팟 배치 점수를 조회하고 있습니다…';
    renderSpotAdvisor();
    try {
      state.spotPlacement = await monitorApi('/api/delivery/spot-placement', undefined, 25000);
      state.spotStatusText = '실시간 스팟 배치 점수를 조회했습니다 (' + formatDate(state.spotPlacement.decidedAt) + ').';
    } catch (err) {
      state.spotStatusText =
        err.status === 503
          ? '로컬 모의 모드에서는 AWS 스팟 배치 조회를 사용할 수 없습니다 (503).'
          : '스팟 배치 조회 실패: ' + safeText(err.message, 200);
    } finally {
      state.spotChecking = false;
      if (btn) btn.disabled = false;
      renderSpotAdvisor();
    }
  }

  async function runMutation(action, successMessage) {
    if (state.busy) return;
    state.busy = true;
    setError(null);
    setNotice(null);
    renderAll();
    try {
      const result = await action();
      if (typeof successMessage === 'function') setNotice(successMessage(result));
      else if (successMessage) setNotice(successMessage);
      await refresh();
    } catch (err) {
      setError('요청 처리 실패: ' + err.message);
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  // ---------- EVENT WIRING ----------
  for (const name of ['overview', 'delivery', 'model-factory', 'collab', 'legacy']) {
    byId('tab-' + name)?.addEventListener('click', () => switchTab(name));
  }
  byId('jump-delivery')?.addEventListener('click', () => switchTab('delivery'));
  byId('jump-mf')?.addEventListener('click', () => switchTab('model-factory'));
  byId('jump-collab')?.addEventListener('click', () => switchTab('collab'));

  byId('monitor-poll-toggle')?.addEventListener('click', () => {
    state.autoRefresh = !state.autoRefresh;
    renderHeader();
    if (state.autoRefresh) void refresh();
  });
  byId('monitor-refresh-now')?.addEventListener('click', () => {
    void refresh();
  });
  byId('connection-form')?.addEventListener('submit', () => {
    setError(null);
    void refresh();
  });
  byId('spot-check-button')?.addEventListener('click', () => {
    void querySpotPlacement();
  });

  // Delivery filter & actions
  byId('delivery-filters')?.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.deliveryFilter = btn.dataset.filter || 'all';
      byId('delivery-filters').querySelectorAll('button').forEach((b) => {
        b.className = b === btn ? 'filter-btn active' : 'filter-btn';
      });
      renderDelivery();
    });
  });

  byId('delivery-reconcile-btn')?.addEventListener('click', () =>
    runMutation(
      () => monitorApi('/api/delivery/reconcile', {}, 35000),
      (res) =>
        'SW 전달 워커 정리를 완료했습니다 (확인 ' +
        (res.checked ?? 0) +
        '건 · 실패 처리 ' +
        (Array.isArray(res.failed) ? res.failed.length : 0) +
        '건).',
    ),
  );

  byId('dlv-action-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const op = event.submitter?.value;
    const task = state.delivery.tasks.find((t) => t.id === state.selectedDeliveryId);
    if (!task || !op) return;
    const reason = byId('dlv-reason').value.trim();
    if (!reason) {
      setError('결정 사유를 입력하세요.');
      byId('dlv-reason').focus();
      return;
    }
    const id = encodeURIComponent(task.id);
    if (op === 'approve') {
      return runMutation(
        async () => {
          const res = await monitorApi('/api/delivery/tasks/' + id + '/approve', { approvalFingerprint: task.approvalFingerprint, reason }, 35000);
          byId('dlv-reason').value = '';
          return res;
        },
        'SW 전달 작업 실행을 승인했습니다.',
      );
    } else if (op === 'cancel') {
      return runMutation(
        async () => {
          const res = await monitorApi('/api/delivery/tasks/' + id + '/cancel', { reason }, 35000);
          byId('dlv-reason').value = '';
          return res;
        },
        'SW 전달 작업을 중단했습니다.',
      );
    } else if (op === 'human_approve' || op === 'human_reject') {
      const durationMinutes = Number(byId('dlv-duration-min').value);
      if (!Number.isFinite(durationMinutes) || durationMinutes < 0) {
        setError('검토 소요 시간(분)을 올바르게 입력하세요.');
        return;
      }
      const missingEvidence = byId('dlv-missing-evidence').value.trim();
      return runMutation(
        async () => {
          const res = await monitorApi('/api/delivery/tasks/' + id + '/human-decision', {
            decision: op === 'human_approve' ? 'approve' : 'reject',
            openedDiff: Boolean(byId('dlv-opened-diff').checked),
            durationMinutes,
            reason,
            ...(missingEvidence ? { missingEvidence } : {}),
          });
          byId('dlv-reason').value = '';
          byId('dlv-missing-evidence').value = '';
          return res;
        },
        op === 'human_approve' ? 'Draft PR 승인 검토 이력을 기록했습니다.' : 'Draft PR 반려 검토 이력을 기록했습니다.',
      );
    }
  });

  // Model Factory filter & actions
  byId('mf-filters')?.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mfFilter = btn.dataset.filter || 'all';
      byId('mf-filters').querySelectorAll('button').forEach((b) => {
        b.className = b === btn ? 'filter-btn active' : 'filter-btn';
      });
      renderModelFactory();
    });
  });

  byId('mf-sweep-btn')?.addEventListener('click', () =>
    runMutation(
      () => monitorApi('/api/model-factory/sweep-expired', {}, 60000),
      'Model Factory 만료 정리 및 상태 갱신을 완료했습니다.',
    ),
  );

  byId('mf-btn-wake')?.addEventListener('click', () => {
    const job = state.mf.jobs.find((j) => j.id === state.selectedMfId);
    if (!job) return;
    return runMutation(
      () => monitorApi('/api/model-factory/jobs/' + encodeURIComponent(job.id) + '/wake', {}, 35000),
      '인스턴스 상태 확인(Wake)을 완료했습니다.',
    );
  });

  byId('mf-btn-verifier')?.addEventListener('click', () => {
    const job = state.mf.jobs.find((j) => j.id === state.selectedMfId);
    if (!job) return;
    return runMutation(
      () => monitorApi('/api/model-factory/jobs/' + encodeURIComponent(job.id) + '/dispatch-verifier', {}, 35000),
      '독립 검증기(Fargate Spot)를 기동했습니다.',
    );
  });

  byId('mf-action-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const op = event.submitter?.value;
    const job = state.mf.jobs.find((j) => j.id === state.selectedMfId);
    if (!job || !op) return;
    const reason = byId('mf-reason').value.trim();
    if (!reason) {
      setError('결정 사유를 입력하세요.');
      byId('mf-reason').focus();
      return;
    }
    const id = encodeURIComponent(job.id);
    if (op === 'approve_training') {
      return runMutation(
        async () => {
          const res = await monitorApi('/api/model-factory/jobs/' + id + '/approve-training', { approvalFingerprint: job.approvalFingerprint, reason }, 35000);
          byId('mf-reason').value = '';
          return res;
        },
        'Model Factory 학습을 승인했습니다.',
      );
    } else if (op === 'cancel') {
      return runMutation(
        async () => {
          const res = await monitorApi('/api/model-factory/jobs/' + id + '/cancel', { reason }, 35000);
          byId('mf-reason').value = '';
          return res;
        },
        'Model Factory 작업을 중단했습니다.',
      );
    } else if (op === 'approve_release' || op === 'reject_release') {
      const durationMinutes = Number(byId('mf-duration-min').value);
      if (!Number.isFinite(durationMinutes) || durationMinutes < 0) {
        setError('검토 소요 시간(분)을 올바르게 입력하세요.');
        return;
      }
      return runMutation(
        async () => {
          const res = await monitorApi('/api/model-factory/jobs/' + id + '/approve-release', {
            decision: op === 'approve_release' ? 'approve' : 'reject',
            openedRawArtifacts: Boolean(byId('mf-opened-raw').checked),
            durationMinutes,
            reason,
          }, 60000);
          byId('mf-reason').value = '';
          return res;
        },
        op === 'approve_release' ? '산출물 공개를 승인했습니다.' : '산출물 공개를 반려했습니다.',
      );
    }
  });

  // Collab actions
  byId('clb-btn-reconcile')?.addEventListener('click', () => {
    const id = state.collab.selectedId;
    if (!id) return;
    return runMutation(
      () => monitorApi('/api/collab/sessions/' + encodeURIComponent(id) + '/reconcile', {}, 35000),
      '협업 세션 워커 상태 정리를 완료했습니다.',
    );
  });

  byId('clb-btn-complete')?.addEventListener('click', () => {
    const id = state.collab.selectedId;
    if (!id) return;
    return runMutation(
      () => monitorApi('/api/collab/sessions/' + encodeURIComponent(id) + '/complete', { status: 'completed' }, 35000),
      '협업 세션을 완료 처리했습니다.',
    );
  });

  byId('clb-btn-cancel')?.addEventListener('click', () => {
    const id = state.collab.selectedId;
    if (!id) return;
    return runMutation(
      () => monitorApi('/api/collab/sessions/' + encodeURIComponent(id) + '/complete', { status: 'cancelled' }, 35000),
      '협업 세션을 중단하고 실행 중인 워커를 중지했습니다.',
    );
  });

  byId('clb-message-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = state.collab.selectedId;
    if (!id) return;
    const body = byId('clb-msg-body').value.trim();
    if (!body) {
      setError('게시할 메시지 내용을 입력하세요.');
      return;
    }
    const kind = byId('clb-msg-kind').value || 'decision';
    return runMutation(
      async () => {
        const res = await monitorApi('/api/collab/sessions/' + encodeURIComponent(id) + '/messages', {
          sender: 'operator',
          kind,
          body,
        });
        byId('clb-msg-body').value = '';
        return res;
      },
      '공유 게시판에 운영자 메시지를 게시했습니다.',
    );
  });

  // Consume one-time #token=... fragment into memory only and immediately strip it from the URL.
  // Query strings (?token=...) are intentionally ignored so tokens are never sent in HTTP request lines.
  function consumeHashToken() {
    try {
      const loc = typeof location !== 'undefined' ? location : null;
      if (!loc || typeof loc.hash !== 'string' || loc.hash.length < 2) return;
      const params = new URLSearchParams(loc.hash.slice(1));
      if (!params.has('token')) return;
      const hashToken = params.get('token');
      if (hashToken && hashToken.trim()) {
        const input = byId('operator-token');
        if (input) input.value = hashToken.trim();
      }
      params.delete('token');
      const remaining = params.toString();
      if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
        history.replaceState(null, '', (loc.pathname || '/') + (loc.search || '') + (remaining ? '#' + remaining : ''));
      }
    } catch {
      // Ignore malformed hash fragments.
    }
  }

  // Initialize default view & polling
  consumeHashToken();
  switchTab('overview');
  renderAll();
  void refresh();
  setInterval(() => {
    if (!document.hidden && state.autoRefresh) void refresh();
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.autoRefresh) void refresh();
  });

  globalThis.hivemindMonitor = {
    state,
    refresh,
    switchTab,
    selectDelivery,
    selectMfJob,
    selectCollab,
    querySpotPlacement,
    formatUsd,
  };
})();
