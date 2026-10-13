import importlib
import time

import httpx
import pytest

from app import billing, workspaces
main = importlib.import_module('app.main')


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
def accounts(monkeypatch):
    monkeypatch.setenv('SESSION_SECRET', 'billing-session-test')
    monkeypatch.setenv('KISSTERRA_CLIENT_PASSWORD', 'legacy-password')
    row = {'clientId': 'new-advertiser', 'name': 'New advertiser', 'category': 'Advertising',
           'username': 'advertiser.new-advertiser', 'status': 'active', 'authVersion': 1,
           'passwordHash': workspaces.hash_password('new-advertiser-password')}
    state = {'row': row, 'allowed': False, 'calls': []}

    def call(module, function, args, kind='query'):
        state['calls'].append((module, function, args, kind))
        if module == 'advertiserAccounts' and function == 'get':
            return row if args.get('clientId') == row['clientId'] or args.get('username') == row['username'] or args.get('inviteHash') == row.get('inviteHash', '-') else None
        if module == 'advertiserAccounts' and function == 'acceptInvite':
            assert args['inviteHash'] == row['inviteHash']
            row.update(status='active', passwordHash=args['passwordHash'], authVersion=row['authVersion'] + 1)
            row.pop('inviteHash')
            return row
        if module == 'billing' and function == 'status':
            return {'allowed': state['allowed'], 'accessMode': 'subscription', 'status': 'active' if state['allowed'] else 'none'}
        if module == 'stripeBilling':
            return {'url': 'https://checkout.stripe.com/owned-session'}
        if module == 'billing' and function == 'requestSync':
            return None
        raise AssertionError((module, function))

    monkeypatch.setattr(billing, 'call', call)
    return state


@pytest.mark.anyio
async def test_new_login_cannot_bypass_payment_and_billing_is_scoped(accounts):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', headers={'origin': 'https://app.adchecked.com'}) as client:
        assert (await client.get('/api/client/new-advertiser/billing')).status_code == 401
        login = await client.post('/api/client/session', json={'username': accounts['row']['username'], 'password': 'new-advertiser-password'})
        assert login.status_code == 200
        assert login.json()['portals'][0]['billing_required'] is True
        assert (await client.get('/api/client/new-advertiser/check')).status_code == 402
        assert (await client.get('/api/client/new-advertiser/billing')).status_code == 200
        assert (await client.post('/api/client/new-advertiser/billing/checkout', json={'plan': 'starter', 'interval': 'month', 'customer_id': 'cus_foreign'})).status_code == 200
        assert accounts['calls'][-1] == ('stripeBilling', 'checkout', {'clientId': 'new-advertiser', 'plan': 'starter', 'interval': 'month'}, 'action')
        assert (await client.post('/api/client/kissterra/billing/checkout', json={'plan': 'starter', 'interval': 'month'})).status_code == 404
        assert (await client.post('/api/client/new-advertiser/billing/checkout', json={'plan': 'free', 'interval': 'month'})).status_code == 422
        assert (await client.post('/api/client/new-advertiser/billing/checkout', json={'plan': 'starter', 'interval': 'month'}, headers={'origin': 'https://attacker.example'})).status_code == 403
        accounts['allowed'] = True
        assert (await client.get('/api/client/new-advertiser/check')).status_code == 200
        accounts['allowed'] = False
        assert (await client.get('/api/client/new-advertiser/reviews')).status_code == 402
        accounts['row']['authVersion'] += 1
        assert (await client.get('/api/client/session')).status_code == 401


@pytest.mark.anyio
async def test_existing_login_has_no_billing_dependency(accounts, monkeypatch):
    monkeypatch.setattr(billing, 'call', lambda *args, **kwargs: pytest.fail('Legacy access depends on billing'))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', headers={'origin': 'https://app.adchecked.com'}) as client:
        login = await client.post('/api/client/session', json={'username': 'kissterra', 'password': 'legacy-password'})
        assert login.status_code == 200
        assert not login.json()['portals'][0].get('billing_required')
        assert (await client.get('/api/client/kissterra/check')).status_code == 200


@pytest.mark.anyio
async def test_advertiser_invite_creates_login_without_paid_access(accounts):
    token = 'c' * 43
    accounts['row'].update(status='invited', inviteHash=workspaces.token_hash(token), inviteExpiresAt=time.time() * 1000 + 60000)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', headers={'origin': 'https://app.adchecked.com'}) as client:
        response = await client.get(f'/api/client/advertiser-invitations/{token}')
        assert response.status_code == 200
        assert 'passwordHash' not in response.text and 'inviteHash' not in response.text
        response = await client.post('/api/client/advertiser-invitations/accept', json={'token': token, 'password': 'a-new-private-password'})
        assert response.status_code == 200
        assert workspaces.verify_password('a-new-private-password', accounts['row']['passwordHash'])
        assert (await client.get('/api/client/new-advertiser/check')).status_code == 402
        assert (await client.get(f'/api/client/advertiser-invitations/{token}')).status_code == 404


@pytest.mark.anyio
async def test_publishers_cannot_manage_billing(accounts, monkeypatch):
    monkeypatch.setattr(main, 'authenticate_client', lambda request: {'role': 'publisher', 'portal_ids': ['new-advertiser'], 'username': 'pub'})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='https://app.adchecked.com', headers={'origin': 'https://app.adchecked.com'}) as client:
        for endpoint, payload in [('checkout', {'plan': 'starter', 'interval': 'month'}), ('portal', {}), ('refresh', {})]:
            assert (await client.post(f'/api/client/new-advertiser/billing/{endpoint}', json=payload)).status_code == 403
        assert (await client.get('/api/client/new-advertiser/billing')).status_code == 200
