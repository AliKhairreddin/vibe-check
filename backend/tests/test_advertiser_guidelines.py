import copy

import pytest
from app import advertiser_guidelines
from test_signup import provision, anyio_backend, client, DETAILS, main


@pytest.fixture
def policies(provision, monkeypatch):
    calls = []
    def invoke(kind, function, args):
        calls.append((kind, function, args))
        profile = provision['profiles'].get(args['offerId'])
        if profile is None:
            return None
        profile = {'offer_id': args['offerId'], 'display_name': 'My real team', 'version': 1,
                   'is_default': False, 'created_at': 1, 'updated_at': 1, **profile}
        if function == 'offers:saveGuidelines':
            if profile['version'] != args['expectedVersion']:
                raise RuntimeError('Guidelines changed since you opened them.')
            profile.update(official_guidelines=args['officialGuidelines'].strip(), enabled=args['enabled'], version=profile['version'] + 1,
                           internal_overrides=[{'override_id': r['overrideId'], **{k: v for k, v in r.items() if k != 'overrideId'}} for r in args['internalOverrides']])
            provision['profiles'][args['offerId']] = profile
        return profile
    monkeypatch.setattr(advertiser_guidelines.storage, 'convex_enabled', lambda: True)
    monkeypatch.setattr(advertiser_guidelines.storage, '_convex_call', invoke)
    return calls


INPUT = {'official_guidelines': 'Require a disclosure.', 'internal_overrides': [
    {'override_id': 'approved-claim', 'title': 'Approved claim', 'guidance': 'Allow only the qualified claim.', 'rationale': '', 'enabled': True}],
    'enabled': True, 'expected_version': 1}


@pytest.mark.anyio
async def test_signed_advertisers_edit_only_their_own_policy_before_payment(provision, policies, monkeypatch):
    async with client() as first, client() as second:
        own = (await first.post('/api/client/signup', json=DETAILS)).json()['portals'][0]['client_id']
        other = (await second.post('/api/client/signup', json={**DETAILS, 'email': 'other@example.com'})).json()['portals'][0]['client_id']
        path = f'/api/client/{own}/guidelines'
        assert (await first.get(path)).status_code == 200
        for foreign in [other, 'kissterra']:
            before = len(policies)
            assert (await first.get(f'/api/client/{foreign}/guidelines')).status_code == 404
            assert (await first.put(f'/api/client/{foreign}/guidelines', json=INPUT)).status_code == 404
            assert len(policies) == before
        saved = await first.put(path, json=INPUT)
        assert saved.status_code == 200, saved.text
        assert saved.json()['internal_overrides'] == INPUT['internal_overrides']
        assert provision['profiles'][other]['official_guidelines'] == ''
        assert (await first.put(path, json=INPUT)).status_code == 409
        assert (await first.get(path)).json()['version'] == 2
        for extra in ['offer_id', 'client_id', 'is_default', 'display_name', 'accessMode']:
            assert (await first.put(path, json={**INPUT, extra: other})).status_code == 422
        assert (await first.put(path, json=INPUT, headers={'origin': 'https://evil.example'})).status_code == 403
        monkeypatch.setattr(main, 'authenticate_client', lambda _: {'role': 'publisher', 'portal_ids': [own]})
        before = len(policies)
        assert (await first.get(path)).status_code == 403
        assert (await first.put(path, json=INPUT)).status_code == 403
        assert len(policies) == before


@pytest.mark.anyio
async def test_legacy_advertisers_and_storage_failures(provision, policies, monkeypatch):
    monkeypatch.setenv('KISSTERRA_CLIENT_PASSWORD', 'legacy-password')
    provision['profiles']['kissterra'] = {'official_guidelines': 'Original', 'enabled': True, 'internal_overrides': []}
    async with client() as browser:
        path = '/api/client/kissterra/guidelines'
        assert (await browser.get(path)).status_code == 401
        assert (await browser.post('/api/client/session', json={'username': 'kissterra', 'password': 'legacy-password'})).status_code == 200
        saved = await browser.put(path, json={**INPUT, 'official_guidelines': 'a' * 13000})
        assert saved.status_code == 200
        assert len(saved.json()['official_guidelines']) == 13000
        before = copy.deepcopy(provision['profiles'])
        monkeypatch.setattr(advertiser_guidelines.storage, 'convex_enabled', lambda: False)
        assert (await browser.put(path, json={**INPUT, 'expected_version': 2})).status_code == 503
        assert provision['profiles'] == before
