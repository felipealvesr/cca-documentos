"""Build-time only: download runtime/models. The installed application never downloads."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

root = Path(__file__).resolve().parents[1]
runtime = root / 'resources' / 'ocr'
runtime.mkdir(parents=True, exist_ok=True)
cache = root / '.cache'
cache.mkdir(exist_ok=True)
if not (runtime / 'python312.dll').exists():
    archive = cache / 'python-embed.zip'
    if not archive.exists():
        urllib.request.urlretrieve('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', archive)
    with zipfile.ZipFile(archive) as z:
        z.extractall(runtime)
site = runtime / 'Lib' / 'site-packages'
if not (site / 'rapidocr').exists():
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--target', str(site), '-r', str(root / 'ocr-worker' / 'requirements.txt')], check=True)
shutil.copy2(runtime / 'python.exe', runtime / 'cca-ocr.exe')
for dll in ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll']:
    source = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / dll
    if source.exists():
        shutil.copy2(source, runtime / dll)
    elif not (runtime / dll).exists():
        raise RuntimeError('Build machine requires the Microsoft Visual C++ x64 redistributable: ' + dll)
(runtime / 'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n', encoding='utf-8')
shutil.copy2(root / 'ocr-worker' / 'worker.py', runtime / 'worker.py')
models = json.loads((root / 'ocr-worker' / 'models.json').read_text())
(runtime / 'models').mkdir(exist_ok=True)
def download(model):
    target = runtime / 'models' / model['file']
    def valid():
        return target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == model['sha256']
    if not valid():
        print('Downloading', model['file'], flush=True)
        urllib.request.urlretrieve(model['url'], target)
    if not valid():
        raise RuntimeError('Model checksum mismatch: ' + model['file'])
    print('Verified', model['file'], flush=True)
with ThreadPoolExecutor(max_workers=3) as executor:
    list(executor.map(download, models))
shutil.copy2(root / 'ocr-worker' / 'models.json', runtime / 'models' / 'manifest.json')
print('Offline OCR runtime ready.')
