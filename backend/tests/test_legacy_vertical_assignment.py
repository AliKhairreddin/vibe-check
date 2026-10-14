import copy
import importlib.util
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.review_pipeline import jobs, storage
from app.review_pipeline.models import ComplianceReport, OfferProfile, ReviewRequestMeta
from app.review_pipeline.policy_seeds import seeded_offer_inputs
from app.review_pipeline.vertical_policy import select_review_policies

spec = importlib.util.spec_from_file_location('assign_verticals', Path(__file__).parents[2] / 'scripts/assign-legacy-verticals.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def policies():
    return [migration.partition(client, {**seeded_offer_inputs()[client].model_dump(), 'version': 5}) for client in migration.SOURCE_HASHES]


def frozen_profile(plan):
    return OfferProfile(offer_id=plan['clientId'], display_name=plan['clientId'], version=6,
        official_guidelines=plan['sharedGuidelines'], internal_overrides=snake_rules(plan['sharedOverrides']),
        vertical_policies=[{'vertical_id': p['verticalId'], 'name': p['verticalId'], 'enabled': p['enabled'],
            'include_default': True, 'official_guidelines': p['officialGuidelines'], 'version': 1,
            'internal_overrides': snake_rules(p['internalOverrides'])} for p in plan['verticals']])


def snake_rules(rules):
    return [{('override_id' if k == 'overrideId' else k): v for k, v in r.items()} for r in rules]


def policy_text(profile):
    return profile.official_guidelines + '\n' + '\n'.join(r.guidance for r in profile.internal_overrides)


def test_reviewed_sources_partition_auto_and_home_without_changing_severity():
    for plan in policies():
        base = frozen_profile(plan)
        meta = ReviewRequestMeta(offer_profiles=[base])
        auto = select_review_policies(meta, 'AUTO creative.png').offer_profiles[0]
        home = select_review_policies(meta, 'HOME creative.png').offer_profiles[0]
        auto_text, home_text = policy_text(auto), policy_text(home)
        assert 'car-crash' in auto_text and 'house-fire' not in auto_text
        assert 'house-fire' in home_text and 'car-crash' not in home_text
        assert 'driving record' not in home_text and 'DUIs' not in home_text
        assert '$19' not in home_text and '$89' not in home_text and '$39' not in home_text
        assert '$29' not in home_text and '$25' not in home_text
        assert home.vertical_policy_version == auto.vertical_policy_version == 1
        assert home.vertical_policies is None and auto.vertical_policies is None
        severity = next(r for r in plan['expectedOverrides'] if r['overrideId'] == 'refund-rebate-and-enforcement')
        assert next(r.guidance for r in home.internal_overrides if r.override_id == severity['overrideId']) == severity['guidance']
        assert next(r.guidance for r in auto.internal_overrides if r.override_id == severity['overrideId']) == severity['guidance']
        if plan['clientId'] == 'smart-financial':
            assert 'Home rate floor is $31/month' in home_text and '$50/month' in home_text
            assert 'Auto rate floor is $39/month' in auto_text and '$31' not in auto_text
            assert all(not p['enabled'] for p in plan['verticals'] if p['verticalId'] not in {'auto-insurance', 'home-insurance'})
        else:
            assert '$31' not in home_text
            assert 'does not specify a Home rate floor' in home_text
            assert ('$19/month' if plan['clientId'] == 'kissterra' else '$31/month') in auto_text
        if plan['clientId'] == 'kissterra':
            assert 'Average expenditure $89/month' in auto_text


def test_migration_refuses_changed_source():
    source = {**seeded_offer_inputs()['kissterra'].model_dump(), 'version': 5}
    source['official_guidelines'] += '\nNew advertiser rule.'
    with pytest.raises(AssertionError, match='Unreviewed source'):
        migration.partition('kissterra', source)


def test_catalog_snapshot_is_atomic_and_stays_frozen_for_retry(monkeypatch):
    profile = frozen_profile(policies()[0])
    monkeypatch.setattr(storage, 'list_offer_profiles', lambda **kw: [profile.model_copy(update={'vertical_policies': None})])
    monkeypatch.setattr(storage, 'convex_enabled', lambda: True)
    response = [profile.model_dump()]
    def query(kind, path, args):
        assert path == 'verticals:reviewCatalog' and args['offerIds'] == ['lead-economy']
        return response
    monkeypatch.setattr(storage, '_convex_call', query)
    profiles, outcomes = storage.resolve_review_offer_snapshot()
    meta = ReviewRequestMeta(offer_profiles=profiles, offer_outcomes=outcomes)
    serialized = meta.model_dump_json()
    response[0]['vertical_policies'][1]['official_guidelines'] = 'Unrelated later change'
    selected = select_review_policies(ReviewRequestMeta.model_validate_json(serialized), 'HOME.png')
    assert 'Unrelated later change' not in policy_text(selected.offer_profiles[0])
    assert select_review_policies(selected, 'AUTO.png') is selected
    assert selected.vertical == 'home-insurance'


def test_missing_or_disabled_vertical_does_not_fall_back_to_default_or_auto():
    profile = frozen_profile(policies()[2])
    meta = ReviewRequestMeta(offer_profiles=[profile], vertical='life-insurance')
    with pytest.raises(HTTPException, match='No active advertiser guidelines'):
        select_review_policies(meta, 'AUTO.png')
    meta.vertical = 'solar'
    with pytest.raises(HTTPException, match='No active advertiser guidelines'):
        select_review_policies(meta, 'AUTO.png')
    # Legacy historical snapshots have no policy bundle and stay unchanged.
    old = ReviewRequestMeta(offer_profiles=[OfferProfile(offer_id='kissterra', display_name='Kissterra', official_guidelines='Historical policy')])
    assert select_review_policies(old, 'HOME.png') is old


@pytest.mark.anyio
async def test_internal_multi_offer_evidence_contains_only_home_and_never_default_learning(monkeypatch):
    meta = select_review_policies(ReviewRequestMeta(ad_copy='Compare Home insurance', offer_profiles=[frozen_profile(p) for p in policies()]), 'HOME.png')
    seen = []
    async def review(evidence, model):
        seen.append(copy.deepcopy(evidence))
        return ComplianceReport(overall_status='green', summary='No issue')
    async def no_learning(*args, **kwargs):
        pytest.fail('Legacy Auto learning cannot be applied to a scoped policy')
    monkeypatch.setattr(jobs, 'review_with_openrouter', review)
    monkeypatch.setattr(jobs.learning, 'review_context', no_learning)
    monkeypatch.setattr(jobs.learning, 'apply_learning', no_learning)
    for profile in meta.offer_profiles:
        result = await jobs._review_offer(profile, 'copy_only', meta, {}, [], [], None, '')
        assert result.vertical_policy_version == 1 and result.learning_version == 0
    assert len(seen) == 3
    for evidence in seen:
        assert evidence['offer']['vertical'] == 'home-insurance'
        text = json.dumps(evidence)
        assert 'Average expenditure' not in text and '$19' not in text and '$39' not in text
        assert 'car-crash' not in text


@pytest.mark.anyio
async def test_queue_persists_only_selected_policy_before_scheduling(monkeypatch, tmp_path):
    import asyncio
    from app.review_pipeline import queue
    from app.review_pipeline.models import JobRecord
    captured = []
    async def persist(job_id, media, kind, meta, *args):
        captured.append(meta.model_dump(mode='json'))
    monkeypatch.setattr(queue, 'persist_job_payload', persist)
    monkeypatch.setattr(queue, 'job_dir', lambda _: tmp_path)
    monkeypatch.setattr(queue, 'set_status', lambda *a, **kw: JobRecord(job_id='scoped', vertical=kw['vertical']))
    monkeypatch.setattr(queue, 'send_review_started', lambda *a: None)
    monkeypatch.setattr(queue, '_queue', asyncio.Queue())
    meta = ReviewRequestMeta(ad_copy='Home quotes', offer_profiles=[frozen_profile(p) for p in policies()], vertical='home-insurance')
    await queue.enqueue_job('scoped', None, 'copy_only', meta, 'AUTO.png')
    queued = queue._queue.get_nowait()
    queue._queue.task_done()
    assert queued.meta.vertical == 'home-insurance'
    assert all(p.vertical_policies is None for p in queued.meta.offer_profiles)
    assert '$39' not in json.dumps(captured) and '$89' not in json.dumps(captured)
    assert json.loads((tmp_path / 'request.json').read_text()) == captured[0]
