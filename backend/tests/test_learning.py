import asyncio
import time

import pytest

from app.review_pipeline import learning
from app.review_pipeline.models import ComplianceReport, OfferProfile


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def row(i, decision='approved', text=None):
    evidence = {'media_type': 'copy_only', 'submitted_ad_copy': {'present': True, 'text': text or f'Creative {i} unique phrase alpha{i} beta{i} gamma{i} delta{i}'}}
    return dict(id=f'd{i}@{i}', jobId=f'job{i}', decidedAt=i, createdAt=i, decision=decision,
        evidence=evidence, fingerprint=learning.fingerprint(evidence), evidenceComplete=True,
        feedbackReason='partner_preference', feedbackNote='This interpretation applies to similar creatives.',
        feedbackScope='similar_creatives')


def profile():
    return OfferProfile(offer_id='acp', display_name='ACP', official_guidelines='Claims must have a readable disclaimer.', version=2)


def lesson():
    return dict(key='lesson', title='Read the disclaimer', guidance='Consider the visible qualifying disclaimer.',
        appliesWhen='Savings claim with a visible disclaimer', excludes='Missing or illegible disclaimer', terms=['savings', 'disclaimer'],
        supportingDecisionIds=[f'd{i}@{i}' for i in range(8)], contradictingDecisionIds=[], support=8, contradictions=0, lowerBound=learning.wilson_lower(8, 8))


def report(status):
    return ComplianceReport(overall_status=status, summary='Review summary.', findings=[] if status == 'green' else [{
        'severity': 'high' if status == 'red' else 'medium', 'source': 'ad_copy', 'evidence': 'Savings claim',
        'policy_reason': 'Needs a visible disclaimer.', 'suggested_fix': 'Add a disclaimer.', 'confidence': 'high',
    }])


def test_unexplained_business_and_one_off_decisions_cannot_teach_rules():
    assert learning.eligible(row(1))
    for change in [{'feedbackNote': ''}, {'feedbackReason': 'business_decision'}, {'feedbackReason': 'one_off_exception'},
                   {'feedbackScope': 'this_creative'}, {'feedbackScope': None}, {'evidenceComplete': False}]:
        assert not learning.eligible({**row(1), **change})


def test_duplicate_and_conflicting_families_do_not_inflate_confidence():
    original = row(1)
    duplicate = {**original, 'id': 'copy', 'jobId': 'copy', 'decidedAt': 2}
    assert len(learning.deduplicate([original, duplicate])) == 1
    assert not learning.deduplicate([original, {**duplicate, 'decision': 'disapproved'}])
    text = ' '.join(f'word{i}' for i in range(30))
    assert len(learning.deduplicate([row(1, text=text), row(2, text=text + ' extra')])) == 1
    assert len(learning.deduplicate([row(i) for i in range(14)])) == 14


def test_wilson_bound_requires_independent_support():
    assert learning.wilson_lower(1, 1) < .65
    assert learning.wilson_lower(8, 8) > .65
    assert learning.wilson_lower(8, 10) < .65
    assert learning.wilson_lower(0, 0) == 0


@pytest.mark.anyio
async def test_learning_failures_preserve_the_normal_result(monkeypatch):
    baseline = report('green')
    async def failure(*args, **kwargs):
        raise RuntimeError('provider unavailable')
    monkeypatch.setattr(learning, 'guarded_review', failure)
    result, keys = await learning.apply_learning(row(1)['evidence'], profile(), baseline, {'lessons': [lesson()]}, None)
    assert result is baseline and keys == []
    monkeypatch.setattr(learning, '_call', failure)
    assert await learning.review_context('acp', 2) == {}


@pytest.mark.anyio
async def test_severe_results_cannot_be_downgraded_by_learning(monkeypatch):
    baseline = report('red')
    monkeypatch.setattr(learning, 'enforce_consequence_based_red', lambda *_: None)
    async def forbidden(*args, **kwargs):
        pytest.fail('A severe baseline must not be re-reviewed using learned preferences.')
    monkeypatch.setattr(learning, 'review_with_openrouter', forbidden)
    assert (await learning.guarded_review({}, profile(), [lesson()], baseline))[0] is baseline


@pytest.mark.anyio
async def test_semantic_guard_rejects_policy_conflicts_and_unknown_lessons(monkeypatch):
    baseline = report('yellow')
    async def proposed(*args, **kwargs):
        return report('green')
    monkeypatch.setattr(learning, 'review_with_openrouter', proposed)
    for safe, keys in [(False, ['lesson']), (True, ['invented']), (True, [])]:
        async def audit(*args, **kwargs):
            return learning.Application(safe=safe, applicable_keys=keys, explanation='Audit')
        monkeypatch.setattr(learning, 'structured', audit)
        result, applied = await learning.guarded_review({}, profile(), [lesson()], baseline)
        assert result is baseline and applied == []


@pytest.mark.anyio
async def test_replay_only_scores_outputs_and_does_not_send_decisions_to_reviewer(monkeypatch):
    cases = [row(1, 'approved'), row(2, 'disapproved')]
    async def fake(evidence, _profile, lessons, baseline=None, model=None):
        assert 'decision' not in evidence and 'feedbackNote' not in evidence
        return report('green' if lessons else 'yellow'), ['lesson']
    monkeypatch.setattr(learning, 'guarded_review', fake)
    metrics = await learning.evaluate(cases, profile(), [], lesson())
    assert metrics['improved'] == 1 and metrics['regressions'] == 1


@pytest.mark.anyio
async def test_snapshot_failure_and_truncation_do_not_fail_reviews(monkeypatch):
    saved = []
    async def capture(kind, path, args):
        saved.append(args)
    monkeypatch.setattr(learning, '_call', capture)
    await learning.persist_evidence('job', profile(), {'media_type': 'copy_only', 'submitted_ad_copy': {'text': 'a' * 100000}, 'policy_text': 'secret policy'}, 3)
    assert saved[0]['complete'] is False
    assert 'policy_text' not in saved[0]['evidence']
    await learning.persist_evidence('job2', profile(), {**row(1)['evidence'], 'additional_policy_present': True}, 3)
    assert saved[1]['complete'] is False


@pytest.mark.anyio
@pytest.mark.parametrize('status,complete', [('partial', False), ('unavailable', False), ('complete', True), ('not_applicable', True)])
async def test_incomplete_ocr_cannot_validate_automatic_learning(monkeypatch, status, complete):
    saved = []
    async def capture(kind, path, args):
        saved.append(args)
    monkeypatch.setattr(learning, '_call', capture)
    await learning.persist_evidence('job', profile(), {
        'media_type': 'image', 'ocr_coverage': {'status': status}, 'onscreen_text_ocr': []}, 3)
    assert saved[0]['complete'] is complete
    assert saved[0]['evidence']['ocr_coverage']['status'] == status


@pytest.mark.anyio
async def test_insufficient_feedback_finishes_without_llm_calls(monkeypatch):
    saved = []
    async def call(kind, path, args):
        if path == 'learning:dataset':
            return dict(profile=dict(offerId='acp', displayName='ACP', officialGuidelines='Policy', enabled=True, version=2, internalOverrides=[]),
                rows=[row(i) for i in range(5)], current=None, lastRun=None, state={'suppressedKeys': []}, shadows=[])
        saved.append((path, args))
        return True
    async def forbidden(*_):
        pytest.fail('Too little evidence should not consume model calls.')
    monkeypatch.setattr(learning, '_call', call)
    monkeypatch.setattr(learning, 'structured', forbidden)
    assert await learning.process_claim(dict(offerId='acp', token='token', generation=1))
    assert saved[0][1]['lessons'] == []


@pytest.mark.anyio
async def test_successful_historical_replay_waits_for_future_decisions(monkeypatch):
    rows = [row(i) for i in range(14)]
    data = dict(profile=dict(offerId='acp', displayName='ACP', officialGuidelines='Policy', enabled=True, version=2, internalOverrides=[]),
        rows=rows, current=None, lastRun=None, state={'suppressedKeys': []}, shadows=[])
    saved = []
    async def call(kind, path, args):
        if path == 'learning:dataset': return data
        saved.append(args)
        return True
    async def structured(instruction, payload, schema):
        # The six latest decisions must never be exposed to discovery.
        assert not any(x['id'] in {r['id'] for r in rows[8:]} for x in payload['examples'])
        if schema is learning.Proposal:
            return learning.Proposal(lesson=learning.Draft(title='Specific distinction', guidance='Accept this only under the stated conditions.', applies_when='Specific conditions', excludes='Explicit restrictions', terms=['specific', 'conditions']), explanation='Pattern found')
        return learning.Assessment(compatible=True, category='clarification', supporting_ids=[r['id'] for r in rows[:8]], contradicting_ids=[], explanation='Compatible')
    async def evaluate(cases, *_):
        assert [x['id'] for x in cases] == [x['id'] for x in rows[8:]]
        return {**learning.METRICS, 'validation': 6, 'improved': 2}
    monkeypatch.setattr(learning, '_call', call)
    monkeypatch.setattr(learning, 'structured', structured)
    monkeypatch.setattr(learning, 'evaluate', evaluate)
    await learning.process_claim(dict(offerId='acp', token='t', generation=1))
    assert saved[-1]['lessons'] == []
    assert saved[-1]['candidates'][0]['status'] == 'shadow'


@pytest.mark.anyio
async def test_shadow_publication_requires_new_unrelated_creatives(monkeypatch):
    training = [row(i) for i in range(8)]
    future = [row(i) for i in range(100, 103)]
    candidate = dict(lesson=lesson(), status='shadow', reason='Waiting', metrics={**learning.METRICS, 'validation': 6, 'improved': 2})
    data = dict(lastRun={'_id': 'run', 'createdAt': 50}, rows=[*training, *future], shadows=[])
    async def fake(evidence, _profile, lessons, baseline=None, model=None):
        return report('green' if lessons else 'yellow'), []
    async def call(*_): pass
    monkeypatch.setattr(learning, 'guarded_review', fake)
    monkeypatch.setattr(learning, '_call', call)
    result = await learning.assess_shadow(data, candidate, profile(), [], [*training, *future])
    assert result['status'] == 'published' and result['metrics']['shadow'] == 3
    # A fresh review that repeats discovery evidence is not an independent test.
    future[0]['evidence'] = training[0]['evidence']
    future[0]['fingerprint'] = training[0]['fingerprint']
    result = await learning.assess_shadow(data, candidate, profile(), [], [*training, *future])
    assert result['status'] == 'shadow' and result['metrics']['shadow'] == 2


@pytest.mark.anyio
async def test_learning_dashboard_is_internal_and_employee_controls_are_forbidden(monkeypatch):
    import httpx
    from app import main
    monkeypatch.setenv('ADMIN_PASSWORD', 'test-owner-password')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setattr(main.learning, 'dashboard', lambda *_: {'available': True, 'versions': []})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
        assert (await client.get('/api/learning/acp')).status_code == 401
        monkeypatch.setattr(main, 'require_admin', lambda _: {'role': 'employee'})
        response = await client.get('/api/learning/acp')
        assert response.status_code == 200 and response.json()['canManage'] is False
        for action in ['pause', 'resume', 'retry', 'restore', 'disable']:
            response = await client.post('/api/learning/acp/control', json={'action': action, 'expected_version': 0})
            assert response.status_code == 403
