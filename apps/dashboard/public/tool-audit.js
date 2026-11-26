'use strict';
// Worker tool-call audit panel. Server values are shown with textContent only.
(function (root) {
  const outcomes = { allowed: '허용', denied: '거부', error: '오류' };
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  };
  const num = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : '확인 필요';
  const time = (value) => Number.isFinite(value) ? new Date(value).toLocaleString('ko-KR') : '확인 필요';
  const valid = (page) => page && typeof page === 'object' && Array.isArray(page.items) && page.totals && typeof page.totals === 'object';
  /** Renders one page. `onMore(cursor)` is called when the operator asks for the next page. */
  function renderToolAudit(container, page, onMore) {
    if (!valid(page)) { container.replaceChildren(node('p', '도구 호출 기록을 불러오지 못했습니다.', 'tool-audit-error')); return; }
    const t = page.totals, children = [];
    children.push(node('p', '워커가 보고한 기록이며 독립 증명이 아닙니다. 버려진 기록이 있을 수 있습니다.', 'tool-audit-notice'));
    children.push(node('p', '저장 ' + num(t.recorded) + '건 · 거부 ' + num(t.denied) + '건 · 오류 ' + num(t.errors) + '건 · 워커가 버린 기록 ' + num(t.droppedByWorker) + '건 · 저장소가 버린 기록 ' + num(t.droppedByStore) + '건', 'tool-audit-totals'));
    if (!page.items.length) children.push(node('p', '표시할 호출 기록이 없습니다.', 'tool-audit-empty'));
    const list = node('ul', undefined, 'tool-audit-list');
    for (const item of page.items) {
      const row = node('li', undefined, 'tool-audit-item tool-audit-' + (outcomes[item.outcome] ? item.outcome : 'unknown'));
      row.append(
        node('strong', '#' + num(item.sequence) + ' ' + String(item.tool) + (item.subagent ? ' (하위 에이전트)' : ''), 'tool-audit-tool'),
        node('span', ' ' + (outcomes[item.outcome] || '확인 필요') + ' · ' + time(item.startedAt) + ' · ' + (item.durationMs === null ? '소요 시간 미기록' : num(item.durationMs) + 'ms'), 'tool-audit-meta'),
        node('pre', String(item.inputSummary) + (item.inputTruncated ? '\n[잘림]' : ''), 'tool-audit-summary'),
        node('code', String(item.inputDigest), 'tool-audit-digest')
      );
      list.append(row);
    }
    children.push(list);
    if (typeof page.nextCursor === 'string' && typeof onMore === 'function') {
      const more = node('button', '더 보기', 'tool-audit-more');
      more.type = 'button';
      more.addEventListener('click', () => { more.disabled = true; return onMore(page.nextCursor); });
      children.push(more);
    }
    container.replaceChildren(...children);
  }
  /** Loads a page through `fetchJson(path)` (the dashboard's operator-authenticated helper) and renders it. */
  async function loadToolAudit(container, taskId, fetchJson, cursor) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(taskId))) { renderToolAudit(container, null); return; }
    try {
      const page = await fetchJson('/api/cloudflare/autonomous-tasks/' + encodeURIComponent(taskId) + '/tool-calls?limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      renderToolAudit(container, page, (next) => loadToolAudit(container, taskId, fetchJson, next));
    } catch { renderToolAudit(container, null); }
  }
  root.renderToolAudit = renderToolAudit;
  root.loadToolAudit = loadToolAudit;
})(globalThis);
