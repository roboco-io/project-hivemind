#!/usr/bin/env python3
"""Compare one completed 22-query batch to its same-input concurrency-1 baseline.
This is cross-run equivalence, not an independent upstream correctness oracle.
"""
import argparse
import hashlib
import json
import re
import sys
from decimal import Decimal, localcontext
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from query_output import load_query_output, InvalidQueryOutput

COMMIT = '68d7555f68bd25c1a251ccca2e6338949c33986a'
SHARDS = [[9,1,5,11,15,19],[18,2,6,10,14,22],[21,4,7,12,16],[3,8,13,17,20]]
FLOAT_POLICY = {'relative':'1e-12','absolute':'1e-8',
                'formula':'abs(a-b) <= max(absTolerance, relTolerance * max(abs(a), abs(b)))'}
MAX_BYTES = 32 * 1024 * 1024
INT_TYPES = {'TINYINT','SMALLINT','INTEGER','BIGINT','HUGEINT','UTINYINT','USMALLINT','UINTEGER','UBIGINT','UHUGEINT'}
STR_TYPES = {'VARCHAR','DATE','TIMESTAMP','TIMESTAMP_NS','TIMESTAMP_MS','TIMESTAMP_S','TIMESTAMP WITH TIME ZONE','TIME','INTERVAL'}


class Invalid(ValueError):
    pass


def unique_pairs(pairs):
    output = {}
    for key,value in pairs:
        if key in output: raise Invalid('duplicate-json-key')
        output[key] = value
    return output


def parse(data):
    def constant(_): raise Invalid('nonfinite-json-number')
    return json.loads(data.decode('utf-8'), parse_float=Decimal, parse_int=int,
                      parse_constant=constant, object_pairs_hook=unique_pairs)


def read(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise Invalid('input-type-or-size')
    with path.open('rb') as f: data=f.read(MAX_BYTES+1)
    if len(data)>MAX_BYTES: raise Invalid('input-size')
    return data


def digest(data): return hashlib.sha256(data).hexdigest()


def schema_columns(data):
    raw=parse(data)
    if not isinstance(raw,list) or not raw: raise Invalid('schema-array')
    columns=[]
    for item in raw:
        if not isinstance(item,dict) or not isinstance(item.get('column_name'),str) or not isinstance(item.get('column_type'),str):
            raise Invalid('schema-column')
        kind=item['column_type']
        if kind not in INT_TYPES | STR_TYPES | {'DOUBLE','FLOAT','BOOLEAN'} and not re.fullmatch(r'DECIMAL\(\d+,\d+\)',kind): raise Invalid('unsupported-column-type')
        columns.append((item['column_name'],kind))
    if len(set(name for name,_ in columns))!=len(columns): raise Invalid('duplicate-schema-column')
    return columns


def value_equal(a,b,kind):
    if a is None or b is None: return a is None and b is None
    if kind in INT_TYPES: return type(a) is int and type(b) is int and a==b
    if re.fullmatch(r'DECIMAL\(\d+,\d+\)',kind):
        return type(a) in (int,Decimal) and type(b) in (int,Decimal) and a==b
    if kind in ('DOUBLE','FLOAT'):
        if type(a) not in (int,Decimal) or type(b) not in (int,Decimal): return False
        a,b=Decimal(a),Decimal(b)
        if not a.is_finite() or not b.is_finite(): return False
        with localcontext() as ctx:
            ctx.prec=80
            tolerance=max(Decimal(FLOAT_POLICY['absolute']),Decimal(FLOAT_POLICY['relative'])*max(abs(a),abs(b)))
            return abs(a-b)<=tolerance
    if kind in STR_TYPES: return type(a) is str and type(b) is str and a==b
    if kind=='BOOLEAN': return type(a) is bool and type(b) is bool and a==b
    raise Invalid('unsupported-column-type')


def compare_query(reference_data,reference_schema,actual_data,actual_schema):
    columns=schema_columns(reference_schema)
    if columns!=schema_columns(actual_schema): return {'passed':False,'reason':'schema-name-order-or-type'}
    reference,actual=parse(reference_data),parse(actual_data)
    if not isinstance(reference,list) or not isinstance(actual,list): raise Invalid('result-not-row-array')
    if len(reference)!=len(actual): return {'passed':False,'reason':'row-count','referenceRows':len(reference),'actualRows':len(actual)}
    names=[name for name,_ in columns]
    for i,(left,right) in enumerate(zip(reference,actual)):
        if not isinstance(left,dict) or not isinstance(right,dict) or list(left)!=names or list(right)!=names:
            return {'passed':False,'reason':'column-name-or-order','row':i}
        for name,kind in columns:
            if not value_equal(left[name],right[name],kind):
                return {'passed':False,'reason':'value-or-type','row':i,'column':name,'columnType':kind}
    return {'passed':True,'rows':len(actual),'columns':[{'name':name,'type':kind} for name,kind in columns],
            'rawResultHashesEqual':digest(reference_data)==digest(actual_data)}


def load_run(directory):
    root=Path(directory).resolve(strict=True)
    settings=parse(read(root/'memory-batch-settings.json'))
    result=parse(read(root/'result.json'))
    if settings.get('sourceCommit')!=COMMIT or settings.get('shards')!=SHARDS or settings.get('floatComparison')!=FLOAT_POLICY:
        raise Invalid('run-settings')
    if settings.get('sf') not in (1,3,10,30) or settings.get('memoryGiB') not in (3,6,9) or settings.get('concurrency') not in (1,2,4):
        raise Invalid('run-scope')
    if result.get('status')!='SUCCEEDED' or result.get('outcome',{}).get('passed') is not True or result['outcome'].get('sourceUnchanged') is not True or result['outcome'].get('queryCount')!=22:
        raise Invalid('run-not-complete')
    query_hashes=settings.get('querySourceSha256',{})
    if set(query_hashes)!={str(q) for q in range(1,23)} or any(not isinstance(h,str) or not re.fullmatch('[a-f0-9]{64}',h) for h in query_hashes.values()):
        raise Invalid('query-source-manifest')
    for filename in ('dataset-before-hash.json','dataset-after-hash.json'):
        if parse(read(root/filename)).get('sha256')!=settings.get('datasetSha256'): raise Invalid('dataset-hash')
    receipts={}
    records=result['outcome'].get('records',[])
    if len(records)!=4: raise Invalid('shard-receipts')
    for index,row in enumerate(records):
        if row.get('status')!='SUCCEEDED' or row.get('task',{}).get('index')!=index or row['task'].get('queries')!=SHARDS[index]:
            raise Invalid('shard-receipt')
        for receipt in row.get('value',{}).get('outputs',[]):
            q=receipt.get('query')
            if type(q) is not int or q not in SHARDS[index] or q in receipts: raise Invalid('query-receipt')
            receipts[q]=receipt
    if set(receipts)!=set(range(1,23)): raise Invalid('query-coverage')
    names={p.name for p in root.iterdir() if re.fullmatch(r'query-\d+\.json',p.name)}
    if names!={f'query-{q:02d}.json' for q in range(1,23)}: raise Invalid('query-output-coverage')
    outputs={}
    for q,receipt in receipts.items():
        validated=load_query_output(root,q);observed=validated['receipt'];data=validated['data'];schema=validated['schema']
        if observed['resultSha256']!=receipt.get('resultSha256') or observed['schemaSha256']!=receipt.get('schemaSha256'): raise Invalid('query-output-hash')
        if observed['rows']!=receipt.get('rows'): raise Invalid('query-receipt-row-count')
        if observed.get('normalization')!=receipt.get('normalization'): raise Invalid('query-normalization-receipt')
        outputs[q]=(data,schema)
    return settings,outputs,receipts


def validate_comparison_inputs(left,right,allow_memory_tuning=False):
    for key in ('sourceCommit','sf','threads','datasetSha256','querySourceSha256','shards','floatComparison'):
        if left.get(key)!=right.get(key): raise Invalid('comparison-inputs-differ')
    different_memory=left.get('memoryGiB')!=right.get('memoryGiB')
    if different_memory and not allow_memory_tuning: raise Invalid('comparison-inputs-differ')
    if allow_memory_tuning:
        left_binary,right_binary=left.get('binarySha256'),right.get('binarySha256')
        if not isinstance(left_binary,str) or not re.fullmatch('[a-f0-9]{64}',left_binary) or left_binary!=right_binary:
            raise Invalid('tuning-binary-differs')
    return different_memory


def compare_runs(baseline,actual,allow_memory_tuning=False):
    left,left_rows,left_receipts=load_run(baseline);right,right_rows,right_receipts=load_run(actual)
    if left['concurrency']!=1: raise Invalid('baseline-must-be-concurrency-one')
    memory_tuning=validate_comparison_inputs(left,right,allow_memory_tuning)
    results=[]
    for q in range(1,23):
        compared=compare_query(*left_rows[q],*right_rows[q])
        representation_equal=compared.pop('rawResultHashesEqual',None)
        results.append({'query':q,**compared,'comparedRepresentationHashesEqual':representation_equal,
                        'rawResultHashesEqual':left_receipts[q]['resultSha256']==right_receipts[q]['resultSha256'],
                        'normalizations':{'baseline':left_receipts[q].get('normalization'),'actual':right_receipts[q].get('normalization')}})
    return {'kind':'cross-memory-tuning-query-equivalence' if memory_tuning else 'same-input-query-equivalence-not-independent-oracle','passed':all(x['passed'] for x in results),
            'queryCount':22,'sourceCommit':COMMIT,'scaleFactor':left['sf'],'memoryGiB':None if memory_tuning else left['memoryGiB'],'baselineMemoryGiB':left['memoryGiB'],'actualMemoryGiB':right['memoryGiB'],'memoryTuningComparison':memory_tuning,'performanceConditionsEquivalent':False,'threads':left['threads'],
            'baselineConcurrency':1,'actualConcurrency':right['concurrency'],'datasetSha256':left['datasetSha256'],
            'sameBinary':left.get('binarySha256')==right.get('binarySha256'),'floatComparison':FLOAT_POLICY,
            'integerAndDecimal':'exact','rowOrder':'exact','columnNameOrderAndType':'exact','results':results}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--baseline',required=True);parser.add_argument('--actual',required=True);parser.add_argument('--allow-memory-tuning',action='store_true');args=parser.parse_args()
    try:result=compare_runs(args.baseline,args.actual,args.allow_memory_tuning)
    except (Invalid,InvalidQueryOutput,ValueError,OSError,UnicodeError,KeyError,TypeError,ArithmeticError) as error:
        result={'passed':False,'reason':str(error) if isinstance(error,(Invalid,InvalidQueryOutput)) else 'comparison-input-invalid'}
    print(json.dumps(result,separators=(',',':')));return 0 if result['passed'] else 1
if __name__=='__main__':raise SystemExit(main())
