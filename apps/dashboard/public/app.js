'use strict';

const $ = (id) => document.getElementById(id);
const statuses = {
  awaiting_execution_approval: '실행 승인 대기', queued: '배정 대기', running: '실행 중',
  awaiting_review: '결과 검토 대기', completed: '수락 완료', rejected: '반려', cancelled: '중단', failed: '실패'
};
const terminal = new Set(['completed', 'rejected', 'cancelled', 'failed']);
const state = { tasks: [], workers: [], events: [], selectedId: null, creating: true, busy: false, refreshing: false, error: null };
const usd = (micros) => '$' + (micros / 1_000_000).toFixed(6);
const date = (value) => new Date(value).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
  $('cost-total').textContent = usd(state.tasks.reduce((sum, t) => sum + t.actualCostMicros, 0));
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
    button.lastChild.firstChild.textContent = statuses[task.status] || task.status;
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
    item.append(node('strong', worker.id), node('p', worker.provider + ' / ' + worker.runtime));
    item.append(node('p', (fresh ? '연결됨' : '응답 확인 필요') + ' · ' + date(worker.lastSeenAt), fresh ? 'online' : 'stale'));
    list.append(item);
  }
  if (!state.workers.length) list.append(node('p', '워커 연결을 기다립니다. 별도 터미널에서 npm run worker를 실행하세요.', 'empty'));
}
function renderSelected() {
  const task = state.tasks.find(t => t.id === state.selectedId);
  $('create-panel').hidden = !state.creating;
  $('task-panel').hidden = state.creating || !task;
  if (state.creating || !task) return;
  $('task-id').textContent = task.id;
  $('selected-title').textContent = task.title;
  $('selected-status').textContent = statuses[task.status] || task.status;
  $('selected-status').className = 'pill ' + task.status;
  $('task-instructions-view').textContent = task.instructions;
  $('task-route').textContent = task.provider + ' / ' + task.runtime;
  $('task-worker').textContent = task.workerId || '아직 배정하지 않음';
  $('task-budget-view').textContent = usd(task.budgetMicros);
  $('task-estimate').textContent = usd(task.estimatedCostMicros);
  $('task-actual').textContent = usd(task.actualCostMicros);
  $('task-updated').textContent = date(task.updatedAt);
  const awaitingExecution = task.status === 'awaiting_execution_approval';
  const awaitingReview = task.status === 'awaiting_review';
  $('decision-panel').hidden = terminal.has(task.status);
  $('decision-title').textContent = awaitingExecution ? '실행을 승인해 주세요' : awaitingReview ? '결과를 검토해 주세요' : '작업을 감독하고 있습니다';
  $('decision-description').textContent = awaitingExecution ? '승인하면 대기열에 들어가고, 연결된 워커가 작업을 가져갑니다.' : awaitingReview ? 'diff와 보고 비용을 확인하세요. 결과 수락은 Git 적용·병합을 실행하지 않습니다.' : '필요하면 작업을 중단할 수 있습니다. 중단 후 도착한 결과는 수락하지 않습니다.';
  $('approve-button').hidden = !awaitingExecution && !awaitingReview;
  $('approve-button').textContent = awaitingReview ? '결과 수락' : '실행 승인';
  $('reject-button').hidden = !awaitingExecution && !awaitingReview;
  $('task-summary').textContent = task.summary || '아직 보고된 결과가 없습니다.';
  $('task-summary').className = task.summary ? '' : 'empty';
  $('task-diff').textContent = task.diff || '워커 실행 후 변경 제안이 표시됩니다.';
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
  renderTasks();
  renderWorkers();
  renderSelected();
  $('new-task-button').disabled = state.busy;
  $('create-submit').disabled = state.busy;
  $('create-submit').textContent = state.busy && state.creating ? '등록 중…' : '작업 등록';
  for (const button of $('decision-form').querySelectorAll('button')) button.disabled = state.busy;
}
async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const result = await api('/api/state');
    state.tasks = result.tasks;
    state.workers = result.workers;
    state.events = result.events;
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
$('connection-form').addEventListener('submit', event => { event.preventDefault(); setError(null); void refresh(); });
$('new-task-button').addEventListener('click', () => { if (!state.busy) { state.creating = true; render(); $('task-title').focus(); } });
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy) return;
  const title = $('task-title').value.trim();
  const instructions = $('task-instructions').value.trim();
  const budgetMicros = Math.round(Number($('task-budget').value) * 1_000_000);
  if (!title || !instructions || !Number.isSafeInteger(budgetMicros) || budgetMicros < 1000) { setError('제목, 목표와 $0.001000 이상의 예산을 입력하세요.'); return; }
  state.busy = true;
  setError(null);
  render();
  try {
    const result = await api('/api/tasks', { title, instructions, budgetMicros, provider: 'mock', runtime: 'local' });
    state.selectedId = result.id;
    state.creating = false;
    $('create-form').reset();
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
  const reason = $('decision-reason').value.trim();
  if (!reason) { setError('결정 사유를 입력하세요.'); $('decision-reason').focus(); return; }
  state.busy = true;
  setError(null);
  render();
  try {
    await api('/api/tasks/' + encodeURIComponent(state.selectedId) + (decision === 'cancel' ? '/cancel' : '/decision'), decision === 'cancel' ? { reason } : { decision, reason });
    $('decision-reason').value = '';
    await refresh();
  } catch (error) { setError('결정 기록 실패: ' + error.message); }
  finally { state.busy = false; render(); }
});
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
