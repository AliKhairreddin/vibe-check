import importlib
import io
import time

import httpx
import pytest
from fastapi import HTTPException
from pypdf import PdfReader

from app import workspaces
from app.review_pipeline.models import JobRecord, JobStatus, OfferProfile
from app.review_pipeline import pdf_reports

main = importlib.import_module('app.main')
JOB = 'a' * 32
OTHER = 'b' * 32
TOKEN = 'c' * 43


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
def portal(monkeypatch, tmp_path):
    monkeypatch.setenv('SESSION_SECRET', 'workspace-test-secret')
    monkeypatch.setenv('KISSTERRA_CLIENT_PASSWORD', 'advertiser-secret')
    monkeypatch.setenv('APP_PASSWORD', 'operator-only')
    monkeypatch.setattr(workspaces.storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(workspaces.storage, 'CONVEX_URL', '')
    monkeypatch.setattr(workspaces.storage, 'CONVEX_HTTP_SECRET', '')
    row = {'publisherId': 'publisher-a', 'clientId': 'kissterra', 'name': 'Banana Team', 'username': 'banana',
           'status': 'active', 'authVersion': 1, 'passwordHash': workspaces.hash_password('publisher-test-password')}
    state = {'publisher': row, 'share': None, 'calls': []}

    def call(function, args, *, mutation=False):
        state['calls'].append((function, args, mutation))
        if function == 'getPublisher':
            return row if (args.get('publisherId') == row['publisherId'] or args.get('username') == row['username'] or args.get('inviteHash') == row.get('inviteHash', '-')) else None
        if function == 'getSubmission':
            return {'clientId': 'kissterra', 'publisherId': 'publisher-a'} if args['jobId'] == JOB else None
        if function == 'getShare':
            return state['share']
        if function == 'listPublishers' or function == 'listSubmissions' or function == 'listShares':
            return []
        if function == 'claimSubmission' or function == 'createShare' or function == 'revokeShare' or function == 'setPlan':
            return None
        if function == 'getPlan':
            return {'clientId': args['clientId'], 'plan': 'pilot', 'publisherLimit': 5, 'monthlyReviewLimit': 250, 'publishers': 1, 'monthlyReviews': 0}
        raise AssertionError(function)

    monkeypatch.setattr(workspaces, 'call', call)
    def cookies(role='publisher'):
        session = workspaces.publisher_session(row) if role == 'publisher' else {'role': 'client', 'username': 'kissterra', 'portal_ids': ['kissterra']}
        session['credential_fingerprint'] = main.current_client_credential_fingerprint(session)
        return {main.CLIENT_SESSION_COOKIE: main.encode_session_token('client', session)}
    state['cookies'] = cookies
    return state


def detail():
    return {'review': {'jobId': JOB, 'fileName': 'creative.mp4', 'aiStatus': 'green', 'createdAt': 1, 'mediaKind': 'video', 'preview': {'googleDriveUrl': 'private-source'}},
            'report': {'offer_name': 'Kissterra', 'overall_status': 'green', 'summary': 'Clear', 'findings': [], 'internal_overrides': ['secret policy'], 'offer_results': [{'offer_name': 'Other advertiser'}]},
            'googleDriveUrl': 'private-source', 'evidenceFrames': [{'filename': 'frame.jpg', 'timestamp': 1}]}


def test_passwords_and_tokens_are_one_way_and_salted():
    a = workspaces.hash_password('a-long-private-password')
    b = workspaces.hash_password('a-long-private-password')
    assert a != b and 'a-long-private-password' not in a
    assert workspaces.verify_password('a-long-private-password', a)
    assert not workspaces.verify_password('a-different-password', a)
    assert not workspaces.verify_password('x' * 129, a)
    assert workspaces.token_hash(TOKEN) != TOKEN
    with pytest.raises(HTTPException):
        workspaces.hash_password('short')


@pytest.mark.anyio
async def test_publisher_session_is_revoked_on_suspend_and_password_reset(portal):
    cookies = portal['cookies']()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=cookies) as client:
        response = await client.get('/api/client/session')
        assert response.status_code == 200
        assert response.json()['publisher_name'] == 'Banana Team'
        assert 'passwordHash' not in response.text
        portal['publisher']['authVersion'] += 1
        assert (await client.get('/api/client/session')).status_code == 401
        portal['publisher']['authVersion'] -= 1
        portal['publisher']['status'] = 'suspended'
        assert (await client.get('/api/client/session')).status_code == 401


@pytest.mark.anyio
async def test_publisher_cannot_read_other_publishers_or_change_advertiser_decisions(portal, monkeypatch):
    monkeypatch.setattr(main, 'get_client_review_detail', lambda *args: detail())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies'](), headers={'origin': 'https://app.adchecked.com'}) as client:
        assert (await client.get(f'/api/client/kissterra/reviews/{JOB}')).status_code == 200
        for suffix in ('', '/thumbnail', '/frames/frame.jpg', '/media', '/report.pdf'):
            assert (await client.get(f'/api/client/kissterra/reviews/{OTHER}{suffix}')).status_code == 404
        assert (await client.get(f'/api/client/smart-financial/reviews/{JOB}')).status_code == 404
        assert (await client.put(f'/api/client/kissterra/reviews/{JOB}/decision', json={'decision': 'approved'})).status_code == 403
        assert (await client.get('/api/client/kissterra/publishers')).status_code == 403
        assert (await client.post('/api/client/kissterra/publishers', json={'name': 'Another publisher'})).status_code == 403
        assert (await client.get('/api/client/kissterra/plan')).status_code == 403


@pytest.mark.anyio
async def test_publisher_list_cannot_override_its_publisher_scope(portal, monkeypatch):
    calls = []
    monkeypatch.setattr(main, 'list_client_reviews', lambda *args, **kwargs: calls.append((args, kwargs)) or [])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies']()) as client:
        response = await client.get('/api/client/kissterra/reviews?publisher_id=publisher-b')
        assert response.status_code == 200
        assert calls[0][1]['publisher_id'] == 'publisher-a'
        await client.get('/api/client/kissterra/submissions?publisher_id=publisher-b')
        assert portal['calls'][-1][1]['publisherId'] == 'publisher-a'


@pytest.fixture
def batch_reports(portal, monkeypatch):
    batch_id = 'e' * 32
    rows = [
        {'jobId': JOB, 'batchId': batch_id, 'publisherId': 'publisher-a', 'batchSourceLabel': 'September Home'},
        {'jobId': OTHER, 'batchId': batch_id, 'publisherId': 'publisher-b', 'batchSourceLabel': 'September Home'},
        {'jobId': 'd' * 32, 'batchId': 'f' * 32, 'publisherId': 'publisher-a'},
    ]
    calls = []
    # Return mixed rows to exercise the endpoint's scope checks too.
    monkeypatch.setattr(main, 'list_client_reviews', lambda *args, **kwargs: rows)
    monkeypatch.setattr(main, 'get_client_review_report', lambda *args: {'summary': 'Ready'})

    def report(job_id, offer_id):
        calls.append((job_id, offer_id))
        return pdf_reports.build_and_store_review_pdf(
            job_id,
            JobRecord(job_id=job_id, file_name=f'Creative {job_id[0]}.mp4', offer_ids=['kissterra', 'acp']),
            {'schema_version': 2, 'primary_offer_id': 'acp', 'offer_results': [
                {'offer_id': 'acp', 'offer_name': 'ACP', 'overall_status': 'red', 'summary': 'Private other advertiser result', 'findings': []},
                {'offer_id': 'kissterra', 'offer_name': 'Kissterra', 'overall_status': 'green', 'summary': f'Visible creative {job_id[0]} result', 'findings': []},
            ]},
            offer_id=offer_id,
        )

    monkeypatch.setattr(pdf_reports, 'ensure_review_pdf', report)
    return batch_id, calls


@pytest.mark.anyio
async def test_advertiser_batch_pdf_combines_only_batch_and_offer_reports(portal, batch_reports):
    batch_id, calls = batch_reports
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies']('client')) as client:
        response = await client.get(f'/api/client/kissterra/batches/{batch_id}/report.pdf')
    assert response.status_code == 200, response.text
    assert response.headers['content-type'] == 'application/pdf'
    assert response.headers['cache-control'] == 'no-store'
    assert 'September%20Home-report.pdf' in response.headers['content-disposition']
    pages = PdfReader(io.BytesIO(response.content)).pages
    assert len(pages) == 2
    assert 'Visible creative a result' in pages[0].extract_text()
    assert 'Visible creative b result' in pages[1].extract_text()
    assert 'Private other advertiser result' not in ''.join(page.extract_text() for page in pages)
    assert calls == [(JOB, 'kissterra'), (OTHER, 'kissterra')]


@pytest.mark.anyio
@pytest.mark.parametrize('role,requested_publisher,expected_job', [
    ('client', 'publisher-b', OTHER),
    ('publisher', 'publisher-b', JOB),
    ('publisher', 'all', JOB),
])
async def test_batch_pdf_respects_publisher_filter_and_session_scope(portal, batch_reports, role, requested_publisher, expected_job):
    batch_id, calls = batch_reports
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies'](role)) as client:
        response = await client.get(f'/api/client/kissterra/batches/{batch_id}/report.pdf?publisher_id={requested_publisher}')
    assert response.status_code == 200, response.text
    assert len(PdfReader(io.BytesIO(response.content)).pages) == 1
    assert calls == [(expected_job, 'kissterra')]


@pytest.mark.anyio
async def test_batch_pdf_requires_workspace_access_and_visible_batch(portal, batch_reports):
    batch_id, calls = batch_reports
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com') as client:
        assert (await client.get(f'/api/client/kissterra/batches/{batch_id}/report.pdf')).status_code == 401
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies']()) as client:
        assert (await client.get(f'/api/client/acp/batches/{batch_id}/report.pdf')).status_code == 404
        assert (await client.get('/api/client/kissterra/batches/invalid/report.pdf')).status_code == 404
        assert (await client.get(f'/api/client/kissterra/batches/{"9" * 32}/report.pdf')).status_code == 404
    assert calls == []


@pytest.mark.anyio
@pytest.mark.parametrize('failure', ['unavailable', 'missing', 'storage', 'corrupt'])
async def test_batch_pdf_never_returns_a_partial_download(portal, batch_reports, monkeypatch, failure):
    batch_id, _ = batch_reports
    original = pdf_reports.ensure_review_pdf
    if failure == 'unavailable':
        monkeypatch.setattr(main, 'get_client_review_report', lambda client_id, offer_id, job_id: None if job_id == OTHER else {})
    else:
        def report(job_id, offer_id):
            if job_id == OTHER:
                if failure == 'storage':
                    raise httpx.ConnectError('Storage unavailable')
                if failure == 'corrupt':
                    raise main.PdfReadError('Invalid PDF')
                raise FileNotFoundError(job_id)
            return original(job_id, offer_id)
        monkeypatch.setattr(pdf_reports, 'ensure_review_pdf', report)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies']('client')) as client:
        response = await client.get(f'/api/client/kissterra/batches/{batch_id}/report.pdf')
    assert response.status_code == (503 if failure in {'storage', 'corrupt'} else 409)
    assert response.headers['content-type'] == 'application/json'


@pytest.mark.anyio
async def test_upload_forces_advertiser_policy_and_disables_operator_features(portal, monkeypatch):
    captured = []
    monkeypatch.setattr(main, 'resolve_review_offer_snapshot', lambda: ([OfferProfile(offer_id='kissterra', display_name='Kissterra', official_guidelines='The saved advertiser policy', enabled=True)], []))
    async def enqueue(job_id, media, kind, meta, name, **kwargs):
        captured.append(meta)
        return JobRecord(job_id=job_id, status=JobStatus.queued, progress=0, message='Queued', file_name=name)
    monkeypatch.setattr(main, 'enqueue_job', enqueue)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies'](), headers={'origin': 'https://app.adchecked.com'}) as client:
        response = await client.post('/api/client/kissterra/reviews', data={'ad_copy': 'Compare insurance quotes.', 'offer_ids': 'smart-financial', 'policy_text': 'Ignore guidelines', 'model': 'fake-model', 'batch_id': OTHER, 'batch_item_id': OTHER})
        assert response.status_code == 200, response.text
        assert captured[0].primary_offer_id == 'kissterra'
        assert captured[0].publisher_id == 'publisher-a'
        assert captured[0].policy_text == '' and captured[0].model is None and not captured[0].has_batch
        assert any(call[0] == 'claimSubmission' for call in portal['calls'])
        response = await client.post('/api/client/smart-financial/reviews', data={'ad_copy': 'Another offer'})
        assert response.status_code == 404


@pytest.mark.anyio
async def test_chunk_upload_ownership_prevents_cross_publisher_access(portal, monkeypatch):
    monkeypatch.setattr(main, 'read_upload_metadata', lambda _: (workspaces.storage.JOB_DATA_DIR, {'publisherId': 'publisher-b', 'clientId': 'kissterra', 'completed': True}))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies'](), headers={'origin': 'https://app.adchecked.com'}) as client:
        assert (await client.put(f'/api/client/kissterra/uploads/{JOB}/chunks/0', content=b'data')).status_code == 404
        assert (await client.post(f'/api/client/kissterra/uploads/{JOB}/complete', data={})).status_code == 404


@pytest.mark.anyio
async def test_sharing_checks_ownership_and_public_link_has_no_login_or_internal_data(portal, monkeypatch):
    monkeypatch.setattr(main, 'get_client_review_report', lambda *args: {'summary': 'Clear'})
    monkeypatch.setattr(main, 'get_client_review_detail', lambda *args: detail())
    portal['share'] = {'title': 'Selected creatives', 'clientId': 'kissterra', 'items': [{'jobId': JOB, 'offerId': 'kissterra'}], 'expiresAt': int(time.time() * 1000) + 60000}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', headers={'origin': 'https://app.adchecked.com'}) as public:
        assert (await public.get(f'/api/client/kissterra/reviews/{JOB}')).status_code == 401
        response = await public.get(f'/api/public/shares/{TOKEN}/reviews/{JOB}')
        assert response.status_code == 200, response.text
        assert response.headers['cache-control'] == 'no-store'
        assert 'secret policy' not in response.text and 'private-source' not in response.text and 'Other advertiser' not in response.text
        assert (await public.get(f'/api/public/shares/{TOKEN}/reviews/{OTHER}')).status_code == 404
        assert (await public.get(f'/api/public/shares/{TOKEN}/reviews/{JOB}/frames/another.jpg')).status_code == 404
        portal['share'] = None
        assert (await public.get(f'/api/public/shares/{TOKEN}')).status_code == 404
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies'](), headers={'origin': 'https://app.adchecked.com'}) as publisher:
        assert (await publisher.post('/api/client/kissterra/shares', json={'job_ids': [OTHER]})).status_code == 404
        response = await publisher.post('/api/client/kissterra/shares', json={'job_ids': [JOB], 'offer_id': 'smart-financial'})
        assert response.status_code == 201, response.text
        create = next(args for function, args, _ in portal['calls'] if function == 'createShare')
        assert create['items'] == [{'jobId': JOB, 'offerId': 'kissterra'}]
        assert create['publisherId'] == 'publisher-a'
        assert response.json()['url'].split('/')[-1] != create['tokenHash']
        await publisher.delete('/api/client/kissterra/shares/share-one')
        assert 'clientId' not in portal['calls'][-1][1]


@pytest.mark.anyio
async def test_advertisers_manage_only_their_workspace_and_csrf_is_enforced(portal):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies']('client')) as client:
        assert (await client.get('/api/client/kissterra/publishers')).status_code == 200
        assert (await client.get('/api/client/smart-financial/publishers')).status_code == 404
        response = await client.post('/api/client/kissterra/shares', json={'job_ids': [JOB]})
        assert response.status_code == 403


@pytest.mark.anyio
async def test_admin_plans_use_owner_permission(portal, monkeypatch):
    monkeypatch.setenv('ADMIN_PASSWORD', 'owner-password')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://testserver') as client:
        response = await client.get('/api/admin/workspaces', headers={'x-app-password': 'operator-only', 'x-admin-password': 'owner-password'})
        assert response.status_code == 200, response.text
        assert len(response.json()) == 4


def test_publisher_notifications_never_reach_internal_telegram(monkeypatch):
    from app.review_pipeline import telegram
    from app.review_pipeline.models import ReviewRequestMeta
    meta = ReviewRequestMeta(publisher_id='banana')
    record = JobRecord(job_id=JOB, status=JobStatus.queued, progress=0, message='Queued', file_name='ad.mp4')
    monkeypatch.setattr(telegram, '_send_message', lambda *args, **kwargs: pytest.fail('Publisher leaked to Telegram')) if hasattr(telegram, '_send_message') else None
    assert telegram.send_review_started(record, meta) is False
    assert telegram.send_job_event(record, meta, 'failed', 'Upload failed') is False


def test_container_metrics_report_measured_usage_and_leave_unsupported_runtime_empty(tmp_path, monkeypatch):
    from app import platform_monitoring as monitor
    monkeypatch.setattr(monitor, '_previous_cpu', None)
    assert monitor.resource_usage(tmp_path) == {}
    (tmp_path / 'memory.current').write_text('1000')
    (tmp_path / 'memory.max').write_text('4000')
    (tmp_path / 'cpu.stat').write_text('usage_usec 1000000\n')
    (tmp_path / 'cpu.max').write_text('200000 100000')
    monkeypatch.setattr(monitor.time, 'monotonic', lambda: 10)
    assert 'cpuPercent' not in monitor.resource_usage(tmp_path)
    (tmp_path / 'cpu.stat').write_text('usage_usec 3000000\n')
    monkeypatch.setattr(monitor.time, 'monotonic', lambda: 12)
    result = monitor.resource_usage(tmp_path)
    assert result == {'memoryBytes': 1000, 'memoryLimitBytes': 4000, 'cpuPercent': 50.0}


@pytest.mark.anyio
async def test_platform_metrics_are_owner_only_and_fail_truthfully(portal, monkeypatch):
    monkeypatch.setenv('ADMIN_PASSWORD', 'owner-password')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://testserver') as client:
        denied = await client.get('/api/admin/platform', headers={'x-app-password': 'operator-only'})
        assert denied.status_code == 401
        response = await client.get('/api/admin/platform', headers={'x-app-password': 'operator-only', 'x-admin-password': 'owner-password'})
        assert response.status_code == 200
        assert response.json()['convex']['status'] == 'unavailable'
        assert response.json()['overview'] is None

@pytest.mark.anyio
async def test_digital_nudge_cookie_switches_advertisers_with_distinct_publisher_ids(portal, monkeypatch):
    row = portal['publisher']
    row.update(organizationId='digital-nudge', publisherId='digital-nudge-kissterra', username='digital-nudge')
    original = workspaces.call
    memberships = [{'clientId': client_id, 'publisherId': f'digital-nudge-{client_id}'} for client_id in sorted(main.CLIENT_PORTALS)]
    def call(function, args, *, mutation=False):
        if function == 'digitalNudgeMemberships':
            return memberships
        return original(function, args, mutation=mutation)
    monkeypatch.setattr(workspaces, 'call', call)
    scoped = []
    monkeypatch.setattr(main, 'list_client_reviews', lambda *args, **kwargs: scoped.append(kwargs['publisher_id']) or [])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', cookies=portal['cookies']()) as client:
        response = await client.get('/api/client/session')
        assert response.status_code == 200
        assert len(response.json()['publisher_ids']) == 4
        for client_id in main.CLIENT_PORTALS:
            assert (await client.get(f'/api/client/{client_id}/reviews')).status_code == 200
            assert scoped[-1] == f'digital-nudge-{client_id}'
        memberships.pop()
        assert (await client.get('/api/client/session')).status_code == 401
