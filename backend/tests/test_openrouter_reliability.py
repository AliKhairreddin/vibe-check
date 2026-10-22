import asyncio
import json
from email.utils import formatdate
from unittest.mock import AsyncMock

import httpx
import pytest

from app.review_pipeline import llm


def completed_response():
    return {'choices': [{'message': {'content': json.dumps({
        'overall_status': 'green',
        'summary': 'No policy issues were identified.',
        'source_results': {'creative': None, 'ad_copy': None},
        'findings': [], 'applied_overrides': [],
        'safe_rewrite': {'ad_copy': '', 'onscreen_text': []},
        'limitations': [],
    })}, 'finish_reason': 'stop'}]}


def use_transport(monkeypatch, handler):
    client_class = httpx.AsyncClient
    monkeypatch.setattr(llm.httpx, 'AsyncClient', lambda **kwargs: client_class(
        transport=httpx.MockTransport(handler), **kwargs,
    ))
    monkeypatch.setenv('OPENROUTER_API_KEY', 'test-key')
    monkeypatch.setenv('OPENROUTER_RETRY_BASE_SECONDS', '0')
    monkeypatch.setenv('OPENROUTER_MAX_ATTEMPTS', '3')


@pytest.mark.anyio
async def test_slow_provider_can_finish_on_longer_recovery_attempt(monkeypatch):
    calls = []

    async def provider(request):
        calls.append(json.loads(request.content))
        await asyncio.sleep(0.06)
        return httpx.Response(200, json=completed_response())

    use_transport(monkeypatch, provider)
    monkeypatch.setattr(llm, '_request_deadline_seconds', lambda: 0.04)

    report = await llm.review_with_openrouter({'offer': {'offer_id': 'acp'}}, 'selected-model')

    assert report.overall_status == 'green'
    assert len(calls) == 2
    assert [call['model'] for call in calls] == ['selected-model', 'selected-model']
    assert calls[1]['provider']['sort'] == 'latency'
    assert calls[1]['provider']['zdr'] is True
    assert calls[1]['provider']['data_collection'] == 'deny'
    assert calls[1]['response_format'] == calls[0]['response_format']


@pytest.mark.anyio
async def test_repeated_timeouts_have_bounded_increasing_deadlines(monkeypatch):
    deadlines = []
    original_timeout = asyncio.timeout

    def timeout(delay):
        deadlines.append(delay)
        return original_timeout(delay)

    async def provider(request):
        raise httpx.ReadTimeout('No completed response', request=request)

    use_transport(monkeypatch, provider)
    monkeypatch.setenv('OPENROUTER_REQUEST_TIMEOUT_SECONDS', '180')
    monkeypatch.setenv('OPENROUTER_MAX_ATTEMPTS', '5')
    monkeypatch.setattr(llm.asyncio, 'timeout', timeout)

    with pytest.raises(llm.ComplianceResponseError, match='failed after 5 automatic attempts'):
        await llm.review_with_openrouter({})
    assert deadlines == [180, 360, 600, 600, 600]


@pytest.mark.anyio
@pytest.mark.parametrize('failed_response', [
    {'choices': [{'message': {'content': None}}]},
    {'choices': [{'message': {'content': '  '}}]},
    {'choices': []},
    {'error': {'code': 503, 'message': 'Private provider diagnostic'}},
    {'choices': [{'error': {'code': 502}, 'finish_reason': 'error',
                  'message': {'content': completed_response()['choices'][0]['message']['content']}}]},
    {'choices': [{'finish_reason': 'length', 'message': {
        'content': completed_response()['choices'][0]['message']['content'],
    }}]},
    {'choices': [{'finish_reason': 'content_filter', 'message': {
        'content': completed_response()['choices'][0]['message']['content'],
    }}]},
    {'choices': [{'message': 'invalid'}]},
    ['invalid envelope'],
])
async def test_incomplete_provider_response_never_becomes_a_verdict(monkeypatch, failed_response):
    calls = []

    def provider(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json=failed_response)

    use_transport(monkeypatch, provider)
    with pytest.raises(llm.ComplianceResponseError, match='failed after 3 automatic attempts') as error:
        await llm.review_with_openrouter({})
    assert 'Private provider diagnostic' not in str(error.value)
    assert len(calls) == 3
    # Empty/interrupted output is a provider failure, not a schema correction.
    assert all(len(call['messages']) == 2 for call in calls)


@pytest.mark.anyio
async def test_empty_response_recovers_without_appending_empty_assistant_message(monkeypatch):
    calls = []

    def provider(request):
        calls.append(json.loads(request.content))
        data = {'choices': [{'message': {'content': None}}]} if len(calls) == 1 else completed_response()
        return httpx.Response(200, json=data)

    use_transport(monkeypatch, provider)
    report = await llm.review_with_openrouter({})
    assert report.overall_status == 'green'
    assert len(calls) == 2
    assert calls[0]['messages'] == calls[1]['messages']


@pytest.mark.anyio
@pytest.mark.parametrize('embedded', [False, True])
@pytest.mark.parametrize('use_date', [False, True])
async def test_rate_limit_retry_respects_provider_retry_after(monkeypatch, embedded, use_date):
    calls = []
    sleeps = AsyncMock()
    monkeypatch.setattr(llm.time, 'time', lambda: 1_700_000_000)
    retry_after = formatdate(1_700_000_007, usegmt=True) if use_date else '7'

    def provider(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200 if embedded else 429,
                                  json={'error': {'code': 429}},
                                  headers={'retry-after': retry_after})
        return httpx.Response(200, json=completed_response())

    use_transport(monkeypatch, provider)
    monkeypatch.setattr(llm.asyncio, 'sleep', sleeps)
    assert (await llm.review_with_openrouter({})).overall_status == 'green'
    sleeps.assert_awaited_once_with(7.0)


@pytest.mark.anyio
async def test_long_provider_cooldown_stops_instead_of_retrying_early(monkeypatch):
    calls = []

    def provider(request):
        calls.append(request)
        return httpx.Response(429, headers={'retry-after': '900'})

    use_transport(monkeypatch, provider)
    with pytest.raises(llm.ComplianceResponseError, match='Retry this review later'):
        await llm.review_with_openrouter({})
    assert len(calls) == 1


@pytest.mark.anyio
async def test_embedded_auth_error_is_actionable_without_repeated_calls(monkeypatch):
    calls = []

    def provider(request):
        calls.append(request)
        return httpx.Response(200, json={
            'id': 'gen-123', 'provider': 'provider-1',
            'error': {'code': 401, 'message': 'Private account details'},
        })

    use_transport(monkeypatch, provider)
    with pytest.raises(llm.ProviderResponseError, match='HTTP 401') as error:
        await llm.review_with_openrouter({})
    assert 'generation=gen-123' in str(error.value)
    assert 'provider=provider-1' in str(error.value)
    assert 'Private account details' not in str(error.value)
    assert len(calls) == 1
