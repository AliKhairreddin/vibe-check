"""Protect the existing browser API when moving reads out of the container."""
import importlib
import json
import runpy
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from app.review_pipeline.models import ComplianceReport, JobRecord
from app.review_pipeline.storage import _normalize_report_statuses

main = importlib.import_module('app.main')
ROOT = Path(__file__).resolve().parents[2]
JOB = 'a' * 32
URL = f'https://admin.adchecked.com/api/reviews/{JOB}'
ENV = {'SESSION_SECRET': 'parity-signing-secret', 'ADMIN_PASSWORD': 'owner-password',
       'EMPLOYEE_ADMIN_PASSWORD': 'employee-password', 'CONVEX_URL': 'https://example.convex.cloud',
       'CONVEX_HTTP_SECRET': 'parity-database-secret', 'CORS_ALLOWED_ORIGINS': 'https://admin.adchecked.com'}


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def node(cases):
    result = subprocess.run(['node', '--experimental-strip-types', 'tests/worker-read-parity.mjs'],
                            cwd=ROOT, input=json.dumps(cases), text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def test_generated_worker_models_match_current_backend():
    module = runpy.run_path(str(ROOT / 'scripts/generate-read-contract.py'))
    assert module['TARGET'].read_text() == module['render']()


def signed_cookie(role='owner', **extra):
    payload = {'role': role}
    payload['credential_fingerprint'] = main.current_admin_credential_fingerprint(payload)
    return f'adchecked_admin_session={main.encode_session_token("admin", {**payload, **extra})}'


@pytest.mark.anyio
async def test_edge_responses_match_real_fastapi_responses(monkeypatch):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv('APP_ADMIN_HOSTS', 'admin.adchecked.com')
    rich_report = {
        'overall_status': 'needs_review', 'summary': 'Legacy result with current decisions',
        'source_results': {'creative': {'status': 'pass'}, 'ad_copy': {'status': 'likely_violation', 'summary': 'Copy'}},
        'offer_results': [{'overall_status': 'orange', 'summary': 'Offer result', 'offer_id': 'kissterra', 'offer_name': 'Kissterra'}],
        'offer_outcomes': [{'offer_id': 'kissterra', 'offer_name': 'Kissterra', 'evaluation_state': 'evaluated',
                            'client_decision': 'approved', 'automated_status': 'amber', 'effective_status': 'green',
                            'client_decided_at': 1234, 'client_feedback_note': 'Keep this', 'with_override': True}],
        'client_decisions': [{'decision': 'approved', 'extra': {'status': 'pass'}}],
        'findings': [{'severity': 'high', 'source': 'visual', 'evidence': 'Claim', 'policy_reason': 'Policy',
                      'suggested_fix': 'Revise', 'confidence': 'medium',
                      'internal_override': {'override_id': 'rule', 'title': 'Keep title'}}],
        'applied_overrides': [{'override_id': 'rule', 'title': 'Keep applied title'}],
        'private_extra': 'must not appear',
    }
    values = [
        ('status', {'job_id': JOB}),
        ('status', {'job_id': JOB, 'status': 'complete', 'report_ready': True, 'progress': 100,
                    'released_offer_ids': ['kissterra'], 'released_at': 12, 'vertical': 'home-insurance',
                    'source_status': 'linked', 'source_kind': 'google_drive_file', 'source_url': 'https://example.com',
                    'private_extra': 'must not appear'}),
        ('report', {'overall_status': 'green', 'summary': 'Minimal report'}),
        ('report', rich_report),
        ('report', ComplianceReport.model_validate(_normalize_report_statuses(rich_report)).model_dump(mode='json')),
        ('status', None), ('report', None),
    ]
    cases, expected = [], []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://admin.adchecked.com') as client:
        for role in ['owner', 'employee']:
            headers = {'cookie': signed_cookie(role)}
            for kind, value in values:
                def status(_):
                    if value is None:
                        raise FileNotFoundError(JOB)
                    return JobRecord.model_validate(value)
                monkeypatch.setattr(main, 'get_status', status)
                monkeypatch.setattr(main, 'get_stored_report', lambda _: _normalize_report_statuses(value))
                url = URL + ('/report' if kind == 'report' else '')
                response = await client.get(url, headers=headers)
                expected.append({'status': response.status_code, 'body': response.json()})
                cases.append({'url': url, 'headers': headers, 'env': ENV, 'value': value})
    assert node(cases) == expected


@pytest.mark.anyio
async def test_cookie_rejection_matches_backend_including_rotation(monkeypatch):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv('APP_ADMIN_HOSTS', 'admin.adchecked.com')
    monkeypatch.setattr(main, 'get_status', lambda _: JobRecord(job_id=JOB))
    owner = signed_cookie()
    employee = signed_cookie('employee')
    issued_at = time.time()
    with monkeypatch.context() as patch:
        patch.setattr(main.time, 'time', lambda: issued_at - main.session_ttl_seconds() - 1)
        expired = signed_cookie()
    client = main.encode_session_token('client', {'role': 'owner', 'credential_fingerprint': main.credential_fingerprint('admin', ENV['ADMIN_PASSWORD'])})
    tokens = ['', 'adchecked_admin_session=garbage', owner + 'tampered', f'adchecked_admin_session={client}',
              signed_cookie('unrecognized'), signed_cookie(credential_fingerprint=''), expired, owner, employee]
    cases, expected = [], []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://admin.adchecked.com') as client:
        for cookie in tokens:
            response = await client.get(URL, headers={'cookie': cookie})
            expected.append({'status': response.status_code, 'body': response.json()})
            cases.append({'url': URL, 'headers': {'cookie': cookie}, 'env': ENV, 'value': {'job_id': JOB}})
        for key, cookie in [('ADMIN_PASSWORD', owner), ('EMPLOYEE_ADMIN_PASSWORD', employee), ('SESSION_SECRET', owner)]:
            with monkeypatch.context() as patch:
                patch.setenv(key, 'rotated')
                response = await client.get(URL, headers={'cookie': cookie})
                expected.append({'status': response.status_code, 'body': response.json()})
                cases.append({'url': URL, 'headers': {'cookie': cookie}, 'env': {**ENV, key: 'rotated'}, 'value': {'job_id': JOB}})
    assert node(cases) == expected
