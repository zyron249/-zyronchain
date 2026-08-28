import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def run_python(source: str, *, quarantine: bool) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT)
    if quarantine:
        env["ZYRON_LEGACY_PUBLIC_QUARANTINE"] = "1"
    else:
        env.pop("ZYRON_LEGACY_PUBLIC_QUARANTINE", None)
    return subprocess.run(
        [sys.executable, "-c", source],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_quarantine_is_inert_without_explicit_env():
    result = run_python(
        """
from flask import Flask
app = Flask(__name__)
@app.get('/health')
def health():
    return {'status': 'online'}
response = app.test_client().get('/health')
assert response.status_code == 200
assert response.get_json() == {'status': 'online'}
""",
        quarantine=False,
    )
    assert result.returncode == 0, result.stderr


def test_quarantine_replaces_all_flask_routes_with_410():
    result = run_python(
        """
import json
from flask import Flask
app = Flask(__name__)
@app.get('/chain')
def chain():
    return {'canonical': True}
@app.post('/transaction')
def transaction():
    return {'accepted': True}, 201
client = app.test_client()
for method, path in [('get', '/chain'), ('post', '/transaction'), ('get', '/missing')]:
    response = getattr(client, method)(path)
    assert response.status_code == 410
    assert response.headers['Cache-Control'] == 'no-store'
    assert response.headers['X-ZyronChain-Network'] == 'legacy-quarantined'
    payload = json.loads(response.get_data(as_text=True))
    assert payload['canonical'] is False
    assert payload['network'] == 'legacy-python-compatibility-testnet'
    assert payload['status'] == 'gone'
    assert 'not the canonical ZyronChain Layer-1 network' in payload['message']
""",
        quarantine=True,
    )
    assert result.returncode == 0, result.stderr


def test_only_exact_one_activates_quarantine():
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT)
    env["ZYRON_LEGACY_PUBLIC_QUARANTINE"] = "true"
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from sitecustomize import legacy_public_quarantine_enabled; "
            "assert legacy_public_quarantine_enabled() is False",
        ],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
