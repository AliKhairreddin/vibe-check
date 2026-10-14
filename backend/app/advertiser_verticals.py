"""Advertiser-selected verticals and immutable per-submission policy snapshots."""
import hashlib

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .advertiser_guidelines import GuidelineRule, own_offer
from .review_pipeline import storage
from .review_pipeline.models import OfferProfile, OfferOutcome


def call(function, args, mutation=False):
    if not storage.convex_enabled():
        raise HTTPException(503, 'Vertical settings are temporarily unavailable.')
    try:
        return storage._convex_call('mutation' if mutation else 'query', f'verticals:{function}', args)
    except Exception as exc:
        for public in ['Vertical changed since you opened it. Reload before saving.', 'A workspace supports up to 120 saved verticals.',
                       'Add vertical guidelines or select the default policy before activating.', 'The combined vertical guidelines and rules are too large.', 'Enable and save the default policy before including it.']:
            if public in str(exc):
                raise HTTPException(409, public) from None
        raise HTTPException(503, 'Could not load or save vertical settings. Please retry.') from None


class VerticalInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=2, max_length=100)
    enabled: bool
    include_default: bool
    official_guidelines: str = Field(max_length=200_000)
    internal_overrides: list[GuidelineRule] = Field(max_length=100)
    expected_version: int = Field(ge=0)

    @model_validator(mode='after')
    def validate_policy(self):
        if self.enabled and not self.include_default and not self.official_guidelines.strip():
            raise ValueError('Add guidelines or include the default policy before activating.')
        ids = [r.override_id for r in self.internal_overrides]
        if len(ids) != len(set(ids)) or any(not r.title.strip() or not r.guidance.strip() for r in self.internal_overrides):
            raise ValueError('Each rule needs a unique ID, a title, and guidance.')
        return self


def review_snapshot(context, vertical):
    if not vertical:
        raise HTTPException(400, 'Choose the vertical for these creatives.')
    result = call('reviewPolicy', {**{k: context[k] for k in ('clientId', 'offerId')}, 'verticalId': vertical})
    selected, base = result.get('policy'), result.get('base')
    if not selected or not selected['enabled']:
        raise HTTPException(409, 'This vertical is not active. Choose an active vertical or contact your advertiser.')
    if not base:
        raise HTTPException(409, 'The advertiser has not configured guidelines yet.')
    include = selected['includeDefault']
    if include and (not base['enabled'] or not base['official_guidelines'].strip()):
        raise HTTPException(409, 'The default policy is paused or empty. Contact your advertiser.')
    specific = selected['officialGuidelines'].strip()
    rules = [{'override_id': r['overrideId'], **{k: v for k, v in r.items() if k != 'overrideId'}} for r in selected['internalOverrides']]
    custom = bool(specific or rules or not include)
    if custom:
        texts = ([base['official_guidelines']] if include else []) + ([f"Vertical guidelines: {selected['name']}\n{specific}"] if specific else [])
        text = '\n\n'.join(texts)
        if not text or len(text) > 200_000:
            raise HTTPException(409, 'The combined policy is empty or too long. Ask your advertiser to adjust the guidelines.')
        # Prefix scoped rule IDs, keeping default and vertical exceptions distinct.
        combined = (base['internal_overrides'] if include else []) + [{**r, 'override_id': 'vertical-' + hashlib.sha256(r['override_id'].encode()).hexdigest()[:32]} for r in rules]
        base = {**base, 'official_guidelines': text, 'internal_overrides': combined, 'enabled': True, 'is_default': False}
    profile = OfferProfile.model_validate(base)
    context['verticalId'] = vertical
    return ([profile], [OfferOutcome(offer_id=profile.offer_id, offer_name=profile.display_name, evaluation_state='evaluated')]), selected if custom else None


def register(app):
    @app.get('/api/client/{client_id}/verticals')
    def list_verticals(client_id: str, request: Request):
        from .main import authenticate_client, client_portal
        session = authenticate_client(request)
        if client_id not in session['portal_ids']:
            raise HTTPException(404, 'Workspace not found.')
        client_portal(client_id)
        return call('list', {'clientId': client_id, 'publisher': session['role'] == 'publisher'})

    @app.put('/api/client/{client_id}/verticals/{vertical_id}')
    def save_vertical(client_id: str, vertical_id: str, payload: VerticalInput, request: Request):
        from .main import parse_review_vertical
        offer_id = own_offer(request, client_id)
        parse_review_vertical(vertical_id)
        return call('save', {'clientId': client_id, 'offerId': offer_id, 'verticalId': vertical_id, 'name': payload.name,
            'enabled': payload.enabled, 'includeDefault': payload.include_default, 'officialGuidelines': payload.official_guidelines,
            'internalOverrides': [{'overrideId': r.override_id, 'title': r.title, 'guidance': r.guidance, 'rationale': r.rationale, 'enabled': r.enabled} for r in payload.internal_overrides],
            'expectedVersion': payload.expected_version}, mutation=True)
