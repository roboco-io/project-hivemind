(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined && v !== null) node.setAttribute(k, String(v));
      }
    }
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function htmlEl(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function shortDate(iso) {
    if (!iso) return '-';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '-';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /**
   * Pure DOM-API SVG chart showing per-job settled/reserved bars and cumulative cost line.
   * Uses createElementNS + textContent exclusively (zero innerHTML, strict CSP compliant).
   */
  function renderCostTrendChart(container, jobs, formatUsd, options) {
    if (!container) return;
    container.replaceChildren();

    const list = Array.isArray(jobs)
      ? [...jobs]
          .filter((j) => j && typeof j === 'object')
          .sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''))
      : [];

    if (!list.length) {
      container.append(htmlEl('p', '아직 시각화할 Model Factory 비용 이력이 없습니다.', 'empty'));
      return;
    }

    const compact = Boolean(options?.compact);
    const items = list.slice(compact ? -10 : -20);
    const width = compact ? 520 : 760;
    const height = compact ? 185 : 230;
    const pad = { top: 20, right: 56, bottom: 32, left: 56 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    let cumSettled = 0;
    let cumCommitted = 0;
    const series = items.map((job) => {
      const settled = typeof job.cost?.settledMicros === 'number' ? job.cost.settledMicros : typeof job.settledMicros === 'number' ? job.settledMicros : 0;
      const isSettled = job.cost ? job.cost.settledMicros !== null : job.settledMicros !== null;
      const reserved = !isSettled ? (job.cost?.reservedMicros ?? job.reservedMicros ?? 0) : 0;
      cumSettled += settled;
      cumCommitted += settled + reserved;
      return {
        id: String(job.id || job.jobId || ''),
        modelId: String(job.modelId || ''),
        label: shortDate(job.createdAt),
        settled,
        reserved,
        cumSettled,
        cumCommitted,
      };
    });

    const maxBar = Math.max(1, ...series.map((s) => s.settled + s.reserved));
    const maxCum = Math.max(1, ...series.map((s) => s.cumCommitted));
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'hm-svg-chart',
      role: 'img',
      'aria-label': 'Model Factory 작업별 및 누적 비용 추이 차트',
    });

    // Horizontal gridlines & left/right axis ticks
    for (let i = 0; i <= 3; i++) {
      const ratio = i / 3;
      const y = pad.top + plotH * (1 - ratio);
      svg.append(
        svgEl('line', {
          x1: pad.left,
          y1: y.toFixed(1),
          x2: width - pad.right,
          y2: y.toFixed(1),
          class: 'chart-grid',
        }),
      );
      svg.append(
        svgEl(
          'text',
          { x: pad.left - 8, y: (y + 3).toFixed(1), 'text-anchor': 'end', class: 'chart-axis-text' },
          formatUsd(Math.round(maxBar * ratio)),
        ),
      );
      svg.append(
        svgEl(
          'text',
          { x: width - pad.right + 8, y: (y + 3).toFixed(1), 'text-anchor': 'start', class: 'chart-axis-text chart-axis-cum' },
          formatUsd(Math.round(maxCum * ratio)),
        ),
      );
    }

    const step = plotW / series.length;
    const barW = Math.max(6, Math.min(28, step * 0.56));
    const linePoints = [];

    series.forEach((pt, idx) => {
      const cx = pad.left + step * idx + step / 2;
      const x = cx - barW / 2;
      const settledH = (pt.settled / maxBar) * plotH;
      const reservedH = (pt.reserved / maxBar) * plotH;

      const group = svgEl('g', { class: 'chart-bar-group' });
      const tip =
        pt.modelId +
        ' (' +
        pt.label +
        ') · 정산 ' +
        formatUsd(pt.settled) +
        (pt.reserved ? ' · 예약 ' + formatUsd(pt.reserved) : '') +
        ' · 누적 ' +
        formatUsd(pt.cumCommitted);
      group.append(svgEl('title', null, tip));

      if (settledH > 0) {
        group.append(
          svgEl('rect', {
            x: x.toFixed(1),
            y: (pad.top + plotH - settledH).toFixed(1),
            width: barW.toFixed(1),
            height: Math.max(2, settledH).toFixed(1),
            rx: 3,
            class: 'chart-bar-settled',
          }),
        );
      }
      if (reservedH > 0) {
        group.append(
          svgEl('rect', {
            x: x.toFixed(1),
            y: (pad.top + plotH - settledH - reservedH).toFixed(1),
            width: barW.toFixed(1),
            height: Math.max(2, reservedH).toFixed(1),
            rx: 3,
            class: 'chart-bar-reserved',
          }),
        );
      }
      svg.append(group);

      const cumY = pad.top + plotH - (pt.cumCommitted / maxCum) * plotH;
      linePoints.push([cx, cumY, tip]);

      if (series.length <= 10 || idx % Math.ceil(series.length / 8) === 0 || idx === series.length - 1) {
        svg.append(
          svgEl(
            'text',
            { x: cx.toFixed(1), y: (height - 10).toFixed(1), 'text-anchor': 'middle', class: 'chart-axis-text' },
            pt.label,
          ),
        );
      }
    });

    if (linePoints.length > 1) {
      const pathD = linePoints.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
      svg.append(svgEl('path', { d: pathD, class: 'chart-cum-line' }));
    }
    for (const [cx, cy, tip] of linePoints) {
      const dot = svgEl('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 3.5, class: 'chart-cum-dot' });
      dot.append(svgEl('title', null, tip));
      svg.append(dot);
    }

    container.append(svg);

    const footer = htmlEl('div', undefined, 'chart-caption');
    footer.append(
      htmlEl('span', '막대(좌축): 작업별 정산(파랑) · 활성 예약(황색)'),
      htmlEl('span', '선(우축): 누적 확보·정산 추이'),
    );
    container.append(footer);
  }

  /**
   * Renders ranked horizontal proportion bars for cost/count breakdowns (model, region, instance type).
   */
  function renderBreakdownBars(container, entries, formatUsd, emptyText) {
    if (!container) return;
    container.replaceChildren();

    const rows = Array.isArray(entries) ? [...entries].sort((a, b) => b.totalMicros - a.totalMicros || b.count - a.count) : [];
    if (!rows.length) {
      container.append(htmlEl('p', emptyText || '집계할 데이터가 없습니다.', 'empty'));
      return;
    }

    const totalAll = Math.max(1, rows.reduce((sum, r) => sum + r.totalMicros, 0));
    const maxRow = Math.max(1, rows[0].totalMicros);
    const list = htmlEl('div', undefined, 'breakdown-list');

    for (const row of rows.slice(0, 8)) {
      const item = htmlEl('div', undefined, 'breakdown-item');
      const head = htmlEl('div', undefined, 'breakdown-head');
      const left = htmlEl('span', undefined, 'breakdown-name');
      left.append(htmlEl('strong', row.label), htmlEl('span', ' (' + row.count + '건)', 'quiet'));
      const share = row.totalMicros > 0 ? Math.round((row.totalMicros / totalAll) * 100) : 0;
      const right = htmlEl('span', formatUsd(row.totalMicros) + ' · ' + share + '%', 'mono breakdown-val');
      head.append(left, right);

      const track = htmlEl('div', undefined, 'breakdown-track');
      const settledFill = htmlEl('div', undefined, 'breakdown-fill settled');
      const reservedFill = htmlEl('div', undefined, 'breakdown-fill reserved');
      const settledW = maxRow > 0 ? Math.min(100, (row.settledMicros / maxRow) * 100) : 0;
      const reservedW = maxRow > 0 ? Math.min(100 - settledW, (row.reservedMicros / maxRow) * 100) : 0;
      settledFill.style.width = settledW.toFixed(1) + '%';
      reservedFill.style.width = reservedW.toFixed(1) + '%';
      track.append(settledFill, reservedFill);

      item.append(head, track);
      list.append(item);
    }
    container.append(list);
  }

  function renderStepper(container, steps) {
    if (!container) return;
    container.replaceChildren();
    const ol = htmlEl('ol', undefined, 'pipeline-stepper');
    for (const step of steps) {
      const li = htmlEl('li', undefined, 'step-item step-' + step.state);
      li.append(htmlEl('span', step.badge || '', 'step-dot'), htmlEl('span', step.label, 'step-label'));
      ol.append(li);
    }
    container.append(ol);
  }

  function deliverySteps(task) {
    const labels = ['등록', '실행 승인', 'Fargate 실행', '독립 검증', 'Draft PR', '최종 승인'];
    const s = task?.status || '';
    const terminalFail = s === 'failed' || s === 'cancelled' || s === 'rejected';
    let idx = 0;
    if (s === 'awaiting_approval') idx = 1;
    else if (s === 'queued' || s === 'running') idx = 2;
    else if (s === 'verified') idx = 3;
    else if (s === 'draft_pr_published') idx = 4;
    else if (s === 'approved') idx = 6;
    else if (terminalFail) {
      idx = task?.publication ? 5 : task?.latestAttestation ? 3 : task?.approvedAt ? 2 : 1;
    }
    return labels.map((label, i) => {
      if (i < idx) return { label, state: 'done', badge: '✓' };
      if (i === idx && terminalFail) return { label, state: 'error', badge: '!' };
      if (i === idx) return { label, state: 'active', badge: '●' };
      return { label, state: 'upcoming', badge: String(i + 1) };
    });
  }

  function mfSteps(job) {
    const labels = ['등록', '학습 승인', 'EC2 학습', '영수증·검증', '공개 승인', '공개 완료'];
    const s = job?.status || '';
    const terminalFail = s === 'failed' || s === 'cancelled' || s === 'rejected';
    let idx = 0;
    if (s === 'awaiting_training_approval') idx = 1;
    else if (s === 'training_queued' || s === 'training_running') idx = 2;
    else if (s === 'evaluating') idx = 3;
    else if (s === 'awaiting_release_approval' || s === 'release_approved') idx = 4;
    else if (s === 'released') idx = 6;
    else if (terminalFail) {
      idx = job?.releaseAttestation ? 4 : job?.receipt ? 3 : job?.approvedAt ? 2 : 1;
    }
    return labels.map((label, i) => {
      if (i < idx) return { label, state: 'done', badge: '✓' };
      if (i === idx && terminalFail) return { label, state: 'error', badge: '!' };
      if (i === idx) return { label, state: 'active', badge: '●' };
      return { label, state: 'upcoming', badge: String(i + 1) };
    });
  }

  function collabSteps(session, subtasks) {
    const labels = ['세션 등록', '하위 분배', '병렬 실행', '세션 종료'];
    const s = session?.status || '';
    const subs = Array.isArray(subtasks) ? subtasks : [];
    const terminalFail = s === 'failed' || s === 'cancelled';
    let idx = 1;
    if (s === 'completed') idx = 4;
    else if (terminalFail) idx = 2;
    else if (subs.some((st) => st.status === 'running' || st.status === 'completed')) idx = 2;
    return labels.map((label, i) => {
      if (i < idx) return { label, state: 'done', badge: '✓' };
      if (i === idx && terminalFail) return { label, state: 'error', badge: '!' };
      if (i === idx) return { label, state: 'active', badge: '●' };
      return { label, state: 'upcoming', badge: String(i + 1) };
    });
  }

  globalThis.hivemindCharts = {
    renderCostTrendChart,
    renderBreakdownBars,
    renderStepper,
    deliverySteps,
    mfSteps,
    collabSteps,
  };
})();
