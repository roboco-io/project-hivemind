"""Install two pinned Linux wheels from the verified input artifact."""
import hashlib
import io
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import zipfile

bundle, destination = map(Path, sys.argv[1:])
hashes = {
    'cmake': '1c8b05df0602365da91ee6a3336fe57525b137706c4ab5675498f662ae1dbcec',
    'ninja': 'fb46acf6b93b8dd0322adc3a4945452a4e774b75b91293bafcc7b7f8e6517dfa',
}
with zipfile.ZipFile(bundle) as archive:
    for tool, expected in hashes.items():
        name = tool+'.whl'
        if archive.getinfo(name).file_size > 40*1024**2:
            raise ValueError('Unexpected wheel size')
        wheel = archive.read(name)
        if hashlib.sha256(wheel).hexdigest() != expected:
            raise ValueError('Unexpected wheel hash')
        with zipfile.ZipFile(io.BytesIO(wheel)) as content:
            for info in content.infolist():
                path = PurePosixPath(info.filename)
                if info.is_dir():
                    continue
                if path.is_absolute() or '..' in path.parts or '\\' in info.filename:
                    raise ValueError('Invalid wheel entry')
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError('Unexpected wheel link')
                if tool == 'cmake' and path.parts[:2] == ('cmake','data'):
                    target = destination / Path(*path.parts)
                elif tool == 'ninja' and path.name == 'ninja' and path.parent.name in ('bin','scripts'):
                    target = destination / 'bin/ninja'
                else:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as out, content.open(info) as src:
                    shutil.copyfileobj(src,out)
                if path.parent.name in ('bin','scripts'):
                    target.chmod(0o700)
assert (destination/'bin/ninja').is_file()
assert (destination/'cmake/data/bin/cmake').is_file()
