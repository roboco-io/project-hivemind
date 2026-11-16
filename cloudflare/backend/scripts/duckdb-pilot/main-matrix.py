"""Run the preregistered DuckDB matrix in sequential, randomized blocks."""
import hashlib
import json
import os
import random
import subprocess
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
root = Path(sys.argv[1]).resolve()
origin, control = sys.argv[2:4]
output = root / 'main-matrix'
output.mkdir(mode=0o700, exist_ok=True)
gate = json.loads((root / 'main-inventory-gate/build/result.json').read_text())
if gate['validation']['passed'] is not True:
    raise SystemExit('Remote inventory gate must pass')
conditions = [('local', 2, 5), ('local', 4, 4), ('cloud', 1, 4),
              ('cloud', 2, 4), ('cloud', 4, 4)]
rng = random.Random(20261115)
plan = []
for block in range(1, 4):
    order = conditions.copy()
    rng.shuffle(order)
    for environment, workers, jobs in order:
        plan.append(dict(id=f'main-b{block}-{environment}-c{workers}-j{jobs}',
                         block=block, environment=environment, workers=workers, jobs=jobs))
# Reserve full CPU, memory and disk for every remote work and aggregation timeout.
ceiling = 9 * (4 * 3600 + 120) * 0.0001114
manifest = dict(seed=20261115, conditions=plan, budgetUsd=30,
                containerTimeoutScenarioUsd=ceiling, operatorReserveUsd=10)
inputs = [here / name for name in ('main-matrix.py', 'projection-tests.txt', 'pilot.ts', 'remote.ts',
                                  'remote/runner.mjs', 'remote/probe-policy.ts',
                                  'remote/toolchain.ts', 'inventory.py')]
manifest['scriptSha256'] = {str(p.relative_to(here)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
manifest['runtimeRevision'] = gate['plan']['binding']['runtimeRevision'] if 'plan' in gate else json.loads(
    (root/'main-inventory-gate/build/plan.json').read_text())['binding']['runtimeRevision']
if ceiling + manifest['operatorReserveUsd'] >= manifest['budgetUsd']:
    raise SystemExit('Cloudflare timeout reservations exceed budget')
planfile = output / 'manifest.json'
if planfile.exists() and json.loads(planfile.read_text()) != manifest:
    raise SystemExit('Matrix manifest changed')
planfile.write_text(json.dumps(manifest, indent=2) + '\n')
lock = output / 'operator.lock'
with lock.open('x') as fh:
    fh.write(str(os.getpid()))
try:
    for case in plan:
        name = case['id']
        env = dict(os.environ, DUCKDB_MATRIX_RUNTIME=manifest['runtimeRevision'])
        if case['environment'] == 'local':
            evidence = root / 'runs' / name / 'result.json'
            env['DUCKDB_PILOT_OSX_SYSROOT'] = '/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk'
            command = ['node', str(here/'pilot.ts'), 'build-batch', str(root), name,
                       'C1,C2,C3,C4', str(case['workers']), str(case['jobs'])]
        else:
            evidence = output / name / 'build/result.json'
            command = ['node', str(here/'remote.ts'), 'matrix', str(output/name),
                       str(root/'remote-live/source-ref.json'), '-', origin, control,
                       str(case['workers'])]
        print(json.dumps(case), flush=True)
        if not evidence.exists():
            with (output / (name + '.log')).open('a') as log:
                process = subprocess.run(command, env=env, stdout=log, stderr=log)
            if process.returncode and not evidence.exists():
                raise SystemExit('No terminal evidence for ' + name)
        result = json.loads(evidence.read_text())
        passed = (result['status']=='SUCCEEDED' and result['outcome']['passed']
                  if case['environment']=='local' else result['validation']['passed'])
        if not passed:
            print('Recorded incomplete bundle: ' + name, flush=True)
    (output/'complete.json').write_text(json.dumps({'bundles':len(plan)}))
finally:
    lock.unlink()
