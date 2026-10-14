"""Compose only the selected vertical from a frozen policy snapshot."""
import hashlib

from fastapi import HTTPException

from .models import OfferProfile, OfferVerticalPolicy, OfferOutcome, ReviewRequestMeta
from .verticals import classify_review_vertical


def compose_policy(base: OfferProfile, selected: OfferVerticalPolicy) -> OfferProfile:
    if not selected.enabled:
        raise HTTPException(409, 'This vertical is not active. Choose an active vertical or contact your advertiser.')
    if selected.include_default and (not base.enabled or not base.official_guidelines.strip()):
        raise HTTPException(409, 'The default policy is paused or empty. Contact your advertiser.')
    specific = selected.official_guidelines.strip()
    scoped = bool(specific or selected.internal_overrides or not selected.include_default or selected.version)
    if not scoped:
        return base.model_copy(update={'vertical_policies': None}, deep=True)
    text = '\n\n'.join(([base.official_guidelines] if selected.include_default else []) +
                       ([f'Vertical guidelines: {selected.name}\n{specific}'] if specific else []))
    if not text or len(text) > 200_000:
        raise HTTPException(409, 'The combined policy is empty or too long. Ask your advertiser to adjust the guidelines.')
    rules = [r.model_copy(deep=True) for r in base.internal_overrides] if selected.include_default else []
    ids = {r.override_id for r in rules}
    for rule in selected.internal_overrides:
        # Preserve stable rule IDs (including enforcement precedence); namespace
        # only actual collisions with shared rules.
        identifier = 'vertical-' + hashlib.sha256(rule.override_id.encode()).hexdigest()[:32] if rule.override_id in ids else rule.override_id
        rules.append(rule.model_copy(update={'override_id': identifier}, deep=True))
        ids.add(identifier)
    return base.model_copy(update={
        'official_guidelines': text, 'internal_overrides': rules, 'enabled': True, 'is_default': False,
        'vertical_policies': None, 'vertical_policy_version': selected.version,
        'vertical_policy_name': selected.name, 'vertical_uses_default': selected.include_default,
    }, deep=True)


def select_review_policies(meta: ReviewRequestMeta, file_name: str) -> ReviewRequestMeta:
    """No I/O: retries and durable partner batches retain submission-time rules."""
    if not any(p.vertical_policies is not None for p in meta.offer_profiles):
        return meta
    vertical = meta.vertical or classify_review_vertical(file_name)
    profiles = []
    outcomes = {o.offer_id: o.model_copy(deep=True) for o in meta.offer_outcomes}
    for profile in meta.offer_profiles:
        if profile.vertical_policies is None:
            profiles.append(profile)
            continue
        selected = next((p for p in profile.vertical_policies if p.vertical_id == vertical), None)
        if selected is None or not selected.enabled:
            outcomes[profile.offer_id] = OfferOutcome(offer_id=profile.offer_id, offer_name=profile.display_name,
                evaluation_state='disabled', message=f'No active guidelines for {vertical}.')
            continue
        profiles.append(compose_policy(profile, selected))
    if not profiles:
        raise HTTPException(409, f'No active advertiser guidelines for {vertical}.')
    return meta.model_copy(update={'vertical': vertical, 'offer_profiles': profiles, 'offer_outcomes': list(outcomes.values())}, deep=True)
