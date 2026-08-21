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
    hash_api_token,
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
    assert '/api/v1/reviews' in schema['paths']
    assert '/api/reviews' not in schema['paths']
    assert all(path.startswith('/api/v1') for path in schema['paths'])


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
