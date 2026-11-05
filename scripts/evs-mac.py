"""EVS streaming sobre un paquete de .qa/mac-signing. Sin salida cruda: el cliente
puede imprimir datos de cuenta o URLs firmadas. Uso: evs-mac.py sign-pkg|verify-pkg <candidate|installed> <label>"""
from pathlib import Path
import json
import os
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent  # raíz del checkout: la carpeta que contiene scripts/
out = root / '.qa/mac-signing'
action, which, label = sys.argv[1:]
packages = {'candidate': out / 'candidate/mac-arm64', 'installed': out / 'installed-prototype'}
if action not in ('sign-pkg', 'verify-pkg') or which not in packages or not re.fullmatch(r'[a-z0-9-]+', label):
    raise SystemExit('Invalid operation')
package = packages[which]
report = out / (label + '.json')
if report.exists() or not (package / 'LGA El Music.app/Contents/Resources/.lga-staging').is_file():
    raise SystemExit('New report and attributed package required')
env = dict(os.environ)
for key in list(env):
    if key.startswith(('EVS_', 'AWS_')) or key in ('DEBUG', 'BOTO_CONFIG'):
        del env[key]
env.update({
    'EVS_CONFIG_FILE': str(root / '.local/evs/config.json'),
    'EVS_CACHE_FILE': str(root / '.local/evs/cache.json'),
    'EVS_NO_ASK': '1',
    'EVS_CONNECT_TIMEOUT': '20',
    'EVS_AUTH_TIMEOUT': '30',
    'EVS_UPLOAD_TIMEOUT': '90',
    'EVS_SIGN_TIMEOUT': '60',
    'PYTHONPYCACHEPREFIX': str(root / '.local/python-cache'),
    'TMPDIR': str(root / '.local/tmp'),
    'TMP': str(root / '.local/tmp'),
    'TEMP': str(root / '.local/tmp'),
    'AWS_EC2_METADATA_DISABLED': 'true',
    'AWS_CONFIG_FILE': str(root / '.local/evs/aws-config-empty'),
    'AWS_SHARED_CREDENTIALS_FILE': str(root / '.local/evs/aws-credentials-empty'),
    'BOTO_CONFIG': '/dev/null',
})
command = [str(root / 'tools/evs-env/bin/python3'), '-I', '-B', '-m',
           'castlabs_evs.vmp', '--no-ask', action, '--streaming', str(package)]
try:
    result = subprocess.run(command, env=env, cwd=root, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, timeout=180)
    captured = result.stdout + result.stderr
    safe = {
        'action': action,
        'package': which,
        'exitCode': result.returncode,
        'validSignature': 'Signature is valid:' in captured,
        'productionSignatureRequested': 'Requesting signature:' in captured,
        'signatureRequestSuccessful': 'Signature request successful:' in captured,
        'retainedExistingSignature': 'Retain existing signature:' in captured,
        'usedCachedSignature': 'Using cached signature:' in captured,
        'developmentOnly': 'Certificate is valid for development only' in captured,
        'interactiveInformationMissing': 'NonInteractiveError' in captured,
        'rawOutputStored': False,
    }
except subprocess.TimeoutExpired:
    safe = {'action': action, 'package': which, 'exitCode': 124, 'timedOut': True, 'rawOutputStored': False}
report.write_text(json.dumps(safe, indent=2) + '\n')
print(json.dumps(safe))
raise SystemExit(safe['exitCode'])
