"""Advertisers manage only the policy attached to their signed-in workspace."""
from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .review_pipeline import storage
from .review_pipeline.models import OfferOverride, OfferProfile


class GuidelineRule(OfferOverride):
    model_config = ConfigDict(extra='forbid')
    override_id: str = Field(pattern=r'^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$')


class GuidelinesInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    official_guidelines: str = Field(max_length=200_000)
    internal_overrides: list[GuidelineRule] = Field(max_length=100)
    enabled: bool
    expected_version: int = Field(ge=1)

    @model_validator(mode='after')
    def valid_policy(self):
        if self.enabled and not self.official_guidelines.strip():
            raise ValueError('Add official guidelines before enabling reviews.')
        ids = [rule.override_id for rule in self.internal_overrides]
        if len(ids) != len(set(ids)):
            raise ValueError('Each internal rule must have a unique ID.')
        if any(not rule.title.strip() or not rule.guidance.strip() for rule in self.internal_overrides):
            raise ValueError('Each internal rule needs a title and guidance.')
        return self


def policy_call(kind, function, args):
    if not storage.convex_enabled():
        raise HTTPException(503, 'Guideline storage is temporarily unavailable.')
    try:
        result = storage._convex_call(kind, f'offers:{function}', args)
    except Exception as exc:
        message = str(exc)
        if 'Guidelines changed since you opened them.' in message:
            raise HTTPException(409, 'Guidelines changed since you opened them. Your edits are still here. Copy them before loading the latest saved version.') from None
        if 'Offer profile not found.' in message:
            raise HTTPException(404, 'Guidelines are unavailable for this workspace.') from None
        if 'UTF-8 bytes; reduce guideline or override text' in message:
            raise HTTPException(422, 'The combined guidelines and rules are too large. Shorten them before saving.') from None
        raise HTTPException(503, 'Could not load or save guidelines. Please retry.') from None
    if result is None:
        raise HTTPException(404, 'Guidelines are unavailable for this workspace.')
    return result


def own_offer(request: Request, client_id: str):
    from .main import authenticate_client, client_portal
    session = authenticate_client(request)
    # Check membership before resolving any other customer's profile. Policy setup
    # is available before subscribing, but never to publishers or public links.
    if client_id not in session['portal_ids']:
        raise HTTPException(404, 'Workspace not found.')
    if session['role'] != 'client':
        raise HTTPException(403, 'Only the advertiser can manage guidelines.')
    return client_portal(client_id)['offer_id']


def register(app):
    @app.get('/api/client/{client_id}/guidelines', response_model=OfferProfile)
    def get_guidelines(client_id: str, request: Request):
        return policy_call('query', 'get', {'offerId': own_offer(request, client_id)})

    @app.put('/api/client/{client_id}/guidelines', response_model=OfferProfile)
    def save_guidelines(client_id: str, payload: GuidelinesInput, request: Request):
        offer_id = own_offer(request, client_id)
        return policy_call('mutation', 'saveGuidelines', {
            'offerId': offer_id,
            'officialGuidelines': payload.official_guidelines,
            'internalOverrides': [{
                'overrideId': rule.override_id, 'title': rule.title,
                'guidance': rule.guidance, 'rationale': rule.rationale, 'enabled': rule.enabled,
            } for rule in payload.internal_overrides],
            'enabled': payload.enabled, 'expectedVersion': payload.expected_version,
        })
