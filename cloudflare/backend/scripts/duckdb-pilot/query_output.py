#!/usr/bin/env python3
"""One shared result policy for the runner and the cross-run comparator."""
import argparse
import hashlib
import json
import re
from decimal import Decimal
from pathlib import Path

COMMIT='68d7555f68bd25c1a251ccca2e6338949c33986a'
SHARDS=[[9,1,5,11,15,19],[18,2,6,10,14,22],[21,4,7,12,16],[3,8,13,17,20]]
MAX_BYTES=32*1024*1024
class InvalidQueryOutput(ValueError): pass

def read(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size>MAX_BYTES:
        raise InvalidQueryOutput('query-file-type-or-size')
    with path.open('rb') as f:data=f.read(MAX_BYTES+1)
    if len(data)>MAX_BYTES:raise InvalidQueryOutput('query-file-size')
    return data

def pairs(values):
    output={}
    for key,value in values:
        if key in output:raise InvalidQueryOutput('duplicate-query-json-key')
        output[key]=value
    return output

def parse(data):
    def invalid(_):raise InvalidQueryOutput('query-json-nonfinite')
    try:return json.loads(data.decode('utf-8'),parse_float=Decimal,parse_int=int,parse_constant=invalid,object_pairs_hook=pairs)
    except (ValueError,UnicodeError) as error:
        if isinstance(error,InvalidQueryOutput):raise
        raise InvalidQueryOutput('query-json-invalid') from None

def digest(data):return hashlib.sha256(data).hexdigest()

def load_query_output(directory,query):
    if type(query) is not int or query<1 or query>22:raise InvalidQueryOutput('query-id')
    root=Path(directory).resolve(strict=True)
    raw=read(root/f'query-{query:02d}.json');schema=read(root/f'query-{query:02d}.schema.json')
    columns=parse(schema)
    if not isinstance(columns,list) or not columns or any(not isinstance(c,dict) or not isinstance(c.get('column_name'),str) or not isinstance(c.get('column_type'),str) for c in columns):raise InvalidQueryOutput('query-schema-invalid')
    names=[c['column_name'] for c in columns]
    if len(set(names))!=len(names):raise InvalidQueryOutput('query-schema-duplicate-column')
    shard=next(index for index,ids in enumerate(SHARDS) if query in ids)
    stage_bytes=read(root/f'shard-{shard}.json');stage=parse(stage_bytes)
    if not isinstance(stage,dict) or stage.get('passed') is not True or type(stage.get('exitCode')) is not int or stage['exitCode']!=0 or stage.get('signal') is not None or stage.get('terminationReason')!='exit':raise InvalidQueryOutput('query-stage-not-successful')
    normalized=raw;normalization=None
    if len(raw)==0:
        profile_bytes=read(root/f'query-{query:02d}.profile.json');profile=parse(profile_bytes)
        settings=parse(read(root/'memory-batch-settings.json'))
        hashes=settings.get('querySourceSha256') if isinstance(settings,dict) else None
        expected=hashes.get(str(query)) if isinstance(hashes,dict) else None
        if not isinstance(settings,dict) or settings.get('sourceCommit')!=COMMIT or not isinstance(expected,str) or not re.fullmatch('[a-f0-9]{64}',expected):raise InvalidQueryOutput('empty-query-source-manifest')
        if not isinstance(profile,dict) or type(profile.get('rows_returned')) is not int or profile['rows_returned']!=0:raise InvalidQueryOutput('empty-query-profile-not-zero')
        query_name=profile.get('query_name')
        if not isinstance(query_name,str) or digest(query_name.encode('utf-8'))!=expected:raise InvalidQueryOutput('empty-query-profile-query-mismatch')
        normalized=b'[]'
        normalization={'kind':'duckdb-empty-json-zero-rows','rawBytes':0,'normalizedRows':0,
                       'normalizedRepresentation':'[]','normalizedSha256':digest(normalized),
                       'profileRowsReturned':0,'profileSha256':digest(profile_bytes),
                       'querySourceSha256':expected,'stageReceiptSha256':digest(stage_bytes)}
    rows=parse(normalized)
    if not isinstance(rows,list) or any(not isinstance(row,dict) or list(row)!=names for row in rows):raise InvalidQueryOutput('query-row-schema')
    receipt={'query':query,'rows':len(rows),'resultSha256':digest(raw),'schemaSha256':digest(schema)}
    if normalization is not None:receipt['normalization']=normalization
    return {'data':normalized,'schema':schema,'receipt':receipt}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--run',required=True);parser.add_argument('--queries',required=True);args=parser.parse_args()
    try:
        queries=[int(q) for q in args.queries.split(',')]
        if not queries or len(queries)>22 or len(set(queries))!=len(queries):raise InvalidQueryOutput('query-list')
        output={'outputs':[load_query_output(args.run,q)['receipt'] for q in queries]}
    except (InvalidQueryOutput,ValueError,OSError,UnicodeError) as error:
        print(json.dumps({'error':str(error) if isinstance(error,InvalidQueryOutput) else 'query-output-unavailable'}));return 1
    print(json.dumps(output,separators=(',',':')));return 0
if __name__=='__main__':raise SystemExit(main())
