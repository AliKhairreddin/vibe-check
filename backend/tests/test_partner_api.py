import hashlib
import hmac
import json

import httpx
import pytest

from app.main import app
from app.review_pipeline import storage as review_storage
from app.review_pipeline import partner_api
from app.review_pipeline.models import JobRecord, OfferProfile
from app.review_pipeline.partner_api import (
    ApiKeyInput,
    ApiPartnerInput,
    ApiPrincipal,
    DownloadedMedia,
    hash_api_token,
    validate_media_url,
    validate_webhook_url,
)


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def api_principal(
    partner_id: str = 'partner_' + 'a' * 32,
    scopes: frozenset[str] | None = None,
) -> ApiPrincipal:
    return ApiPrincipal(
        partner_id=partner_id,
        partner_name='Internal company integration',
        api_key_id='key_' + 'b' * 32,
        api_key_name='Production',
        api_key_prefix='vc_live_example…',
        scopes=scopes or frozenset({
            'evidence:read',
            'history:read',
            'reports:download',
            'reviews:create',
            'reviews:read',
            'scans:read',
            'scans:write',
        }),
        allowed_offer_ids=(),
        allow_custom_policy=True,
        monthly_review_limit=500,
        monthly_reviews_created=12,
        concurrent_review_limit=5,
        max_upload_mb=400,
        retention_days=90,
        unlimited_reviews=True,
        unlimited_concurrency=True,
        webhook_configured=False,
    )


def test_api_tokens_are_stored_as_one_way_hashes():
    token = 'vc_live_' + 'example-secret-value' * 3

    assert hash_api_token(token) == hashlib.sha256(token.encode()).hexdigest()
    assert token not in hash_api_token(token)


def test_internal_partner_can_have_unlimited_reviews_and_queue_access():
    partner = ApiPartnerInput.model_validate({
        'name': 'Internal company integration',
        'unlimited_reviews': True,
        'unlimited_concurrency': True,
    })

    assert partner.unlimited_reviews is True
    assert partner.unlimited_concurrency is True


def test_optional_convex_arguments_are_omitted_instead_of_sent_as_null(monkeypatch):
    calls = []

    def fake_convex_call(kind, path, args):
        calls.append((kind, path, args))
        return {'ok': True}

    monkeypatch.setattr(partner_api, '_convex_call', fake_convex_call)
    partner_api.save_api_partner(
        'partner_' + 'a' * 32,
        ApiPartnerInput(name='No webhook'),
    )
    partner_api.issue_api_key(
        'partner_' + 'a' * 32,
        ApiKeyInput(name='No expiration'),
    )
    partner_api.claim_api_review(
        api_principal(),
        job_id='c' * 32,
        external_id='',
        idempotency_key='',
        media_kind='copy_only',
        file_name='Ad copy',
        file_size=None,
    )

    assert 'webhookUrl' not in calls[0][2]
    assert 'expiresAt' not in calls[1][2]
    assert 'externalId' not in calls[2][2]
    assert 'idempotencyKey' not in calls[2][2]
    assert 'fileSize' not in calls[2][2]


@pytest.mark.parametrize('url', [
    'http://hooks.example.com/vibe',
    'https://localhost/vibe',
    'https://127.0.0.1/vibe',
    'https://10.0.0.1/vibe',
    'https://user:password@hooks.example.com/vibe',
    'https://hooks.example.com:8443/vibe',
])
def test_webhook_configuration_rejects_non_public_destinations(url):
    with pytest.raises(ValueError):
        validate_webhook_url(url)


def test_webhook_configuration_accepts_public_https_url():
    assert validate_webhook_url('https://hooks.example.com/vibe') == 'https://hooks.example.com/vibe'


@pytest.mark.parametrize('url', [
    'http://cdn.example.com/creative.mp4',
    'https://localhost/creative.mp4',
    'https://127.0.0.1/creative.mp4',
    'https://10.0.0.1/creative.mp4',
    'https://user:password@cdn.example.com/creative.mp4',
    'https://cdn.example.com:8443/creative.mp4',
])
def test_media_url_rejects_non_public_destinations(url):
    with pytest.raises(ValueError):
        validate_media_url(url)


@pytest.mark.anyio
async def test_media_url_download_verifies_file_signature(tmp_path, monkeypatch):
    class FakeResponse:
        status_code = 200
        headers = {'content-length': '16'}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_bytes(self, _chunk_size):
            yield b'\x89PNG\r\n\x1a\nexample!'

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def stream(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(partner_api, '_assert_public_media_destination', lambda _url: None)
    monkeypatch.setattr(partner_api.httpx, 'AsyncClient', lambda **_kwargs: FakeClient())

    downloaded = await partner_api.download_api_media(
        'https://cdn.example.com/download?id=1',
        'Monday Creative',
        tmp_path,
        1_000,
    )

    assert downloaded.file_name == 'Monday Creative.png'
    assert downloaded.media_kind == 'image'
    assert downloaded.file_size == 16
    assert downloaded.path.read_bytes().startswith(b'\x89PNG')


@pytest.mark.anyio
async def test_completion_webhook_signs_timestamp_and_exact_body(monkeypatch):
    sent = {}
    completions = []
    payload = {
        'event_id': 'evt_example',
        'type': 'review.completed',
        'data': {'review_id': '1' * 32, 'status': 'complete'},
    }

    def fake_convex_call(kind, path, args):
        assert kind == 'mutation'
        if path == 'apiPartners:claimWebhookDeliveries':
            return [{
                'delivery_id': 'evt_example',
                'event_type': 'review.completed',
                'payload': payload,
                'signing_secret': 'whsec_test',
                'webhook_url': 'https://hooks.example.com/vibe',
            }]
        assert path == 'apiPartners:completeWebhookDelivery'
        completions.append(args)
        return {'status': 'delivered'}

    class FakeResponse:
        status_code = 204

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, content, headers):
            sent.update({'url': url, 'content': content, 'headers': headers})
            return FakeResponse()

    monkeypatch.setattr(partner_api, '_convex_call', fake_convex_call)
    monkeypatch.setattr(partner_api, '_assert_public_webhook_destination', lambda _url: None)
    monkeypatch.setattr(partner_api.httpx, 'AsyncClient', lambda **_kwargs: FakeClient())

    completed = await partner_api.deliver_pending_api_webhooks(limit=1)

    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode()
    timestamp = sent['headers']['x-vibe-timestamp']
    signature = hmac.new(b'whsec_test', timestamp.encode() + b'.' + body, hashlib.sha256).hexdigest()
    assert completed == 1
    assert sent['url'] == 'https://hooks.example.com/vibe'
    assert sent['content'] == body
    assert sent['headers']['x-vibe-signature'] == f'v1={signature}'
    assert completions[0]['success'] is True
    assert completions[0]['responseStatus'] == 204


@pytest.mark.anyio
async def test_partner_openapi_contains_only_versioned_partner_routes(monkeypatch):
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        response = await client.get('/api/v1/openapi.json')

    assert response.status_code == 200
    schema = response.json()
    assert schema['components']['securitySchemes']['BearerAuth']['scheme'] == 'bearer'
    assert '/api/v1/jobs' in schema['paths']
    assert '/api/v1/jobs/{job_id}' in schema['paths']
    assert '/api/v1/jobs/{job_id}/result' in schema['paths']
    assert '/api/v1/reviews' in schema['paths']
    assert '/api/v1/scans/creative' in schema['paths']
    assert '/api/reviews' not in schema['paths']
    assert all(path.startswith('/api/v1') for path in schema['paths'])
    assert set(schema['components']['schemas']['ApiJobInput']['required']) == {
        'asset_id',
        'creative_name',
        'media_url',
    }


@pytest.mark.anyio
async def test_partner_api_discovery_uses_one_documentation_hub(monkeypatch):
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        index_response = await client.get('/api/v1')
        guide_response = await client.get('/api/v1/docs')
        reference_response = await client.get('/api/v1/reference')

    assert index_response.status_code == 200
    assert index_response.json()['documentation_url'] == '/developers/api?view=guide'
    assert index_response.json()['interactive_reference_url'] == '/developers/api?view=reference'
    assert guide_response.headers['location'] == '/developers/api?view=guide'
    assert reference_response.headers['location'] == '/developers/api?view=reference'


@pytest.mark.anyio
async def test_partner_copy_review_is_authenticated_claimed_and_queued(tmp_path, monkeypatch):
    principal = api_principal()
    captured = {}
    profile = OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Use qualified, supportable claims.',
        is_default=True,
    )

    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _token: principal)
    monkeypatch.setattr('app.main.resolve_review_offer_snapshot', lambda: ([profile], []))

    def fake_claim(_principal, **kwargs):
        captured['claim'] = kwargs
        return {'created': True, 'review_id': kwargs['job_id']}

    async def fake_enqueue(job_id, media_path, media_kind, meta, file_name, file_size=None):
        captured['meta'] = meta
        captured['media_kind'] = media_kind
        return JobRecord(
            job_id=job_id,
            file_name=file_name,
            file_size=file_size,
            offer_ids=['acp'],
            primary_offer_id='acp',
        )

    monkeypatch.setattr('app.main.claim_api_review', fake_claim)
    monkeypatch.setattr('app.main.enqueue_job', fake_enqueue)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        unauthorized = await client.post('/api/v1/reviews', data={'ad_copy': 'Qualified copy.'})
        response = await client.post(
            '/api/v1/reviews',
            headers={
                'authorization': 'Bearer vc_live_test-key',
                'idempotency-key': 'internal-review-001',
            },
            data={
                'ad_copy': 'Qualified copy.',
                'external_id': 'creative-001',
                'policy_text': 'Internal policy supplement.',
            },
        )

    assert unauthorized.status_code == 401
    assert response.status_code == 202
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['x-request-id']
    assert response.json()['review_id'] == captured['claim']['job_id']
    assert captured['claim']['idempotency_key'] == 'internal-review-001'
    assert captured['claim']['external_id'] == 'creative-001'
    assert captured['media_kind'] == 'copy_only'
    assert captured['meta'].api_partner_id == principal.partner_id
    assert captured['meta'].api_key_id == principal.api_key_id
    assert captured['meta'].offer_profiles[0].offer_id == 'acp'


@pytest.mark.anyio
async def test_simple_job_contract_downloads_url_and_returns_job_id(tmp_path, monkeypatch):
    principal = api_principal()
    captured = {}
    profile = OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Use qualified, supportable claims.',
        is_default=True,
    )

    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _token: principal)
    monkeypatch.setattr('app.main.resolve_review_offer_snapshot', lambda: ([profile], []))

    async def fake_download(_url, _creative_name, destination, _max_bytes):
        media_path = destination / 'Monday Creative.mp4'
        media_path.write_bytes(b'creative')
        return DownloadedMedia(
            file_name=media_path.name,
            file_size=media_path.stat().st_size,
            media_kind='video',
            path=media_path,
        )

    def fake_claim(_principal, **kwargs):
        captured['claim'] = kwargs
        return {'created': True, 'review_id': kwargs['job_id']}

    async def fake_enqueue(job_id, media_path, media_kind, meta, file_name, file_size=None):
        captured['media_path'] = media_path
        captured['media_kind'] = media_kind
        captured['meta'] = meta
        return JobRecord(job_id=job_id, file_name=file_name, file_size=file_size)

    monkeypatch.setattr('app.main.download_api_media', fake_download)
    monkeypatch.setattr('app.main.claim_api_review', fake_claim)
    monkeypatch.setattr('app.main.enqueue_job', fake_enqueue)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        missing_asset = await client.post(
            '/api/v1/jobs',
            headers={'authorization': 'Bearer vc_live_test-key'},
            json={
                'creative_name': 'Monday Creative',
                'media_url': 'https://cdn.example.com/creative.mp4',
            },
        )
        response = await client.post(
            '/api/v1/jobs',
            headers={
                'authorization': 'Bearer vc_live_test-key',
                'idempotency-key': 'lemmonmaxx-monday-001',
            },
            json={
                'asset_id': ' asset_12345 ',
                'creative_name': 'Monday Creative',
                'media_url': 'https://cdn.example.com/creative.mp4',
            },
        )

    assert missing_asset.status_code == 422
    assert missing_asset.json()['detail'][0]['loc'][-1] == 'asset_id'
    assert response.status_code == 202
    payload = response.json()
    assert payload['asset_id'] == 'asset_12345'
    assert payload['job_id'] == captured['claim']['job_id']
    assert payload['creative_name'] == 'Monday Creative'
    assert payload['status'] == 'queued'
    assert payload['status_url'] == f"/api/v1/jobs/{payload['job_id']}"
    assert captured['claim']['creative_name'] == 'Monday Creative'
    assert captured['claim']['external_id'] == 'asset_12345'
    assert captured['claim']['idempotency_key'] == 'lemmonmaxx-monday-001'
    assert captured['meta'].api_external_id == 'asset_12345'
    assert captured['media_kind'] == 'video'


@pytest.mark.anyio
async def test_simple_job_status_normalizes_pipeline_states(monkeypatch):
    principal = api_principal()
    job_id = '6' * 32
    statuses = {
        'queued': 'queued',
        'extracting_frames': 'processing',
        'reviewing_with_llm': 'processing',
        'complete': 'completed',
        'failed': 'failed',
    }

    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _token: principal)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        for internal_status, expected_status in statuses.items():
            monkeypatch.setattr(
                'app.main.get_api_review',
                lambda _principal, _job_id, status=internal_status: {
                    'creative_name': 'Monday Creative',
                    'external_id': 'asset_12345',
                    'job_id': job_id,
                    'message': 'Working',
                    'progress': 50,
                    'report_ready': status == 'complete',
                    'review_id': job_id,
                    'status': status,
                },
            )
            response = await client.get(
                f'/api/v1/jobs/{job_id}',
                headers={'authorization': 'Bearer vc_live_test-key'},
            )
            assert response.status_code == 200
            assert response.json()['asset_id'] == 'asset_12345'
            assert response.json()['status'] == expected_status


@pytest.mark.anyio
async def test_simple_job_result_includes_creative_name_and_complete_report(monkeypatch):
    principal = api_principal()
    job_id = '7' * 32
    report = {'overall_status': 'green', 'findings': []}

    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _token: principal)
    monkeypatch.setattr(
        'app.main.get_api_review',
        lambda _principal, _job_id: {
            'creative_name': 'Monday Creative',
            'external_id': 'asset_12345',
            'job_id': job_id,
            'report_ready': True,
            'review_id': job_id,
            'status': 'complete',
        },
    )
    monkeypatch.setattr('app.main.get_stored_report', lambda _job_id: report)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        response = await client.get(
            f'/api/v1/jobs/{job_id}/result',
            headers={'authorization': 'Bearer vc_live_test-key'},
        )

    assert response.status_code == 200
    assert response.json() == {
        'asset_id': 'asset_12345',
        'job_id': job_id,
        'creative_name': 'Monday Creative',
        'status': 'completed',
        'result': report,
    }


@pytest.mark.anyio
async def test_partner_review_ownership_isolated_between_tokens(monkeypatch):
    first = api_principal('partner_' + '1' * 32)
    second = api_principal('partner_' + '2' * 32)
    job_id = '3' * 32

    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr(
        'app.main.authenticate_api_token',
        lambda token: first if token == 'vc_live_first-token' else second,
    )
    monkeypatch.setattr(
        'app.main.get_api_review',
        lambda principal, requested_job_id: (
            {
                'review_id': requested_job_id,
                'status': 'complete',
                'report_ready': True,
            }
            if principal.partner_id == first.partner_id and requested_job_id == job_id
            else None
        ),
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        owned = await client.get(
            f'/api/v1/reviews/{job_id}',
            headers={'authorization': 'Bearer vc_live_first-token'},
        )
        hidden = await client.get(
            f'/api/v1/reviews/{job_id}',
            headers={'authorization': 'Bearer vc_live_second-token'},
        )

    assert owned.status_code == 200
    assert hidden.status_code == 404


@pytest.mark.anyio
async def test_api_key_scope_is_enforced(monkeypatch):
    principal = api_principal(scopes=frozenset({'reviews:create'}))
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _token: principal)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        response = await client.get(
            '/api/v1/reviews',
            headers={'authorization': 'Bearer vc_live_create-only'},
        )

    assert response.status_code == 403
    assert 'history:read' in response.json()['detail']


@pytest.mark.anyio
async def test_live_scan_hashes_uploaded_bytes_and_review_fields(tmp_path, monkeypatch):
    principal = api_principal()
    profile = OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Use qualified, supportable claims.',
        is_default=True,
        version=3,
    )
    claims = []

    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _token: principal)
    monkeypatch.setattr('app.main.resolve_review_offer_snapshot', lambda: ([profile], []))

    def fake_claim(_principal, **kwargs):
        claims.append(kwargs)
        return {
            'change_status': 'new' if len(claims) == 1 else 'fields_changed',
            'content_fingerprint': kwargs['content_fingerprint'],
            'created': True,
            'fields_sha256': kwargs['fields_sha256'],
            'media_sha256': kwargs['media_sha256'],
            'observation_id': kwargs['observation_id'],
            'observed_at': 1_787_328_000_000 + len(claims),
            'previous_content_fingerprint': None,
            'review_id': kwargs['job_id'],
        }

    async def fake_enqueue(job_id, _media_path, _media_kind, meta, file_name, file_size=None):
        return JobRecord(
            job_id=job_id,
            file_name=file_name,
            file_size=file_size,
            has_ad_copy=meta.has_ad_copy,
            offer_ids=['acp'],
            primary_offer_id='acp',
        )

    monkeypatch.setattr('app.main.claim_api_scan_review', fake_claim)
    monkeypatch.setattr('app.main.enqueue_job', fake_enqueue)
    media = b'the exact bytes currently served by Meta'
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        mismatched_route_key = await client.post(
            '/api/v1/scans/creative',
            headers={
                'authorization': 'Bearer vc_live_test-key',
                'x-vibe-ad-id': 'different-ad',
            },
            files={'creative': ('ad-one.mp4', media, 'video/mp4')},
            data={'ad_id': '23851234567890123'},
        )
        first = await client.post(
            '/api/v1/scans/creative',
            headers={
                'authorization': 'Bearer vc_live_test-key',
                'x-vibe-ad-id': '23851234567890123',
            },
            files={'creative': ('ad-one.mp4', media, 'video/mp4')},
            data={'ad_id': '23851234567890123', 'headline': 'First headline'},
        )
        changed_copy = await client.post(
            '/api/v1/scans/creative',
            headers={
                'authorization': 'Bearer vc_live_test-key',
                'x-vibe-ad-id': '23851234567890123',
            },
            files={'creative': ('ad-one.mp4', media, 'video/mp4')},
            data={'ad_id': '23851234567890123', 'headline': 'Changed headline'},
        )

    expected_media_hash = hashlib.sha256(media).hexdigest()
    assert mismatched_route_key.status_code == 400
    assert 'must exactly match' in mismatched_route_key.json()['detail']
    assert first.status_code == 202
    assert changed_copy.status_code == 202
    assert first.json()['media_sha256'] == expected_media_hash
    assert claims[0]['media_sha256'] == claims[1]['media_sha256'] == expected_media_hash
    assert claims[0]['fields_sha256'] != claims[1]['fields_sha256']
    assert claims[0]['content_fingerprint'] != claims[1]['content_fingerprint']
    assert claims[0]['external_ad_id'] == '23851234567890123'


@pytest.mark.anyio
async def test_unchanged_live_scan_reuses_owned_review_without_queueing(tmp_path, monkeypatch):
    principal = api_principal()
    profile = OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Use qualified, supportable claims.',
        is_default=True,
    )
    queued = []
    existing_review_id = '4' * 32

    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _token: principal)
    monkeypatch.setattr('app.main.resolve_review_offer_snapshot', lambda: ([profile], []))

    def fake_claim(_principal, **kwargs):
        return {
            'change_status': 'unchanged',
            'content_fingerprint': kwargs['content_fingerprint'],
            'created': False,
            'fields_sha256': kwargs['fields_sha256'],
            'media_sha256': kwargs['media_sha256'],
            'observation_id': kwargs['observation_id'],
            'observed_at': 1_787_328_000_000,
            'previous_content_fingerprint': kwargs['content_fingerprint'],
            'review_id': existing_review_id,
        }

    async def fake_enqueue(*args, **kwargs):
        queued.append((args, kwargs))
        raise AssertionError('Unchanged scans must not enter the review pipeline')

    monkeypatch.setattr('app.main.claim_api_scan_review', fake_claim)
    monkeypatch.setattr('app.main.enqueue_job', fake_enqueue)
    monkeypatch.setattr(
        'app.main.get_api_review',
        lambda _principal, _job_id: {
            'review_id': existing_review_id,
            'status': 'complete',
            'report_ready': True,
        },
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        response = await client.post(
            '/api/v1/scans/creative',
            headers={
                'authorization': 'Bearer vc_live_test-key',
                'x-vibe-ad-id': '23851234567890123',
            },
            files={'creative': ('ad-one.mp4', b'unchanged-media', 'video/mp4')},
            data={'ad_id': '23851234567890123', 'headline': 'Same headline'},
        )

    payload = response.json()
    assert response.status_code == 200
    assert payload['change_status'] == 'unchanged'
    assert payload['changed'] is False
    assert payload['review_created'] is False
    assert payload['review_id'] == existing_review_id
    assert payload['report_ready'] is True
    assert queued == []
    assert list(tmp_path.iterdir()) == []


@pytest.mark.anyio
async def test_scan_history_is_tenant_scoped(monkeypatch):
    first = api_principal('partner_' + '1' * 32)
    second = api_principal('partner_' + '2' * 32)

    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr(
        'app.main.authenticate_api_token',
        lambda token: first if token == 'vc_live_first-token' else second,
    )
    monkeypatch.setattr(
        'app.main.get_api_scan_ad',
        lambda principal, _ad_id: ({
            'ad_id': 'ad-1',
            'current_review_id': '5' * 32,
            'partner': principal.partner_id,
        } if principal.partner_id == first.partner_id else None),
    )
    monkeypatch.setattr(
        'app.main.get_api_review',
        lambda principal, job_id: ({
            'review_id': job_id,
            'status': 'complete',
            'report_ready': True,
        } if principal.partner_id == first.partner_id else None),
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        owned = await client.get(
            '/api/v1/scans/ads/ad-1',
            headers={'authorization': 'Bearer vc_live_first-token'},
        )
        hidden = await client.get(
            '/api/v1/scans/ads/ad-1',
            headers={'authorization': 'Bearer vc_live_second-token'},
        )

    assert owned.status_code == 200
    assert hidden.status_code == 404
