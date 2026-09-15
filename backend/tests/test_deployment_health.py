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
    monkeypatch.setattr(check_backend_health, 'read_backend_secret', lambda: 'private-credential')
    monkeypatch.setenv('CONFIGURED_BACKEND_SHARDS', '40')
    monkeypatch.setattr(check_backend_health.time, 'sleep', lambda _: None)
    state = {'workers': 5, 'configured_shards': 40, 'ocr': {'engine': 'PP-OCRv6_small', 'ready': True, 'workers': 2, 'cpu_threads': 2}}
    monkeypatch.setattr(check_backend_health.httpx, 'get', lambda *a, **kw: SimpleNamespace(raise_for_status=lambda: None, json=lambda: state))
    check_backend_health.check_backend_health()
    state['configured_shards'] = 10
    with pytest.raises(RuntimeError, match='Wrong shard configuration'):
        check_backend_health.check_backend_health()
