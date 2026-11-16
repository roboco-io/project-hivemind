#!/usr/bin/env python3
"""DuckDB's pinned Catch lists return the test count as exit status, not zero."""
import subprocess,sys
if len(sys.argv)!=5: raise SystemExit('Usage: inventory.py BINARY FILTER SOURCE NEW_TEMP_DIR')
options=['--test-dir',sys.argv[3],'--test-temp-dir',sys.argv[4]]
p=subprocess.run([sys.argv[1],*options,'--list-test-names-only',sys.argv[2]],capture_output=True,text=True,timeout=25)
lines=[x for x in p.stdout.splitlines() if x.strip()]
if not lines or p.returncode!=len(lines)%256 or p.stderr or any('No test cases matched' in x for x in lines):
 print('Test inventory failed validation',file=sys.stderr);sys.exit(1)
print('\n'.join(lines))
