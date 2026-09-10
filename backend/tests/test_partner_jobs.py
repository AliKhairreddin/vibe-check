import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest

from app.main import app
from app.review_pipeline import partner_jobs, storage
from app.review_pipeline.models import OfferOutcome, OfferProfile
from app.review_pipeline.partner_api import ApiStatusColorsInput, PartnerMediaError
from test_partner_api import api_principal


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
def setup_api(monkeypatch):
    principal = api_principal()
    profiles = [
        OfferProfile(offer_id='acp', display_name='ACP', official_guidelines='ACP policy'),
        OfferProfile(offer_id='kissterra', display_name='Kissterra Connect', official_guidelines='Kissterra policy'),
    ]
    outcomes = [OfferOutcome(offer_id=p.offer_id, offer_name=p.display_name, evaluation_state='evaluated', message='Ready') for p in profiles]
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _: principal)
    monkeypatch.setattr('app.main.resolve_review_offer_snapshot', lambda: (profiles, outcomes))
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    return principal


def creative(i=0):
    return {'asset_id': f'asset_{i}', 'creative_name': f'Creative {i}', 'media_url': f'https://cdn.example.com/{i}.mp4'}


def card(status='completed', asset_id='asset_0'):
    return {
        'asset_id': asset_id, 'job_id': 'batch_' + 'a' * 32, 'review_id': 'b' * 32, 'creative_name': 'Creative',
        'offer_id': 'kissterra', 'offer_name': 'Kissterra Connect', 'status': status, 'color': 'green' if status == 'completed' else None,
        'clean': True if status == 'completed' else None, 'finding_count': 0 if status == 'completed' else None,
        'report_ready': status == 'completed', 'progress': 100 if status == 'completed' else 0, 'message': 'Status',
        'status_url': '/api/v1/jobs/batch_' + 'a' * 32, 'result_url': '/api/v1/assets/asset_0/result?review_id=' + 'b' * 32,
        'updated_at': 123,
    }


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', headers={'authorization': 'Bearer vc_live_test-key'})


@pytest.mark.anyio
async def test_internal_dispatch_wakes_workers_without_holding_a_request_open(monkeypatch):
    monkeypatch.setenv('CONVEX_HTTP_SECRET', 'internal-test-secret')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr(partner_jobs, '_work_available', False)
    drain = AsyncMock(side_effect=AssertionError('Dispatch should return immediately'))
    monkeypatch.setattr(partner_jobs, 'drain_partner_jobs', drain)
    async with client() as http:
        denied = await http.post('/api/internal/partner-jobs')
        assert denied.status_code == 401
        assert not partner_jobs._work_available
        response = await http.post('/api/internal/partner-jobs', headers={'x-automation-secret': 'internal-test-secret'})
    assert response.status_code == 200
    assert partner_jobs._work_available
    assert 'workers' in response.json()
    drain.assert_not_called()


@pytest.mark.anyio
async def test_idle_state_includes_background_maintenance(monkeypatch):
    monkeypatch.setenv('CONVEX_HTTP_SECRET', 'internal-test-secret')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr('app.main.background_tasks', {object()})
    async with client() as http:
        response = await http.get('/api/internal/queue-state', headers={'x-automation-secret': 'internal-test-secret'})
    assert response.status_code == 200
    assert response.json()['background'] == 1


@pytest.mark.anyio
async def test_batch_freezes_only_requested_offer_and_returns_without_download(setup_api, monkeypatch):
    captured = {}
    download = AsyncMock(side_effect=AssertionError('Batch request must not download'))
    monkeypatch.setattr('app.main.download_api_media', download)

    def submit(principal, payload, meta, key, max_bytes):
        captured.update(meta=meta, key=key, max_bytes=max_bytes)
        return {'job_id': 'batch_' + 'a' * 32, 'status': 'queued', 'total': len(payload.creatives),
                'counts': {'queued': len(payload.creatives), 'processing': 0, 'completed': 0, 'failed': 0},
                'assets': [card('queued', c.asset_id) for c in payload.creatives], 'offer_id': meta.primary_offer_id,
                'offer_name': meta.offer_profiles[0].display_name, 'progress': 0, 'status_url': '/api/v1/jobs/batch_' + 'a' * 32, 'created_at': 123}

    monkeypatch.setattr(partner_jobs, 'submit_batch', submit)
    async with client() as http:
        response = await http.post('/api/v1/jobs', headers={'Idempotency-Key': 'one-batch'}, json={
            'offer_name': '  KISSTERRA   Connect ', 'creatives': [creative(i) for i in range(100)],
        })
    assert response.status_code == 202, response.text
    assert response.json()['total'] == 100
    assert captured['meta'].offer_ids == ['kissterra']
    assert [o.offer_id for o in captured['meta'].offer_outcomes] == ['kissterra']
    assert captured['key'] == 'one-batch'
    download.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize('payload', [
    {'offer_name': 'acp', 'creatives': []},
    {'offer_name': 'acp', 'creatives': [creative(i) for i in range(101)]},
    {'offer_name': 'acp', 'creatives': [creative(), creative()]},
    {'creatives': [creative()]},
    {'offer_name': ' ', 'creatives': [creative()]},
    {'offer_name': 'unknown', 'creatives': [creative()]},
    {'offer_name': 'acp', 'creatives': [{**creative(), 'offer_name': 'kissterra'}]},
    {'offer_name': 'acp', 'creatives': [{**creative(), 'media_url': 'https://127.0.0.1/media.mp4'}]},
])
async def test_invalid_batches_are_rejected_before_storage(setup_api, monkeypatch, payload):
    monkeypatch.setattr(partner_jobs, 'submit_batch', lambda *_: pytest.fail('Invalid batch was accepted'))
    async with client() as http:
        response = await http.post('/api/v1/jobs', json=payload)
    assert response.status_code == 422


@pytest.mark.anyio
async def test_unentitled_offer_and_batch_quota_errors(setup_api, monkeypatch):
    monkeypatch.setattr('app.main.authenticate_api_token', lambda _: replace(setup_api, allowed_offer_ids=('acp',)))
    async with client() as http:
        denied = await http.post('/api/v1/jobs', json={'offer_name': 'kissterra', 'creatives': [creative()]})
        assert denied.status_code == 403
        def over_quota(*_):
            raise RuntimeError('Monthly review limit reached for this batch')
        monkeypatch.setattr(partner_jobs, 'submit_batch', over_quota)
        limited = await http.post('/api/v1/jobs', json={'offer_name': 'acp', 'creatives': [creative()]})
        assert limited.status_code == 429
        assert limited.headers['retry-after'] == '60'


@pytest.mark.anyio
@pytest.mark.parametrize('body', [{'asset_id': 'asset_0'}, {'asset_ids': ['asset_0']}, ['asset_0']])
async def test_all_color_request_shapes_and_compact_response(setup_api, monkeypatch, body):
    def colors(principal, ids, offer_id):
        assert ids == ['asset_0']
        return {'data': [{'asset_id': ids[0], 'status': 'processing', 'color': None, 'review_id': 'b' * 32, 'job_id': 'batch_' + 'a' * 32}]}
    monkeypatch.setattr(partner_jobs, 'status_colors', colors)
    async with client() as http:
        response = await http.post('/api/v1/assets/status-colors', json=body)
    assert response.status_code == 200
    assert response.json()['data'][0]['color'] is None
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['x-request-id']


@pytest.mark.parametrize('body', [{}, {'asset_id': 'a', 'asset_ids': ['a']}, {'asset_ids': []}, {'asset_ids': ['a'] * 101}, {'asset_ids': ['a\nb']}, {'asset_ids': ['x' * 201]}])
def test_invalid_color_requests_are_rejected(body):
    with pytest.raises(ValueError):
        ApiStatusColorsInput.model_validate(body)


@pytest.mark.anyio
@pytest.mark.parametrize('route', ['/api/v1/jobs/asset_0/result', '/api/v1/assets/asset_0/result'])
async def test_asset_details_include_transcript_and_only_selected_offer(setup_api, monkeypatch, route):
    monkeypatch.setattr(partner_jobs, 'get_asset', lambda *_: card())
    monkeypatch.setattr('app.main.get_stored_report', lambda _: {'overall_status': 'red', 'findings': ['other offer'], 'offer_results': [
        {'offer_id': 'acp', 'overall_status': 'red', 'findings': ['ACP only']},
        {'offer_id': 'kissterra', 'overall_status': 'green', 'findings': [], 'summary': 'Clean'},
    ]})
    monkeypatch.setattr('app.main.get_api_evidence', lambda *_: {'bundle': {'audio_transcript': [{'start': 0, 'text': 'Compare options'}], 'visual_frame_references': [{'filename': 'frame_001.jpg'}]}, 'expires_at': 10000, 'expired': False})
    async with client() as http:
        response = await http.get(route)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['result']['offer_id'] == 'kissterra'
    assert result['result']['findings'] == []
    assert 'ACP only' not in response.text
    assert result['transcript'][0]['text'] == 'Compare options'
    assert result['evidence']['frames'][0]['url'].endswith('/frames/frame_001.jpg')


@pytest.mark.anyio
async def test_asset_pending_failed_unknown_scope_and_expiry(setup_api, monkeypatch):
    async with client() as http:
        for state, expected in [('queued', 409), ('processing', 409), ('failed', 409), ('missing', 404)]:
            monkeypatch.setattr(partner_jobs, 'get_asset', lambda *_, state=state: None if state == 'missing' else card(state))
            response = await http.get('/api/v1/assets/asset_0/result')
            assert response.status_code == expected
            assert ('retry-after' in response.headers) == (state in {'queued', 'processing'})
        monkeypatch.setattr(partner_jobs, 'get_asset', lambda *_: card())
        monkeypatch.setattr('app.main.get_stored_report', lambda _: {'offer_id': 'kissterra', 'overall_status': 'green', 'findings': []})
        monkeypatch.setattr('app.main.get_api_evidence', lambda *_: {'bundle': None, 'expired': True, 'expires_at': 123})
        expired = await http.get('/api/v1/assets/asset_0/result')
        assert expired.status_code == 200
        assert expired.json()['evidence_status'] == 'expired'
        assert expired.json()['transcript'] is None
        monkeypatch.setattr('app.main.authenticate_api_token', lambda _: replace(setup_api, scopes=frozenset({'reviews:read'})))
        assert (await http.get('/api/v1/assets/asset_0/result')).status_code == 403


@pytest.mark.anyio
async def test_unknown_batch_and_machine_readable_contract(setup_api, monkeypatch):
    monkeypatch.setattr(partner_jobs, 'get_batch', lambda *_: None)
    async with client() as http:
        assert (await http.get('/api/v1/jobs/batch_' + 'a' * 32)).status_code == 404
        response = await http.get('/api/v1/openapi.json')
    schema = response.json()
    assert schema['info']['version'] == '1.1.0'
    assert '/api/v1/assets/status-colors' in schema['paths']
    assert '/api/v1/assets/{asset_id}/result' in schema['paths']
    batch = schema['components']['schemas']['ApiBatchJobInput']
    assert batch['properties']['creatives']['maxItems'] == 100
    assert batch['required'] == ['offer_name', 'creatives']
    assert 'ApiAssetResult' in schema['components']['schemas']


@pytest.mark.anyio
@pytest.mark.parametrize('failure, retryable', [(None, True), (PartnerMediaError(415, 'Unsupported file'), False), (PartnerMediaError(504, 'Timeout'), True)])
async def test_durable_worker_finishes_with_fenced_context_and_cleans_files(tmp_path, monkeypatch, failure, retryable):
    monkeypatch.setattr(storage, 'JOB_DATA_DIR', tmp_path)
    calls = []
    async def process(claim):
        assert storage.api_job_lease.get() == 'lease'
        storage.job_dir(claim['job_id']).joinpath('media').write_bytes(b'test')
        if failure:
            raise failure
        return True, True, 'Complete'
    monkeypatch.setattr(partner_jobs, '_process_remote_job', process)
    monkeypatch.setattr(partner_jobs, '_convex_call', lambda kind, path, args: calls.append((path, args, storage.api_job_lease.get())))
    await partner_jobs.run_partner_job({'job_id': 'a' * 32, 'lease_id': 'lease'}, 5)
    assert calls[0][0] == 'apiJobs:finish'
    assert calls[0][1]['success'] == (failure is None)
    assert calls[0][1]['retryable'] == retryable
    assert calls[0][2] == 'lease'
    assert storage.api_job_lease.get() is None
    assert not (tmp_path / ('a' * 32)).exists()


@pytest.mark.anyio
async def test_lost_heartbeat_cancels_processing_before_finishing(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, 'JOB_DATA_DIR', tmp_path)
    cancelled = asyncio.Event()
    async def process(_):
        try:
            await asyncio.Future()
        finally:
            cancelled.set()
    async def heartbeat(*_):
        await asyncio.sleep(0)
        raise RuntimeError('Lease lost')
    def finish(*_):
        assert cancelled.is_set()
    monkeypatch.setattr(partner_jobs, '_process_remote_job', process)
    monkeypatch.setattr(partner_jobs, '_heartbeat', heartbeat)
    monkeypatch.setattr(partner_jobs, '_convex_call', finish)
    await partner_jobs.run_partner_job({'job_id': 'a' * 32, 'lease_id': 'lease'}, 5)
    assert cancelled.is_set()
