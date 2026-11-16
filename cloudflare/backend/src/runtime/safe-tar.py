#!/usr/bin/env python3
"""Bounded, deliberately restricted tar.gz extraction for immutable job inputs.

No tarfile metadata reads: every gzip read and metadata allocation is bounded.
This creates a NEW destination only. It does not by itself provide a sandbox
read-only mount; the trusted launcher must enforce that boundary before exec.
"""
import argparse
import gzip
import json
import os
import re
import shutil
import signal
import stat
import sys
import unicodedata
from pathlib import Path

BLOCK = 512
CHUNK = 65536
PAX_LIMIT = 65536
PAX_TOTAL_LIMIT = 16 * 1024 * 1024
PADDING_LIMIT = 1024 * 1024
OWNER_MARKER = ".hivemind-extraction-owner"


class Rejected(Exception):
    pass


def reject(code):
    raise Rejected(code)


def octal(field):
    value = field.strip(b" \0")
    if not value:
        return 0
    if not re.fullmatch(b"[0-7]+", value):
        reject("numeric-header")
    return int(value, 8)


def text(field):
    value, separator, tail = field.partition(b"\0")
    if separator and any(tail):
        reject("text-header")
    try:
        return value.decode("utf-8", "strict")
    except UnicodeError:
        reject("text-encoding")


def safe_path(value, directory):
    if not value or len(value.encode("utf-8")) > 4096:
        reject("path-length")
    if value.startswith("/") or "\\" in value or re.match(r"^[A-Za-z]:", value):
        reject("path-root")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        reject("path-control")
    if unicodedata.normalize("NFC", value) != value:
        reject("path-normalization")
    if value.startswith("./"):
        value = value[2:]
    if directory and value.endswith("/"):
        value = value[:-1]
    if directory and value in ("", "."):
        return []
    parts = value.split("/")
    if len(parts) > 64 or OWNER_MARKER in parts or any(p in ("", ".", "..") or len(p.encode("utf-8")) > 255 for p in parts):
        reject("path-components")
    return parts


def pax_fields(payload, global_header):
    fields = {}
    offset = 0
    allowed = {"path", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "comment"}
    while offset < len(payload):
        end = payload.find(b" ", offset, min(len(payload), offset + 12))
        if end < 0 or not re.fullmatch(b"[1-9][0-9]*", payload[offset:end]):
            reject("pax-framing")
        length = int(payload[offset:end])
        if length < end - offset + 4 or offset + length > len(payload):
            reject("pax-size")
        record = payload[end + 1:offset + length]
        if not record.endswith(b"\n") or b"=" not in record:
            reject("pax-record")
        key, value = record[:-1].split(b"=", 1)
        try:
            key, value = key.decode("ascii"), value.decode("utf-8", "strict")
        except UnicodeError:
            reject("pax-encoding")
        if key not in allowed or key in fields or (global_header and key == "path"):
            reject("pax-key")
        if "\0" in value:
            reject("pax-null")
        fields[key] = value
        offset += length
    return fields


class Reader:
    def __init__(self, stream, limit):
        self.stream = stream
        self.limit = limit
        self.read_bytes = 0

    def read(self, length):
        if length > CHUNK:
            reject("internal-read-size")
        data = self.stream.read(length)
        self.read_bytes += len(data)
        if self.read_bytes > self.limit:
            reject("decompressed-stream-limit")
        return data

    def exact(self, length):
        if length > CHUNK:
            reject("internal-metadata-size")
        chunks = []
        received = 0
        while received < length:
            part = self.read(length - received)
            if not part:
                reject("truncated-archive")
            chunks.append(part)
            received += len(part)
        return b"".join(chunks)


def extract(archive, destination, max_bytes, max_files, strip_components, owner_token=None):
    created = False
    try:
        if not 1 <= max_bytes <= 2 * 1024**3 or not 1 <= max_files <= 100000 or strip_components not in (0, 1):
            reject("limits")
        if not os.path.isabs(archive) or not os.path.isabs(destination):
            reject("absolute-arguments-required")
        if owner_token is not None and not re.fullmatch(r"[a-f0-9]{32}", owner_token):
            reject("owner-token")
        os.mkdir(destination, 0o700)
        created = True
        if owner_token is not None:
            with open(os.path.join(destination, OWNER_MARKER), "x") as marker:
                marker.write(owner_token)
        fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            reject("archive-file-type")
        paths = {}
        explicit = set()
        files = nodes = expanded = metadata = metadata_headers = headers = 0
        pending = None
        top = None

        def ensure_node(parts, kind, explicit_entry=False):
            nonlocal nodes
            if not parts:
                return
            name = "/".join(parts)
            key = name.casefold()
            prior = paths.get(key)
            if prior and prior[0] != name:
                reject("case-collision")
            if explicit_entry and key in explicit:
                reject("duplicate-path")
            if explicit_entry:
                explicit.add(key)
            if prior:
                if prior[1] != kind or kind == "file":
                    reject("ancestor-collision")
                return
            if len(parts) > 1:
                ensure_node(parts[:-1], "directory")
            if nodes >= max_files:
                reject("entry-count")
            nodes += 1
            target = os.path.join(destination, *parts)
            if kind == "directory":
                os.mkdir(target, 0o700)
            paths[key] = (name, kind)

        with os.fdopen(fd, "rb") as raw, gzip.GzipFile(fileobj=raw, mode="rb") as gz:
            stream = Reader(gz, max_bytes + max_files * 1024 + PAX_TOTAL_LIMIT + PADDING_LIMIT)
            while True:
                header = stream.exact(BLOCK)
                if not any(header):
                    if any(stream.exact(BLOCK)):
                        reject("end-marker")
                    if pending is not None:
                        reject("dangling-pax")
                    padding = 0
                    while True:
                        tail = stream.read(CHUNK)
                        if not tail:
                            break
                        padding += len(tail)
                        if padding > PADDING_LIMIT or any(tail):
                            reject("trailing-payload")
                    break
                headers += 1
                if headers > max_files * 2 + 4096:
                    reject("header-count")
                if header[257:263] not in (b"ustar\0", b"ustar "):
                    reject("tar-format")
                expected = octal(header[148:156])
                if expected != sum(header[:148]) + 8 * 32 + sum(header[156:]):
                    reject("header-checksum")
                size = octal(header[124:136])
                kind = header[156:157]
                name, prefix = text(header[:100]), text(header[345:500])
                if prefix:
                    name = prefix + "/" + name
                if kind in (b"g", b"x"):
                    if size > PAX_LIMIT or metadata + size > PAX_TOTAL_LIMIT or metadata_headers >= min(max_files + 16, 4096):
                        reject("pax-limit")
                    metadata += size
                    metadata_headers += 1
                    fields = pax_fields(stream.exact(size), kind == b"g")
                    if size % BLOCK:
                        stream.exact(BLOCK - size % BLOCK)
                    if kind == b"x":
                        if pending is not None:
                            reject("duplicate-pax")
                        pending = fields
                    continue
                if kind not in (b"0", b"\0", b"5"):
                    reject("entry-type")
                if text(header[157:257]):
                    reject("unexpected-link-target")
                directory = kind == b"5"
                # Both the physical and PAX effective path are checked. No hidden
                # traversal is accepted even if a later metadata path replaces it.
                safe_path(name, directory)
                if pending is not None:
                    name = pending.get("path", name)
                    pending = None
                parts = safe_path(name, directory)
                if strip_components and parts:
                    if top is None:
                        top = parts[0]
                    if top != parts[0]:
                        reject("multiple-top-roots")
                    parts = parts[1:]
                if not parts:
                    if not directory or size:
                        reject("empty-target")
                    continue
                if directory:
                    if size:
                        reject("directory-payload")
                    ensure_node(parts, "directory", True)
                    continue
                if size > max_bytes - expanded:
                    reject("expanded-bytes")
                ensure_node(parts, "file", True)
                files += 1
                expanded += size
                target = os.path.join(destination, *parts)
                mode = 0o700 if octal(header[100:108]) & 0o111 else 0o600
                out_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
                with os.fdopen(out_fd, "wb") as output:
                    remaining = size
                    while remaining:
                        data = stream.exact(min(CHUNK, remaining))
                        output.write(data)
                        remaining -= len(data)
                if size % BLOCK:
                    stream.exact(BLOCK - size % BLOCK)
            if not files:
                reject("empty-archive")
        if owner_token is not None:
            os.unlink(os.path.join(destination, OWNER_MARKER))
        return {"expandedBytes": expanded, "files": files, "entries": nodes}
    except BaseException:
        if created:
            shutil.rmtree(destination, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--max-bytes", required=True, type=int)
    parser.add_argument("--max-files", required=True, type=int)
    parser.add_argument("--strip-components", default=0, type=int)
    parser.add_argument("--owner-token")
    args = parser.parse_args()
    def interrupted(_number, _frame):
        reject("cancelled")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        result = extract(args.archive, args.destination, args.max_bytes, args.max_files, args.strip_components, args.owner_token)
        print(json.dumps(result, separators=(",", ":")))
    except Rejected as error:
        print("Archive rejected: " + str(error), file=sys.stderr)
        return 1
    except BaseException:
        # Archive-controlled names, contents and arbitrary OS errors are not logs.
        print("Archive rejected: extraction-failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
