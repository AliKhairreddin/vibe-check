from dataclasses import replace
import importlib

import httpx
import pytest

from app.review_pipeline.partner_api import ApiPartnerInput, public_api_evidence
from test_partner_api import api_principal

main = importlib.import_module('app.main')
cors = importlib.import_module('app.partner_cors')
partner_api = importlib.import_module('app.review_pipeline.partner_api')
ORIGIN = 'https://lemonmaxx.com'
JOB = 'a' * 32


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def test_origins_are_exact_normalized_and_deduplicated():
    partner = ApiPartnerInput(name='LemonMax', allowed_origins=[
        ' https://LEMONMAXX.com/ ', 'https://lemonmaxx.com:443',
        'http://localhost:9002/', 'http://[::1]:9002',
    ])
    assert partner.allowed_origins == ['http://[::1]:9002', 'http://localhost:9002', ORIGIN]


@pytest.mark.parametrize('origin', [
    '*', 'null', 'https://*.example.com', 'http://lemonmaxx.com', 'lemonmaxx.com',
    'https://example.com/path', 'https://example.com/../', 'https://example.com?x=1',
    'https://example.com#', 'https://user:pass@example.com', 'https://@example.com',
    'https://example.com:0', 'https://example.com:65536', 'https://exam ple.com',
    'http://localhost.example.com:9002', 'http://10.0.0.1:9002', 'file:///tmp/file',
])
def test_invalid_origins_are_rejected(origin):
    with pytest.raises(ValueError):
        ApiPartnerInput(name='Test', allowed_origins=[origin])


@pytest.mark.anyio
async def test_preflight_and_authenticated_media_are_allowed_only_for_configured_partner(monkeypatch):
    origins = {ORIGIN, 'http://localhost:9002', 'https://other.example'}
    monkeypatch.setattr(cors, 'browser_origin_allowed', lambda origin: origin in origins)
    monkeypatch.setattr(main, 'authenticate_api_token', lambda _: replace(api_principal(), allowed_origins=(ORIGIN, 'http://localhost:9002')))
    monkeypatch.setattr(main, 'get_api_review', lambda *_: {'review_id': JOB, 'status': 'complete'})
    monkeypatch.setattr(main, 'review_media_response', lambda *_: main.Response(
        b'video', status_code=206, headers={'content-range': 'bytes 0-4/10', 'accept-ranges': 'bytes'}))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://api.adchecked.com') as client:
        for origin in [ORIGIN, 'http://localhost:9002']:
            for method in ['GET', 'HEAD']:
                response = await client.options(f'/api/v1/reviews/{JOB}/media', headers={
                    'origin': origin, 'access-control-request-method': method,
                    'access-control-request-headers': 'authorization,range',
                })
                assert response.status_code == 200
                assert response.headers['access-control-allow-origin'] == origin
                assert 'HEAD' in response.headers['access-control-allow-methods']
            response = await client.get(f'/api/v1/reviews/{JOB}/media', headers={
                'origin': origin, 'authorization': 'Bearer test', 'range': 'bytes=0-4',
            })
            assert response.status_code == 206
            assert response.headers['access-control-allow-origin'] == origin
            assert 'content-range' in response.headers['access-control-expose-headers']
            assert 'Origin' in response.headers['vary']

        # Registered for a different partner: handshake may pass, but this key
        # must not read data or execute an endpoint from that origin.
        response = await client.get(f'/api/v1/reviews/{JOB}/media', headers={
            'origin': 'https://other.example', 'authorization': 'Bearer test',
        })
        assert response.status_code == 403
        assert 'this API partner' in response.json()['detail']

        origins.remove(ORIGIN)
        response = await client.options('/api/v1/reviews', headers={
            'origin': ORIGIN, 'access-control-request-method': 'GET',
        })
        assert response.status_code == 400
        assert 'access-control-allow-origin' not in response.headers
        assert (await client.get('/api/v1/reviews', headers={'origin': ORIGIN, 'authorization': 'Bearer test'})).status_code == 403


@pytest.mark.anyio
async def test_origins_do_not_broaden_admin_access_and_auth_errors_remain_readable(monkeypatch):
    monkeypatch.setattr(cors, 'browser_origin_allowed', lambda origin: origin == ORIGIN)
    monkeypatch.setattr(main, 'authenticate_api_token', lambda _: None)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://api.adchecked.com') as client:
        response = await client.get('/api/v1/reviews', headers={'origin': ORIGIN})
        assert response.status_code == 401
        assert response.headers['access-control-allow-origin'] == ORIGIN
        response = await client.options('/api/reviews/history', headers={
            'origin': ORIGIN, 'access-control-request-method': 'GET',
        })
        assert response.status_code == 400
        assert 'access-control-allow-origin' not in response.headers
        response = await client.options('/api/v1/reviews', headers={
            'origin': 'https://admin.adchecked.com', 'access-control-request-method': 'GET',
        })
        assert response.status_code == 200
        assert response.headers['access-control-allow-origin'] == 'https://admin.adchecked.com'


@pytest.mark.anyio
async def test_requests_without_origin_do_not_need_browser_permission(monkeypatch):
    def unexpected_lookup(_):
        raise AssertionError('Server-to-server calls must not query origin settings')
    monkeypatch.setattr(cors, 'browser_origin_allowed', unexpected_lookup)
    monkeypatch.setattr(main, 'authenticate_api_token', lambda _: api_principal())
    monkeypatch.setattr(main, 'list_api_reviews', lambda *_args, **_kwargs: {'reviews': [], 'has_more': False})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://api.adchecked.com') as client:
        response = await client.get('/api/v1/reviews', headers={'authorization': 'Bearer test'})
        assert response.status_code == 200


def test_evidence_returns_protected_urls_instead_of_temporary_server_paths():
    bundle = {
        'media_metadata': {'format': {'filename': '/tmp/vibe-check/jobs/job/Creative Video.mp4', 'duration': '20.0'}},
        'visual_frame_references': [{'filename': 'frame 1.jpg', 'timestamp': 1}],
    }
    result = public_api_evidence(JOB, bundle)
    assert result['media_metadata']['format']['filename'] == 'Creative Video.mp4'
    assert result['media_url'] == f'/api/v1/reviews/{JOB}/media'
    assert result['frames'][0]['url'] == f'/api/v1/reviews/{JOB}/frames/frame%201.jpg'
    assert result['visual_frame_references'] == result['frames']
    assert bundle['media_metadata']['format']['filename'].startswith('/tmp/')


@pytest.mark.parametrize('account_type', [None, 'production', 'testing'])
def test_account_type_updates_are_explicit_so_older_clients_preserve_testing(monkeypatch, account_type):
    calls = []
    monkeypatch.setattr(partner_api, '_convex_call', lambda kind, name, args: calls.append(args) or {'partner_id': 'partner'})
    payload = ApiPartnerInput(name='Partner', **({'account_type': account_type} if account_type else {}))
    partner_api.save_api_partner('partner', payload)
    assert calls[0].get('accountType') == account_type
    assert ('accountType' in calls[0]) == (account_type is not None)


def test_account_type_rejects_unknown_categories():
    with pytest.raises(ValueError):
        ApiPartnerInput(name='Partner', account_type='sandbox')
