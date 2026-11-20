#!/usr/bin/env python3
"""Export only ccache result and manifest payloads from the sandbox-owned directory."""
import gzip
import hashlib
import json
import os
import re
import stat
import sys
import tarfile


HEX_DIRECTORY = re.compile(r"[a-f0-9]")
CACHE_ENTRY = re.compile(r"[a-f0-9]+")
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
ENTRY_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class BoundedOutput:
    def __init__(self, file, limit):
        self.file = file
        self.limit = limit
        self.size = 0
        self.hash = hashlib.sha256()

    def write(self, data):
        self.size += len(data)
        if self.size > self.limit:
            raise ValueError("compressed cache limit")
        self.hash.update(data)
        return self.file.write(data)


def pack(cache, archive, compressed_limit, expanded_limit, entry_limit):
    examined = expanded = files = 0

    def walk(directory, parts):
        nonlocal examined, expanded, files
        with os.scandir(directory) as entries:
            names = []
            for entry in entries:
                examined += 1
                if examined > entry_limit:
                    raise ValueError("cache entry count limit")
                names.append(entry.name)
        for name in sorted(names):
            if len(parts) < 4 and HEX_DIRECTORY.fullmatch(name):
                child = os.open(name, DIRECTORY_FLAGS, dir_fd=directory)
                try:
                    walk(child, (*parts, name))
                finally:
                    os.close(child)
            # ccache 4.14 uses 40 hex digits, with leading digits in directories.
            elif 2 <= len(parts) <= 4 and len(parts) + len(name) == 40 and CACHE_ENTRY.fullmatch(name):
                fd = os.open(name, ENTRY_FLAGS, dir_fd=directory)
                with os.fdopen(fd, "rb") as source:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise ValueError("unexpected cache entry type")
                    if info.st_size > expanded_limit - expanded:
                        raise ValueError("expanded cache limit")
                    expanded += info.st_size
                    entry = tarfile.TarInfo("/".join((*parts, name)))
                    entry.size = info.st_size
                    entry.mode = 0o600
                    tar.addfile(entry, source)
                    if source.read(1):
                        raise ValueError("cache file changed during export")
                    files += 1

    root = os.open(cache, DIRECTORY_FLAGS)
    try:
        out = os.open(archive, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(out, "wb") as raw:
            bounded = BoundedOutput(raw, compressed_limit)
            with gzip.GzipFile(filename="", mode="wb", fileobj=bounded, compresslevel=1, mtime=0) as gzip_output:
                with tarfile.open(mode="w|", fileobj=gzip_output, format=tarfile.USTAR_FORMAT) as tar:
                    walk(root, ())
            if files == 0:
                raise ValueError("no compiler cache entries")
        return {"sizeBytes": bounded.size, "sha256": bounded.hash.hexdigest()}
    finally:
        os.close(root)


def main():
    try:
        cache, archive, compressed, expanded, entries = sys.argv[1:]
        result = pack(cache, archive, int(compressed), int(expanded), int(entries))
        print(json.dumps(result, separators=(",", ":")))
    except (OSError, ValueError, tarfile.TarError):
        # Filesystem entries are sandbox-controlled and may contain sensitive text.
        print("DuckDB cache archive rejected", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
