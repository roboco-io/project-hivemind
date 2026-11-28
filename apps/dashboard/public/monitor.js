(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const charts = () => (typeof globalThis !== 'undefined' ? globalThis.hivemindCharts : null);

  const TAB_ORDER = ['overview', 'projects', 'inbox', 'delivery', 'compute', 'collab', 'costs', 'legacy'];
  const TAB_TITLES = {
    overview: '개요 HUD',
    projects: '호스트 프로젝트',
    inbox: '승인 인박스',
    delivery: 'SW 전달',
    compute: 'Spot 컴퓨팅',
    collab: '병렬 협업',
    costs: '비용 분석',
    legacy: '로컬 · 레거시 도구',
  };

  const PROJECT_STATUS = { active: '활성', paused: '일시정지', archived: '보관' };
  const CAPABILITY_LABEL = {
    delivery: 'SW 전달',
    compute: 'Spot 컴퓨팅',
    collab: '병렬 협업',
    autonomy_triggers: '자율 트리거',
    scoped_credentials: '단기 AWS 자격',
    hf_release: 'HF 공개',
    notifications: '알림',
  };

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

  const COMPUTE_STATUS = {
    awaiting_launch_approval: '기동 승인 대기',
    awaiting_training_approval: '기동 승인 대기',
    queued: '배정 대기',
    training_queued: '배정 대기',
    running: 'Spot 실행 중',
    training_running: 'Spot 실행 중',
    evaluating: '산출물 평가 중',
    awaiting_release_approval: '공개 승인 대기',
    release_approved: '공개 승인됨',
    released: '공개 완료',
    failed: '실패',
    cancelled: '중단',
    rejected: '반려',
  };
  const COMPUTE_ACTIVE = new Set(['queued', 'running', 'training_queued', 'training_running', 'evaluating', 'release_approved']);
  const COMPUTE_ATTENTION = new Set(['awaiting_launch_approval', 'awaiting_training_approval', 'awaiting_release_approval']);
  const COMPUTE_TERMINAL = new Set(['released', 'failed', 'cancelled', 'rejected']);

  const COLLAB_STATUS = { active: '진행 중', completed: '완료', failed: '실패', cancelled: '중단' };
  const SUBTASK_STATUS = { pending: '대기', queued: '배정 대기', running: '실행 중', completed: '완료', failed: '실패', cancelled: '중단' };
  const EC2_STATE = { pending: '시작 중', running: '실행 중', stopping: '중지 중', stopped: '중지됨', 'shutting-down': '종료 중', terminated: '종료됨', unknown: '확인 필요' };
  const WAIT_REASON = {
    awaiting_launch_approval: '사람의 실행 승인을 기다립니다.',
    awaiting_training_approval: '사람의 실행 승인을 기다립니다.',
    running_in_progress: 'EC2 스팟 인스턴스에서 워크로드를 실행하고 있습니다.',
    training_in_progress: 'EC2 스팟 인스턴스에서 워크로드를 실행하고 있습니다.',
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
  const BACKEND_LABEL = { 'aurora-dsql': 'Aurora DSQL', sqlite: 'SQLite' };

  const TAB_TOKEN_KEY = 'hivemind.operatorToken';
  const UI_PREFS_KEY = 'hivemind.uiPrefs';
  const ALLOWED_POLL_MS = new Set([0, 15000, 30000, 60000]);

  const state = {
    activeTab: 'overview',
    projectFilter: 'all',
    projectsStatusFilter: 'all',
    theme: 'dark',
    density: 'comfortable',
    pollIntervalMs: 15000,
    autoRefresh: true,
    notificationsEnabled: false,
    seenAlertsInitialized: false,
    seenAlertIds: new Set(),
    lastSyncTs: 0,
    health: null,
    projects: { storageBackend: null, list: [], events: [] },
    autonomy: { storageBackend: null, triggers: [], events: [] },
    delivery: { storageBackend: null, tasks: [], events: [] },
    deliveryFilter: 'all',
    deliverySearch: '',
    selectedDeliveryId: null,
    selectedDeliveryFingerprint: null,
    spotPlacement: null,
    spotStatusText: null,
    spotChecking: false,
    compute: { storageBackend: null, jobs: [], events: [], ledger: null },
    computeFilter: 'all',
    computeSearch: '',
    selectedComputeId: null,
    selectedComputeFingerprint: null,
    collab: { storageBackend: null, sessions: [], selectedId: null, snapshot: null, epoch: 0 },
    inboxFilter: 'all',
    eventFilter: { source: 'all', errorsOnly: false, query: '' },
    drawer: { open: false, kind: null, id: null, fingerprint: null },
    busy: false,
    refreshing: false,
    error: null,
    notice: null,
  };

  let pollTimer = null;

  // ---------- SAFE HELPERS ----------
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

  function formatElapsedSince(iso) {
    const ts = Date.parse(iso || '');
    if (!Number.isFinite(ts)) return '-';
    return formatDurationSec(Math.max(0, (Date.now() - ts) / 1000));
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

  // ---------- NON-SECRET UI PREFS (localStorage) & TAB-SCOPED TOKEN (sessionStorage) ----------
  function loadUiPrefs() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(UI_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.theme === 'dark' || parsed.theme === 'light') state.theme = parsed.theme;
      if (parsed.density === 'comfortable' || parsed.density === 'compact') state.density = parsed.density;
      if (typeof parsed.pollIntervalMs === 'number' && ALLOWED_POLL_MS.has(parsed.pollIntervalMs)) {
        state.pollIntervalMs = parsed.pollIntervalMs;
        state.autoRefresh = parsed.pollIntervalMs > 0;
      }
      if (typeof parsed.notificationsEnabled === 'boolean') state.notificationsEnabled = parsed.notificationsEnabled;
    } catch {
      // Ignore storage errors.
    }
  }

  function saveUiPrefs() {
    try {
      if (typeof localStorage === 'undefined') return;
      // Only non-secret UI display preferences are persisted here; operator tokens NEVER enter localStorage.
      localStorage.setItem(
        UI_PREFS_KEY,
        JSON.stringify({
          theme: state.theme,
          density: state.density,
          pollIntervalMs: state.autoRefresh ? state.pollIntervalMs || 15000 : 0,
          notificationsEnabled: state.notificationsEnabled,
        }),
      );
    } catch {
      // Ignore storage errors.
    }
  }

  function applyUiPrefs() {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (root && root.dataset) {
      root.dataset.theme = state.theme;
      root.dataset.density = state.density;
    }
    const themeBtn = byId('monitor-theme-toggle');
    if (themeBtn) {
      themeBtn.textContent = state.theme === 'dark' ? '다크' : '라이트';
      themeBtn.setAttribute('aria-pressed', String(state.theme === 'dark'));
    }
    const densityBtn = byId('monitor-density-toggle');
    if (densityBtn) {
      densityBtn.textContent = state.density === 'compact' ? '컴팩트' : '기본 밀도';
      densityBtn.setAttribute('aria-pressed', String(state.density === 'compact'));
    }
    const notifyBtn = byId('monitor-notify-toggle');
    if (notifyBtn) {
      notifyBtn.textContent = state.notificationsEnabled ? '알림 켜짐' : '알림 꺼짐';
      notifyBtn.setAttribute('aria-pressed', String(state.notificationsEnabled));
    }
    const select = byId('monitor-poll-select');
    if (select) {
      select.value = String(state.autoRefresh ? state.pollIntervalMs : 0);
    }
    const pollBtn = byId('monitor-poll-toggle');
    if (pollBtn) {
      const sec = Math.round(state.pollIntervalMs / 1000);
      pollBtn.textContent = state.autoRefresh ? '자동 갱신 켜짐 (' + sec + '초)' : '자동 갱신 일시정지';
      pollBtn.setAttribute('aria-pressed', String(state.autoRefresh));
    }
  }

  function reschedulePolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (state.autoRefresh && state.pollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        if (!document.hidden && state.autoRefresh) void refresh();
      }, state.pollIntervalMs);
    }
  }

  function saveTabToken(token) {
    try {
      if (typeof sessionStorage !== 'undefined' && token) {
        sessionStorage.setItem(TAB_TOKEN_KEY, token);
      }
    } catch {
      // Ignore storage restrictions.
    }
  }

  function restoreTabToken() {
    try {
      if (typeof sessionStorage === 'undefined') return;
      const saved = sessionStorage.getItem(TAB_TOKEN_KEY);
      if (saved && saved.trim()) {
        const input = byId('operator-token');
        if (input) input.value = saved.trim();
      }
    } catch {
      // Ignore storage restrictions.
    }
  }

  function consumeHashToken() {
    try {
      const loc = typeof location !== 'undefined' ? location : null;
      if (!loc || typeof loc.hash !== 'string' || loc.hash.length < 2) return false;
      const params = new URLSearchParams(loc.hash.slice(1));
      if (!params.has('token')) return false;
      const hashToken = params.get('token');
      let applied = false;
      if (hashToken && hashToken.trim()) {
        const trimmed = hashToken.trim();
        const input = byId('operator-token');
        if (input) input.value = trimmed;
        saveTabToken(trimmed);
        applied = true;
      }
      params.delete('token');
      const remaining = params.toString();
      if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
        history.replaceState(null, '', (loc.pathname || '/') + (loc.search || '') + (remaining ? '#' + remaining : ''));
      }
      return applied;
    } catch {
      return false;
    }
  }

  // ---------- PROJECT SCOPING HELPERS ----------
  function matchesProject(projectId) {
    if (state.projectFilter === 'all') return true;
    return (projectId || 'default') === state.projectFilter;
  }

  function visibleDeliveryTasks() {
    return state.delivery.tasks.filter((t) => matchesProject(t.projectId));
  }

  function visibleComputeJobs() {
    return state.compute.jobs.filter((j) => matchesProject(j.projectId));
  }

  function visibleCollabSessions() {
    return state.collab.sessions.filter((s) => matchesProject(s.projectId));
  }

  function visibleLedger() {
    const base = state.compute.ledger;
    if (!base) return null;
    if (state.projectFilter === 'all') return base;
    const pSummary = base.byProject?.[state.projectFilter];
    const jobs = (base.jobs || []).filter((e) => matchesProject(e.projectId));
    if (pSummary) {
      return {
        globalBudgetCapMicros: pSummary.budgetCapMicros ?? base.globalBudgetCapMicros,
        totalReservedMicros: pSummary.totalReservedMicros,
        totalSettledMicros: pSummary.totalSettledMicros,
        remainingBudgetMicros: pSummary.remainingBudgetMicros,
        activeReservations: pSummary.activeReservations,
        settledJobs: pSummary.settledJobs,
        byProject: { [state.projectFilter]: pSummary },
        jobs,
      };
    }
    const proj = state.projects.list.find((p) => p.id === state.projectFilter);
    const cap = proj?.budget?.computeBudgetCapMicros ?? base.globalBudgetCapMicros;
    return {
      globalBudgetCapMicros: cap,
      totalReservedMicros: 0,
      totalSettledMicros: 0,
      remainingBudgetMicros: Math.min(cap, base.remainingBudgetMicros),
      activeReservations: 0,
      settledJobs: 0,
      byProject: {},
      jobs,
    };
  }

  // ---------- API ----------
  async function monitorApi(path, body, timeoutMs = 15000, method) {
    const token = (byId('operator-token')?.value || '').trim();
    const effectiveMethod = method || (body === undefined ? 'GET' : 'POST');
    const response = await fetch(path, {
      method: effectiveMethod,
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

  // ---------- NAVIGATION ----------
  function switchTab(tabName) {
    if (!TAB_ORDER.includes(tabName)) return;
    state.activeTab = tabName;
    for (const name of TAB_ORDER) {
      const btn = byId('tab-' + name);
      const panel = byId('panel-' + name);
      const active = name === tabName;
      if (btn) {
        const subtle = name === 'legacy' ? ' nav-item-subtle' : '';
        btn.className = 'nav-item' + subtle + (active ? ' active' : '');
        btn.setAttribute('aria-selected', String(active));
      }
      if (panel) panel.hidden = !active;
    }
    if (byId('page-title')) byId('page-title').textContent = TAB_TITLES[tabName] || 'HIVEMIND 관제실';
  }

  // ---------- TAB TITLE & DESKTOP ALERTS ----------
  function getAttentionItems() {
    const items = [];
    for (const t of visibleDeliveryTasks()) {
      if (DELIVERY_ATTENTION.has(t.status)) {
        items.push({ kind: 'delivery', id: t.id, projectId: t.projectId || 'default', title: t.title, status: t.status, updatedAt: t.updatedAt, raw: t });
      }
    }
    for (const j of visibleComputeJobs()) {
      if (COMPUTE_ATTENTION.has(j.status)) {
        items.push({ kind: 'compute', id: j.id, projectId: j.projectId || 'default', title: j.title, status: j.status, updatedAt: j.updatedAt, raw: j });
      }
    }
    items.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
    return items;
  }

  function updateTabTitleAndAlerts() {
    const attention = getAttentionItems();
    const activeCount =
      visibleDeliveryTasks().filter((t) => DELIVERY_ACTIVE.has(t.status)).length +
      visibleComputeJobs().filter((j) => COMPUTE_ACTIVE.has(j.status)).length +
      visibleCollabSessions().filter((s) => s.status === 'active').length;

    const parts = [];
    if (attention.length > 0) parts.push(attention.length + ' 대기');
    if (activeCount > 0) parts.push(activeCount + ' 실행');
    if (typeof document !== 'undefined') {
      document.title = parts.length ? '(' + parts.join(' · ') + ') HIVEMIND 관제실' : 'HIVEMIND 관제실';
    }

    const currentAlertIds = new Set();
    const freshNotifications = [];
    for (const item of attention) {
      const key = item.kind + ':' + item.id + ':' + item.status;
      currentAlertIds.add(key);
      if (state.seenAlertsInitialized && !state.seenAlertIds.has(key)) {
        freshNotifications.push({
          title: 'HIVEMIND 승인·검토 대기',
          body: safeText(item.title, 100),
        });
      }
    }
    for (const t of state.delivery.tasks) {
      if (t.status === 'failed') {
        const key = 'delivery:' + t.id + ':failed';
        currentAlertIds.add(key);
        if (state.seenAlertsInitialized && !state.seenAlertIds.has(key)) {
          freshNotifications.push({ title: 'HIVEMIND SW 전달 실패', body: safeText(t.title, 100) });
        }
      }
    }
    for (const j of state.compute.jobs) {
      if (j.status === 'failed') {
        const key = 'compute:' + j.id + ':failed';
        currentAlertIds.add(key);
        if (state.seenAlertsInitialized && !state.seenAlertIds.has(key)) {
          freshNotifications.push({ title: 'HIVEMIND Spot 컴퓨팅 실패', body: safeText(j.title, 100) });
        }
      }
    }
    state.seenAlertIds = currentAlertIds;
    state.seenAlertsInitialized = true;

    if (state.notificationsEnabled && freshNotifications.length && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      for (const n of freshNotifications.slice(0, 3)) {
        try {
          new Notification(n.title, { body: n.body });
        } catch {
          // Ignore browser notification restrictions.
        }
      }
    }
  }

  // ---------- HEADER & SYNC AGE ----------
  function updateSyncAge() {
    const elAge = byId('sync-age');
    if (!elAge) return;
    if (!state.lastSyncTs) {
      elAge.textContent = '';
      return;
    }
    const sec = Math.max(0, Math.round((Date.now() - state.lastSyncTs) / 1000));
    elAge.textContent = sec < 5 ? '(방금 전)' : '(' + formatDurationSec(sec) + ' 전)';
  }

  function syncProjectSelector() {
    const sel = byId('project-filter');
    if (!sel) return;
    const ids = ['all', ...state.projects.list.map((p) => p.id)];
    const sig = ids.join(',');
    if (sel.dataset.signature !== sig) {
      sel.dataset.signature = sig;
      sel.replaceChildren();
      const allOpt = el('option', '전체 프로젝트 (' + state.projects.list.length + ')');
      allOpt.value = 'all';
      sel.append(allOpt);
      for (const p of state.projects.list) {
        const opt = el('option', safeText(p.name, 40) + ' (' + safeText(p.id, 32) + ')');
        opt.value = p.id;
        sel.append(opt);
      }
    }
    if (!ids.includes(state.projectFilter)) state.projectFilter = 'all';
    sel.value = state.projectFilter;
  }

  function renderHeader() {
    applyUiPrefs();
    syncProjectSelector();
    const modeBadge = byId('monitor-mode-badge');
    if (modeBadge) {
      if (state.health?.status === 'ok') {
        const isAwsDsql = [state.projects.storageBackend, state.delivery.storageBackend, state.compute.storageBackend, state.collab.storageBackend].includes('aurora-dsql');
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
    const backendText = (v) => (v && BACKEND_LABEL[v]) || (v ? safeText(v, 32) : '미연결');
    if (byId('monitor-backend-projects')) byId('monitor-backend-projects').textContent = backendText(state.projects.storageBackend);
    if (byId('monitor-backend-delivery')) byId('monitor-backend-delivery').textContent = backendText(state.delivery.storageBackend);
    if (byId('monitor-backend-compute')) byId('monitor-backend-compute').textContent = backendText(state.compute.storageBackend);
    if (byId('monitor-backend-collab')) byId('monitor-backend-collab').textContent = backendText(state.collab.storageBackend);

    const attentionCount = getAttentionItems().length;
    const inboxBadge = byId('tab-badge-inbox');
    if (inboxBadge) {
      inboxBadge.textContent = String(attentionCount);
      inboxBadge.className = 'nav-badge badge-attention' + (attentionCount > 0 ? ' has-items' : '');
    }
    if (byId('tab-badge-projects')) byId('tab-badge-projects').textContent = String(state.projects.list.length);
    if (byId('tab-badge-delivery')) byId('tab-badge-delivery').textContent = String(visibleDeliveryTasks().length);
    if (byId('tab-badge-compute')) byId('tab-badge-compute').textContent = String(visibleComputeJobs().length);
    if (byId('tab-badge-collab')) byId('tab-badge-collab').textContent = String(visibleCollabSessions().length);
    const legacyCount = byId('task-count')?.textContent;
    if (byId('tab-badge-legacy') && legacyCount !== undefined) byId('tab-badge-legacy').textContent = legacyCount;
    updateSyncAge();
  }

  // ---------- HOSTED PROJECTS ----------
  function showOneTimeTokenBanner(projectId, issued) {
    const banner = byId('project-token-banner');
    if (!banner) return;
    banner.hidden = false;
    byId('project-token-banner-title').textContent =
      '프로젝트 ' + safeText(projectId, 48) + ' · ' + safeText(issued.metadata?.label || '', 64) + ' (' + safeText(issued.metadata?.tokenId || '', 32) + ')';
    byId('project-token-value').textContent = String(issued.token || '');
  }

  function clearOneTimeTokenBanner() {
    const banner = byId('project-token-banner');
    if (!banner) return;
    banner.hidden = true;
    if (byId('project-token-banner-title')) byId('project-token-banner-title').textContent = '';
    if (byId('project-token-value')) byId('project-token-value').textContent = '';
  }

  function renderProjects() {
    const all = state.projects.list;
    const filtered = state.projectsStatusFilter === 'all' ? all : all.filter((p) => p.status === state.projectsStatusFilter);
    if (byId('projects-count-label')) {
      byId('projects-count-label').textContent = filtered.length + '개 프로젝트 / 전체 ' + all.length + '개';
    }
    const grid = byId('projects-list');
    if (!grid) return;
    grid.replaceChildren();
    if (!filtered.length) {
      grid.append(el('p', '조건에 맞는 호스트 프로젝트가 없습니다. 새 프로젝트를 등록하거나 npm run project:bootstrap 을 실행하세요.', 'empty'));
      return;
    }

    const ledgerByProject = state.compute.ledger?.byProject || {};
    for (const p of filtered) {
      const card = el('article', undefined, 'project-card');
      card.addEventListener('click', () => openDrawer('project', p.id));

      const head = el('div', undefined, 'project-card-head');
      const titleBox = el('div');
      titleBox.append(el('strong', safeText(p.name, 80)), el('p', safeText(p.id, 48) + ' · ' + safeText(p.template, 24), 'help mono'));
      head.append(titleBox, el('span', PROJECT_STATUS[p.status] || p.status, p.status === 'active' ? 'pill tone-success' : p.status === 'paused' ? 'pill tone-attention' : 'pill'));
      card.append(head);

      if (p.description) card.append(el('p', safeText(p.description, 200), 'help'));

      const caps = el('div', undefined, 'project-cap-row');
      for (const cap of p.capabilities || []) {
        caps.append(el('span', CAPABILITY_LABEL[cap] || cap, 'cap-chip'));
      }
      card.append(caps);

      const pl = ledgerByProject[p.id];
      const capMicros = p.budget?.computeBudgetCapMicros ?? 0;
      const usedMicros = (pl?.totalSettledMicros ?? 0) + (pl?.totalReservedMicros ?? 0);
      const pct = capMicros > 0 ? Math.min(100, (usedMicros / capMicros) * 100) : 0;
      const budgetRow = el('div');
      budgetRow.append(el('p', '컴퓨팅 예산 ' + formatUsd(usedMicros) + ' / ' + formatUsd(capMicros) + ' (' + pct.toFixed(1) + '%)', 'help'));
      const track = el('div', undefined, 'breakdown-track');
      const fill = el('div', undefined, 'breakdown-fill settled');
      fill.style.width = pct.toFixed(1) + '%';
      track.append(fill);
      budgetRow.append(track);
      card.append(budgetRow);

      const dlvCount = state.delivery.tasks.filter((t) => (t.projectId || 'default') === p.id).length;
      const cmpCount = state.compute.jobs.filter((j) => (j.projectId || 'default') === p.id).length;
      const activeTokens = (p.tokens || []).filter((t) => !t.revokedAt).length;
      const foot = el('div', undefined, 'inbox-card-foot');
      foot.append(
        el('span', '저장소 ' + (p.delivery?.repositories?.length || 0) + ' · 토큰 ' + activeTokens + ' · 전달 ' + dlvCount + ' · 컴퓨팅 ' + cmpCount, 'quiet'),
        (() => {
          const filterBtn = el('button', '필터 보기', 'secondary compact-btn');
          filterBtn.type = 'button';
          filterBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.projectFilter = p.id;
            renderAll();
            switchTab('overview');
          });
          return filterBtn;
        })(),
      );
      card.append(foot);
      grid.append(card);
    }
  }

  // ---------- LIVE STRIP ----------
  function renderLiveStrip() {
    const list = byId('live-strip-list');
    const countEl = byId('live-strip-count');
    const dot = byId('live-pulse-dot');
    if (!list) return;
    list.replaceChildren();

    const activeItems = [];
    for (const t of visibleDeliveryTasks()) {
      if (DELIVERY_ACTIVE.has(t.status)) {
        activeItems.push({
          kind: 'delivery',
          kindLabel: 'SW 전달',
          id: t.id,
          title: t.title,
          status: t.status,
          statusLabel: DELIVERY_STATUS[t.status] || t.status,
          meta:
            (t.projectId && t.projectId !== 'default' ? '[' + safeText(t.projectId, 32) + '] ' : '') +
            safeText(t.provider, 16) +
            ' · 반복 ' +
            t.currentIteration +
            '/' +
            t.maxIterations +
            (t.activeRegion ? ' · ' + safeText(t.activeRegion, 24) : '') +
            ' · 갱신 ' +
            formatElapsedSince(t.updatedAt) +
            ' 전',
        });
      }
    }
    for (const j of visibleComputeJobs()) {
      if (COMPUTE_ACTIVE.has(j.status)) {
        const inst = j.instance;
        activeItems.push({
          kind: 'compute',
          kindLabel: 'Spot 컴퓨팅',
          id: j.id,
          title: j.title,
          status: j.status,
          statusLabel: COMPUTE_STATUS[j.status] || j.status,
          meta:
            (j.projectId && j.projectId !== 'default' ? '[' + safeText(j.projectId, 32) + '] ' : '') +
            safeText(j.compute?.instanceType, 24) +
            ' · ' +
            safeText(inst?.region || j.compute?.region, 24) +
            (inst?.launchedAt ? ' · 경과 ' + formatElapsedSince(inst.launchedAt) : '') +
            (inst?.expiresAt ? ' · TTL ' + formatTtl(inst.expiresAt) : ''),
        });
      }
    }
    for (const s of visibleCollabSessions()) {
      if (s.status === 'active') {
        activeItems.push({
          kind: 'collab',
          kindLabel: '병렬 협업',
          id: s.id,
          title: s.title,
          status: s.status,
          statusLabel: COLLAB_STATUS[s.status] || s.status,
          meta:
            (s.projectId && s.projectId !== 'default' ? '[' + safeText(s.projectId, 32) + '] ' : '') +
            safeText(s.provider, 16) +
            ' · 최대 ' +
            s.maxParallelWorkers +
            '워커 · 갱신 ' +
            formatElapsedSince(s.updatedAt) +
            ' 전',
        });
      }
    }

    if (dot) dot.className = activeItems.length ? 'pulse-dot' : 'pulse-dot idle';
    if (countEl) countEl.textContent = activeItems.length ? activeItems.length + '개 워크로드 실행 중 (클릭 시 상세 드로어)' : '실행 중인 워크로드 없음';

    if (!activeItems.length) {
      list.append(el('p', '현재 실행 중인 워커·학습 인스턴스가 없습니다.', 'empty'));
      return;
    }

    for (const item of activeItems) {
      const btn = el('button', undefined, 'live-item-btn');
      btn.type = 'button';
      btn.addEventListener('click', () => openDrawer(item.kind, item.id));
      const top = el('div', undefined, 'live-item-top');
      top.append(el('span', item.kindLabel, 'pill'), el('span', item.statusLabel, pillClass(item.status)));
      btn.append(top, el('strong', safeText(item.title, 120)), el('span', item.meta, 'live-item-meta'));
      list.append(btn);
    }
  }

  // ---------- INBOX ----------
  function buildInboxCard(item) {
    const card = el('article', undefined, 'inbox-card');
    const head = el('div', undefined, 'inbox-card-head');
    const kindText = item.kind === 'delivery' ? 'SW 전달' : 'Spot 컴퓨팅';
    const statusLabel = item.kind === 'delivery' ? DELIVERY_STATUS[item.status] || item.status : COMPUTE_STATUS[item.status] || item.status;
    head.append(el('span', kindText, 'pill'), el('span', statusLabel, pillClass(item.status)));
    card.append(head, el('strong', safeText(item.title, 140)));

    const chips = el('div', undefined, 'inbox-chips');
    if (item.kind === 'delivery') {
      const t = item.raw;
      chips.append(el('span', safeText(t.provider, 16) + ' · 예산 ' + formatUsd(t.budgetMicros), 'pill'));
      if (t.publication && t.latestAttestation) {
        const matched = t.publication.prTreeHash === t.latestAttestation.verifiedTreeHash;
        chips.append(el('span', matched ? '트리 해시 3자 일치' : '해시 불일치 주의', matched ? 'pill tone-success' : 'pill tone-danger'));
      }
      if (t.publication?.changeSummary) {
        const cs = t.publication.changeSummary;
        chips.append(el('span', cs.totalFiles + '파일 (+' + cs.totalInsertions + '/-' + cs.totalDeletions + ')', 'pill'));
      }
    } else {
      const j = item.raw;
      chips.append(el('span', safeText(j.compute?.instanceType, 24) + ' · 예약 ' + formatUsd(j.cost?.reservedMicros), 'pill'));
      if (j.placementPlan) {
        chips.append(el('span', '배치 ' + safeText(j.placementPlan.status, 24), j.placementPlan.status === 'ranked' ? 'pill tone-success' : 'pill tone-attention'));
      }
      if (j.releaseAttestation?.attestationSource === 'operator_self_reported') {
        chips.append(el('span', '비독립 검증(운영자 보고)', 'pill tone-attention'));
      } else if (j.releaseAttestation?.attestationSource === 'independent_verifier') {
        chips.append(el('span', '독립 검증 통과', 'pill tone-success'));
      }
    }
    card.append(chips);

    const foot = el('div', undefined, 'inbox-card-foot');
    foot.append(el('span', '대기 ' + formatElapsedSince(item.updatedAt) + ' · ' + safeText(item.id, 24), 'quiet mono'));
    const actionBtn = el('button', '검토 · 결정', 'compact-btn');
    actionBtn.type = 'button';
    actionBtn.addEventListener('click', () => openDrawer(item.kind, item.id));
    foot.append(actionBtn);
    card.append(foot);
    return card;
  }

  function renderInbox() {
    const all = getAttentionItems();
    const overviewBox = byId('overview-inbox-list');
    if (overviewBox) {
      overviewBox.replaceChildren();
      if (!all.length) {
        overviewBox.append(el('p', '현재 사람의 결정을 기다리는 항목이 없습니다.', 'empty'));
      } else {
        for (const item of all.slice(0, 4)) overviewBox.append(buildInboxCard(item));
      }
    }

    const filtered = state.inboxFilter === 'all' ? all : all.filter((i) => i.kind === state.inboxFilter);
    if (byId('inbox-count-label')) byId('inbox-count-label').textContent = filtered.length + '건 대기 중 / 전체 ' + all.length + '건';
    const fullBox = byId('inbox-list');
    if (fullBox) {
      fullBox.replaceChildren();
      if (!filtered.length) {
        fullBox.append(el('p', '선택한 필터에 해당하는 승인·검토 대기 항목이 없습니다.', 'empty'));
      } else {
        for (const item of filtered) fullBox.append(buildInboxCard(item));
      }
    }
  }

  // ---------- OVERVIEW & COST ANALYTICS ----------
  function aggregateBreakdown(jobs, keyFn) {
    const map = new Map();
    for (const j of jobs) {
      const label = safeText(keyFn(j) || '미지정', 64);
      const entry = map.get(label) || { label, count: 0, settledMicros: 0, reservedMicros: 0, totalMicros: 0 };
      entry.count += 1;
      const settled = typeof j.cost?.settledMicros === 'number' ? j.cost.settledMicros : null;
      if (settled !== null) {
        entry.settledMicros += settled;
        entry.totalMicros += settled;
      } else if (typeof j.cost?.reservedMicros === 'number' && j.cost.reservedMicros > 0) {
        entry.reservedMicros += j.cost.reservedMicros;
        entry.totalMicros += j.cost.reservedMicros;
      }
      map.set(label, entry);
    }
    return Array.from(map.values());
  }

  function renderCosts() {
    const ledger = visibleLedger();
    const jobs = visibleComputeJobs();
    const ch = charts();

    if (byId('costs-summary-pill') && ledger) {
      byId('costs-summary-pill').textContent =
        '정산 ' + formatUsd(ledger.totalSettledMicros) + ' · 예약 ' + formatUsd(ledger.totalReservedMicros);
    }

    if (ch) {
      const chartSource = jobs.length ? jobs : ledger?.jobs || [];
      ch.renderCostTrendChart(byId('overview-cost-chart'), chartSource, formatUsd, { compact: true });
      ch.renderCostTrendChart(byId('costs-trend-chart'), chartSource, formatUsd, { compact: false });
      ch.renderBreakdownBars(byId('costs-by-project'), aggregateBreakdown(jobs, (j) => j.projectId || 'default'), formatUsd, '프로젝트 기록 없음');
      ch.renderBreakdownBars(byId('costs-by-workload'), aggregateBreakdown(jobs, (j) => j.workloadId || j.modelId), formatUsd, '워크로드 기록 없음');
      ch.renderBreakdownBars(byId('costs-by-region'), aggregateBreakdown(jobs, (j) => j.instance?.region || j.compute?.region), formatUsd, '리전 기록 없음');
      ch.renderBreakdownBars(byId('costs-by-instance'), aggregateBreakdown(jobs, (j) => j.compute?.instanceType), formatUsd, '인스턴스 기록 없음');
    }

    // Running EC2 Spot live cost estimator & TTL countdown
    const liveEc2 = jobs.filter((j) => j.instance && ['pending', 'running'].includes(j.instance.state));
    if (byId('costs-ec2-count')) {
      byId('costs-ec2-count').textContent = liveEc2.length + '대';
      byId('costs-ec2-count').className = liveEc2.length ? 'pill tone-running' : 'pill';
    }
    const ec2Box = byId('costs-live-ec2');
    if (ec2Box) {
      ec2Box.replaceChildren();
      if (!liveEc2.length) {
        ec2Box.append(el('p', '현재 실행 중인 EC2 스팟 인스턴스가 없습니다.', 'empty'));
      } else {
        for (const j of liveEc2) {
          const inst = j.instance;
          const card = el('div', undefined, 'ec2-live-card');
          const launchedTs = Date.parse(inst.launchedAt || '');
          const expiresTs = Date.parse(inst.expiresAt || '');
          const elapsedSec = Number.isFinite(launchedTs) ? Math.max(0, (Date.now() - launchedTs) / 1000) : 0;
          const rate = Number(j.cost?.hourlyRateUsd ?? j.compute?.maxHourlyPriceUsd ?? 0);
          const estMicros = Math.min(j.cost?.reservedMicros ?? Number.MAX_SAFE_INTEGER, Math.round((elapsedSec / 3600) * rate * 1_000_000));
          const head = el('div', undefined, 'subtask-head');
          head.append(el('strong', '[' + safeText(j.projectId || 'default', 24) + '] ' + safeText(j.workloadId || j.modelId, 48) + ' · ' + safeText(inst.instanceType, 24)), el('span', EC2_STATE[inst.state] || inst.state, 'pill tone-running'));
          card.append(
            head,
            el('p', safeText(inst.instanceId, 32) + ' · ' + safeText(inst.region, 24) + (inst.availabilityZone ? '/' + safeText(inst.availabilityZone, 24) : ''), 'help mono'),
            el('p', '경과 ' + formatDurationSec(elapsedSec) + ' · 상한가 기준 경과 추정 ' + formatUsd(estMicros) + ' (실청구 아님)', 'help'),
            el('p', 'TTL: ' + formatTtl(inst.expiresAt), 'help'),
          );
          if (Number.isFinite(launchedTs) && Number.isFinite(expiresTs) && expiresTs > launchedTs) {
            const pct = Math.min(100, Math.max(0, ((Date.now() - launchedTs) / (expiresTs - launchedTs)) * 100));
            const track = el('div', undefined, 'breakdown-track');
            const fill = el('div', undefined, 'breakdown-fill reserved');
            fill.style.width = pct.toFixed(1) + '%';
            track.append(fill);
            card.append(track);
          }
          const btn = el('button', '상세 보기', 'secondary compact-btn');
          btn.type = 'button';
          btn.addEventListener('click', () => openDrawer('compute', j.id));
          const cardActions = el('div', undefined, 'actions');
          cardActions.append(btn);
          card.append(cardActions);
          ec2Box.append(card);
        }
      }
    }

    // SW Delivery budget & spot savings summary
    const dlvBox = byId('costs-delivery-summary');
    if (dlvBox) {
      dlvBox.replaceChildren();
      const tasks = visibleDeliveryTasks();
      const totalBudget = tasks.reduce((sum, t) => sum + (typeof t.budgetMicros === 'number' ? t.budgetMicros : 0), 0);
      const placed = tasks.filter((t) => typeof t.lastPlacement?.savingsVsPrimaryPercent === 'number');
      const avgSavings = placed.length
        ? placed.reduce((sum, t) => sum + t.lastPlacement.savingsVsPrimaryPercent, 0) / placed.length
        : null;
      const facts = el('dl', undefined, 'repository-facts compact-facts');
      const addFact = (dt, dd) => {
        const d = el('div');
        d.append(el('dt', dt), el('dd', dd));
        facts.append(d);
      };
      addFact('총 SW 전달 작업', tasks.length + '건 (Draft PR ' + tasks.filter((t) => Boolean(t.publication)).length + '건)');
      addFact('승인 예산 합계', formatUsd(totalBudget));
      addFact('평균 스팟 절감률', avgSavings !== null ? avgSavings.toFixed(1) + '% (' + placed.length + '건 기준)' : '배치 기록 없음');
      addFact('모델·Fargate 실청구', '미확정 (중앙 원장 미포함 · 별도 구독/AWS 청구)');
      dlvBox.append(facts);
      const badges = el('div', undefined, 'status-badges');
      renderStatusBadges(badges, countByStatus(tasks), DELIVERY_STATUS);
      dlvBox.append(badges);
    }
  }

  function renderOverview() {
    const tasks = visibleDeliveryTasks();
    const jobs = visibleComputeJobs();
    const sessions = visibleCollabSessions();
    const deliveryActive = tasks.filter((t) => DELIVERY_ACTIVE.has(t.status)).length;
    const deliveryAttention = tasks.filter((t) => DELIVERY_ATTENTION.has(t.status)).length;
    const computeActive = jobs.filter((j) => COMPUTE_ACTIVE.has(j.status)).length;
    const computeAttention = jobs.filter((j) => COMPUTE_ATTENTION.has(j.status)).length;
    const collabActive = sessions.filter((s) => s.status === 'active').length;

    byId('kpi-active-total').textContent = String(deliveryActive + computeActive + collabActive);
    byId('kpi-active-detail').textContent = 'SW 전달 ' + deliveryActive + ' · 컴퓨팅 ' + computeActive + ' · 협업 활성 ' + collabActive;

    byId('kpi-attention-total').textContent = String(deliveryAttention + computeAttention);
    byId('kpi-attention-detail').textContent = 'SW 전달 ' + deliveryAttention + ' · Spot 컴퓨팅 ' + computeAttention;

    const ledger = visibleLedger();
    if (ledger && typeof ledger.globalBudgetCapMicros === 'number') {
      const cap = ledger.globalBudgetCapMicros;
      const settled = ledger.totalSettledMicros;
      const reserved = ledger.totalReservedMicros;
      const remaining = ledger.remainingBudgetMicros;
      const committed = settled + reserved;
      const pct = cap > 0 ? Math.min(100, Math.round((committed / cap) * 1000) / 10) : 0;
      const settledPct = cap > 0 ? Math.min(100, (settled / cap) * 100) : 0;
      const reservedPct = cap > 0 ? Math.min(Math.max(0, 100 - settledPct), (reserved / cap) * 100) : 0;

      const capLabel = state.projectFilter === 'all' ? '중앙 상한 ' : '프로젝트 상한 ';
      byId('kpi-compute-remaining').textContent = formatUsd(remaining);
      byId('kpi-compute-cap-detail').textContent = capLabel + formatUsd(cap) + ' · 사용률 ' + pct.toFixed(1) + '%';
      byId('kpi-compute-committed').textContent = formatUsd(committed);
      byId('kpi-compute-committed-detail').textContent =
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
      if (tbody) {
        tbody.replaceChildren();
        const entries = Array.isArray(ledger.jobs) ? [...ledger.jobs] : [];
        entries.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
        if (!entries.length) {
          const row = el('tr');
          const cell = el('td', '아직 Spot 컴퓨팅 비용 원장 기록이 없습니다.', 'empty-cell');
          cell.colSpan = 7;
          row.append(cell);
          tbody.append(row);
        } else {
          for (const entry of entries) {
            const row = el('tr', undefined, 'clickable-row');
            row.addEventListener('click', () => openDrawer('compute', entry.jobId));
            row.append(
              el('td', safeText(entry.jobId, 48), 'mono'),
              el('td', '[' + safeText(entry.projectId || 'default', 24) + '] ' + safeText(entry.workloadId || entry.modelId, 48)),
              (() => {
                const td = el('td');
                td.append(el('span', COMPUTE_STATUS[entry.status] || safeText(entry.status, 32), pillClass(entry.status)));
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
    }

    const deliveryBudgetSum = tasks.reduce((acc, t) => acc + (typeof t.budgetMicros === 'number' ? t.budgetMicros : 0), 0);
    const prCount = tasks.filter((t) => Boolean(t.publication)).length;
    byId('overview-delivery-budget').textContent =
      '총 ' + tasks.length + '건 · Draft PR ' + prCount + '건 · 승인 예산 합계 ' + formatUsd(deliveryBudgetSum) + ' (모델·Fargate 실청구 미확정)';
    renderStatusBadges(byId('overview-delivery-badges'), countByStatus(tasks), DELIVERY_STATUS);

    const runningInstances = jobs.filter((j) => j.instance && ['pending', 'running'].includes(j.instance.state)).length;
    byId('overview-compute-instances').textContent = '총 ' + jobs.length + '건 · 실행 중 EC2 스팟 인스턴스 ' + runningInstances + '대';
    renderStatusBadges(byId('overview-compute-badges'), countByStatus(jobs), COMPUTE_STATUS);

    byId('overview-collab-summary').textContent = '총 ' + sessions.length + '개 세션 · 활성 ' + collabActive + '개';
    renderStatusBadges(byId('overview-collab-badges'), countByStatus(sessions), COLLAB_STATUS);

    renderLiveStrip();
    renderInbox();
    renderCosts();
    renderSpotAdvisor();
    renderRecentEvents();
  }

  function renderSpotAdvisor() {
    const statusEl = byId('spot-advisor-status');
    const body = byId('spot-advisor-body');
    if (!body) return;
    body.replaceChildren();
    if (state.spotStatusText && statusEl) statusEl.textContent = state.spotStatusText;

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
        list.append(
          el(
            'li',
            safeText(c.region, 24) +
              (c.azId ? ' (' + safeText(c.azId, 24) + ')' : '') +
              ' · 점수 ' +
              (c.latestScore ?? '-') +
              ' · 단가 ' +
              (typeof c.latestPriceUsd === 'number' ? '$' + c.latestPriceUsd.toFixed(4) + '/hr' : '-') +
              (c.eligible ? ' · 적합' : ' · 제외 (' + safeText(c.rejectionReason || '조건 미달', 80) + ')'),
          ),
        );
      }
      body.append(list);
    }
  }

  function isErrorEvent(ev) {
    const hay = (String(ev.type || '') + ' ' + JSON.stringify(ev.data || {})).toLowerCase();
    return /fail|error|cancel|reject|interrupt|exceeded|expired|denied|forced/.test(hay);
  }

  function renderRecentEvents() {
    const list = byId('monitor-recent-events');
    if (!list) return;
    const { source, errorsOnly, query } = state.eventFilter;
    const q = query.trim().toLowerCase();

    const visibleTaskIds = new Set(visibleDeliveryTasks().map((t) => t.id));
    const visibleJobIds = new Set(visibleComputeJobs().map((j) => j.id));
    let merged = [
      ...state.projects.events
        .filter((e) => state.projectFilter === 'all' || e.projectId === state.projectFilter)
        .map((e) => ({ kind: 'project', sourceKey: 'projects', source: '프로젝트', id: e.projectId, type: e.type, at: e.at, data: e.data })),
      ...state.delivery.events
        .filter((e) => state.projectFilter === 'all' || visibleTaskIds.has(e.taskId))
        .map((e) => ({ kind: 'delivery', sourceKey: 'delivery', source: 'SW 전달', id: e.taskId, type: e.type, at: e.at, data: e.data })),
      ...state.compute.events
        .filter((e) => state.projectFilter === 'all' || visibleJobIds.has(e.jobId))
        .map((e) => ({ kind: 'compute', sourceKey: 'compute', source: 'Spot 컴퓨팅', id: e.jobId, type: e.type, at: e.at, data: e.data })),
    ];
    if (source !== 'all') merged = merged.filter((e) => e.sourceKey === source);
    if (errorsOnly) merged = merged.filter(isErrorEvent);
    if (q) {
      merged = merged.filter((e) =>
        (e.source + ' ' + e.id + ' ' + e.type + ' ' + JSON.stringify(e.data || {})).toLowerCase().includes(q),
      );
    }
    merged.sort((a, b) => Date.parse(b.at || '') - Date.parse(a.at || ''));
    merged = merged.slice(0, 40);

    const sig = JSON.stringify([source, errorsOnly, q, merged.map((e) => [e.kind, e.id, e.type, e.at])]);
    if (list.dataset.signature === sig) return;
    list.dataset.signature = sig;
    list.replaceChildren();
    if (!merged.length) {
      list.append(el('li', '조건에 맞는 이벤트가 없습니다.', 'empty'));
      return;
    }
    for (const ev of merged) {
      const li = el('li');
      const time = el('time', formatDate(ev.at));
      time.dateTime = safeText(ev.at, 40);
      const body = el('div');
      const titleLine = el('div', undefined, 'event-head');
      const idBtn = el('button', safeText(ev.id, 36), 'secondary compact-btn mono');
      idBtn.type = 'button';
      idBtn.addEventListener('click', () => openDrawer(ev.kind, ev.id));
      titleLine.append(
        el('span', ev.source, isErrorEvent(ev) ? 'pill tone-danger' : 'pill'),
        el('strong', safeText(ev.type, 80)),
        idBtn,
      );
      body.append(titleLine);
      if (ev.data && Object.keys(ev.data).length) {
        body.append(el('p', safeText(JSON.stringify(ev.data), 600)));
      }
      li.append(time, body);
      list.append(li);
    }
  }

  // ---------- RIGHT SLIDE-OVER DETAIL DRAWER ----------
  function openDrawer(kind, id) {
    state.drawer = { open: true, kind, id, fingerprint: null };
    if (kind === 'delivery') {
      const t = state.delivery.tasks.find((x) => x.id === id);
      state.drawer.fingerprint = t?.approvalFingerprint || null;
    } else if (kind === 'compute') {
      const j = state.compute.jobs.find((x) => x.id === id);
      state.drawer.fingerprint = j?.approvalFingerprint || null;
    } else if (kind === 'collab') {
      void selectCollab(id);
    }
    renderDrawer();
  }

  function closeDrawer() {
    state.drawer = { open: false, kind: null, id: null, fingerprint: null };
    const drawer = byId('detail-drawer');
    const backdrop = byId('drawer-backdrop');
    if (drawer) drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
  }

  function renderDrawer() {
    const drawer = byId('detail-drawer');
    const backdrop = byId('drawer-backdrop');
    if (!drawer || !backdrop) return;
    if (!state.drawer.open || !state.drawer.kind || !state.drawer.id) {
      drawer.hidden = true;
      backdrop.hidden = true;
      return;
    }
    drawer.hidden = false;
    backdrop.hidden = false;

    const kindEl = byId('drawer-kind');
    const statusEl = byId('drawer-status');
    const idEl = byId('drawer-id');
    const titleEl = byId('drawer-title');
    const stepperEl = byId('drawer-stepper');
    const bodyEl = byId('drawer-body');
    const ch = charts();
    bodyEl.replaceChildren();

    if (state.drawer.kind === 'delivery') {
      const task = state.delivery.tasks.find((t) => t.id === state.drawer.id);
      if (!task) {
        titleEl.textContent = '작업을 찾을 수 없습니다';
        return;
      }
      kindEl.textContent = 'SW 전달';
      statusEl.textContent = DELIVERY_STATUS[task.status] || task.status;
      statusEl.className = pillClass(task.status);
      idEl.textContent = safeText(task.id, 48);
      titleEl.textContent = safeText(task.title, 180);
      if (ch) ch.renderStepper(stepperEl, ch.deliverySteps(task));

      if (state.drawer.fingerprint && state.drawer.fingerprint !== task.approvalFingerprint) {
        state.drawer.fingerprint = task.approvalFingerprint;
        setError('검토 중인 SW 전달 작업의 approvalFingerprint가 변경되었습니다. 다시 검토하세요.');
      }

      const facts = el('dl', undefined, 'repository-facts');
      const add = (dt, dd, wide) => {
        const d = el('div', undefined, wide ? 'wide' : undefined);
        d.append(el('dt', dt), el('dd', dd));
        facts.append(d);
      };
      add('제공자 · 반복', safeText(task.provider, 24) + ' · ' + task.currentIteration + '/' + task.maxIterations);
      add('승인 예산', formatUsd(task.budgetMicros) + ' (모델·Fargate 미확정)');
      add('대상 저장소', safeText(task.delivery?.repository, 160) + ' (' + safeText(task.delivery?.baseBranch, 48) + ')');
      add('리전 · 스팟 재시도', (task.activeRegion || '미배정') + ' · ' + task.spotRetriesUsed + '/' + (task.spot?.maxSpotRetries ?? 0));
      if (task.publication) {
        const pubRow = el('div', undefined, 'wide');
        pubRow.append(el('dt', 'Draft PR'));
        const dd = el('dd');
        dd.append(safeHttpsLink(task.publication.prUrl, 'PR #' + task.publication.prNumber + ' · ' + task.publication.branchName));
        pubRow.append(dd);
        facts.append(pubRow);
      }
      if (task.latestAttestation) {
        const att = task.latestAttestation;
        const matched = task.publication ? task.publication.prTreeHash === att.verifiedTreeHash : null;
        add(
          '독립 검증 증명',
          (att.checksPassed ? '통과' : '실패') +
            ' · 수용 테스트 무수정 ' +
            (att.acceptancePathsUnmodified ? '확인' : '위반') +
            (matched !== null ? ' · 트리 해시 ' + (matched ? '3자 일치' : '불일치') : ''),
          true,
        );
      }
      bodyEl.append(facts);

      if (!DELIVERY_TERMINAL.has(task.status)) {
        const panel = el('section', undefined, 'decision-panel');
        const awaitingApproval = task.status === 'awaiting_approval';
        const awaitingHuman = task.status === 'draft_pr_published';
        panel.append(
          el('h3', awaitingApproval ? '실행 승인' : awaitingHuman ? 'Draft PR 검토 결정' : '작업 제어'),
          el(
            'p',
            awaitingApproval
              ? '승인 시 Fargate Spot 워커가 기동되어 실제 모델 호출 및 독립 검증을 수행합니다.'
              : awaitingHuman
                ? '검토 이력을 기록합니다. Git 자동 병합·푸시는 수행하지 않습니다.'
                : '사유를 입력해 작업을 중단할 수 있습니다.',
          ),
        );
        if (awaitingApproval) panel.append(el('p', 'approvalFingerprint: ' + safeText(task.approvalFingerprint, 64), 'fingerprint-box'));
        const form = el('form');
        const reasonInput = el('textarea');
        reasonInput.rows = 2;
        reasonInput.maxLength = 2000;
        reasonInput.required = true;
        reasonInput.placeholder = '승인·반려·중단 사유를 입력하세요.';
        const lbl = el('label', '결정 사유');
        lbl.append(reasonInput);
        form.append(lbl);

        let openedDiffCheck = null;
        let durationInput = null;
        if (awaitingHuman) {
          openedDiffCheck = el('input');
          openedDiffCheck.type = 'checkbox';
          const cbLbl = el('label', undefined, 'checkbox-label');
          cbLbl.append(openedDiffCheck, el('span', 'Git diff를 직접 열어 확인함 (openedDiff)'));
          durationInput = el('input');
          durationInput.type = 'number';
          durationInput.value = '1';
          durationInput.step = '0.1';
          durationInput.min = '0';
          const durLbl = el('label', '소요 시간 (분)', 'compact-input');
          durLbl.append(durationInput);
          form.append(cbLbl, durLbl);
        }

        const actions = el('div', undefined, 'actions');
        const addBtn = (text, val, cls) => {
          const b = el('button', text, cls);
          b.type = 'submit';
          b.value = val;
          b.disabled = state.busy;
          actions.append(b);
        };
        if (awaitingApproval) addBtn('실행 승인 (Fargate Spot 기동)', 'approve');
        if (awaitingHuman) {
          addBtn('Draft PR 승인 기록', 'human_approve');
          addBtn('Draft PR 반려 기록', 'human_reject', 'secondary');
        }
        addBtn('작업 중단', 'cancel', 'danger');
        form.append(actions);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const op = e.submitter?.value;
          const reason = reasonInput.value.trim();
          if (!reason) {
            setError('결정 사유를 입력하세요.');
            return;
          }
          const encId = encodeURIComponent(task.id);
          if (op === 'approve') {
            return runMutation(() => monitorApi('/api/delivery/tasks/' + encId + '/approve', { approvalFingerprint: task.approvalFingerprint, reason }, 35000), 'SW 전달 작업 실행을 승인했습니다.');
          }
          if (op === 'cancel') {
            return runMutation(() => monitorApi('/api/delivery/tasks/' + encId + '/cancel', { reason }, 35000), 'SW 전달 작업을 중단했습니다.');
          }
          if (op === 'human_approve' || op === 'human_reject') {
            return runMutation(
              () =>
                monitorApi('/api/delivery/tasks/' + encId + '/human-decision', {
                  decision: op === 'human_approve' ? 'approve' : 'reject',
                  openedDiff: Boolean(openedDiffCheck?.checked),
                  durationMinutes: Number(durationInput?.value || 0),
                  reason,
                }),
              op === 'human_approve' ? 'Draft PR 승인 검토 이력을 기록했습니다.' : 'Draft PR 반려 검토 이력을 기록했습니다.',
            );
          }
        });
        panel.append(form);
        bodyEl.append(panel);
      }

      bodyEl.append(el('h3', '지시 내용'), el('p', safeText(task.instructions, 3000), 'instructions'));
    } else if (state.drawer.kind === 'compute') {
      const job = state.compute.jobs.find((j) => j.id === state.drawer.id);
      if (!job) {
        titleEl.textContent = '작업을 찾을 수 없습니다';
        return;
      }
      kindEl.textContent = 'Spot 컴퓨팅 · ' + safeText(job.projectId || 'default', 32);
      statusEl.textContent = COMPUTE_STATUS[job.status] || job.status;
      statusEl.className = pillClass(job.status);
      idEl.textContent = safeText(job.id, 48);
      titleEl.textContent = safeText(job.title, 180);
      if (ch) ch.renderStepper(stepperEl, ch.computeSteps(job));

      if (state.drawer.fingerprint && state.drawer.fingerprint !== job.approvalFingerprint) {
        state.drawer.fingerprint = job.approvalFingerprint;
        setError('검토 중인 Spot 컴퓨팅 작업의 approvalFingerprint가 변경되었습니다. 다시 검토하세요.');
      }

      if (job.releaseAttestation?.verificationDisclaimer) {
        bodyEl.append(el('p', safeText(job.releaseAttestation.verificationDisclaimer, 400), 'evidence-warning'));
      }

      const facts = el('dl', undefined, 'repository-facts');
      const add = (dt, dd, wide) => {
        const d = el('div', undefined, wide ? 'wide' : undefined);
        d.append(el('dt', dt), el('dd', dd));
        facts.append(d);
      };
      add('프로젝트 · 워크로드', safeText(job.projectId || 'default', 48) + ' / ' + safeText(job.workloadId || job.modelId, 80));
      add('컴퓨트', safeText(job.compute?.instanceType, 32) + ' · ' + safeText(job.instance?.region || job.compute?.region, 24));
      add('예약 상한', formatUsd(job.cost?.reservedMicros));
      add('정산 추정 (실청구 아님)', job.cost?.settledMicros === null ? '미정산' : formatUsd(job.cost?.settledMicros));
      if (job.instance) {
        add('EC2 스팟 상태', safeText(job.instance.instanceId, 32) + ' · ' + (EC2_STATE[job.instance.state] || job.instance.state));
        add('TTL 만료', formatTtl(job.instance.expiresAt));
      }
      if (job.placementPlan) {
        add('배치 계획', safeText(job.placementPlan.status, 24) + ' · ' + safeText(job.placementPlan.note, 200), true);
      }
      if (job.publication?.url) {
        const row = el('div', undefined, 'wide');
        row.append(el('dt', '공개 결과'));
        const dd = el('dd');
        dd.append(safeHttpsLink(job.publication.url, job.publication.url));
        row.append(dd);
        facts.append(row);
      }
      bodyEl.append(facts);

      if (!COMPUTE_TERMINAL.has(job.status)) {
        const panel = el('section', undefined, 'decision-panel');
        const awaitingLaunch = job.status === 'awaiting_launch_approval' || job.status === 'awaiting_training_approval';
        const awaitingRelease = job.status === 'awaiting_release_approval';
        panel.append(
          el('h3', awaitingLaunch ? '기동 승인' : awaitingRelease ? '공개 승인' : '작업 제어'),
          el(
            'p',
            awaitingLaunch
              ? '승인 시 프로젝트·중앙 예산을 예약하고 EC2 스팟 인스턴스를 기동합니다.'
              : awaitingRelease
                ? '검증 근거와 다이제스트를 확인한 뒤 공개 여부를 결정하세요.'
                : '상태를 점검(Wake)하거나 사유를 적어 작업을 중단할 수 있습니다.',
          ),
        );
        if (awaitingLaunch) panel.append(el('p', 'approvalFingerprint: ' + safeText(job.approvalFingerprint, 64), 'fingerprint-box'));

        const form = el('form');
        const reasonInput = el('textarea');
        reasonInput.rows = 2;
        reasonInput.maxLength = 2000;
        reasonInput.required = true;
        reasonInput.placeholder = '승인·반려·중단 사유를 입력하세요.';
        const lbl = el('label', '결정 사유');
        lbl.append(reasonInput);
        form.append(lbl);

        let openedRawCheck = null;
        let durationInput = null;
        if (awaitingRelease) {
          openedRawCheck = el('input');
          openedRawCheck.type = 'checkbox';
          const cbLbl = el('label', undefined, 'checkbox-label');
          cbLbl.append(openedRawCheck, el('span', '원본 산출물을 직접 열람함 (openedRawArtifacts)'));
          durationInput = el('input');
          durationInput.type = 'number';
          durationInput.value = '1';
          durationInput.step = '0.1';
          durationInput.min = '0';
          const durLbl = el('label', '소요 시간 (분)', 'compact-input');
          durLbl.append(durationInput);
          form.append(cbLbl, durLbl);
        }

        const actions = el('div', undefined, 'actions');
        const addBtn = (text, val, cls) => {
          const b = el('button', text, cls);
          b.type = 'submit';
          b.value = val;
          b.disabled = state.busy;
          actions.append(b);
        };
        if (awaitingLaunch) addBtn('기동 승인 (예산 예약·EC2 Spot 기동)', 'approve_launch');
        if (awaitingRelease) {
          addBtn('공개 승인', 'approve_release');
          addBtn('공개 반려', 'reject_release', 'secondary');
        }
        addBtn('작업 중단', 'cancel', 'danger');
        form.append(actions);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const op = e.submitter?.value;
          const reason = reasonInput.value.trim();
          if (!reason) {
            setError('결정 사유를 입력하세요.');
            return;
          }
          const encId = encodeURIComponent(job.id);
          if (op === 'approve_launch') {
            return runMutation(() => monitorApi('/api/compute/jobs/' + encId + '/approve', { approvalFingerprint: job.approvalFingerprint, reason }, 35000), 'Spot 컴퓨팅 작업 기동을 승인했습니다.');
          }
          if (op === 'cancel') {
            return runMutation(() => monitorApi('/api/compute/jobs/' + encId + '/cancel', { reason }, 35000), 'Spot 컴퓨팅 작업을 중단했습니다.');
          }
          if (op === 'approve_release' || op === 'reject_release') {
            return runMutation(
              () =>
                monitorApi('/api/compute/jobs/' + encId + '/approve-release', {
                  decision: op === 'approve_release' ? 'approve' : 'reject',
                  openedRawArtifacts: Boolean(openedRawCheck?.checked),
                  durationMinutes: Number(durationInput?.value || 0),
                  reason,
                }, 60000),
              op === 'approve_release' ? '산출물 공개를 승인했습니다.' : '산출물 공개를 반려했습니다.',
            );
          }
        });
        panel.append(form);
        bodyEl.append(panel);
      }
    } else if (state.drawer.kind === 'project') {
      const project = state.projects.list.find((p) => p.id === state.drawer.id);
      if (!project) {
        titleEl.textContent = '프로젝트를 찾을 수 없습니다';
        return;
      }
      kindEl.textContent = '호스트 프로젝트';
      statusEl.textContent = PROJECT_STATUS[project.status] || project.status;
      statusEl.className = project.status === 'active' ? 'pill tone-success' : project.status === 'paused' ? 'pill tone-attention' : 'pill';
      idEl.textContent = safeText(project.id, 64);
      titleEl.textContent = safeText(project.name, 120);
      stepperEl.replaceChildren();

      const facts = el('dl', undefined, 'repository-facts');
      const add = (dt, dd, wide) => {
        const d = el('div', undefined, wide ? 'wide' : undefined);
        d.append(el('dt', dt), el('dd', dd));
        facts.append(d);
      };
      add('템플릿', safeText(project.template, 32));
      add('컴퓨팅 예산 상한', formatUsd(project.budget?.computeBudgetCapMicros));
      add('단일 작업 상한', project.budget?.maxSingleJobCostMicros ? formatUsd(project.budget.maxSingleJobCostMicros) : '제한 없음');
      add('허용 리전', (project.compute?.allowedRegions || []).join(', ') || '-');
      add('허용 저장소', (project.delivery?.repositories || []).join(', ') || '미지정', true);
      add('S3 네임스페이스', (project.compute?.s3ArtifactPrefixes || []).join(', ') || '-', true);
      bodyEl.append(facts);

      const ctrl = el('section', undefined, 'decision-panel');
      ctrl.append(el('h3', '프로젝트 상태 및 전용 토큰'));
      const statusActions = el('div', undefined, 'actions');
      const toggleBtn = el('button', project.status === 'active' ? '프로젝트 일시정지' : '프로젝트 재개', project.status === 'active' ? 'secondary' : undefined);
      toggleBtn.type = 'button';
      toggleBtn.disabled = state.busy;
      toggleBtn.addEventListener('click', () => {
        const nextStatus = project.status === 'active' ? 'paused' : 'active';
        return runMutation(
          () => monitorApi('/api/projects/' + encodeURIComponent(project.id), { status: nextStatus }, 15000, 'PATCH'),
          nextStatus === 'paused' ? '프로젝트를 일시정지했습니다.' : '프로젝트를 재개했습니다.',
        );
      });
      statusActions.append(toggleBtn);
      ctrl.append(statusActions);

      const tokForm = el('form');
      const labelInput = el('input');
      labelInput.type = 'text';
      labelInput.required = true;
      labelInput.maxLength = 80;
      labelInput.placeholder = '예: ci-agent, autonomy-loop';
      const lbl = el('label', '새 프로젝트 전용 에이전트 토큰 라벨');
      lbl.append(labelInput);
      const issueBtn = el('button', '전용 토큰 발급 (1회 표시)', 'compact-btn');
      issueBtn.type = 'submit';
      issueBtn.disabled = state.busy || project.status === 'archived';
      tokForm.append(lbl, issueBtn);
      tokForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const label = labelInput.value.trim();
        if (!label) return;
        return runMutation(
          async () => {
            const issued = await monitorApi('/api/projects/' + encodeURIComponent(project.id) + '/tokens', { label }, 15000, 'POST');
            labelInput.value = '';
            showOneTimeTokenBanner(project.id, issued);
            switchTab('projects');
            return issued;
          },
          '프로젝트 전용 에이전트 토큰을 발급했습니다. 프로젝트 화면 상단 배너에서 1회 확인하세요.',
        );
      });
      ctrl.append(tokForm);
      bodyEl.append(ctrl);

      bodyEl.append(el('h3', '발급된 토큰 (' + (project.tokens || []).length + '개)'));
      if (!project.tokens || !project.tokens.length) {
        bodyEl.append(el('p', '발급된 프로젝트 전용 에이전트 토큰이 없습니다.', 'empty'));
      } else {
        for (const tok of project.tokens) {
          const row = el('div', undefined, 'token-row');
          const info = el('div');
          info.append(
            el('strong', safeText(tok.label, 64) + ' (' + safeText(tok.tokenPrefix, 16) + '…)'),
            el('p', safeText((tok.scopes || []).join(', '), 200) + (tok.revokedAt ? ' · 폐기됨' : ''), 'help mono'),
          );
          row.append(info);
          if (!tok.revokedAt) {
            const revBtn = el('button', '폐기', 'danger compact-btn');
            revBtn.type = 'button';
            revBtn.disabled = state.busy;
            revBtn.addEventListener('click', () =>
              runMutation(
                () => monitorApi('/api/projects/' + encodeURIComponent(project.id) + '/tokens/' + encodeURIComponent(tok.tokenId), { reason: 'Revoked from dashboard' }, 15000, 'DELETE'),
                '토큰을 폐기했습니다.',
              ),
            );
            row.append(revBtn);
          }
          bodyEl.append(row);
        }
      }
    } else if (state.drawer.kind === 'collab') {
      const session =
        (state.collab.snapshot?.session?.id === state.drawer.id ? state.collab.snapshot.session : null) ||
        state.collab.sessions.find((s) => s.id === state.drawer.id);
      if (!session) {
        titleEl.textContent = '협업 세션을 찾을 수 없습니다';
        return;
      }
      const subtasks = state.collab.snapshot?.session?.id === session.id ? state.collab.snapshot.subtasks || [] : [];
      kindEl.textContent = '병렬 협업';
      statusEl.textContent = COLLAB_STATUS[session.status] || session.status;
      statusEl.className = pillClass(session.status);
      idEl.textContent = safeText(session.id, 48);
      titleEl.textContent = safeText(session.title, 180);
      if (ch) ch.renderStepper(stepperEl, ch.collabSteps(session, subtasks));

      bodyEl.append(el('p', safeText(session.goal, 2000), 'instructions'));
      const subHead = el('h3', '하위 작업 (' + subtasks.length + '건)');
      bodyEl.append(subHead);
      if (!subtasks.length) {
        bodyEl.append(el('p', '하위 작업 정보를 불러오는 중이거나 등록된 항목이 없습니다.', 'empty'));
      } else {
        for (const st of subtasks) {
          const card = el('div', undefined, 'subtask-card');
          const row = el('div', undefined, 'subtask-head');
          row.append(el('strong', safeText(st.title, 120)), el('span', SUBTASK_STATUS[st.status] || st.status, pillClass(st.status)));
          card.append(row, el('p', (st.assignedAgentId || '미배정') + ' · ' + (st.region || '-'), 'help'));
          bodyEl.append(card);
        }
      }
    }
  }

  // ---------- SW DELIVERY ----------
  function filterDelivery(tasks) {
    let out = tasks;
    if (state.deliveryFilter === 'active') out = out.filter((t) => DELIVERY_ACTIVE.has(t.status));
    else if (state.deliveryFilter === 'attention') out = out.filter((t) => DELIVERY_ATTENTION.has(t.status));
    else if (state.deliveryFilter === 'terminal') out = out.filter((t) => DELIVERY_TERMINAL.has(t.status));
    const q = state.deliverySearch.trim().toLowerCase();
    if (q) out = out.filter((t) => (t.id + ' ' + t.title + ' ' + t.provider + ' ' + (t.delivery?.repository || '')).toLowerCase().includes(q));
    return out;
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
    const allTasks = visibleDeliveryTasks();
    const filtered = filterDelivery(allTasks);
    byId('delivery-count-label').textContent = filtered.length + '건 / 전체 ' + allTasks.length + '건';

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

    if (state.selectedDeliveryFingerprint && state.selectedDeliveryFingerprint !== task.approvalFingerprint) {
      state.selectedDeliveryFingerprint = task.approvalFingerprint;
      byId('dlv-reason').value = '';
      setError('선택한 SW 전달 작업의 승인 지문(approvalFingerprint)이 변경되었습니다. 내용을 다시 검토한 뒤 사유를 입력하세요.');
    }

    const ch = charts();
    if (ch) ch.renderStepper(byId('dlv-stepper'), ch.deliverySteps(task));

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

    const isTerminal = DELIVERY_TERMINAL.has(task.status);
    byId('dlv-action-section').hidden = isTerminal;
    if (!isTerminal) {
      const awaitingApproval = task.status === 'awaiting_approval';
      const awaitingHuman = task.status === 'draft_pr_published';
      byId('dlv-action-title').textContent = awaitingApproval ? '실행 승인이 필요합니다' : awaitingHuman ? 'Draft PR 결과를 검토해 주세요' : '작업을 감독하고 있습니다';
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

    byId('dlv-test-cmd').textContent = task.acceptance?.testCommand ? safeText(JSON.stringify(task.acceptance.testCommand), 400) : '미보고';
    byId('dlv-acceptance-digest').textContent = safeText(task.acceptance?.digest, 64) || '미보고';
    const att = task.latestAttestation;
    byId('dlv-attest-status').textContent = att
      ? (att.checksPassed ? '통과' : '실패') + ' · 수용 테스트 무수정 ' + (att.acceptancePathsUnmodified ? '확인' : '위반') + ' · 종료 코드 ' + (att.exitCode === null ? '없음' : att.exitCode) + ' · ' + (att.durationMs / 1000).toFixed(2) + '초'
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
          ul.append(el('li', safeText(f.path, 200) + (f.binary ? ' (binary)' : ' (+' + (f.insertions ?? 0) + ' / -' + (f.deletions ?? 0) + ')'), 'mono'));
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
      ? (pf.ok ? '통과' : '실패') + ' · CLI ' + (pf.cliVersion ? safeText(pf.cliVersion, 64) : '미보고') + ' · auth ' + (pf.authReady ? 'OK' : '미준비') + ' · git ' + (pf.gitReady ? 'OK' : '미준비') + (pf.reason ? ' · ' + safeText(pf.reason, 200) : '')
      : '프리플라이트 기록 없음';

    const taskEvents = state.delivery.events.filter((e) => e.taskId === task.id).sort((a, b) => b.sequence - a.sequence);
    renderEntityEvents(byId('dlv-events'), taskEvents);
  }

  // ---------- SPOT COMPUTE ----------
  function filterCompute(jobs) {
    let out = jobs;
    if (state.computeFilter === 'active') out = out.filter((j) => COMPUTE_ACTIVE.has(j.status));
    else if (state.computeFilter === 'attention') out = out.filter((j) => COMPUTE_ATTENTION.has(j.status));
    else if (state.computeFilter === 'terminal') out = out.filter((j) => COMPUTE_TERMINAL.has(j.status));
    const q = state.computeSearch.trim().toLowerCase();
    if (q) {
      out = out.filter((j) =>
        (j.id + ' ' + (j.projectId || '') + ' ' + j.title + ' ' + (j.workloadId || j.modelId || '') + ' ' + (j.compute?.region || '') + ' ' + (j.compute?.instanceType || ''))
          .toLowerCase()
          .includes(q),
      );
    }
    return out;
  }

  function selectComputeJob(id) {
    if (state.busy) return;
    state.selectedComputeId = id;
    const job = state.compute.jobs.find((j) => j.id === id);
    state.selectedComputeFingerprint = job?.approvalFingerprint || null;
    if (byId('cmp-reason')) byId('cmp-reason').value = '';
    renderCompute();
  }

  function renderCompute() {
    const ledger = visibleLedger();
    if (byId('compute-inline-budget')) {
      byId('compute-inline-budget').textContent = ledger
        ? '잔여 ' + formatUsd(ledger.remainingBudgetMicros) + ' / 상한 ' + formatUsd(ledger.globalBudgetCapMicros)
        : '예산 확인 중';
    }

    const filtered = filterCompute(visibleComputeJobs());
    const list = byId('compute-list');
    const existing = new Map(Array.from(list.querySelectorAll('button')).map((b) => [b.dataset.jobId, b]));
    list.querySelectorAll('.empty').forEach((n) => n.remove());
    for (const job of filtered) {
      let btn = existing.get(job.id);
      if (!btn) {
        btn = el('button');
        btn.type = 'button';
        btn.dataset.jobId = job.id;
        btn.addEventListener('click', () => selectComputeJob(job.id));
        const meta = el('span', undefined, 'task-meta');
        meta.append(el('span'), el('small'));
        btn.append(el('strong'), meta);
        list.append(btn);
      }
      existing.delete(job.id);
      const selected = job.id === state.selectedComputeId;
      btn.className = 'task-choice' + (selected ? ' selected' : '');
      btn.setAttribute('aria-pressed', String(selected));
      btn.disabled = state.busy;
      btn.firstChild.textContent = safeText(job.title, 160);
      btn.lastChild.firstChild.className = pillClass(job.status);
      btn.lastChild.firstChild.textContent = COMPUTE_STATUS[job.status] || safeText(job.status, 32);
      const costText =
        job.cost?.settledMicros !== null && job.cost?.settledMicros !== undefined
          ? '정산 ' + formatUsd(job.cost.settledMicros)
          : '예약 ' + formatUsd(job.cost?.reservedMicros);
      btn.lastChild.lastChild.textContent =
        '[' + safeText(job.projectId || 'default', 24) + '] ' + safeText(job.compute?.instanceType, 24) + ' · ' + costText;
    }
    existing.forEach((b) => b.remove());
    if (!filtered.length) list.append(el('p', '조건에 맞는 Spot 컴퓨팅 작업이 없습니다.', 'empty'));

    const job = state.compute.jobs.find((j) => j.id === state.selectedComputeId) || null;
    byId('compute-empty').hidden = Boolean(job);
    byId('compute-detail').hidden = !job;
    if (!job) return;

    if (state.selectedComputeFingerprint && state.selectedComputeFingerprint !== job.approvalFingerprint) {
      state.selectedComputeFingerprint = job.approvalFingerprint;
      byId('cmp-reason').value = '';
      setError('선택한 Spot 컴퓨팅 작업의 승인 지문(approvalFingerprint)이 변경되었습니다. 범위를 다시 검토하세요.');
    }

    const ch = charts();
    if (ch) ch.renderStepper(byId('cmp-stepper'), ch.computeSteps(job));

    byId('cmp-id').textContent = safeText(job.id, 64);
    byId('cmp-title').textContent = safeText(job.title, 200);
    byId('cmp-status').textContent = COMPUTE_STATUS[job.status] || safeText(job.status, 32);
    byId('cmp-status').className = pillClass(job.status);

    const waitEl = byId('cmp-wait-reason');
    waitEl.hidden = !job.waitReason;
    waitEl.textContent = job.waitReason ? '대기 사유: ' + (WAIT_REASON[job.waitReason] || safeText(job.waitReason, 160)) : '';

    byId('cmp-workload-id').textContent =
      safeText(job.projectId || 'default', 48) + ' · ' + safeText(job.workloadId || job.modelId, 80) + ' (' + safeText(job.workloadKind || 'batch', 24) + ')';
    byId('cmp-repo').textContent = safeText(job.repository, 160) + ' @ ' + safeText(job.baseCommit, 12);
    byId('cmp-compute').textContent = safeText(job.compute?.instanceType, 40) + ' · ' + safeText(job.compute?.region, 32);
    byId('cmp-reserved').textContent = formatUsd(job.cost?.reservedMicros);
    byId('cmp-settled').textContent =
      job.cost?.settledMicros === null || job.cost?.settledMicros === undefined
        ? '미정산 (실행 종료 후 정산)'
        : formatUsd(job.cost.settledMicros) + (job.cost.settledAt ? ' · ' + formatDate(job.cost.settledAt) : '');
    byId('cmp-rate').textContent =
      '$' + Number(job.cost?.hourlyRateUsd ?? job.compute?.maxHourlyPriceUsd ?? 0).toFixed(4) + '/hr · ' + formatDurationSec(job.cost?.instanceSeconds);
    byId('cmp-release-policy').textContent =
      safeText(job.releasePolicy?.mode, 32) +
      ' · ' +
      safeText(job.releasePolicy?.visibility, 16) +
      (job.releasePolicy?.hfRepository ? ' · ' + safeText(job.releasePolicy.hfRepository, 120) : '');
    byId('cmp-next-wake').textContent = job.nextWakeAt ? formatDate(job.nextWakeAt) : '예정 없음';
    byId('cmp-updated').textContent = formatDate(job.updatedAt);

    const outcome = byId('cmp-outcome-banner');
    if (job.failureReason) {
      outcome.textContent = '실패 사유: ' + safeText(job.failureReason, 500);
      outcome.hidden = false;
    } else if (job.cancelReason) {
      outcome.textContent = '중단 사유: ' + safeText(job.cancelReason, 500);
      outcome.hidden = false;
    } else if (job.releaseDecision) {
      outcome.textContent =
        '공개 결정: ' + (job.releaseDecision.decision === 'approve' ? '승인' : '반려') + ' · 원본 열람 ' + (job.releaseDecision.openedRawArtifacts ? '예' : '아니오') + ' · ' + safeText(job.releaseDecision.reason, 400);
      outcome.hidden = false;
    } else {
      outcome.hidden = true;
    }

    const isTerminal = COMPUTE_TERMINAL.has(job.status);
    byId('cmp-action-section').hidden = isTerminal;
    if (!isTerminal) {
      const awaitingLaunch = job.status === 'awaiting_launch_approval' || job.status === 'awaiting_training_approval';
      const runningJob = job.status === 'running' || job.status === 'training_running';
      const evaluating = job.status === 'evaluating';
      const awaitingRelease = job.status === 'awaiting_release_approval';

      byId('cmp-action-title').textContent = awaitingLaunch ? '기동 승인이 필요합니다' : awaitingRelease ? '산출물 공개 승인이 필요합니다' : evaluating ? '산출물 검증 단계입니다' : '컴퓨팅 작업을 감독하고 있습니다';
      byId('cmp-action-desc').textContent = awaitingLaunch
        ? '승인하면 프로젝트·중앙 예산에서 예약 상한을 확보하고 EC2 스팟 인스턴스를 기동합니다.'
        : awaitingRelease
          ? job.releasePolicy?.mode === 'hf_release' && job.releasePolicy?.visibility === 'public'
            ? '주의: 공개(public) Hugging Face 저장소로 산출물이 게시됩니다. 검증 근거와 다이제스트를 확인한 뒤 승인하세요.'
            : '검증 근거와 다이제스트를 확인한 뒤 공개 승인 또는 반려를 결정하세요.'
          : evaluating
            ? '독립 검증기를 기동해 S3 산출물과 승인된 releaseCheckCommand를 검증할 수 있습니다.'
            : '인스턴스 상태를 확인(Wake)하거나 사유를 적어 작업을 중단하고 인스턴스를 종료할 수 있습니다.';

      const fpRow = byId('cmp-fingerprint-row');
      fpRow.hidden = !awaitingLaunch;
      fpRow.textContent = awaitingLaunch ? '승인 지문 (approvalFingerprint): ' + safeText(job.approvalFingerprint, 64) : '';
      byId('cmp-quick-actions').hidden = !runningJob && !evaluating;
      byId('cmp-btn-wake').hidden = !runningJob;
      byId('cmp-btn-wake').disabled = state.busy;
      byId('cmp-btn-verifier').hidden = !evaluating || !job.receipt;
      byId('cmp-btn-verifier').disabled = state.busy;
      byId('cmp-release-fields').hidden = !awaitingRelease;
      byId('cmp-btn-approve-launch').hidden = !awaitingLaunch;
      byId('cmp-btn-approve-release').hidden = !awaitingRelease;
      byId('cmp-btn-reject-release').hidden = !awaitingRelease;
      byId('cmp-btn-cancel').hidden = false;
      for (const b of byId('cmp-action-form').querySelectorAll('button')) b.disabled = state.busy;
    }

    const inst = job.instance;
    const instPill = byId('cmp-instance-state');
    if (inst) {
      instPill.textContent = EC2_STATE[inst.state] || safeText(inst.state, 24);
      instPill.className = inst.state === 'running' ? 'pill tone-running' : inst.state === 'terminated' ? 'pill' : 'pill tone-attention';
      byId('cmp-inst-id').textContent = safeText(inst.instanceId, 40) + ' (' + safeText(inst.instanceType, 32) + ')';
      byId('cmp-inst-az').textContent = safeText(inst.region, 32) + (inst.availabilityZone ? ' / ' + safeText(inst.availabilityZone, 32) : '');
      byId('cmp-inst-launched').textContent = formatDate(inst.launchedAt);
      byId('cmp-inst-expires').textContent = formatTtl(inst.expiresAt);
      byId('cmp-inst-terminated').textContent = inst.terminatedAt ? formatDate(inst.terminatedAt) : '실행 중 또는 미종료';
      byId('cmp-inst-forced').textContent = inst.forcedTerminationReason ? safeText(inst.forcedTerminationReason, 240) : '없음';
    } else {
      instPill.textContent = '미기동';
      instPill.className = 'pill';
      byId('cmp-inst-id').textContent = '기동된 인스턴스 없음';
      byId('cmp-inst-az').textContent = '미배정';
      byId('cmp-inst-launched').textContent = '-';
      byId('cmp-inst-expires').textContent = '-';
      byId('cmp-inst-terminated').textContent = '-';
      byId('cmp-inst-forced').textContent = '없음';
    }

    const diagBlock = byId('cmp-diagnostics-block');
    const diagList = byId('cmp-diagnostics-list');
    diagList.replaceChildren();
    if (Array.isArray(job.diagnostics) && job.diagnostics.length) {
      diagBlock.hidden = false;
      for (const d of job.diagnostics) diagList.append(el('li', safeText(d, 500)));
    } else {
      diagBlock.hidden = true;
    }

    const plan = job.placementPlan;
    const planPill = byId('cmp-plan-status');
    const planRegions = byId('cmp-plan-regions');
    planRegions.replaceChildren();
    if (plan) {
      planPill.textContent = safeText(plan.status, 32);
      planPill.className = plan.status === 'ranked' ? 'pill tone-success' : 'pill tone-attention';
      byId('cmp-plan-note').textContent =
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
      byId('cmp-plan-note').textContent = '배치 계획 기록이 없습니다.';
    }

    const receipt = job.receipt;
    byId('cmp-receipt-path').textContent = receipt ? 's3://' + safeText(receipt.s3Bucket, 128) + '/' + safeText(receipt.s3Prefix, 300) : '아직 영수증이 기록되지 않았습니다.';
    byId('cmp-receipt-digest').textContent = receipt ? safeText(receipt.manifestDigest, 64) : '미보고';
    byId('cmp-receipt-files').textContent = receipt ? receipt.files.length + '개 (' + formatBytes(receipt.files.reduce((sum, f) => sum + (f.sizeBytes || 0), 0)) + ')' : '0개';
    byId('cmp-verifier-info').textContent = job.releaseVerifier ? safeText(job.releaseVerifier.ecsTaskArn, 180) + ' · ' + formatDate(job.releaseVerifier.dispatchedAt) : '미기동';

    const att = job.releaseAttestation;
    const attPill = byId('cmp-attest-source');
    const attDisc = byId('cmp-attest-disclaimer');
    if (att) {
      const independent = att.attestationSource === 'independent_verifier';
      attPill.textContent = independent ? '독립 검증기 증명' : '운영자 직접 보고 (비독립)';
      attPill.className = independent ? 'pill tone-success' : 'pill tone-attention';
      attDisc.hidden = !att.verificationDisclaimer;
      attDisc.textContent = att.verificationDisclaimer ? safeText(att.verificationDisclaimer, 400) : '';
      byId('cmp-attest-result').textContent = (att.releaseCheckPassed ? '통과' : '실패') + ' · ' + formatDate(att.verifiedAt);
      const metricsStr = att.metrics && Object.keys(att.metrics).length ? JSON.stringify(att.metrics) + '\n' : '';
      byId('cmp-attest-summary').textContent = safeText(metricsStr + att.summary, 2000);
    } else {
      attPill.textContent = '미검증';
      attPill.className = 'pill';
      attDisc.hidden = true;
      byId('cmp-attest-result').textContent = '아직 검증 결과가 없습니다.';
      byId('cmp-attest-summary').textContent = '없음';
    }

    const pubInfo = byId('cmp-pub-info');
    pubInfo.replaceChildren();
    if (job.publication) {
      const p = job.publication;
      pubInfo.append(el('span', safeText(p.mode, 32) + (p.repository ? ' · ' + safeText(p.repository, 120) : '') + (p.commitSha ? ' @ ' + safeText(p.commitSha, 16) : '') + ' · '));
      if (p.url) pubInfo.append(safeHttpsLink(p.url, p.url));
      else pubInfo.append(el('span', formatDate(p.publishedAt), 'quiet'));
    } else {
      pubInfo.append(el('span', '아직 공개되지 않았습니다.', 'quiet'));
    }

    const jobEvents = state.compute.events.filter((e) => e.jobId === job.id).sort((a, b) => b.sequence - a.sequence);
    renderEntityEvents(byId('cmp-events'), jobEvents);
  }

  // ---------- COLLAB SESSIONS ----------
  async function selectCollab(id) {
    if (state.busy) return;
    const epoch = ++state.collab.epoch;
    state.collab.selectedId = id;
    state.collab.snapshot = null;
    renderCollab();
    if (state.drawer.open && state.drawer.kind === 'collab') renderDrawer();
    try {
      const snapshot = await monitorApi('/api/collab/sessions/' + encodeURIComponent(id));
      if (epoch === state.collab.epoch && state.collab.selectedId === id) {
        state.collab.snapshot = snapshot;
        renderCollab();
        if (state.drawer.open && state.drawer.kind === 'collab') renderDrawer();
      }
    } catch (err) {
      if (epoch === state.collab.epoch) setError('협업 세션 상세 조회 실패: ' + err.message);
    }
  }

  function renderCollab() {
    const sessions = visibleCollabSessions();
    byId('collab-count-label').textContent = sessions.length + '개 세션';
    const list = byId('collab-list');
    const existing = new Map(Array.from(list.querySelectorAll('button')).map((b) => [b.dataset.sessionId, b]));
    list.querySelectorAll('.empty').forEach((n) => n.remove());
    for (const s of sessions) {
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
    if (!sessions.length) list.append(el('p', '등록된 협업 세션이 없습니다.', 'empty'));

    const session = state.collab.snapshot?.session || state.collab.sessions.find((s) => s.id === state.collab.selectedId) || null;
    byId('collab-empty').hidden = Boolean(session);
    byId('collab-detail').hidden = !session;
    if (!session) return;

    const snap = state.collab.snapshot;
    const ch = charts();
    if (ch) ch.renderStepper(byId('clb-stepper'), ch.collabSteps(session, snap?.subtasks || []));

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
    byId('clb-orch').textContent = orch ? safeText(orch.status, 24) + ' · ' + safeText(orch.provider, 16) + (orch.model ? ' (' + safeText(orch.model, 48) + ')' : '') : '실행 기록 없음';
    byId('clb-updated').textContent = formatDate(session.updatedAt);

    const active = session.status === 'active';
    byId('clb-btn-reconcile').disabled = state.busy;
    byId('clb-btn-complete').hidden = !active;
    byId('clb-btn-complete').disabled = state.busy;
    byId('clb-btn-cancel').hidden = !active;
    byId('clb-btn-cancel').disabled = state.busy;
    byId('clb-msg-submit').disabled = state.busy;

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
        card.append(
          head,
          el(
            'p',
            'ID ' + safeText(st.id, 48) + ' · 제공자 ' + safeText(st.provider, 16) + ' · 에이전트 ' + (st.assignedAgentId ? safeText(st.assignedAgentId, 48) : '미배정') + ' · 리전 ' + (st.region ? safeText(st.region, 24) : '-'),
            'help',
          ),
        );
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
        head.append(el('span', safeText(m.kind, 24), 'pill'), el('strong', safeText(m.sender, 48) + (m.recipient ? ' → ' + safeText(m.recipient, 48) : ' → 전체')));
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
    renderProjects();
    renderDelivery();
    renderCompute();
    renderCollab();
    if (state.drawer.open) renderDrawer();
    updateTabTitleAndAlerts();
  }

  function updateConnectionIndicator(ok) {
    const conn = byId('connection-status');
    const sync = byId('last-sync');
    if (conn) {
      conn.textContent = ok ? '관제 연결됨' : '연결 확인 필요';
      conn.style.color = ok ? 'var(--green)' : 'var(--danger)';
    }
    if (sync && ok) {
      state.lastSyncTs = Date.now();
      sync.textContent = '동기화 ' + new Date(state.lastSyncTs).toLocaleTimeString('ko-KR');
      updateSyncAge();
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
        const snapCompute = snap?.compute || snap?.modelFactory;
        if (snap && snap.health && snap.delivery && snapCompute && snap.collab) {
          usedSnapshot = true;
          state.health = snap.health;
          if (snap.projects) {
            state.projects = {
              storageBackend: snap.projects.storageBackend ?? null,
              list: Array.isArray(snap.projects.projects) ? snap.projects.projects : [],
              events: Array.isArray(snap.projects.events) ? snap.projects.events : [],
            };
          }
          if (snap.autonomy) {
            state.autonomy = {
              storageBackend: snap.autonomy.storageBackend ?? null,
              triggers: Array.isArray(snap.autonomy.triggers) ? snap.autonomy.triggers : [],
              events: Array.isArray(snap.autonomy.events) ? snap.autonomy.events : [],
            };
          }
          state.delivery = {
            storageBackend: snap.delivery.storageBackend ?? null,
            tasks: Array.isArray(snap.delivery.tasks) ? snap.delivery.tasks : [],
            events: Array.isArray(snap.delivery.events) ? snap.delivery.events : [],
          };
          state.compute.storageBackend = snapCompute.storageBackend ?? null;
          state.compute.jobs = Array.isArray(snapCompute.jobs) ? snapCompute.jobs : [];
          state.compute.events = Array.isArray(snapCompute.events) ? snapCompute.events : [];
          state.compute.ledger = snapCompute.ledger ?? null;
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
        try {
          state.health = await monitorApi('/health', undefined, 10000);
        } catch {
          state.health = null;
        }
        for (const [path, apply] of [
          [
            '/api/projects',
            (v) => {
              state.projects = { storageBackend: v.storageBackend ?? null, list: Array.isArray(v.projects) ? v.projects : [], events: Array.isArray(v.events) ? v.events : [] };
            },
          ],
          [
            '/api/delivery/tasks',
            (v) => {
              state.delivery = { storageBackend: v.storageBackend ?? null, tasks: Array.isArray(v.tasks) ? v.tasks : [], events: Array.isArray(v.events) ? v.events : [] };
            },
          ],
          [
            '/api/compute/jobs',
            (v) => {
              state.compute.storageBackend = v.storageBackend ?? null;
              state.compute.jobs = Array.isArray(v.jobs) ? v.jobs : [];
              state.compute.events = Array.isArray(v.events) ? v.events : [];
            },
          ],
          ['/api/compute/ledger', (v) => { state.compute.ledger = v; }],
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

      if (!firstError && state.collab.selectedId && (state.activeTab === 'collab' || (state.drawer.open && state.drawer.kind === 'collab'))) {
        const id = state.collab.selectedId;
        const epoch = state.collab.epoch;
        try {
          const snap = await monitorApi('/api/collab/sessions/' + encodeURIComponent(id), undefined, 15000);
          if (epoch === state.collab.epoch && state.collab.selectedId === id) state.collab.snapshot = snap;
        } catch {
          // Keep last snapshot.
        }
      }

      if (firstError) {
        updateConnectionIndicator(false);
        setError('모니터링 동기화 오류: ' + firstError.message);
      } else {
        updateConnectionIndicator(true);
        if (state.error && state.error.startsWith('모니터링 동기화 오류:')) setError(null);
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
  for (const name of TAB_ORDER) {
    byId('tab-' + name)?.addEventListener('click', () => switchTab(name));
  }
  byId('jump-inbox')?.addEventListener('click', () => switchTab('inbox'));
  byId('jump-costs')?.addEventListener('click', () => switchTab('costs'));
  byId('jump-delivery')?.addEventListener('click', () => switchTab('delivery'));
  byId('jump-compute')?.addEventListener('click', () => switchTab('compute'));
  byId('jump-collab')?.addEventListener('click', () => switchTab('collab'));
  byId('project-filter')?.addEventListener('change', () => {
    state.projectFilter = byId('project-filter').value || 'all';
    renderAll();
  });
  byId('projects-filters')?.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.projectsStatusFilter = btn.dataset.filter || 'all';
      byId('projects-filters').querySelectorAll('button').forEach((b) => {
        b.className = b === btn ? 'filter-btn active' : 'filter-btn';
      });
      renderProjects();
    });
  });
  byId('projects-create-toggle')?.addEventListener('click', () => {
    const p = byId('project-create-panel');
    if (p) p.hidden = !p.hidden;
  });
  byId('project-create-cancel')?.addEventListener('click', () => {
    const p = byId('project-create-panel');
    if (p) p.hidden = true;
  });
  byId('project-token-dismiss')?.addEventListener('click', clearOneTimeTokenBanner);
  byId('project-create-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = (byId('proj-id')?.value || '').trim().toLowerCase();
    const name = (byId('proj-name')?.value || '').trim();
    const template = byId('proj-template')?.value || 'generic';
    const budgetUsd = Number(byId('proj-budget')?.value || 0);
    const repos = (byId('proj-repos')?.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    const description = (byId('proj-desc')?.value || '').trim();
    const autoMerge = Boolean(byId('proj-automerge')?.checked);
    if (!id || !name) {
      setError('프로젝트 ID와 이름을 입력하세요.');
      return;
    }
    return runMutation(
      async () => {
        const created = await monitorApi('/api/projects', {
          id,
          name,
          description,
          template,
          budget: { computeBudgetCapMicros: Math.max(0, Math.round(budgetUsd * 1_000_000)) },
          delivery: { repositories: repos, autoMergeRepositories: autoMerge ? repos : [] },
        });
        if (byId('project-create-panel')) byId('project-create-panel').hidden = true;
        if (byId('proj-id')) byId('proj-id').value = '';
        if (byId('proj-name')) byId('proj-name').value = '';
        if (byId('proj-repos')) byId('proj-repos').value = '';
        if (byId('proj-desc')) byId('proj-desc').value = '';
        return created;
      },
      '새 호스트 프로젝트를 등록했습니다.',
    );
  });

  byId('monitor-theme-toggle')?.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    saveUiPrefs();
    applyUiPrefs();
  });
  byId('monitor-density-toggle')?.addEventListener('click', () => {
    state.density = state.density === 'compact' ? 'comfortable' : 'compact';
    saveUiPrefs();
    applyUiPrefs();
  });
  byId('monitor-notify-toggle')?.addEventListener('click', async () => {
    if (!state.notificationsEnabled) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        try {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            setError('브라우저 데스크톱 알림 권한이 거부되었습니다.');
            return;
          }
        } catch {
          return;
        }
      }
      state.notificationsEnabled = true;
    } else {
      state.notificationsEnabled = false;
    }
    saveUiPrefs();
    applyUiPrefs();
  });
  byId('monitor-poll-select')?.addEventListener('change', () => {
    const val = Number(byId('monitor-poll-select').value);
    if (!ALLOWED_POLL_MS.has(val)) return;
    if (val === 0) {
      state.autoRefresh = false;
    } else {
      state.pollIntervalMs = val;
      state.autoRefresh = true;
    }
    saveUiPrefs();
    applyUiPrefs();
    reschedulePolling();
    if (state.autoRefresh) void refresh();
  });
  byId('monitor-poll-toggle')?.addEventListener('click', () => {
    state.autoRefresh = !state.autoRefresh;
    if (state.autoRefresh && !state.pollIntervalMs) state.pollIntervalMs = 15000;
    saveUiPrefs();
    applyUiPrefs();
    reschedulePolling();
    if (state.autoRefresh) void refresh();
  });
  byId('monitor-refresh-now')?.addEventListener('click', () => {
    void refresh();
  });
  byId('connection-form')?.addEventListener('submit', () => {
    const entered = (byId('operator-token')?.value || '').trim();
    if (entered) {
      byId('operator-token').value = entered;
      saveTabToken(entered);
    }
    setError(null);
    void refresh();
  });
  byId('spot-check-button')?.addEventListener('click', () => {
    void querySpotPlacement();
  });

  // Drawer controls
  byId('drawer-close')?.addEventListener('click', closeDrawer);
  byId('drawer-backdrop')?.addEventListener('click', closeDrawer);
  byId('drawer-open-full')?.addEventListener('click', () => {
    const { kind, id } = state.drawer;
    closeDrawer();
    if (kind === 'delivery' && id) {
      selectDelivery(id);
      switchTab('delivery');
    } else if (kind === 'compute' && id) {
      selectComputeJob(id);
      switchTab('compute');
    } else if (kind === 'project') {
      switchTab('projects');
    } else if (kind === 'collab' && id) {
      void selectCollab(id);
      switchTab('collab');
    }
  });

  // Event & Inbox filters
  byId('events-source-filter')?.addEventListener('change', () => {
    state.eventFilter.source = byId('events-source-filter').value || 'all';
    renderRecentEvents();
  });
  byId('events-errors-only')?.addEventListener('change', () => {
    state.eventFilter.errorsOnly = Boolean(byId('events-errors-only').checked);
    renderRecentEvents();
  });
  byId('events-search')?.addEventListener('input', () => {
    state.eventFilter.query = byId('events-search').value || '';
    renderRecentEvents();
  });
  byId('inbox-filters')?.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.inboxFilter = btn.dataset.filter || 'all';
      byId('inbox-filters').querySelectorAll('button').forEach((b) => {
        b.className = b === btn ? 'filter-btn active' : 'filter-btn';
      });
      renderInbox();
    });
  });

  // Delivery filter, search & actions
  byId('delivery-search')?.addEventListener('input', () => {
    state.deliverySearch = byId('delivery-search').value || '';
    renderDelivery();
  });
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
      (res) => 'SW 전달 워커 정리를 완료했습니다 (확인 ' + (res.checked ?? 0) + '건 · 실패 처리 ' + (Array.isArray(res.failed) ? res.failed.length : 0) + '건).',
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

  // Spot Compute filter, search & actions
  byId('compute-search')?.addEventListener('input', () => {
    state.computeSearch = byId('compute-search').value || '';
    renderCompute();
  });
  byId('compute-filters')?.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.computeFilter = btn.dataset.filter || 'all';
      byId('compute-filters').querySelectorAll('button').forEach((b) => {
        b.className = b === btn ? 'filter-btn active' : 'filter-btn';
      });
      renderCompute();
    });
  });
  byId('compute-sweep-btn')?.addEventListener('click', () =>
    runMutation(() => monitorApi('/api/compute/sweep-expired', { region: 'ap-northeast-2' }, 60000), 'Spot 컴퓨팅 만료 정리 및 상태 갱신을 완료했습니다.'),
  );
  byId('cmp-btn-wake')?.addEventListener('click', () => {
    const job = state.compute.jobs.find((j) => j.id === state.selectedComputeId);
    if (!job) return;
    return runMutation(() => monitorApi('/api/compute/jobs/' + encodeURIComponent(job.id) + '/wake', {}, 35000), '인스턴스 상태 확인(Wake)을 완료했습니다.');
  });
  byId('cmp-btn-verifier')?.addEventListener('click', () => {
    const job = state.compute.jobs.find((j) => j.id === state.selectedComputeId);
    if (!job) return;
    return runMutation(() => monitorApi('/api/compute/jobs/' + encodeURIComponent(job.id) + '/dispatch-verifier', {}, 35000), '독립 검증기(Fargate Spot)를 기동했습니다.');
  });
  byId('cmp-action-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const op = event.submitter?.value;
    const job = state.compute.jobs.find((j) => j.id === state.selectedComputeId);
    if (!job || !op) return;
    const reason = byId('cmp-reason').value.trim();
    if (!reason) {
      setError('결정 사유를 입력하세요.');
      byId('cmp-reason').focus();
      return;
    }
    const id = encodeURIComponent(job.id);
    if (op === 'approve_launch') {
      return runMutation(
        async () => {
          const res = await monitorApi('/api/compute/jobs/' + id + '/approve', { approvalFingerprint: job.approvalFingerprint, reason }, 35000);
          byId('cmp-reason').value = '';
          return res;
        },
        'Spot 컴퓨팅 작업 기동을 승인했습니다.',
      );
    } else if (op === 'cancel') {
      return runMutation(
        async () => {
          const res = await monitorApi('/api/compute/jobs/' + id + '/cancel', { reason }, 35000);
          byId('cmp-reason').value = '';
          return res;
        },
        'Spot 컴퓨팅 작업을 중단했습니다.',
      );
    } else if (op === 'approve_release' || op === 'reject_release') {
      const durationMinutes = Number(byId('cmp-duration-min').value);
      if (!Number.isFinite(durationMinutes) || durationMinutes < 0) {
        setError('검토 소요 시간(분)을 올바르게 입력하세요.');
        return;
      }
      return runMutation(
        async () => {
          const res = await monitorApi('/api/compute/jobs/' + id + '/approve-release', {
            decision: op === 'approve_release' ? 'approve' : 'reject',
            openedRawArtifacts: Boolean(byId('cmp-opened-raw').checked),
            durationMinutes,
            reason,
          }, 60000);
          byId('cmp-reason').value = '';
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
    return runMutation(() => monitorApi('/api/collab/sessions/' + encodeURIComponent(id) + '/reconcile', {}, 35000), '협업 세션 워커 상태 정리를 완료했습니다.');
  });
  byId('clb-btn-complete')?.addEventListener('click', () => {
    const id = state.collab.selectedId;
    if (!id) return;
    return runMutation(() => monitorApi('/api/collab/sessions/' + encodeURIComponent(id) + '/complete', { status: 'completed' }, 35000), '협업 세션을 완료 처리했습니다.');
  });
  byId('clb-btn-cancel')?.addEventListener('click', () => {
    const id = state.collab.selectedId;
    if (!id) return;
    return runMutation(() => monitorApi('/api/collab/sessions/' + encodeURIComponent(id) + '/complete', { status: 'cancelled' }, 35000), '협업 세션을 중단하고 실행 중인 워커를 중지했습니다.');
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
        const res = await monitorApi('/api/collab/sessions/' + encodeURIComponent(id) + '/messages', { sender: 'operator', kind, body });
        byId('clb-msg-body').value = '';
        return res;
      },
      '공유 게시판에 운영자 메시지를 게시했습니다.',
    );
  });

  // Keyboard shortcuts
  function handleKeydown(event) {
    if (!event || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = String(event.target?.tagName || '').toUpperCase();
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(event.target?.isContentEditable);
    if (event.key === 'Escape' && state.drawer.open) {
      closeDrawer();
      return;
    }
    if (typing) return;
    if (event.key === 'r') {
      void refresh();
    } else if (event.key === '/') {
      event.preventDefault?.();
      const targetSearch =
        state.activeTab === 'delivery'
          ? byId('delivery-search')
          : state.activeTab === 'compute'
            ? byId('compute-search')
            : (switchTab('overview'), byId('events-search'));
      targetSearch?.focus();
    } else if (event.key >= '1' && event.key <= '7') {
      const tab = TAB_ORDER[Number(event.key) - 1];
      if (tab) switchTab(tab);
    }
  }
  document.addEventListener('keydown', handleKeydown);

  // Initialize
  loadUiPrefs();
  if (!consumeHashToken()) restoreTabToken();
  applyUiPrefs();
  switchTab('overview');
  renderAll();
  void refresh();
  reschedulePolling();
  setInterval(updateSyncAge, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.autoRefresh) void refresh();
  });

  globalThis.hivemindMonitor = {
    state,
    refresh,
    switchTab,
    selectDelivery,
    selectComputeJob,
    selectCollab,
    openDrawer,
    closeDrawer,
    querySpotPlacement,
    handleKeydown,
    formatUsd,
  };
})();
