import asyncio
import json
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from app.review_pipeline import jobs, storage


@pytest.fixture
def convex_transport(monkeypatch):
    monkeypatch.setattr(storage, 'CONVEX_URL', 'https://convex.test')
    monkeypatch.setattr(storage, 'CONVEX_HTTP_SECRET', 'test-secret')
    monkeypatch.setattr(storage, '_convex_client', None)
    monkeypatch.setattr(storage.time, 'sleep', lambda _: None)
    yield
    storage.close_convex_client()


def test_convex_reuses_http_connection_and_preserves_request_payload(convex_transport, monkeypatch):
    requests = []
    connections = set()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def do_POST(self):
            connections.add(self.client_address)
            requests.append((self.path, json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
            body = b'{"status":"success","value":{"ready":true}}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(storage, 'CONVEX_URL', f'http://127.0.0.1:{server.server_port}')
    try:
        for _ in range(2):
            assert storage._convex_call('query', 'reviews:getStatus', {'jobId': 'job'}) == {'ready': True}
        assert len(connections) == 1
        assert requests == [('/api/query', {
            'path': 'reviews:getStatus', 'args': {'jobId': 'job', 'secret': 'test-secret'}, 'format': 'json',
        })] * 2
    finally:
        storage.close_convex_client()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize('status,expected_calls', [(503, 4), (429, 4), (400, 1), (401, 1)])
def test_convex_transport_preserves_http_retry_policy(convex_transport, monkeypatch, status, expected_calls):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(status, json={'error': 'test failure'})

    monkeypatch.setattr(storage, '_convex_client', httpx.Client(transport=httpx.MockTransport(respond)))
    with pytest.raises(urllib.error.HTTPError) as error:
        storage._convex_call_with_retry('mutation', 'reviews:upsertStatus', {'jobId': 'job'})
    assert error.value.code == status
    assert len(calls) == expected_calls


def test_convex_transport_recovers_network_failure_without_losing_lease(convex_transport, monkeypatch):
    payloads = []

    def respond(request):
        payloads.append(json.loads(request.content))
        if len(payloads) == 1:
            raise httpx.ReadTimeout('timeout', request=request)
        return httpx.Response(200, json={'status': 'success', 'value': 'saved'})

    monkeypatch.setattr(storage, '_convex_client', httpx.Client(transport=httpx.MockTransport(respond)))
    token = storage.api_job_lease.set('active-lease')
    try:
        assert storage._convex_call_with_retry('mutation', 'reviews:setReport', {'jobId': 'job'}) == 'saved'
    finally:
        storage.api_job_lease.reset(token)
    assert len(payloads) == 2
    assert all(row['args']['apiLeaseId'] == 'active-lease' for row in payloads)


def test_convex_function_errors_are_not_retried(convex_transport, monkeypatch):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={'status': 'error', 'errorMessage': 'Invalid review'})

    monkeypatch.setattr(storage, '_convex_client', httpx.Client(transport=httpx.MockTransport(respond)))
    with pytest.raises(RuntimeError, match='Invalid review'):
        storage._convex_call_with_retry('mutation', 'reviews:upsertStatus', {})
    assert len(calls) == 1


def test_review_status_write_keeps_event_loop_responsive_and_lease_context(monkeypatch):
    async def run():
        started = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()

        def slow_status(*args, **kwargs):
            assert storage.api_job_lease.get() == 'worker-lease'
            loop.call_soon_threadsafe(started.set)
            assert release.wait(2), 'The event loop was blocked by a status write'
            return {'status': 'saved'}

        monkeypatch.setattr(jobs, 'set_status', slow_status)

        async def other_review():
            await asyncio.wait_for(started.wait(), 1)
            release.set()

        token = storage.api_job_lease.set('worker-lease')
        try:
            result, _ = await asyncio.gather(jobs._set_status('job', progress=50), other_review())
            assert result == {'status': 'saved'}
        finally:
            storage.api_job_lease.reset(token)

    asyncio.run(run())
