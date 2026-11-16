#!/usr/bin/env python3
"""Read-only P0 summary. Whitelists numeric evidence, IDs and hashes only."""
import argparse
import datetime
import hashlib
import json
import math
import re
import time
from pathlib import Path

STATES=('normal','warning','critical','unknown')
RESOURCE_STOPS={'critical-memory-pressure','swap-out-rate','disk-space','response-time'}
MEASUREMENT_STOPS={'critical-metrics-unavailable','host-monitor-failed'}
PHASES=('configure','compile-link','test-inventory','test','data-generation','query-process','shard-process','other')
NOTES=[
 'Preview memory runs may include dataset generation and four-query previews; do not compare them directly with the 22-query batch.',
 'Stage CPU uses wait4 for the root and reaped descendants. Hashing and controller validation outside stages are not included; terminated or detached descendants may be omitted.',
 'Sampled tree RSS can double-count shared pages. wait4 RSS is a maximum process value, not concurrent tree or host memory.',
 'Pressure durations approximate host sample intervals, clipped to the run; gaps over five seconds are unobserved.',
 'Swap-out is the new counter delta; old swap use and recovery deltas are separate. Background apps remain present.',
 'Node/Git probes are proxies, not IDE interaction latency. Parent hashing and validation can influence them.',
 'Failed SDK builds and output-parser failures are execution/harness evidence, not automatically resource-limit evidence.',
 'Cross-run SQL equivalence is not an independent upstream oracle. Missing comparisons remain missing; multiple comparison documents may cover the same execution.',
 'Core phase means compile/link for builds, query process for previews, and persistent shard process for 22-query batches. Absent phases are not-run, not zero.',
 'Local HTTP artifact proofs do not establish Cloudflare or R2 behavior. Their process-only resource figures are not whole-machine totals.',
]

def number(x):return x if type(x) in (int,float) and math.isfinite(x) else None

def ident(x):return x if isinstance(x,str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,120}',x) else None

def sha(x):return x if isinstance(x,str) and re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}',x) else None

def read_json(path):
 try:
  if path.is_symlink() or not path.is_file() or path.stat().st_size>32*1024*1024:return None
  return json.loads(path.read_text())
 except (OSError,ValueError,UnicodeError):return None

def elapsed(a,b):
 a,b=number(a),number(b)
 return (b-a)/1000 if a is not None and b is not None and b>=a else None

def ms_stamp(x):
 if number(x) is not None:return x
 if not isinstance(x,str):return None
 try:return datetime.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()*1000
 except ValueError:return None

def phase(name):
 if not isinstance(name,str):name=''
 if name=='generate':return 'data-generation'
 if name.startswith('query-'):return 'query-process'
 if name.startswith('shard-'):return 'shard-process'
 for suffix,label in [('test-inventory','test-inventory'),('configure','configure'),('build','compile-link'),('test','test')]:
  if name==suffix or name.endswith('-'+suffix):return label
 return 'other'

def intervals(rows):
 values=sorted((x['startedAt'],x['finishedAt']) for x in rows if elapsed(x.get('startedAt'),x.get('finishedAt')) is not None)
 if not values:return {'sumSeconds':None,'activeUnionSeconds':None,'spanSeconds':None,'peakIntervals':None}
 events=sorted([(a,1) for a,b in values]+[(b,-1) for a,b in values]);active=peak=0
 for _,delta in events:active+=delta;peak=max(peak,active)
 total=0;start,end=values[0]
 for a,b in values[1:]:
  if a>end:total+=end-start;start,end=a,b
  else:end=max(end,b)
 total+=end-start
 return {'sumSeconds':sum(b-a for a,b in values)/1000,'activeUnionSeconds':total/1000,'spanSeconds':(max(b for _,b in values)-values[0][0])/1000,'peakIntervals':peak}

def stage_summary(rows):
 valid=[r for r in rows if isinstance(r,dict)]
 known=[number(r.get('cpuUserSeconds'))+number(r.get('cpuSystemSeconds')) for r in valid if number(r.get('cpuUserSeconds')) is not None and number(r.get('cpuSystemSeconds')) is not None]
 rss=[number(r.get('wait4MaxRssBytes')) for r in valid if number(r.get('wait4MaxRssBytes')) is not None]
 return {**intervals(valid),'availability':'recorded' if valid else 'not-run','count':len(valid),'passed':sum(r.get('passed') is True for r in valid),'cpuSeconds':sum(known) if valid and len(known)==len(valid) else None,'knownCpuSeconds':sum(known) if known else None,'cpuCoverageComplete':bool(valid) and len(known)==len(valid),'wait4MaxSingleProcessRssBytes':max(rss) if rss else None,'terminatedStages':sum(r.get('signal') is not None or r.get('terminationReason')!='exit' for r in valid)}

def host_samples(path):
 samples=[];invalid=0
 try:
  with path.open() as f:
   for line in f:
    if len(line)>1024*1024:invalid+=1;continue
    try:r=json.loads(line)
    except ValueError:invalid+=1;continue
    if not isinstance(r,dict) or ms_stamp(r.get('timestamp')) is None:invalid+=1;continue
    samples.append(r)
 except OSError:pass
 return samples,invalid

def pressure_times(samples,start,end):
 rows=sorted((ms_stamp(s.get('timestamp')),s.get('pressureState') if s.get('pressureState') in STATES else 'unknown') for s in samples)
 duration=elapsed(start,end)
 if not rows or duration is None:return None
 result={k:0.0 for k in STATES};unobserved=0;covered=0
 for i,(at,state) in enumerate(rows):
  until=rows[i+1][0] if i+1<len(rows) else end
  a,b=max(at,start),min(until,end)
  if b<=a:continue
  known=min(b-a,5000);result[state]+=known/1000;covered+=known
  unobserved+=(b-a-known)/1000
 # Use total covered intervals, including final sample, to account for missing head/tail.
 unobserved=max(unobserved,duration-covered/1000)
 return {**result,'unobserved':unobserved,'approximate':True,'maxAttributedGapSeconds':5}

def failure_class(status,stop):
 if status=='SUCCEEDED':return 'completed-observation'
 if stop in RESOURCE_STOPS:return 'resource-guard-stop'
 if stop in MEASUREMENT_STOPS:return 'measurement-failure'
 if stop=='operator-signal':return 'operator-stop'
 return 'execution-or-harness-failure-not-attributed-to-resources'

def run_summary(folder):
 r=read_json(folder/'result.json')
 if not isinstance(r,dict):return None
 run_id=ident(r.get('id')) or ident(folder.name)
 if run_id is None:return None
 settings={};kind='unknown'
 for file,label in [('memory-batch-settings.json','memory-batch-22'),('memory-settings.json','memory-preview-subset'),('batch-settings.json','build-batch'),('build-settings.json','build-single')]:
  value=read_json(folder/file)
  if isinstance(value,dict):settings=value;kind=label;break
 if kind=='unknown' and isinstance(r.get('outcome'),dict) and number(r['outcome'].get('durationSeconds')) is not None:kind='recovery' if 'recover' in run_id else 'baseline'
 host=r.get('host') if isinstance(r.get('host'),dict) else {};samples,invalid=host_samples(folder/'host.jsonl')
 stages=r.get('stages') if isinstance(r.get('stages'),list) else []
 sdk=(read_json(folder/'environment.json') or {}).get('actualMacSdk')
 if not isinstance(sdk,dict):sdk=settings.get('actualMacSdk') if isinstance(settings.get('actualMacSdk'),dict) else {}
 categories={key:stage_summary([s for s in stages if isinstance(s,dict) and phase(s.get('name',''))==key]) for key in PHASES}
 stop=r.get('stopReason');known_stops=RESOURCE_STOPS|MEASUREMENT_STOPS|{'operator-signal','batch-task-failed'}
 status=r.get('status') if r.get('status') in ('SUCCEEDED','FAILED','STOPPED','INTERRUPTED') else 'unknown'
 result={'id':run_id,'kind':kind,'status':status,'failureClass':failure_class(status,stop),'stopCode':stop if stop in known_stops else None,
  'startedAt':number(r.get('startedAt')),'finishedAt':number(r.get('finishedAt')),'totalSeconds':elapsed(r.get('startedAt'),r.get('finishedAt')),
  'settings':{key:number(settings.get(key)) for key in ('sf','memoryGiB','threads','concurrency','jobs')},
  'profile':settings.get('config') if settings.get('config') in ('C1','C2','C3','C4') else None,
  'sdkVersion':ident(sdk.get('version')),'sdkSettingsSha256':sha(sdk.get('settingsSha256')),
  'queryCount':22 if kind=='memory-batch-22' else len(settings.get('queryIds',[])) if kind=='memory-preview-subset' else None,
  'sourceCommit':sha(settings.get('sourceCommit')),'datasetSha256':sha(settings.get('datasetSha256')),'binarySha256':sha(settings.get('binarySha256')),
  'stages':stage_summary(stages),'phaseTimes':categories,'samples':len(samples),'invalidSampleLines':invalid,
  'pressureApproximateSeconds':pressure_times(samples,r.get('startedAt'),r.get('finishedAt')),
  'host':{'sampledTreeRssPeakBytes':number(host.get('workloadRssSampledPeakBytes')),'controllerRssPeakBytes':number(host.get('controllerRssPeakBytes')),
          'hostCpuBusyP95Percent':number(host.get('cpuBusyPercentP95')),'sampledTreeCpuPeakPercent':number(host.get('workloadCpuPercentSampledPeak')),
          'nodeProbeP95Ms':number((host.get('nodeProbe') or {}).get('p95Ms')),'gitProbeP95Ms':number((host.get('gitProbe') or {}).get('p95Ms')),
          'swapOutDeltaBytes':number(host.get('swapOutDeltaBytes')),'swapUsedDeltaBytes':number(host.get('swapUsedDeltaBytes')),
          'compressedDeltaBytes':number(host.get('compressedDeltaBytes')),'minDiskFreeBytes':number(host.get('minDiskFreeBytes'))}}
 profiles=settings.get('profiles');result['profiles']=[p.get('config') for p in profiles if isinstance(p,dict) and p.get('config') in ('C1','C2','C3','C4')] if isinstance(profiles,list) else []
 state_values=[s.get('pressureState') for s in samples if s.get('pressureState') in STATES];result['pressureFirst']=state_values[0] if state_values else None;result['pressureLast']=state_values[-1] if state_values else None
 result['missing']=[k for k,v in result['host'].items() if v is None]+(['pressure-duration'] if result['pressureApproximateSeconds'] is None else [])
 result['hashPhases']={}
 for filename in ('dataset-generation-hash.json','dataset-before-hash.json','dataset-after-hash.json'):
  h=read_json(folder/filename)
  if isinstance(h,dict):result['hashPhases'][filename.removesuffix('.json')]={'seconds':elapsed(h.get('startedAt'),h.get('finishedAt')),'sha256':sha(h.get('sha256'))}
 before=read_json(folder/'dataset.json')
 if isinstance(before,dict) and elapsed(before.get('hashStartedAt'),before.get('hashFinishedAt')) is not None:result['hashPhases']['dataset-before-hash']={'seconds':elapsed(before.get('hashStartedAt'),before.get('hashFinishedAt')),'sha256':sha(before.get('sha256'))}
 return result

def comparison_summary(path):
 r=read_json(path)
 if not isinstance(r,dict):return {'id':ident(path.name),'status':'invalid-evidence'}
 results=r.get('results') if isinstance(r.get('results'),list) else []
 settings={key:number(r.get(key)) for key in ('scaleFactor','memoryGiB','baselineMemoryGiB','actualMemoryGiB','threads','baselineConcurrency','actualConcurrency')}
 legacy_fallback=False
 if r.get('kind')=='same-input-query-equivalence-not-independent-oracle' and settings['memoryGiB'] is not None:
  for field in ('baselineMemoryGiB','actualMemoryGiB'):
   if settings[field] is None:settings[field]=settings['memoryGiB'];legacy_fallback=True
 memory_complete=settings['baselineMemoryGiB'] is not None and settings['actualMemoryGiB'] is not None
 return {'id':ident(path.name),'status':'passed' if r.get('passed') is True else 'failed' if r.get('passed') is False else 'missing',
  'kind':r.get('kind') if r.get('kind') in ('same-input-query-equivalence-not-independent-oracle','cross-memory-tuning-query-equivalence') else 'unknown',
  'queryCount':number(r.get('queryCount')),'matchedQueries':sum(x.get('passed') is True for x in results if isinstance(x,dict)),
  'failedQueries':[x.get('query') for x in results if isinstance(x,dict) and x.get('passed') is False and type(x.get('query')) is int],
  'settings':settings,'memoryFieldsComplete':memory_complete,'memoryFieldOrigin':'legacy-equal-memory' if legacy_fallback else 'explicit-pair' if memory_complete else 'missing',
  'datasetSha256':sha(r.get('datasetSha256')),'sourceCommit':sha(r.get('sourceCommit')),'independentOracle':False,
  'performanceConditionsEquivalent':False,'fileSha256':hashlib.sha256(path.read_bytes()).hexdigest()}

def metadata(root):
 source=read_json(root/'source.json') or {};normal=read_json(root/'normalization.json') or {};env=read_json(root/'environment.json') or {}
 versions={}
 for name in ('node','cmake','ninja','clang','python'):
  raw=(env.get('versions') or {}).get(name);match=re.search(r'\d+\.\d+(?:\.\d+)?',raw) if isinstance(raw,str) else None;versions[name]=match.group(0) if match else None
 datasets=[]
 for path in sorted((root/'datasets').glob('*.complete.json')):
  value=read_json(path)
  if isinstance(value,dict):datasets.append({'sf':number(value.get('sf')),'bytes':number(value.get('bytes')),'sha256':sha(value.get('sha256')),'sourceCommit':sha(value.get('sourceCommit')),'completedAt':number(value.get('completedAt'))})
 return {'sourceCommit':sha(source.get('commit')),'sourceArchiveSha256':sha(source.get('sha256')),'sourceArchiveBytes':number(source.get('bytes')),
  'normalizedArchiveSha256':sha(normal.get('normalizedArchiveSha256')),'normalizedArchiveBytes':number(normal.get('normalizedBytes')),'expandedSourceBytes':number(normal.get('expandedBytes')),
  'regularSourceFiles':number(normal.get('regularFiles')),'omittedSymlinkFixtures':len(normal.get('removed',[])),
  'host':{'platform':env.get('platform') if env.get('platform') in ('darwin','linux') else 'unknown','architecture':env.get('architecture') if env.get('architecture') in ('arm64','x64') else 'unknown','logicalCpu':number(env.get('logicalCpu')),'memoryBytes':number(env.get('memoryBytes')),'toolVersions':versions},'datasets':datasets}

def fmt(value,divisor=1):return 'missing' if number(value) is None else f'{value/divisor:.3f}'
def phase_time(row,key):
 value=row['phaseTimes'][key]
 return 'not-run' if value['count']==0 else fmt(value['activeUnionSeconds'])
def pressure(row):
 p=row['pressureApproximateSeconds'];return 'missing' if p is None else '/'.join(fmt(p[k]) for k in ('normal','warning','critical'))
def markdown(result):
 lines=['# DuckDB P0 계측 요약','','단일 preview·준비 포함 실행과 22쿼리 배치는 서로 다른 작업이다. CPU·압박 관측으로 실패 원인을 자동 추정하지 않는다.']
 groups=[('기준선·회복',('baseline','recovery')),('C++ 단일·batch',('build-single','build-batch')),('메모리 subset preview',('memory-preview-subset',)),('고정 22쿼리 batch',('memory-batch-22',))]
 for title,kinds in groups:
  lines+=['','## '+title,'','| ID | 상태 | 전체초 | stage CPU초 | gen초 | 핵심단계 union초 | tree RSS GiB | wait4 max GiB | normal/warn/critical 근사초 | 새 swap-out GiB | Node p95 ms |','|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
  for r in result['runs']:
   if r['kind'] not in kinds:continue
   core='compile-link' if r['kind'].startswith('build-') else 'shard-process' if r['kind']=='memory-batch-22' else 'query-process'
   native=phase_time(r,core)
   lines.append(f"| {r['id']} | {r['status']} | {fmt(r['totalSeconds'])} | {fmt(r['stages']['cpuSeconds'])} | {phase_time(r,'data-generation')} | {native} | {fmt(r['host']['sampledTreeRssPeakBytes'],2**30)} | {fmt(r['stages']['wait4MaxSingleProcessRssBytes'],2**30)} | {pressure(r)} | {fmt(r['host']['swapOutDeltaBytes'],2**30)} | {fmt(r['host']['nodeProbeP95Ms'])} |")
 lines+=['','## 결과 동치 대조','','| 근거 ID | 종류 | SF | memory 기준→실행 | 동시성 기준→실행 | 일치쿼리 | 상태 |','|---|---|---:|---|---|---:|---|']
 for r in result['comparisons']:
  settings=r.get('settings',{});a=settings.get('baselineMemoryGiB');b=settings.get('actualMemoryGiB')
  lines.append(f"| {r['id']} | {r.get('kind','missing')} | {fmt(settings.get('scaleFactor'))} | {fmt(a)}→{fmt(b)} | {fmt(settings.get('baselineConcurrency'))}→{fmt(settings.get('actualConcurrency'))} | {r.get('matchedQueries','missing')} | {r['status']} |")
 if not result['comparisons']:lines.append('| missing | missing | missing | missing | missing | missing | missing |')
 lines+=['','## 로컬 아티팩트 경로 검증','','| ID | 성공 | 초 | 데이터 bytes | Node RSS peak bytes | Cloudflare/R2 검증 |','|---|---|---:|---:|---:|---|']
 for proof in result['localArtifactProofs']:
  lines.append(f"| {proof['id']} | {proof['success']} | {fmt(proof['durationSeconds'])} | {fmt(proof['dataBytes'])} | {fmt(proof['nodeSampledRssPeakBytes'])} | false |")
 if not result['localArtifactProofs']:lines.append('| missing | missing | missing | missing | missing | false |')
 lines+=['','## 실패와 계측 누락','']
 for r in result['runs']:
  if r['status']!='SUCCEEDED' or r['missing']:lines.append(f"- {r['id']}: {r['failureClass']}; missing={','.join(r['missing']) or 'none'}")
 lines+=['','## 해석 범위','']+['- '+n for n in NOTES]+['']
 return '\n'.join(lines)

def comparison_files(root,folders):
 patterns=('*.compare.json','*-compare.json','*-quality.json','*.shared-output-policy.json')
 paths=set()
 for directory in [root,root/'runs',*folders]:
  for pattern in patterns:paths.update(p for p in directory.glob(pattern) if p.is_file() and not p.is_symlink() and ident(p.name))
 return sorted(paths)

def artifact_proofs(root):
 proofs=[]
 for path in sorted((root/'local-large-proof').glob('*/receipt.json')):
  r=read_json(path)
  if not isinstance(r,dict) or ident(path.parent.name) is None:continue
  data=r.get('dataReadback') if isinstance(r.get('dataReadback'),dict) else {};resources=r.get('resources') if isinstance(r.get('resources'),dict) else {};source=r.get('extractedSource') if isinstance(r.get('extractedSource'),dict) else {}
  proofs.append({'id':ident(path.parent.name),'kind':'local-http-artifact-proof','success':r.get('success') is True,'durationSeconds':number(r.get('durationMs'))/1000 if number(r.get('durationMs')) is not None else None,'dataBytes':number(data.get('bytes')),'dataSha256':sha(data.get('sha256')),'sourceFiles':number(source.get('files')),'sourceExpandedBytes':number(source.get('expandedBytes')),'nodeSampledRssPeakBytes':number(resources.get('sampledRssPeakBytes')),'nodeMaxRssKiB':number(resources.get('maxRSSKiB')),'nodeCpuUserMicros':number(resources.get('cpuUserMicros')),'nodeCpuSystemMicros':number(resources.get('cpuSystemMicros')),'resourceScope':'node-process-only','remoteVerified':False,'r2Verified':False})
 return proofs

def summarize(root):
 root=Path(root).resolve(strict=True);folders=sorted(p for p in (root/'runs').iterdir() if p.is_dir() and not p.is_symlink());runs=[];incomplete=[]
 for folder in folders:
  row=run_summary(folder)
  if row:runs.append(row)
  elif ident(folder.name):incomplete.append(ident(folder.name))
 comparisons=[comparison_summary(p) for p in comparison_files(root,folders)]
 return {'version':1,'generatedAtMs':round(time.time()*1000),'metadata':metadata(root),'runs':sorted(runs,key=lambda r:r['startedAt'] or 0),'incompleteRuns':incomplete,'comparisons':comparisons,'comparisonStatus':'present' if comparisons else 'missing','localArtifactProofs':artifact_proofs(root),'notes':NOTES}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();result=summarize(args.root);out=Path(args.output);out.mkdir(parents=True,exist_ok=True,mode=0o700)
 for name,text in [('summary.json',json.dumps(result,indent=2)+'\n'),('tables.md',markdown(result))]:
  tmp=out/(name+'.tmp');tmp.write_text(text);tmp.chmod(0o600);tmp.replace(out/name)
 print(json.dumps({'runs':len(result['runs']),'comparisons':len(result['comparisons']),'incompleteRuns':len(result['incompleteRuns'])}))
if __name__=='__main__':main()
