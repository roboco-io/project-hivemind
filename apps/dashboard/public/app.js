'use strict';

const $ = (id) => document.getElementById(id);
const statuses = {
  awaiting_execution_approval: '실행 승인 대기', queued: '배정 대기', running: '실행 중',
  awaiting_review: '결과 검토 대기', completed: '수락 완료', rejected: '반려', cancelled: '중단', failed: '실패'
};
const realProviders = new Set(['codex', 'claude']);
const providerNames = { mock: '모의 워커', codex: 'Codex', claude: 'Claude Code' };
const terminal = new Set(['completed', 'rejected', 'cancelled', 'failed']);
const state = { tasks: [], workers: [], events: [], capabilities: null, cloudflare: null, providerSelection: { local: 'mock', cloudflare: 'codex' }, selectedId: null, creating: true, busy: false, refreshing: false, error: null };
const processStatuses = { passed: '통과', failed: '실패', timed_out: '시간 초과', error: '실행 오류', not_run: '실행하지 않음' };
const cloudStatuses = { AWAITING_APPROVAL: '실행 승인 대기', QUEUED: '배정 대기', PREPARING: '실행 준비', STARTING: '실행 준비', SUBMITTING: '작업 제출 중', RUNNING: '실행 중', VERIFYING: '테스트 중', SAVING: '결과 저장 중', SUCCEEDED: '검증 완료', FAILED: '실패', PREPARATION_FAILED: '실행 준비 실패', CANCELLING: '중단 확인 중', CANCELLED: '중단', TIMED_OUT: '시간 초과', NEEDS_REAUTH: '인증 확인 필요', AUTH_SYNC_FAILED: '인증 저장 실패', PENDING: '대기 중' };
const cloudStatus = (status) => cloudStatuses[status] || processStatuses[status] || '상태 확인 필요';
const usd = (micros) => typeof micros === 'number' && Number.isFinite(micros) ? '$' + (micros / 1_000_000).toFixed(6) : '미확정';
const date = (value) => new Date(value).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const isCloud = (task) => task.runtime === 'cloudflare';
const taskStatus = (task) => isCloud(task) && task.remote?.phase === 'CANCELLING' && !terminal.has(task.status) ? '중단 확인 중' : statuses[task.status] || task.status;
const cloudConnection = () => state.cloudflare?.connection || state.capabilities?.cloudflare?.connection;
const cloudReady = () => Boolean(state.capabilities?.cloudflare && cloudConnection()?.status === 'ready');

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function setError(message) {
  state.error = message;
  $('error-banner').textContent = message || '';
  $('error-banner').hidden = !message;
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + $('operator-token').value, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.error || '요청을 처리하지 못했습니다 (' + response.status + ').');
  return result;
}
function selectTask(id) {
  if (state.busy) return;
  state.selectedId = id;
  state.creating = false;
  $('decision-reason').value = '';
  render();
}
function renderTasks() {
  $('task-count').textContent = String(state.tasks.length);
  $('approval-count').textContent = String(state.tasks.filter(t => t.status === 'awaiting_execution_approval' || t.status === 'awaiting_review').length);
  const knownCosts = state.tasks.filter(task => typeof task.actualCostMicros === 'number');
  const unknownCosts = state.tasks.length - knownCosts.length;
  $('cost-total').textContent = usd(knownCosts.reduce((sum, task) => sum + task.actualCostMicros, 0));
  $('cost-total-label').textContent = '확인된 보고 비용' + (unknownCosts ? ' · 미확정 ' + unknownCosts + '건' : '');
  const list = $('task-list');
  // Reuse task buttons so polling does not remove the keyboard's focused element.
  const existing = new Map(Array.from(list.querySelectorAll('button')).map(button => [button.dataset.taskId, button]));
  list.querySelectorAll('.empty').forEach(element => element.remove());
  for (const task of state.tasks) {
    let button = existing.get(task.id);
    if (!button) {
      button = node('button');
      button.type = 'button';
      button.dataset.taskId = task.id;
      button.addEventListener('click', () => selectTask(task.id));
      button.append(node('strong'), node('span', undefined, 'task-meta'));
      button.lastChild.append(node('span'), node('small'));
      list.append(button);
    }
    existing.delete(task.id);
    button.className = 'task-choice' + (!state.creating && task.id === state.selectedId ? ' selected' : '');
    button.setAttribute('aria-pressed', String(!state.creating && task.id === state.selectedId));
    button.disabled = state.busy;
    button.firstChild.textContent = task.title;
    button.lastChild.firstChild.className = 'pill ' + task.status;
    button.lastChild.firstChild.textContent = taskStatus(task);
    button.lastChild.lastChild.textContent = usd(task.actualCostMicros);
  }
  existing.forEach(button => button.remove());
  if (!state.tasks.length) list.append(node('p', '첫 작업을 등록하면 여기에 표시됩니다.', 'empty'));
}
function renderWorkers() {
  $('worker-count').textContent = String(state.workers.length) + '개';
  const list = $('worker-list');
  list.replaceChildren();
  for (const worker of state.workers) {
    const fresh = Date.now() - Date.parse(worker.lastSeenAt) < 15000;
    const item = node('div', undefined, 'worker');
    item.append(node('strong', worker.id), node('p', worker.provider + ' / ' + worker.runtime + (worker.repositoryId ? ' / ' + worker.repositoryId : '')));
    item.append(node('p', (fresh ? '연결됨' : '응답 확인 필요') + ' · ' + date(worker.lastSeenAt), fresh ? 'online' : 'stale'));
    list.append(item);
  }
  if (!state.workers.length) list.append(node('p', '워커 연결을 기다립니다. 별도 터미널에서 npm run worker를 실행하세요.', 'empty'));
}
function renderProvider() {
  const runtime = $('task-runtime').value;
  const cloud = runtime === 'cloudflare';
  const select = $('task-provider');
  const capabilities = cloud ? state.capabilities?.cloudflare : state.capabilities;
  const providers = capabilities?.providers || [];
  const repository = capabilities?.repository;
  const availableReal = Array.from(realProviders).filter(provider => providers.includes(provider) && repository);
  const allowed = cloud ? (availableReal.length ? availableReal : ['codex', 'claude']) : ['mock', ...availableReal];
  const signature = runtime + ':' + allowed.join(',');
  if (select.dataset.signature !== signature) {
    const previous = state.providerSelection[runtime];
    select.replaceChildren();
    for (const provider of allowed) {
      const option = node('option', realProviders.has(provider) ? '실제 ' + providerNames[provider] + ' 워커' : '모의 워커 (mock)');
      option.value = provider;
      select.append(option);
    }
    select.value = allowed.includes(previous) ? previous : allowed[0];
    select.dataset.signature = signature;
  }
  const real = realProviders.has(select.value);
  $('create-route').textContent = select.value + ' / ' + runtime;
  $('create-repository').hidden = !real || !repository;
  $('provider-help').textContent = cloud ? (cloudReady() ? '표시한 고정 커밋의 snapshot으로 원격 실행합니다. 등록 후 사람이 실행을 승인합니다.' : 'Cloudflare 연결을 사용할 수 없습니다. 서버의 원격 설정과 연결 상태를 확인하세요.') : !state.capabilities ? '실행 가능한 워커 설정을 확인하고 있습니다.' : real ? '표시한 고정 커밋으로 별도 worktree를 만듭니다. 등록 후 사람이 실행을 승인합니다.' : availableReal.length ? 'mock은 합성 결과를 만듭니다. 실제 변경과 테스트는 Codex 또는 Claude Code 워커를 선택하세요.' : '현재 모의 워커만 사용할 수 있습니다. 실제 실행은 서버의 저장소 설정과 선택한 제공자의 워커 연결이 필요합니다.';
  const connection = cloudConnection();
  $('cloudflare-connection').textContent = 'Cloudflare · ' + (connection?.status === 'ready' ? '연결됨' : connection?.status === 'checking' ? '연결 확인 중' : '사용 불가') + (connection?.message ? ' · ' + connection.message : '') + (connection?.checkedAt ? ' · ' + date(connection.checkedAt) : '');
  if (real && repository) {
    $('create-repository-name').textContent = repository.name + ' (' + repository.id + ')';
    $('create-base-commit').textContent = repository.baseCommit;
    $('create-test-profile').textContent = repository.testProfile;
    $('create-test-command').textContent = JSON.stringify(repository.testCommand);
  }
  $('task-budget').min = real ? '0' : '0.001';
  $('budget-help').textContent = real ? providerNames[select.value] + ' 비용은 미확정으로 보고합니다. 이 예산은 외부 과금의 상한을 보장하지 않습니다.' : '모의 워커 예상 비용은 $0.001000입니다. 예산이 이보다 작으면 등록할 수 없습니다.';
  select.disabled = state.busy || !state.capabilities || (cloud && !cloudReady());
  $('task-runtime').disabled = state.busy || !state.capabilities;
}
function renderProcess(prefix, process) {
  $('' + prefix + '-status').textContent = process ? (processStatuses[process.status] || process.status) : '아직 보고되지 않음';
  $('' + prefix + '-status').className = 'pill process-' + (process?.status || 'pending');
  $('' + prefix + '-metadata').textContent = process ? '명령 ' + JSON.stringify(process.command) + ' · 종료 코드 ' + (process.exitCode === null ? '없음' : process.exitCode) + ' · 소요 시간 ' + (process.durationMs / 1000).toFixed(2) + '초' : '워커가 실행한 테스트 명령과 종료 결과를 기다립니다.';
  $('' + prefix + '-stdout').textContent = process ? (process.stdout || '출력 없음') : '아직 보고된 출력이 없습니다.';
  $('' + prefix + '-stderr').textContent = process ? (process.stderr || '출력 없음') : '아직 보고된 출력이 없습니다.';
  $('' + prefix + '-truncated').hidden = !process?.truncated;
}
function renderExecution(task) {
  const evidence = task.execution;
  const agent = evidence?.[task.provider];
  const name = providerNames[task.provider] || task.provider;
  $('execution-section').hidden = isCloud(task) || !realProviders.has(task.provider);
  if (isCloud(task) || !realProviders.has(task.provider)) return;
  const completeEvidence = evidence && agent;
  $('execution-status').textContent = completeEvidence ? (evidence.status === 'succeeded' ? '실행·검증 성공' : '실행·검증 실패') : evidence ? '제공자 실행 근거 확인 필요' : '아직 보고되지 않음';
  $('execution-status').className = 'pill process-' + (completeEvidence ? (evidence.status === 'succeeded' ? 'passed' : 'failed') : evidence ? 'error' : 'pending');
  $('execution-repository').textContent = evidence?.repositoryId || task.repositoryId || '알 수 없음';
  $('execution-base').textContent = evidence?.baseCommit || task.baseCommit || '알 수 없음';
  $('execution-head').textContent = evidence?.headCommit || '아직 보고되지 않음';
  $('execution-profile').textContent = task.testProfile || '알 수 없음';
  $('execution-worktree').textContent = evidence?.worktreePath || '워커가 작업 공간을 준비한 뒤 보고합니다.';
  $('agent-execution-label').textContent = name + ' 실행';
  $('agent-status').textContent = agent ? (processStatuses[agent.status] || agent.status) + ' · 종료 코드 ' + (agent.exitCode === null ? '없음' : agent.exitCode) : '아직 보고되지 않음';
  $('agent-thread').textContent = agent?.threadId || '아직 보고되지 않음';
  $('agent-model').textContent = agent?.model || '기본 모델 · 모델명 미보고';
  const usage = agent?.usage;
  $('agent-usage').textContent = usage ? '입력(캐시 포함) ' + usage.inputTokens.toLocaleString('ko-KR') + ' / 캐시 입력 ' + usage.cachedInputTokens.toLocaleString('ko-KR') + ' / 출력 ' + usage.outputTokens.toLocaleString('ko-KR') : '사용량 미제공';
  $('agent-error-block').hidden = !agent?.stderr;
  $('agent-error-title').textContent = name + ' 오류 출력';
  $('agent-stderr').textContent = agent?.stderr || '';
  $('setup-section').hidden = !evidence?.setup;
  if (evidence?.setup) renderProcess('setup', evidence.setup);
  renderProcess('tests', evidence?.tests);
  if (!evidence && task.testCommand) $('tests-metadata').textContent = '등록 당시 고정한 테스트 명령 ' + JSON.stringify(task.testCommand) + ' · 아직 실행하지 않음';
}
function processMetadata(process) {
  return process ? '종료 코드 ' + (process.exitCode === null ? '없음' : process.exitCode) + ' · 소요 시간 ' + (process.durationMs / 1000).toFixed(2) + '초' : '아직 보고되지 않음';
}
function integrity(value) { return value === true ? '확인됨' : value === false ? '실패' : '미보고'; }
function renderRemote(task) {
  $('remote-execution-section').hidden = !isCloud(task);
  if (!isCloud(task)) return;
  const evidence = task.remote;
  $('remote-phase').textContent = cloudStatus(evidence.phase);
  $('remote-phase').dataset.phase = evidence.phase;
  $('remote-phase').title = evidence.phase;
  $('remote-job').textContent = evidence.jobId || '아직 제출되지 않음';
  $('remote-input-snapshot').textContent = evidence.inputSnapshotId || '아직 보고되지 않음';
  $('remote-output-snapshot').textContent = evidence.outputSnapshotId || '아직 보고되지 않음';
  $('remote-worktree').textContent = task.worktreePath || '아직 준비되지 않음';
  $('remote-base').textContent = task.baseCommit || '미보고';
  $('remote-repository').textContent = task.repositoryId || '미보고';
  $('remote-stopped').textContent = evidence.containerStopped ? '종료 확인됨' : '종료 미확인';
  $('remote-auth-synced').textContent = evidence.authSynced ? '저장 확인됨' : '저장 미확인';
  $('remote-error').textContent = evidence.errorCode || '보고된 오류 없음';
  const agent = evidence.agent;
  $('remote-agent-status').textContent = agent ? (processStatuses[agent.status] || agent.status) : '아직 보고되지 않음';
  $('remote-agent-status').className = 'pill process-' + (agent?.status || 'pending');
  $('remote-agent-metadata').textContent = processMetadata(agent);
  $('remote-agent-stdout').textContent = agent ? agent.stdout || '출력 없음' : '아직 보고되지 않음';
  $('remote-agent-stderr').textContent = agent ? agent.stderr || '출력 없음' : '아직 보고되지 않음';
  $('remote-agent-truncated').hidden = !agent?.truncated;
  const list = $('remote-checks');
  const signature = JSON.stringify(evidence.checks);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  list.replaceChildren();
  for (const check of evidence.checks) {
    const section = node('section', undefined, 'process-evidence');
    const heading = node('div', undefined, 'section-title');
    const status = node('span', cloudStatus(check.status), 'pill');
    status.dataset.status = check.status;
    status.title = check.status;
    heading.append(node('h4', check.name + ' (' + check.id + ')'), status);
    section.append(heading, node('p', '명령 ' + JSON.stringify(check.command) + ' · ' + processMetadata(check.process) + (check.process ? ' · 실행 상태 ' + (processStatuses[check.process.status] || check.process.status) : ''), 'process-metadata'));
    section.append(node('p', '인증 정보 부재 ' + integrity(check.credentialsAbsent) + ' · 소스 보존 ' + integrity(check.sourceUnchanged), 'process-metadata'));
    section.append(node('h4', '표준 출력 (stdout)'), node('pre', check.process ? check.process.stdout || '출력 없음' : '아직 보고되지 않음'));
    section.append(node('h4', '오류 출력 (stderr)'), node('pre', check.process ? check.process.stderr || '출력 없음' : '아직 보고되지 않음'));
    if (check.process?.truncated) section.append(node('p', '검증 출력이 한도를 넘어 일부만 저장되었습니다.', 'evidence-warning'));
    list.append(section);
  }
  if (!evidence.checks.length) list.append(node('p', '아직 보고된 검증 결과가 없습니다.', 'empty'));
}
function renderSelected() {
  const task = state.tasks.find(t => t.id === state.selectedId);
  $('create-panel').hidden = !state.creating;
  $('task-panel').hidden = state.creating || !task;
  if (state.creating || !task) return;
  $('task-id').textContent = task.id;
  $('selected-title').textContent = task.title;
  $('selected-status').textContent = taskStatus(task);
  $('selected-status').className = 'pill ' + task.status;
  $('task-instructions-view').textContent = task.instructions;
  $('task-route').textContent = task.provider + ' / ' + task.runtime;
  $('task-worker').textContent = isCloud(task) ? task.remote.jobId || '아직 제출되지 않음' : task.workerId || '아직 배정하지 않음';
  $('task-budget-view').textContent = usd(task.budgetMicros);
  $('task-estimate').textContent = usd(task.estimatedCostMicros);
  $('task-actual').textContent = usd(task.actualCostMicros);
  $('task-updated').textContent = date(task.updatedAt);
  const awaitingExecution = task.status === 'awaiting_execution_approval';
  const awaitingReview = task.status === 'awaiting_review';
  $('decision-panel').hidden = terminal.has(task.status);
  $('decision-title').textContent = awaitingExecution ? '실행을 승인해 주세요' : awaitingReview ? '결과를 검토해 주세요' : '작업을 감독하고 있습니다';
  $('decision-description').textContent = awaitingExecution ? (isCloud(task) ? '승인하면 고정 커밋의 snapshot을 준비하고 Cloudflare에 제출합니다.' : '승인하면 대기열에 들어가고, 연결된 워커가 작업을 가져갑니다.') : awaitingReview ? 'diff와 실행·검증 근거를 확인하세요. 결과 수락은 Git 적용·병합을 실행하지 않습니다.' : isCloud(task) && task.remote.phase === 'CANCELLING' ? '중단을 요청했습니다. 원격 컨테이너의 실제 종료를 확인하고 있습니다.' : '필요하면 작업을 중단할 수 있습니다. 중단 후 도착한 결과는 수락하지 않습니다.';
  $('approve-button').hidden = !awaitingExecution && !awaitingReview;
  $('approve-button').textContent = awaitingReview ? '결과 수락' : '실행 승인';
  $('reject-button').hidden = !awaitingExecution && !awaitingReview;
  $('task-summary').textContent = task.summary || '아직 보고된 결과가 없습니다.';
  $('task-summary').className = task.summary ? '' : 'empty';
  $('diff-kind').textContent = realProviders.has(task.provider) ? '고정 시작 커밋 기준 실제 변경 · 자동 적용하지 않음' : '합성 예시 · 자동 적용하지 않음';
  $('task-diff').textContent = task.diff === '' ? '변경 사항이 없습니다.' : task.diff ?? '아직 보고된 diff가 없습니다.';
  $('diff-truncated').hidden = !(isCloud(task) ? task.diffTruncated : task.execution?.diffTruncated);
  renderExecution(task);
  renderRemote(task);
  const events = state.events.filter(event => event.taskId === task.id).sort((a, b) => b.sequence - a.sequence);
  const list = $('event-list');
  const signature = JSON.stringify(events);
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.replaceChildren();
    for (const event of events) {
      const item = node('li');
      const time = node('time', date(event.at));
      time.dateTime = event.at;
      const content = node('div');
      content.append(node('strong', event.type));
      if (Object.keys(event.data).length) content.append(node('p', JSON.stringify(event.data, null, 2)));
      item.append(time, content);
      list.append(item);
    }
    if (!events.length) list.append(node('li', '표시할 이벤트가 없습니다.', 'empty'));
  }
}
function render() {
  renderProvider();
  renderTasks();
  renderWorkers();
  renderSelected();
  $('new-task-button').disabled = state.busy;
  $('create-submit').disabled = state.busy || !state.capabilities || ($('task-runtime').value === 'cloudflare' && !cloudReady());
  $('create-submit').textContent = state.busy && state.creating ? '등록 중…' : '작업 등록';
  for (const button of $('decision-form').querySelectorAll('button')) button.disabled = state.busy;
}
async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const [result, capabilities] = await Promise.all([api('/api/state'), api('/api/capabilities')]);
    state.capabilities = capabilities;
    state.cloudflare = result.cloudflare || null;
    state.tasks = [...result.tasks, ...(result.cloudflare?.tasks || [])];
    state.workers = result.workers;
    state.events = [...result.events, ...(result.cloudflare?.events || [])];
    $('connection-status').textContent = '관제 연결됨';
    $('connection-status').style.color = 'var(--green)';
    $('last-sync').textContent = '동기화 ' + new Date().toLocaleTimeString('ko-KR');
    if (state.error?.startsWith('동기화 실패:')) setError(null);
    render();
  } catch (error) {
    $('connection-status').textContent = '연결 확인 필요';
    $('connection-status').style.color = 'var(--danger)';
    setError('동기화 실패: ' + error.message + ' 서버 실행 상태와 운영자 토큰을 확인하세요.');
  } finally { state.refreshing = false; }
}
$('connection-form').addEventListener('submit', event => { event.preventDefault(); setError(null); state.capabilities = null; render(); void refresh(); });
$('task-provider').addEventListener('change', () => { state.providerSelection[$('task-runtime').value] = $('task-provider').value; renderProvider(); });
$('task-runtime').addEventListener('change', render);
$('new-task-button').addEventListener('click', () => { if (!state.busy) { state.creating = true; render(); $('task-title').focus(); } });
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || !state.capabilities) return;
  const runtime = $('task-runtime').value;
  const cloud = runtime === 'cloudflare';
  const provider = $('task-provider').value;
  const capabilities = cloud ? state.capabilities.cloudflare : state.capabilities;
  const repository = capabilities?.repository;
  if (cloud && !cloudReady()) { setError('Cloudflare 연결을 사용할 수 없습니다. 연결 상태를 확인한 뒤 다시 등록하세요.'); return; }
  if (!capabilities?.providers.includes(provider) || (realProviders.has(provider) && !repository)) { setError('선택한 워커의 실행 설정을 확인한 뒤 다시 등록하세요.'); return; }
  const title = $('task-title').value.trim();
  const instructions = $('task-instructions').value.trim();
  const budgetMicros = Math.round(Number($('task-budget').value) * 1_000_000);
  if (!title || !instructions || !Number.isSafeInteger(budgetMicros) || budgetMicros < (provider === 'mock' ? 1000 : 0)) { setError(provider === 'mock' ? '제목, 목표와 $0.001000 이상의 예산을 입력하세요.' : '제목, 목표와 올바른 예산을 입력하세요.'); return; }
  state.busy = true;
  setError(null);
  render();
  try {
    const payload = { title, instructions, budgetMicros, provider, runtime };
    if (realProviders.has(provider)) Object.assign(payload, { repositoryId: repository.id, baseCommit: repository.baseCommit, testProfile: repository.testProfile });
    const result = await api(cloud ? '/api/cloudflare/tasks' : '/api/tasks', payload);
    state.selectedId = result.id;
    state.creating = false;
    $('create-form').reset();
    $('task-runtime').value = runtime;
    $('task-provider').value = provider;
    $('decision-reason').value = '';
    await refresh();
  } catch (error) { setError('작업 등록 실패: ' + error.message); }
  finally { state.busy = false; render(); }
});
$('decision-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || !state.selectedId) return;
  const decision = event.submitter?.value;
  if (!['approve', 'reject', 'cancel'].includes(decision)) return;
  const task = state.tasks.find(task => task.id === state.selectedId);
  if (!task) return;
  const reason = $('decision-reason').value.trim();
  if (!reason) { setError('결정 사유를 입력하세요.'); $('decision-reason').focus(); return; }
  state.busy = true;
  setError(null);
  render();
  try {
    await api((isCloud(task) ? '/api/cloudflare/tasks/' : '/api/tasks/') + encodeURIComponent(state.selectedId) + (decision === 'cancel' ? '/cancel' : '/decision'), decision === 'cancel' ? { reason } : { decision, reason });
    $('decision-reason').value = '';
    await refresh();
  } catch (error) { setError('결정 기록 실패: ' + error.message); }
  finally { state.busy = false; render(); }
});
const legacyHidden = () => Boolean($('panel-legacy')?.hidden);
render();
if (!legacyHidden()) void refresh();
setInterval(() => { if (!document.hidden && !legacyHidden()) void refresh(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !legacyHidden()) void refresh(); });

// Independent operator state: long-task polling never changes the old task form.
const autonomousPath = '/api/cloudflare/autonomous-tasks';
const autonomousStates = { awaiting_approval: '실행 승인 대기', ready: '실행 대기', running: '실행 중', waiting: '예약 대기', awaiting_input: '운영자 입력 대기', stopping: '중단·정리 확인 중', completed: '완료', cancelled: '중단', budget_exceeded: '예산 중단', expired: '기간 만료', failed: '실패' };
const autonomous = { items: [], selectedId: null, detail: null, cursor: null, nextCursor: null, busy: false, refreshing: false, epoch: 0, error: null };
function autonomousText(value, max = 16000) {
  if (typeof value !== 'string') return '';
  let text = value; const token = $('operator-token').value;
  if (token) text = text.split(token).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/(?:sk-ant-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+)/g, '[REDACTED]').slice(0, max);
}
function autonomousError(message) { autonomous.error = message; $('autonomous-error').textContent = message || ''; $('autonomous-error').hidden = !message; }
async function autonomousApi(path, body) {
  if (!path.startsWith(autonomousPath)) throw new Error('장기 작업 연결을 사용할 수 없습니다.');
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + $('operator-token').value, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!response.ok || response.redirected) { const error = new Error('Cloudflare 장기 작업 연결·권한을 확인하세요.'); error.status = response.status; throw error; }
  return response.json();
}
function autonomousTask(value) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Object.hasOwn(autonomousStates, value.status) || !value.spec || typeof value.spec.goal !== 'string' || typeof value.spec.model !== 'string') throw new Error('장기 작업 응답을 확인할 수 없습니다.');
  return value;
}
function autonomousProfileHashes(t) {
  const refs = t.spec.externalProfiles || [], metadata = t.externalProfilesMetadata;
  if (!refs.length) return {};
  if (!Array.isArray(metadata) || metadata.length !== refs.length) return null;
  const entries = refs.map(ref => metadata.find(p => p.id === ref));
  if (entries.some(p => !p || !/^[a-f0-9]{64}$/.test(p.profileHash))) return null;
  return Object.fromEntries(entries.map(p => [p.id, p.profileHash]));
}
function autonomousApprovedTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = 'bucket' in value ? ['accountId', 'region', 'bucket', 'prefix'] : 'accountId' in value ? ['accountId', 'region', 'workloadId'] : 'repository' in value && ('branch' in value) !== ('revision' in value) ? ['repository', 'branch' in value ? 'branch' : 'revision', ...('visibility' in value ? ['visibility'] : [])] : [];
  if (!fields.length || fields.some(k => typeof value[k] !== 'string' || !value[k].length || value[k].length > 256) || ('visibility' in value && !['private', 'public'].includes(value.visibility))) return null;
  if ('allowPublicLarge' in value && (value.allowPublicLarge !== true || value.visibility !== 'public' || !('revision' in value))) return null;
  return { ...Object.fromEntries(fields.map(k => [k, autonomousText(value[k], 256)])), ...('allowPublicLarge' in value ? { allowPublicLarge: true } : {}) };
}
function autonomousR9Metadata(value) {
  const output = {}, hex64 = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), oid = v => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
  const safe = v => { const values = typeof v === 'string' ? [v] : Object.entries(v).filter(([key]) => key !== 'kind').map(([,value]) => value); return values.every(value => typeof value !== 'string' || autonomousText(value, 4096) === value); };
  if (hex64(value.parameterHash) && safe(value.parameterHash)) output.parameterHash = value.parameterHash;
  const p = value.parametersSubset ?? value.parameters;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const checks = { lifetimeMs: v => Number.isSafeInteger(v) && v > 0, startActionId: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v), artifactDigest: hex64, expectedHead: oid };
    const subset = {}, keys = Object.keys(checks).filter(k => Object.hasOwn(p, k));
    if (keys.length && keys.every(k => checks[k](p[k]))) { for (const k of keys) subset[k] = p[k]; if (safe(subset)) output.parametersSubset = subset; }
  }
  const r = value.providerResult;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if (r.kind === 'aws_instance' && typeof r.id === 'string' && /^i-[a-f0-9]{8,32}$/.test(r.id)) output.providerResult = { kind: r.kind, id: r.id };
    else if (['hf_commit', 'github_commit'].includes(r.kind) && oid(r.oid)) output.providerResult = { kind: r.kind, oid: r.oid };
    if (output.providerResult && !safe(output.providerResult)) delete output.providerResult;
  }
  return output;
}
async function loadAutonomousTask(id) {
  const path = autonomousPath + '/' + encodeURIComponent(id);
  const t = autonomousTask(await autonomousApi(path + '?view=summary')), refs = t.spec.externalProfiles || [];
  t.runs = []; t.runsUnavailable = false;
  try { const page = await autonomousApi(path + '/history?kind=runs&limit=20'); if (!Array.isArray(page.items) || page.items.length > 20) throw new Error(); t.runs = page.items; t.runsNextCursor = page.nextCursor; }
  catch { t.runsUnavailable = true; }
  t.externalActionResources = []; t.externalActionPageCount = null;
  try {
    const page = await autonomousApi(path + '/external-actions?limit=20');
    if (!Array.isArray(page.items) || page.items.length > 20) throw new Error();
    t.externalActionResources = page.items.filter(a => a && typeof a === 'object' && !Array.isArray(a)).map(a => ({ ...autonomousR9Metadata(a), profileId: autonomousText(a.profileId, 128), approvedTarget: autonomousApprovedTarget(a.approvedTarget), approvedProfileHash: typeof a.approvedProfileHash === 'string' && /^[a-f0-9]{64}$/.test(a.approvedProfileHash) ? a.approvedProfileHash : null, resourceId: autonomousText(a.resourceId, 256), revision: Number.isSafeInteger(a.revision) && a.revision >= 1 ? a.revision : null, requestId: autonomousText(a.requestId, 256), cleanupStatus: ['none', 'pending', 'deleting', 'cleaned'].includes(a.cleanupStatus) ? a.cleanupStatus : 'unknown', billingSource: autonomousText(a.billingSource, 64), evidenceRef: autonomousText(a.evidenceRef, 1000), attestedAt: Number.isSafeInteger(a.attestedAt) && a.attestedAt >= 0 ? a.attestedAt : null, reportedCostMicros: Number.isSafeInteger(a.verifiedCostMicros) && a.verifiedCostMicros >= 0 ? a.verifiedCostMicros : null }));
    t.externalActionPageCount = page.items.length; t.externalActionsHasNext = typeof page.nextCursor === 'string' && page.nextCursor.length > 0;
  } catch { /* Resource absence in an unavailable page is not cleanup proof. */ }
  t.externalProfilesMetadata = [];
  if (!refs.length) return t;
  try {
    const raw = await autonomousApi(autonomousPath + '/' + encodeURIComponent(id) + '/external-profiles');
    if (refs.length > 3 || new Set(refs).size !== refs.length || raw.available === false || raw.enabled === false || !Array.isArray(raw.profiles) || raw.profiles.length !== refs.length) throw new Error();
    const profiles = refs.map(ref => {
      const p = raw.profiles.find(p => p.id === ref);
      if (!p || p.enabled !== true || !['aws', 's3', 'hf', 'github'].includes(p.provider) || !/^[a-f0-9]{64}$/.test(p.profileHash) || !Number.isSafeInteger(p.upperBoundMicros) || p.upperBoundMicros < 0 || !p.target || !Array.isArray(p.operations)) throw new Error();
      const fields = p.provider === 'aws' ? ['accountId', 'region', 'workloadId'] : p.provider === 's3' ? ['accountId', 'region', 'bucket', 'prefix'] : p.provider === 'hf' ? ['repository', 'revision', ...('visibility' in p.target ? ['visibility'] : [])] : ['repository', 'branch'];
      if (fields.some(k => typeof p.target[k] !== 'string' || !p.target[k])) throw new Error();
      const hasLargeConsent = 'allowPublicLarge' in p.target;
      if (hasLargeConsent && (p.provider !== 'hf' || p.target.allowPublicLarge !== true || p.target.visibility !== 'public' || !p.operations.includes('hf.model.lfs_commit'))) throw new Error();
      if (p.provider === 'hf' && p.target.visibility === 'public' && p.operations.includes('hf.model.lfs_commit') && !hasLargeConsent) throw new Error();
      const display = p.provider === 'hf' ? p.hfVisibilityDisplay : undefined;
      // A public target must come with a matching display; an omitted visibility means private.
      if (p.provider === 'hf' && (display ? !['private', 'public'].includes(display.visibility) || typeof display.publicEffect !== 'boolean' || display.publicEffect !== (display.visibility === 'public') || typeof display.notice !== 'string' || display.visibility !== (p.target.visibility ?? 'private') : p.target.visibility !== undefined && p.target.visibility !== 'private')) throw new Error();
      let oidc;
      if (p.oidc) {
        oidc = { issuer: autonomousText(p.oidc.issuer, 256), audience: autonomousText(p.oidc.audience, 255) };
        for (const purpose of ['execute', 'inspect', 'cleanup']) {
          const v = p.oidc[purpose];
          if (!v || !/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(v.roleArn) || !/^hivemind:task:[a-f0-9]{64}:rev:[1-9][0-9]*:profile:[a-f0-9]{64}:(execute|inspect|cleanup)$/.test(v.subject) || !/^[a-f0-9]{64}$/.test(v.policyHash) || !Number.isInteger(v.durationSeconds) || v.durationSeconds < 1 || v.durationSeconds > 120) throw new Error();
          oidc[purpose] = { roleArn: autonomousText(v.roleArn, 600), subject: autonomousText(v.subject, 255), policyHash: v.policyHash, durationSeconds: v.durationSeconds };
        }
      }
      let delegated;
      if (p.delegated) {
        const v = p.delegated, d = v.descriptor;
        if (!/^[a-f0-9]{64}$/.test(v.descriptorHash) || !/^[a-f0-9]{64}$/.test(v.inputManifestDigest) || !d || !d.hf || !d.s3 || !d.iam || !d.hf.delivery || !['private', 'public'].includes(d.hf.visibility)) throw new Error();
        delegated = { descriptorHash: v.descriptorHash, inputManifestDigest: v.inputManifestDigest, workloadId: autonomousText(d.workloadId, 128), amiId: autonomousText(d.amiId, 32), bootstrapSha256: autonomousText(d.bootstrapSha256, 64), region: autonomousText(d.region, 32), availabilityZoneId: autonomousText(d.availabilityZoneId, 32), policySha256: autonomousText(d.iam.policySha256, 64), bucket: autonomousText(d.s3.bucket, 63), prefix: autonomousText(d.s3.prefix, 512), hfRepo: autonomousText(d.hf.repo, 128), visibility: d.hf.visibility, tokenRef: autonomousText(d.hf.tokenRef, 128), tokenDelivery: autonomousText(d.hf.delivery.mode, 64), trainingEnvironment: d.hf.delivery.trainingEnvironment === true, releasePolicyId: autonomousText(d.releasePolicy?.id, 128) };
      }
      return { id: ref, provider: p.provider, ...(oidc ? { oidc } : {}), ...(delegated ? { delegated } : {}), visibilityNotice: display ? autonomousText(display.notice, 300) : undefined, publicEffect: display ? display.publicEffect : false, profileHash: p.profileHash, target: { ...Object.fromEntries(fields.map(k => [k, autonomousText(p.target[k], 200)])), ...(hasLargeConsent ? { allowPublicLarge: true } : {}) }, upperBoundMicros: p.upperBoundMicros, operations: p.operations.map(v => autonomousText(v, 128)) };
    });
    if (new Set(profiles.map(p => p.provider)).size !== profiles.length) throw new Error();
    t.externalProfilesMetadata = profiles;
  } catch { t.externalProfilesMetadata = []; }
  return t;
}
function renderAutonomous() {
  const list = $('autonomous-list'), existing = new Map(Array.from(list.querySelectorAll('button')).map(b => [b.dataset.taskId, b]));
  list.querySelectorAll('.empty').forEach(e => e.remove());
  for (const t of autonomous.items) {
    let b = existing.get(t.id);
    if (!b) { b = node('button'); b.type = 'button'; b.dataset.taskId = t.id; b.append(node('strong'), node('span', undefined, 'task-meta')); b.addEventListener('click', () => { void selectAutonomousTask(t.id); }); list.append(b); }
    existing.delete(t.id); b.firstChild.textContent = autonomousText(t.spec.goal, 140); b.lastChild.textContent = 'revision ' + t.revision + ' · ' + autonomousStates[t.status]; b.className = 'task-choice' + (t.id === autonomous.selectedId ? ' selected' : ''); b.setAttribute('aria-pressed', String(t.id === autonomous.selectedId)); b.disabled = autonomous.busy;
  }
  existing.forEach(b => b.remove()); if (!autonomous.items.length) list.append(node('p', '현재 페이지에 장기 작업이 없습니다.', 'empty'));
  $('autonomous-page').textContent = '현재 페이지 ' + autonomous.items.length + '건' + (autonomous.nextCursor ? ' · 다음 페이지 있음' : ' · 다음 페이지 없음');
  $('autonomous-next').disabled = autonomous.busy || !autonomous.nextCursor; $('autonomous-first').disabled = autonomous.busy;
  const t = autonomous.detail; $('autonomous-review').hidden = !t; if (!t) return;
  const s = t.spec, profiles = Array.isArray(s.externalProfiles) ? s.externalProfiles : [];
  $('autonomous-current').textContent = autonomousText(t.id, 128) + ' · revision ' + t.revision;
  $('autonomous-status').textContent = autonomousStates[t.status]; $('autonomous-goal').textContent = autonomousText(s.goal);
  $('autonomous-model').textContent = autonomousText(s.model, 100) + (s.subagentModel ? ' / 자식 ' + autonomousText(s.subagentModel, 100) : '');
  $('autonomous-ends').textContent = Number.isSafeInteger(s.endsAt) ? date(s.endsAt) : '미보고';
  $('autonomous-tools').textContent = (s.tools || []).map(v => autonomousText(v, 128)).join(', ') || '없음';
  $('autonomous-web').textContent = (s.web?.allowedHosts || []).map(v => autonomousText(v, 253)).join(', ') || '허용 호스트 없음';
  $('autonomous-credentials').textContent = (s.credentialIds || []).map(v => autonomousText(v, 128)).join(', ') || 'reference 없음';
  $('autonomous-profiles').textContent = profiles.length ? profiles.map(ref => { const p = t.externalProfilesMetadata?.find(p => p.id === ref); return autonomousText(ref, 128) + (p ? ' — ' + p.provider + ' ' + JSON.stringify(p.target) + (p.target.allowPublicLarge === true ? '\n공개 대형 게시 허용' : '') + (p.visibilityNotice ? '\n' + (p.publicEffect ? '[공개 커밋] ' : '') + p.visibilityNotice : '') + '\n허용 ' + p.operations.join(', ') + ' · 행동 상한 ' + usd(p.upperBoundMicros) + '\nprofileHash ' + p.profileHash + (p.oidc ? '\nOIDC·GSC ' + JSON.stringify(p.oidc) : '') + (p.delegated ? '\n위임 실행 ' + JSON.stringify(p.delegated) : '') : ' — 대상·상한 metadata 미확인'); }).join('\n\n') : '외부 profile 없음';
  $('autonomous-source').textContent = s.execution ? autonomousText(s.execution.snapshotId, 64) + '\n' + (s.execution.checks || []).map(c => autonomousText(c.id, 128) + ': ' + autonomousText(JSON.stringify(c.argv), 2000)).join('\n') : 'snapshot 미보고';
  $('autonomous-budget').textContent = usd(s.budgetMicros); $('autonomous-reserved').textContent = usd(t.reservedMicros) + ' (예약 상한)';
  $('autonomous-spent').textContent = usd(t.spentMicros) + ' · 원장 확인분만; 미확정 청구 별도' + ((t.actions || []).some(a => a.status === 'accepted') ? ' · 수락된 행동 청구 미확정' : '');
  const runs = Array.isArray(t.runs) ? t.runs : [], unknown = runs.some(r => r.costMicros === null);
  $('autonomous-model-cost').textContent = unknown ? '미확정 (구독 금액 포함)' : runs.length ? '현재 이력 페이지 보고 금액 · 전체 청구 미확정' : '미확정 · 실행 이력 조회 필요';
  const last = runs.at(-1); $('autonomous-usage').textContent = t.runsUnavailable ? '실행 이력 조회 불가 · 미측정' : last?.usageUnavailable ? '미측정 · placeholder 0은 측정값 아님' : last?.usage ? '현재 페이지 입력 ' + last.usage.inputTokens + ' / 출력 ' + last.usage.outputTokens : '아직 측정 근거 없음';
  if (t.runsNextCursor) $('autonomous-usage').textContent += ' · 다음 이력 페이지 있음';
  $('autonomous-cleanup').textContent = t.status === 'stopping' ? '미확정 실행·비용·정리 확인 중' : 'summary만 조회 · 정리 완료를 의미하지 않음';
  if (Number.isSafeInteger(t.externalActionPageCount) && t.externalActionPageCount >= 0) {
    const cleanupNames = { none: '활성 또는 정리 미요청', pending: '정리 대기', deleting: '삭제 확인 중', cleaned: '부재 확인됨', unknown: '정리 상태 미보고' };
    $('autonomous-cleanup').textContent += '\n외부 행동 현재 페이지 ' + t.externalActionPageCount + '건' + (t.externalActionsHasNext ? ' · 다음 페이지 있음' : ' · 다음 페이지 없음');
    for (const r of t.externalActionResources || []) {
      $('autonomous-cleanup').textContent += '\n요청 ' + (r.requestId || '미보고') + ' · revision ' + (r.revision === null ? '미보고' : r.revision) + ' · 소유 자원 ' + (r.resourceId || '미보고') + ' · ' + cleanupNames[r.cleanupStatus];
      $('autonomous-cleanup').textContent += '\nprofile ' + (r.profileId || '미보고') + ' · 승인 당시 대상 ' + (r.approvedTarget ? JSON.stringify(r.approvedTarget) : '미보고') + (r.approvedProfileHash ? ' · 승인 hash ' + r.approvedProfileHash : '');
      if (r.parameterHash) $('autonomous-cleanup').textContent += '\n파라미터 hash ' + r.parameterHash;
      if (r.parametersSubset) $('autonomous-cleanup').textContent += '\n제출 파라미터 ' + JSON.stringify(r.parametersSubset);
      if (r.providerResult) $('autonomous-cleanup').textContent += '\nprovider 결과 ' + JSON.stringify(r.providerResult);
      if (r.billingSource) $('autonomous-cleanup').textContent += '\n' + (r.billingSource === 'operator_attested' ? '운영자 확인 · provider API 측정 아님' : '보고 출처: ' + r.billingSource + ' · 검증 근거 별도') + ' · 보고 금액 ' + usd(r.reportedCostMicros) + (r.evidenceRef ? ' · 근거 ' + r.evidenceRef : '') + (r.attestedAt !== null ? ' · 확인 시각 ' + date(r.attestedAt) : '');
    }
  } else $('autonomous-cleanup').textContent += '\n외부 자원 페이지 조회 불가';
  $('autonomous-approve').disabled = autonomous.busy || t.status !== 'awaiting_approval' || autonomousProfileHashes(t) === null;
  $('autonomous-resume').disabled = autonomous.busy || t.status !== 'awaiting_input';
  $('autonomous-cancel').disabled = autonomous.busy || ['completed', 'cancelled', 'expired', 'failed', 'budget_exceeded'].includes(t.status);
  $('autonomous-message').disabled = autonomous.busy; $('autonomous-refresh').disabled = autonomous.busy;
}
function applyAutonomousDetail(raw) {
  const t = autonomousTask(raw), prior = autonomous.detail;
  if (prior && prior.id === t.id && prior.revision !== t.revision) { $('autonomous-reason').value = ''; autonomousError('revision이 바뀌었습니다. 현재 범위를 다시 검토하세요.'); }
  else if (prior && prior.id === t.id && JSON.stringify(autonomousProfileHashes(prior)) !== JSON.stringify(autonomousProfileHashes(t))) { $('autonomous-reason').value = ''; autonomousError('외부 profile 대상 또는 설정이 바뀌었습니다. 다시 검토하세요.'); }
  autonomous.detail = t; renderAutonomous(); showAutonomousToolAudit(t.id);
}
/** The worker's own tool-call report. Rendered by tool-audit.js with textContent only; a stale answer never replaces a newer task's panel. */
function showAutonomousToolAudit(id) {
  if (typeof loadToolAudit !== 'function') return;
  const seq = autonomous.auditSeq = (autonomous.auditSeq || 0) + 1, box = node('div');
  void loadToolAudit(box, id, autonomousApi).then(() => { if (seq === autonomous.auditSeq && autonomous.selectedId === id) $('autonomous-tool-audit-body').replaceChildren(box); });
}
async function selectAutonomousTask(id) {
  if (autonomous.busy) return; const epoch = ++autonomous.epoch; autonomous.selectedId = id; autonomous.detail = null; $('autonomous-reason').value = ''; autonomousError(null); renderAutonomous();
  try { const t = await loadAutonomousTask(id); if (epoch === autonomous.epoch) applyAutonomousDetail(t); }
  catch { if (epoch === autonomous.epoch) autonomousError('장기 작업 범위를 조회할 수 없습니다. 연결·권한을 확인하세요.'); }
}
async function refreshAutonomous() {
  if (autonomous.refreshing || autonomous.busy) return; autonomous.refreshing = true; const epoch = autonomous.epoch;
  try {
    const page = await autonomousApi(autonomousPath + '?limit=20' + (autonomous.cursor ? '&cursor=' + encodeURIComponent(autonomous.cursor) : ''));
    if (!Array.isArray(page.items) || page.items.length > 20 || page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || page.nextCursor.length > 512)) throw new Error();
    autonomous.items = page.items.map(autonomousTask); autonomous.nextCursor = page.nextCursor || null;
    if (autonomous.error?.startsWith('Cloudflare')) autonomousError(null); renderAutonomous();
    const id = autonomous.selectedId; if (id) { const detail = await loadAutonomousTask(id); if (!autonomous.busy && epoch === autonomous.epoch && id === autonomous.selectedId) applyAutonomousDetail(detail); }
  } catch { autonomousError('Cloudflare 장기 작업 연결을 사용할 수 없습니다. 서버 설정과 권한을 확인하세요.'); }
  finally { autonomous.refreshing = false; }
}
$('autonomous-refresh').addEventListener('click', () => { void refreshAutonomous(); });
$('autonomous-first').addEventListener('click', async () => { autonomous.cursor = null; await refreshAutonomous(); });
$('autonomous-next').addEventListener('click', async () => { if (autonomous.nextCursor) { autonomous.cursor = autonomous.nextCursor; await refreshAutonomous(); } });
$('autonomous-decision-form').addEventListener('submit', async event => {
  event.preventDefault(); if (autonomous.busy || !autonomous.detail) return;
  const operation = event.submitter?.value; if (!['approve', 'cancel', 'message', 'resume'].includes(operation)) return;
  const reviewed = autonomous.detail, revision = reviewed.revision, profileHashes = autonomousProfileHashes(reviewed), reason = $('autonomous-reason').value.trim();
  if (!reason || reason.length > 2000) { autonomousError('현재 결정의 사유 또는 메시지를 입력하세요.'); return; }
  autonomous.busy = true; autonomousError(null); renderAutonomous();
  try {
    if (operation === 'approve' || operation === 'resume') {
      const current = await loadAutonomousTask(reviewed.id); applyAutonomousDetail(current);
      if (current.revision !== revision) { $('autonomous-reason').value = ''; throw new Error(); }
      if (operation === 'approve' && (current.status !== 'awaiting_approval' || profileHashes === null || JSON.stringify(profileHashes) !== JSON.stringify(autonomousProfileHashes(current)))) { $('autonomous-reason').value = ''; throw new Error(); }
      if (operation === 'resume' && current.status !== 'awaiting_input') throw new Error();
    }
    const body = operation === 'approve' || operation === 'resume' ? { revision, reason, ...(operation === 'approve' && reviewed.spec.externalProfiles?.length ? { externalProfileHashes: profileHashes } : {}) } : operation === 'message' ? { message: reason } : { reason };
    applyAutonomousDetail(await autonomousApi(autonomousPath + '/' + encodeURIComponent(reviewed.id) + '/' + operation, body)); $('autonomous-reason').value = '';
  } catch (error) {
    if (error.status === 409 && (operation === 'approve' || operation === 'resume')) {
      $('autonomous-reason').value = '';
      try { applyAutonomousDetail(await loadAutonomousTask(reviewed.id)); } catch { /* Keep the last visible review; never retry approval. */ }
    }
    autonomousError('요청을 기록하지 못했습니다. 현재 revision·범위·연결을 다시 확인하세요.');
  }
  finally { autonomous.busy = false; renderAutonomous(); }
});
if (!legacyHidden()) void refreshAutonomous();
setInterval(() => { if (!document.hidden && !legacyHidden()) void refreshAutonomous(); }, 2000);
