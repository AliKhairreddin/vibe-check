import importlib
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from app import billing, workspaces, signup

main = importlib.import_module('app.main')

@pytest.fixture
def anyio_backend():
    return 'asyncio'

@pytest.fixture
def provision(monkeypatch):
    monkeypatch.setenv('SESSION_SECRET', 'signup-session-secret')
    monkeypatch.setenv('CONVEX_HTTP_SECRET', 'signup-gateway-secret')
    state = {'rows': [], 'profiles': {}, 'calls': [], 'admit': True}
    def call(module, function, args, kind='query'):
        state['calls'].append((module, function, args))
        if (module, function) == ('signup', 'admit'):
            return state['admit']
        if (module, function) == ('signup', 'create'):
            if any(row['username'] == args['email'] for row in state['rows']):
                raise HTTPException(409, 'This email is already in use. Sign in instead.')
            row = {'clientId': args['clientId'], 'name': args['name'], 'category': 'Advertising', 'username': args['email'], 'passwordHash': args['passwordHash'], 'authVersion': 1, 'status': 'active', 'selfServe': True}
            state['rows'].append(row)
            state['profiles'][args['clientId']] = {'official_guidelines': '', 'enabled': False, 'internal_overrides': []}
            return row
        if (module, function) == ('advertiserAccounts', 'get'):
            return next((row for row in state['rows'] if any(row.get(k) == val for k, val in args.items())), None)
        if (module, function) == ('offers', 'get'):
            return state['profiles'][args['offerId']]
        if (module, function) == ('billing', 'status'):
            return {'allowed': False}
        raise AssertionError((module, function))
    def save(client_id, payload):
        assert payload.is_default is False
        state['profiles'][client_id] = payload.model_dump()
        return SimpleNamespace(**payload.model_dump())
    monkeypatch.setattr(billing, 'call', call)
    monkeypatch.setattr(signup.storage, 'upsert_offer_profile', save)
    return state

HEADERS = {'origin': 'https://app.adchecked.com', 'x-signup-gateway': 'signup-gateway-secret', 'x-signup-ip': 'a' * 64}
DETAILS = {'workspace_name': '  My real team  ', 'email': 'Person@Company.example', 'password': 'a-real-unique-password'}

def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', headers=HEADERS)

@pytest.mark.anyio
async def test_signup_signs_in_clean_workspace_and_existing_login_works(provision):
    async with client() as browser:
        browser.cookies.set('__Host-adchecked_demo', 'demo-capability-must-never-be-adopted')
        result = await browser.post('/api/client/signup', json=DETAILS)
        assert result.status_code == 201, result.text
        data = result.json()
        assert data['username'] == 'person@company.example'
        assert data['role'] == 'client'
        assert len(data['portals']) == 1
        portal = data['portals'][0]
        assert portal['display_name'] == 'My real team'
        assert portal['client_id'].startswith('workspace-')
        assert portal['self_serve'] and portal['billing_required']
        assert all(word not in result.text for word in ['passwordHash', DETAILS['password'], 'credential_fingerprint'])
        assert 'HttpOnly' in result.headers['set-cookie'] and 'Secure' in result.headers['set-cookie']
        assert 'SameSite=strict' in result.headers['set-cookie']
        assert workspaces.verify_password(DETAILS['password'], provision['rows'][0]['passwordHash'])
        assert (await browser.get('/api/client/session')).json() == data
        own = portal['client_id']
        assert (await browser.get(f'/api/client/{own}/setup')).json() == {'name': 'My real team', 'official_guidelines': '', 'configured': False}
        assert (await browser.get(f'/api/client/{own}/reviews')).status_code == 402
        assert (await browser.post('/api/client/signup', json=DETAILS)).status_code == 409
        assert len(provision['rows']) == 1
        assert (await browser.delete('/api/client/session')).status_code == 200
        assert (await browser.get(f'/api/client/{own}/setup')).status_code == 401
        login = await browser.post('/api/client/session', json={'username': 'PERSON@COMPANY.EXAMPLE', 'password': DETAILS['password']})
        assert login.status_code == 200 and login.json() == data
        assert all(module != 'demo' for module, _, _ in provision['calls'])

@pytest.mark.anyio
async def test_signup_setup_is_scoped_to_each_signed_in_advertiser(provision, monkeypatch):
    async with client() as first, client() as second:
        first_id = (await first.post('/api/client/signup', json=DETAILS)).json()['portals'][0]['client_id']
        second_id = (await second.post('/api/client/signup', json={**DETAILS, 'email': 'two@company.example'})).json()['portals'][0]['client_id']
        assert first_id != second_id
        for foreign in [first_id, 'kissterra']:
            assert (await second.get(f'/api/client/{foreign}/setup')).status_code == 404
            assert (await second.put(f'/api/client/{foreign}/setup', json={'official_guidelines': 'forged'})).status_code == 404
        saved = await first.put(f'/api/client/{first_id}/setup', json={'official_guidelines': '  Require an accurate disclosure.  '})
        assert saved.status_code == 200 and saved.json()['configured'] is True
        assert (await first.get(f'/api/client/{first_id}/setup')).json()['official_guidelines'] == 'Require an accurate disclosure.'
        assert (await second.get(f'/api/client/{second_id}/setup')).json()['official_guidelines'] == ''
        assert (await first.put(f'/api/client/{first_id}/setup', json={'official_guidelines': '', 'client_id': second_id})).status_code == 422
        assert (await first.put(f'/api/client/{first_id}/setup', json={'official_guidelines': 'foreign'}, headers={'origin': 'https://evil.example'})).status_code == 403
        monkeypatch.setattr(main, 'authenticate_client', lambda request: {'role': 'publisher', 'portal_ids': [first_id], 'username': 'pub'})
        assert (await first.get(f'/api/client/{first_id}/setup')).status_code == 403
        assert (await first.put(f'/api/client/{first_id}/setup', json={'official_guidelines': 'forged'})).status_code == 403

@pytest.mark.anyio
async def test_signup_rejects_gateway_spoofing_csrf_invalid_fields_and_rate_limit_before_hashing(provision, monkeypatch):
    monkeypatch.setattr(workspaces, 'hash_password', lambda _: pytest.fail('Rejected signup performed expensive hashing'))
    async with client() as browser:
        assert (await browser.post('/api/client/signup', json=DETAILS, headers={'x-signup-gateway': 'forged'})).status_code == 403
        assert (await browser.post('/api/client/signup', json=DETAILS, headers={'origin': 'https://evil.example'})).status_code == 403
        for change in [{'role': 'admin'}, {'client_id': 'kissterra'}, {'demo_id': 'demo'}, {'email': 'not-email'}, {'password': 'short'}, {'workspace_name': ' ' * 5}]:
            assert (await browser.post('/api/client/signup', json={**DETAILS, **change})).status_code == 422
        provision['admit'] = False
        limited = await browser.post('/api/client/signup', json=DETAILS)
        assert limited.status_code == 429 and limited.headers['retry-after'] == '3600'
        assert provision['rows'] == []

@pytest.mark.anyio
async def test_duplicate_email_does_not_create_second_workspace(provision):
    async with client() as first, client() as second:
        assert (await first.post('/api/client/signup', json=DETAILS)).status_code == 201
        result = await second.post('/api/client/signup', json={**DETAILS, 'email': DETAILS['email'].upper()})
        assert result.status_code == 409
        assert len(provision['rows']) == 1
        assert (await second.get('/api/client/session')).status_code == 401
