#!/usr/bin/env python3
"""Normalize only the reviewed, pinned DuckDB archive; never relax extraction policy."""
import gzip, hashlib, json, os, sys, tarfile
from pathlib import Path
COMMIT='68d7555f68bd25c1a251ccca2e6338949c33986a'
EXPECTED='495fe47027a380fc37828dd04be65b2370f68b51872325c78cdeb54d1ec3a2a1'
PREFIX='duckdb-'+COMMIT+'/'
EXCLUDED={PREFIX+'data/csv/glob/crawl/.symbolic_link/link_to_file':'afile.csv',PREFIX+'data/csv/glob/crawl/.symbolic_link/mydir/link_to_upper_dir':'../../symbolic_link'}
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  while chunk:=f.read(1024*1024): h.update(chunk)
 return h.hexdigest()
def main():
 source,output,manifest=map(Path,sys.argv[1:4])
 if digest(source)!=EXPECTED: raise ValueError('pinned-source-hash-mismatch')
 if output.exists(): raise ValueError('output-already-exists')
 files=[];removed=[];seen=set();tmp=output.with_suffix(output.suffix+'.partial')
 try:
  with source.open('rb') as raw,tarfile.open(fileobj=raw,mode='r|gz') as incoming,tmp.open('xb') as f,gzip.GzipFile(fileobj=f,mode='wb',filename='',mtime=0,compresslevel=6) as gz,tarfile.open(fileobj=gz,mode='w|',format=tarfile.USTAR_FORMAT) as outgoing:
   for entry in incoming:
    if entry.name in seen: raise ValueError('duplicate-path')
    seen.add(entry.name)
    if entry.issym():
     if EXCLUDED.get(entry.name)!=entry.linkname: raise ValueError('unreviewed-link')
     removed.append({'path':entry.name,'target':entry.linkname});continue
    if not(entry.isdir() or entry.isfile()):raise ValueError('unreviewed-entry-type')
    copy=tarfile.TarInfo(entry.name);copy.type=tarfile.DIRTYPE if entry.isdir() else tarfile.REGTYPE;copy.size=entry.size if entry.isfile() else 0;copy.mode=0o755 if entry.isdir() or entry.mode&0o111 else 0o644;copy.uid=copy.gid=copy.mtime=0;copy.uname=copy.gname=''
    if entry.isfile():
     data=incoming.extractfile(entry)
     # The pinned archive's files are bounded; stream once into spool to hash and archive.
     import tempfile
     with tempfile.SpooledTemporaryFile(max_size=1024*1024) as spool:
      h=hashlib.sha256();size=0
      while chunk:=data.read(1024*1024):h.update(chunk);spool.write(chunk);size+=len(chunk)
      if size!=entry.size:raise ValueError('truncated-source')
      spool.seek(0);outgoing.addfile(copy,spool)
     files.append({'path':entry.name.removeprefix(PREFIX),'sha256':h.hexdigest(),'bytes':size,'executable':bool(entry.mode&0o111)})
    else:outgoing.addfile(copy)
  if {x['path']:x['target'] for x in removed}!=EXCLUDED:raise ValueError('reviewed-links-not-found')
  os.chmod(tmp,0o600);tmp.replace(output)
  result={'version':1,'commit':COMMIT,'sourceArchiveSha256':EXPECTED,'normalizedArchiveSha256':digest(output),'normalizedBytes':output.stat().st_size,'removed':removed,'regularFiles':len(files),'expandedBytes':sum(x['bytes'] for x in files),'normalization':'USTAR tar; original order; uid/gid/mtime=0; empty user/group; regular content and executable bit retained; reviewed two symlink fixtures omitted','files':files}
  manifest.write_text(json.dumps(result,indent=2)+'\n');os.chmod(manifest,0o600)
  print(json.dumps({k:v for k,v in result.items() if k!='files'}))
 except BaseException:
  tmp.unlink(missing_ok=True)
  raise
if __name__=='__main__':
 try:main()
 except Exception:print('Pinned archive normalization failed',file=sys.stderr);sys.exit(1)
