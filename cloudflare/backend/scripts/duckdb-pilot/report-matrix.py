"""Summarize measured DuckDB matrix runs and available container usage."""
import json
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1])
matrix = root / 'main-matrix'
manifest = json.loads((matrix / 'manifest.json').read_text())
usage_file = matrix / 'accounting/observed-usage.json'
usage = json.loads(usage_file.read_text())['rows'] if usage_file.exists() else []
rows = []

def span(phases):
    intervals = sorted((p['startedAt'], p['finishedAt']) for p in phases)
    if not intervals:
        return None
    start, end = intervals[0]
    total = 0
    for a, b in intervals[1:]:
        if a > end:
            total += end-start
            start, end = a, b
        else:
            end = max(end, b)
    return (total+end-start)/1000

for case in manifest['conditions']:
    row = dict(case)
    location = (root/'runs'/case['id'] if case['environment']=='local'
                else matrix/case['id']/'build')
    f = location/'result.json'
    if not f.exists():
        latest = location/'latest.json'
        if latest.exists() and case['environment']=='cloud':
            row['status'] = json.loads(latest.read_text())['group']['status']
        else:
            row['status'] = 'unavailable'
    elif case['environment']=='local':
        v = json.loads(f.read_text())
        row.update(status=v['status'], passed=v['status']=='SUCCEEDED' and v['outcome']['passed'],
                   total=(v['finishedAt']-v['startedAt'])/1000,
                   build=span([p for p in v['stages'] if p['name'].endswith('-build')]),
                   restoreSeconds=None,integration=None,
                   finalization=(v['finishedAt']-max(p['finishedAt'] for p in v['stages']))/1000 if v['stages'] else None,
                   cpuSeconds=sum(p['cpuUserSeconds']+p['cpuSystemSeconds'] for p in v['stages']),
                   peakGiB=v['host']['workloadRssSampledPeakBytes']/2**30,
                   nodeP95Ms=v['host']['nodeProbe']['p95Ms'], cost=None)
    else:
        v = json.loads(f.read_text())
        g = v['group']
        aggregation = v.get('integration')
        jobs = [item['result'] for item in v['jobs'] if item.get('result')]
        phases = [p for item in v['outcomes'] if item.get('receipt')
                  for p in item['receipt']['phases'] if p['name']=='build']
        charged = [r['usage']['retailUsd'] for r in usage if r['groupId']==g['id']]
        row.update(status=g['status'], passed=v['validation']['passed'],
                   total=(g['finishedAt']-g['approvedAt'])/1000, build=span(phases),
                   restoreSeconds=sum(x['largeArtifacts']['durationMs'] for x in jobs)/1000
                                  if len(jobs)==4 and all(x.get('largeArtifacts') for x in jobs) else None,
                   integration=(aggregation['job']['finishedAt']-aggregation['job']['createdAt'])/1000
                               if aggregation else None,
                   cpuSeconds=sum(x['resources']['usageUsec'] for x in jobs)/1e6
                              if len(jobs)==4 and all(x.get('resources') for x in jobs) else None,
                   peakGiB=max(x['resources']['peakMemoryBytes'] for x in jobs)/2**30
                           if len(jobs)==4 and all(x.get('resources') for x in jobs) else None,
                   throttledSeconds=sum(x['resources']['throttledUsec'] for x in jobs)/1e6
                                    if len(jobs)==4 and all(x.get('resources',{}).get('throttledUsec') is not None for x in jobs) else None,
                   groupId=g['id'], knownCost=sum(x for x in charged if x is not None), observedCostJobs=sum(x is not None for x in charged), cost=sum(charged) if len(charged)==5 and None not in charged else None)
    rows.append(row)

def fmt(value):
    return '미확인' if value is None else f'{value:.3f}'

lines = ['# DuckDB 빌드 본실험', '',
         '입력 복원은 워커별 시간 합계, 빌드는 컴파일·링크 구간의 시간 합집합이다. '
         '로컬 메모리는 작업 트리 RSS 표본, 원격은 단일 워커의 최대 cgroup 메모리다. '
         '로컬 CPU는 명령별 wait4 합계, 원격 CPU는 네 워커의 cgroup 합계다. 원격 통합은 결과 수집과 최종 집계 작업이며 로컬은 별도 통합 작업을 실행하지 않는다.',
         '', '| 조건 | 종료 | 완주 | 전체 중앙값(초) | 입력 복원 합계(초) | 빌드(초) | 통합(초) | CPU초 | 메모리(GiB) | 완주당 비용($) |',
         '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
for key in dict.fromkeys((r['environment'],r['workers'],r['jobs']) for r in rows):
    group = [r for r in rows if (r['environment'],r['workers'],r['jobs'])==key]
    successes = [r for r in group if r.get('passed')]
    fields = ['total','restoreSeconds','build','integration','cpuSeconds','peakGiB']
    values = [fmt(statistics.median([r[k] for r in successes]))
              if successes and all(r.get(k) is not None for r in successes) else '미확인' for k in fields]
    observed = [r.get('cost') for r in group]
    cost = fmt(sum(observed)/len(successes)) if successes and None not in observed else '미확인'
    finished = sum('passed' in r for r in group)
    lines.append(f'| {key[0]} {key[1]}×{key[2]} | {finished}/3 | {len(successes)}/3 | ' +
                 ' | '.join(values+[cost])+' |')
lines += ['', '| 실행 | 상태 | 승인·시작→완료(초) | 비용 조회(작업 수) | 조회된 비용 소계($) |',
          '|---|---|---:|---:|---:|']
for r in rows:
    lines.append(f"| {r['id']} | {r['status']} | {fmt(r.get('total'))} | "
                 f"{r.get('observedCostJobs', '—')} | {fmt(r.get('knownCost'))} |")
if not (matrix/'complete.json').exists():
    lines += ['', '실행이 진행 중이거나 중단되어 일부 결과만 집계했다.']
lines += ['', '비용은 조회된 컨테이너 사용량의 요율 환산이다. R2 및 기타 비용은 별도다.']
(matrix/'summary.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
(matrix/'report.md').write_text('\n'.join(lines)+'\n')

if len(sys.argv)>2:
    Path(sys.argv[2]).write_text('\n'.join(lines)+'\n')
