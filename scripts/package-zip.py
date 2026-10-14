"""Archive the finished Windows directory and verify every ZIP entry."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

root = Path(__file__).resolve().parents[1]
source = root / 'release' / 'win-unpacked'
archive = root / 'release' / 'MoneyComing-win-x64.zip'
assert (source / 'MoneyComing.exe').is_file(), 'Build Windows package first'
files = sorted(p for p in source.rglob('*') if p.is_file())
with ZipFile(archive, 'w', ZIP_DEFLATED, compresslevel=6) as z:
    for file in files:
        z.write(file, Path('MoneyComing') / file.relative_to(source))
with ZipFile(archive) as z:
    assert z.testzip() is None, 'Archive CRC failure'
    assert len(z.infolist()) == len(files)
    z.extractall(root / 'artifacts' / 'ZIP解压 验收')
report = {
    'archive': str(archive),
    'bytes': archive.stat().st_size,
    'unpackedBytes': sum(p.stat().st_size for p in files),
    'fileCount': len(files),
    'sha256': hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest(),
    'crcPassed': True,
    'extractedTo': str(root / 'artifacts' / 'ZIP解压 验收' / 'MoneyComing'),
}
(root / 'artifacts' / 'zip.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
