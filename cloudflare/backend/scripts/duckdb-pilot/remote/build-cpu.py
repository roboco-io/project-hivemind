"""Measure the build command and descendants reaped by its process tree."""
import json
import os
from pathlib import Path
import sys

output, command = sys.argv[1], sys.argv[2:]
pid = os.posix_spawn(command[0], command, os.environ)
_, status, usage = os.wait4(pid, 0)
code = os.waitstatus_to_exitcode(status)
Path(output).write_text(json.dumps({
    'scope': 'wait4-reaped-build-tree', 'exitCode': code,
    'userSeconds': usage.ru_utime, 'systemSeconds': usage.ru_stime,
    'usageUsec': round((usage.ru_utime+usage.ru_stime)*1000000),
}))
sys.exit(code if code >= 0 else 128-code)
