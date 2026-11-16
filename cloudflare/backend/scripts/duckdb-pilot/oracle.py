#!/usr/bin/env python3
"""Exact SF1 P0 comparison against pinned DuckDB upstream answer fixtures.

The supported queries contain integer, string/date, and DECIMAL results. No
floating-point tolerance is applied. Other scales/queries stay unverified.
"""
import argparse
import csv
import hashlib
import io
import json
import re
import stat
from decimal import Decimal, InvalidOperation
from pathlib import Path

COMMIT = '68d7555f68bd25c1a251ccca2e6338949c33986a'
SOURCE_SHA256 = '495fe47027a380fc37828dd04be65b2370f68b51872325c78cdeb54d1ec3a2a1'
SCHEMAS = {
    3: ('integer', 'decimal', 'date', 'integer'),
    9: ('string', 'integer', 'decimal'),
    18: ('string', 'integer', 'integer', 'date', 'decimal', 'decimal'),
    21: ('string', 'integer'),
}
MAX_BYTES = 4 * 1024 * 1024


class Rejected(ValueError):
    pass


def reject(code):
    raise Rejected(code)


def bounded_read(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
        reject('file-type-or-size')
    with path.open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        reject('file-size')
    return data


def pairs_without_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            reject('duplicate-json-column')
        value[key] = item
    return value


def load_actual(data):
    def invalid_constant(_):
        reject('nonfinite-number')
    return json.loads(data.decode('utf-8'), parse_float=Decimal,
                      parse_int=int, parse_constant=invalid_constant,
                      object_pairs_hook=pairs_without_duplicates)


def pinned_reference(source, query):
    if type(query) is not int or query < 1 or query > 22:
        reject('invalid-query-id')
    root = Path(source).resolve(strict=True)
    relative = f'extension/tpch/dbgen/answers/sf1/q{query:02d}.csv'
    current = root
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            reject('reference-symlink')
    # The preparation manifest binds each regular file to the reviewed archive.
    manifest = json.loads(bounded_read(root.parent / 'normalization.json'))
    if not isinstance(manifest, dict) or manifest.get('commit') != COMMIT or manifest.get('sourceArchiveSha256') != SOURCE_SHA256:
        reject('reference-manifest-identity')
    entries = manifest.get('files')
    if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
        reject('reference-manifest-entries')
    matches = [item for item in entries if item.get('path') == relative]
    if len(matches) != 1:
        reject('reference-manifest-entry')
    data = bounded_read(current)
    digest = hashlib.sha256(data).hexdigest()
    if matches[0].get('sha256') != digest:
        reject('reference-hash')
    return data, digest, relative


def expected_value(raw, kind):
    if kind in ('string', 'date'):
        if kind == 'date' and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', raw):
            reject('reference-date')
        return raw
    if kind == 'integer':
        if not re.fullmatch(r'[+-]?\d+', raw):
            reject('reference-integer')
        return int(raw)
    try:
        number = Decimal(raw)
    except InvalidOperation:
        reject('reference-decimal')
    if not number.is_finite():
        reject('reference-decimal')
    return number


def compare(reference_data, actual_data, query):
    if query not in SCHEMAS:
        return {'available': False, 'passed': None, 'reason': 'unsupported-query'}
    schema = SCHEMAS[query]
    csv_rows = list(csv.reader(io.StringIO(reference_data.decode('utf-8')), delimiter='|', strict=True))
    if not csv_rows or len(csv_rows[0]) != len(schema) or len(set(csv_rows[0])) != len(schema):
        reject('reference-columns')
    columns = csv_rows[0]
    rows = csv_rows[1:]
    actual = load_actual(actual_data)
    policy = {'rowOrder': 'exact', 'columnOrder': 'exact', 'integer': 'exact',
              'decimal': 'exact-value-using-Decimal', 'stringAndDate': 'exact',
              'floatTolerance': None}
    base = {'available': True, 'query': query, 'scaleFactor': 1, 'comparison': policy,
            'expectedRows': len(rows), 'columns': columns, 'columnNormalizations': []}
    if not isinstance(actual, list):
        return {**base, 'passed': False, 'reason': 'actual-not-row-array'}
    if len(actual) != len(rows):
        return {**base, 'passed': False, 'reason': 'row-count', 'actualRows': len(actual)}
    actual_columns = columns
    q18_reference = ['c_name', 'c_custkey', 'o_orderkey', 'o_orderdate', 'o_totalprice', 'sum']
    q18_actual = q18_reference[:-1] + ['sum(l_quantity)']
    # Pinned upstream SF1 q18 answer calls the final column 'sum', while the
    # pinned query leaves SUM(l_quantity) unaliased. No other alias is accepted.
    if query == 18 and columns == q18_reference and actual and isinstance(actual[0], dict) and list(actual[0]) == q18_actual:
        actual_columns = q18_actual
        base['columnNormalizations'] = [{'columnIndex': 5, 'reference': 'sum',
                                        'actual': 'sum(l_quantity)',
                                        'reason': 'pinned-q18-upstream-answer-alias'}]
        policy['columnNames'] = 'exact-except-recorded-q18-alias'
    for index, (csv_row, actual_row) in enumerate(zip(rows, actual)):
        if len(csv_row) != len(columns):
            reject('reference-row-width')
        if not isinstance(actual_row, dict) or list(actual_row) != actual_columns:
            return {**base, 'passed': False, 'reason': 'column-order-or-name', 'row': index}
        for column, actual_column, kind, raw in zip(columns, actual_columns, schema, csv_row):
            expected = expected_value(raw, kind)
            observed = actual_row[actual_column]
            typed = (type(observed) is int if kind == 'integer' else
                     type(observed) in (int, Decimal) if kind == 'decimal' else
                     type(observed) is str)
            if not typed or observed != expected:
                return {**base, 'passed': False, 'reason': 'value-or-type', 'row': index, 'column': column}
    return {**base, 'passed': True, 'actualRows': len(actual)}


def evaluate(source, actual_path, sf, query):
    try:
        scale = Decimal(str(sf))
    except InvalidOperation:
        reject('invalid-scale')
    if not scale.is_finite() or scale <= 0:
        reject('invalid-scale')
    if type(query) is not int or not 1 <= query <= 22:
        reject('invalid-query-id')
    if scale != 1 or query not in SCHEMAS:
        return {'available': False, 'passed': None, 'query': query, 'scaleFactor': str(scale),
                'reason': 'no-pinned-P0-oracle-for-this-scale-or-query'}
    reference, reference_hash, relative = pinned_reference(source, query)
    actual = bounded_read(Path(actual_path))
    result = compare(reference, actual, query)
    return {**result, 'referenceCommit': COMMIT, 'referencePath': relative,
            'referenceSha256': reference_hash, 'actualSha256': hashlib.sha256(actual).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--actual', required=True)
    parser.add_argument('--sf', required=True)
    parser.add_argument('--query', required=True, type=int)
    options = parser.parse_args()
    try:
        result = evaluate(options.source, options.actual, options.sf, options.query)
    except (Rejected, ValueError, OSError, UnicodeError, csv.Error) as error:
        reason = str(error) if isinstance(error, Rejected) else 'oracle-input-invalid'
        result = {'available': False, 'passed': False, 'reason': reason}
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result.get('passed') is True else 2 if result.get('passed') is None else 1


if __name__ == '__main__':
    raise SystemExit(main())
