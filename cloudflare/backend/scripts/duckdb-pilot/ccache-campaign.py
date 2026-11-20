"""Run six DuckDB cache bundles with fresh workspaces and one immutable seed."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

pilot, origin, secret_file = sys.argv[1:4]
script = Path(__file__).resolve().parent
root = Path(pilot).resolve()
campaign = root/'ccache'
campaign.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, DUCKDB_CACHE_CAMPAIGN='ccache-20261116-v1')
names = ['seed-01', 'warm-01', 'cold-02', 'warm-02', 'cold-03', 'warm-03']
lock = campaign/'campaign.lock'
with lock.open('x') as file:
    file.write(str(os.getpid()))
try:
    plan = {'runs': names,
            'sourceRef': json.loads((root/'remote-live/source-ref.json').read_text())['ref'],
            'toolsRef': json.loads((campaign/'tools-ref.json').read_text())['ref'],
            'runtime': env['DUCKDB_MATRIX_RUNTIME'],
            'files': {str(p.relative_to(script)): hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in [script/'remote.ts', *sorted((script/'remote').glob('*'))]
                      if p.is_file()}}
    manifest = campaign/'campaign.json'
    if manifest.exists() and json.loads(manifest.read_text()) != plan:
        raise SystemExit('Campaign inputs changed')
    manifest.write_text(json.dumps(plan, indent=2)+'\n')
    seeds = {}
    groups = set()
    for name in names:
        mode = name.split('-')[0]
        destination = campaign/('cloud-'+name)
        result_file = destination/'build/result.json'
        print('Starting '+name, flush=True)
        if not result_file.exists():
            with (campaign/('cloud-'+name+'.log')).open('a') as log:
                subprocess.run(['node', str(script/'remote.ts'), 'ccache-'+mode, str(destination),
                                str(root/'remote-live/source-ref.json'), str(campaign/'tools-ref.json'),
                                origin, secret_file, '2'], env=env, stdout=log, stderr=log, check=True)
        result = json.loads(result_file.read_text())
        if result['validation']['passed'] is not True or result['group']['id'] in groups:
            raise SystemExit('Missing or reused group result: '+name)
        groups.add(result['group']['id'])
        for entry in result['jobs']:
            profile = entry['job']['checkId']
            cache = entry['result']['buildCache']
            if mode == 'seed':
                seeds[profile] = cache['published']['sha256']
            elif mode == 'warm' and cache['restoredSha256'] != seeds[profile]:
                raise SystemExit('Cache digest differs from seed')
        print('Verified '+name, flush=True)
    (campaign/'complete.json').write_text(json.dumps({'groups': sorted(groups), 'seedDigests': seeds})+'\n')
finally:
    lock.unlink()
