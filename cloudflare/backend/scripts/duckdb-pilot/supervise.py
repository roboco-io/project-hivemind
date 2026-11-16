#!/usr/bin/env python3
"""Bounded local process supervisor. No shell interpolation or inherited API keys."""
import json, os, signal, subprocess, sys, time
from pathlib import Path

def main():
    spec_path, result_path = map(Path, sys.argv[1:3])
    spec = json.loads(spec_path.read_text())
    argv = spec['argv']
    if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or '\0' in x for x in argv):
        raise ValueError('Invalid command')
    timeout = spec['timeoutMs'] / 1000
    if not 0 < timeout <= 3600:
        raise ValueError('Invalid timeout')
    cwd = Path(spec['cwd']).resolve()
    stop_file = Path(spec['stopFile'])
    start = time.time()
    reason = None
    child = None
    terminated_at = None
    def request_stop(signum, frame):
        nonlocal reason
        reason = reason or 'operator-signal'
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, request_stop)
    def send(sig):
        if child:
            try: os.killpg(child.pid, sig)
            except ProcessLookupError: pass
    logs = [Path(spec['stdout']), Path(spec['stderr'])]
    for path in logs:
        path.parent.mkdir(parents=True, exist_ok=True)
    with logs[0].open('wb') as stdout, logs[1].open('wb') as stderr:
        os.chmod(logs[0], 0o600); os.chmod(logs[1], 0o600)
        if stop_file.exists():
            raise ValueError('Pilot already stopped')
        child = subprocess.Popen(argv, cwd=cwd, stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL, start_new_session=True)
        while True:
            pid, status, usage = os.wait4(child.pid, os.WNOHANG)
            if pid:
                child.returncode = os.waitstatus_to_exitcode(status)
                break
            now = time.time()
            if stop_file.exists(): reason = reason or 'resource-guard'
            if now-start >= timeout: reason = reason or 'timeout'
            if any(p.stat().st_size > 128*1024*1024 for p in logs): reason = reason or 'log-size-limit'
            if reason and terminated_at is None:
                send(signal.SIGTERM); terminated_at = now
            if terminated_at is not None and now-terminated_at >= 2: send(signal.SIGKILL)
            time.sleep(.05)
        send(signal.SIGTERM)
        time.sleep(.1)
        send(signal.SIGKILL)
    code = child.returncode
    result = {'startedAt':round(start*1000), 'finishedAt':round(time.time()*1000), 'exitCode':code if code>=0 else None,
              'signal':signal.Signals(-code).name if code<0 else None, 'terminationReason':reason or 'exit',
              'passed':code==0 and reason is None, 'cpuUserSeconds':usage.ru_utime, 'cpuSystemSeconds':usage.ru_stime,
              'wait4MaxRssBytes':usage.ru_maxrss*(1 if sys.platform=='darwin' else 1024),
              'cpuCoverage':'wait4 root and reaped descendants; terminated/orphan descendants may be omitted',
              'rssCoverage':'wait4 maximum process RSS, not summed concurrent process-tree RSS'}
    temporary = result_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(result,indent=2)+'\n'); os.chmod(temporary,0o600); temporary.replace(result_path)
    return 0 if result['passed'] else 1

if __name__=='__main__':
    try: sys.exit(main())
    except Exception:
        print('Supervisor failed before a valid receipt; inspect local setup', file=sys.stderr)
        sys.exit(2)
