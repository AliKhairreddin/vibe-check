import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import convex_secret
import check_backend_health


def test_secret_read_retries_stdout_pollution_without_printing_the_credential(monkeypatch, capsys):
    monkeypatch.delenv('GITHUB_ACTIONS', raising=False)
    outputs = iter(['WebSocket closed with code 1006\nprivate-credential', 'private-credential\n'])
    monkeypatch.setattr(convex_secret.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout=next(outputs)))
    monkeypatch.setattr(convex_secret.time, 'sleep', lambda _: None)
    assert convex_secret.read_backend_secret() == 'private-credential'
    assert capsys.readouterr().out == ''


def test_repeated_invalid_output_fails_without_leaking_cli_output(monkeypatch):
    monkeypatch.setattr(convex_secret.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout='connection error\nprivate-credential'))
    monkeypatch.setattr(convex_secret.time, 'sleep', lambda _: None)
    with pytest.raises(RuntimeError, match='output withheld') as error:
        convex_secret.read_backend_secret()
    assert 'private-credential' not in str(error.value)


def test_actions_masks_the_validated_secret(monkeypatch, capsys):
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    monkeypatch.setattr(convex_secret.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout='test-mask-value'))
    assert convex_secret.read_backend_secret() == 'test-mask-value'
    assert capsys.readouterr().out == '::add-mask::test-mask-value\n'


def test_health_check_suppresses_header_values_in_protocol_errors(monkeypatch):
    monkeypatch.setenv('GITHUB_SHA', 'c' * 40)
    monkeypatch.setattr(check_backend_health, 'read_backend_secret', lambda: 'private-credential')
    monkeypatch.setenv('CONFIGURED_BACKEND_SHARDS', '40')
    monkeypatch.setattr(check_backend_health.time, 'sleep', lambda _: None)
    def fail(*a, **kw):
        raise check_backend_health.httpx.LocalProtocolError('Illegal header: private-credential')
    monkeypatch.setattr(check_backend_health.httpx, 'get', fail)
    with pytest.raises(RuntimeError, match='LocalProtocolError') as error:
        check_backend_health.check_backend_health()
    assert 'private-credential' not in str(error.value)
    assert error.value.__context__ is None


def test_health_check_verifies_workers_shards_and_ocr(monkeypatch):
    monkeypatch.setenv('GITHUB_SHA', 'c' * 40)
    monkeypatch.setattr(check_backend_health, 'read_backend_secret', lambda: 'private-credential')
    monkeypatch.setenv('CONFIGURED_BACKEND_SHARDS', '40')
    monkeypatch.setattr(check_backend_health.time, 'sleep', lambda _: None)
    state = {'image_revision': 'c' * 40, 'workers': 5, 'configured_shards': 40, 'ocr': {'engine': 'PP-OCRv6_small', 'ready': True, 'workers': 2, 'cpu_threads': 2}}
    monkeypatch.setattr(check_backend_health.httpx, 'get', lambda *a, **kw: SimpleNamespace(raise_for_status=lambda: None, json=lambda: state))
    calls = []
    def signup_probe(url, **kwargs):
        calls.append((url, kwargs))
        return SimpleNamespace(status_code=422, json=lambda: {'detail': [{'type': 'missing', 'loc': ['body', field]} for field in ('workspace_name', 'email', 'password')]})
    monkeypatch.setattr(check_backend_health.httpx, 'post', signup_probe)
    check_backend_health.check_backend_health()
    assert len(calls) == 1
    assert calls[0][0] == 'https://app.adchecked.com/api/client/signup'
    assert calls[0][1]['json'] == {}
    assert calls[0][1]['headers'] == {'origin': 'https://app.adchecked.com'}
    monkeypatch.setattr(check_backend_health.httpx, 'post', lambda *a, **kw: SimpleNamespace(status_code=404))
    with pytest.raises(RuntimeError, match='current signup route'):
        check_backend_health.check_backend_health()
    monkeypatch.setattr(check_backend_health.httpx, 'post', lambda *a, **kw: SimpleNamespace(status_code=422, json=lambda: {'detail': []}))
    with pytest.raises(RuntimeError, match='unexpected signup schema'):
        check_backend_health.check_backend_health()
    state['configured_shards'] = 10
    with pytest.raises(RuntimeError, match='Wrong shard configuration'):
        check_backend_health.check_backend_health()


def test_activation_rejects_a_signup_capable_backend_from_another_revision(monkeypatch):
    from fastapi.testclient import TestClient
    from app import main

    expected = 'a' * 40
    monkeypatch.setenv('GITHUB_SHA', expected)
    monkeypatch.setenv('CONFIGURED_BACKEND_SHARDS', '40')
    monkeypatch.setenv('REVIEW_BACKEND_SHARDS', '40')
    monkeypatch.setenv('CONVEX_HTTP_SECRET', 'health-fixture')
    monkeypatch.setattr(main, 'queue_state', lambda: {'workers': 5})
    monkeypatch.setattr(main, 'ocr_state', lambda: {
        'engine': 'PP-OCRv6_small', 'ready': True, 'workers': 2, 'cpu_threads': 2,
    })
    client = TestClient(main.app)
    monkeypatch.setattr(check_backend_health.httpx, 'get', lambda url, headers, timeout: client.get(url, headers=headers))
    monkeypatch.setattr(check_backend_health.httpx, 'post', lambda url, headers, json, timeout: client.post(url, headers=headers, json=json))
    monkeypatch.setattr(check_backend_health, 'read_backend_secret', lambda: 'health-fixture')
    monkeypatch.setattr(check_backend_health.time, 'sleep', lambda _: None)

    for image_revision in (None, 'b' * 40):
        monkeypatch.setattr(main, 'IMAGE_REVISION', image_revision, raising=False)
        with pytest.raises(RuntimeError, match='image revision'):
            check_backend_health.check_backend_health()
    monkeypatch.setattr(main, 'IMAGE_REVISION', expected)
    check_backend_health.check_backend_health()


def test_policy_sync_retries_diagnostic_output_before_calling_convex(tmp_path):
    pnpm = tmp_path / 'pnpm'
    pnpm.write_text("""#!/bin/sh
case "$3" in
    env)
        if [ ! -f "$FIXTURE/first-read" ]; then
            touch "$FIXTURE/first-read"
            echo 'WebSocket closed with code 1006'
        fi
        echo 'synthetic-policy-token'
        ;;
    run)
        if [ "$4" = "$FAIL_FUNCTION" ]; then
            echo "$5" >&2
            exit 1
        fi
        printf '%s\\n' "$5" >> "$FIXTURE/requests"
        echo '[]'
        ;;
    *) exit 1 ;;
esac
""")
    pnpm.chmod(0o755)
    script = Path(__file__).resolve().parents[2] / 'scripts' / 'sync-offer-policies.py'
    env = {**os.environ, 'CONVEX_HTTP_SECRET': '', 'GITHUB_ACTIONS': 'false',
           'FIXTURE': str(tmp_path), 'PATH': f"{tmp_path}{os.pathsep}{os.environ['PATH']}"}
    subprocess.run([sys.executable, str(script), '--deployment', 'local:fixture'],
                   cwd=tmp_path, env=env, check=True, capture_output=True)
    requests = [json.loads(line) for line in (tmp_path / 'requests').read_text().splitlines()]
    assert requests
    assert all(request['secret'] == 'synthetic-policy-token' for request in requests)

    for function in ('offers:list', 'offers:upsert'):
        failed = subprocess.run([sys.executable, str(script), '--deployment', 'local:fixture'],
                                cwd=tmp_path, env={**env, 'FAIL_FUNCTION': function},
                                capture_output=True, text=True)
        assert failed.returncode != 0
        assert function in failed.stderr
        assert 'synthetic-policy-token' not in failed.stdout + failed.stderr
