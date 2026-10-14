"""Advertisers manage only the policy attached to their signed-in workspace."""
import asyncio
from threading import BoundedSemaphore

from fastapi import HTTPException, Request
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartParser, MultiPartException

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .guideline_import import MAX_FILE_BYTES, extract_guidelines
from .guideline_organizer import OrganizeInput, organize_guidelines
from .review_pipeline import storage
from .review_pipeline.models import OfferOverride, OfferProfile


_import_capacity = BoundedSemaphore(2)
_organize_capacity = BoundedSemaphore(2)


class UploadTooLarge(MultiPartException):
    pass


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
    @app.post('/api/client/{client_id}/guidelines/import')
    async def import_guidelines(client_id: str, request: Request):
        own_offer(request, client_id)
        if not _import_capacity.acquire(blocking=False):
            raise HTTPException(429, 'Document imports are busy. Please retry shortly.', headers={'Retry-After': '10'})
        try:
            async def bounded_stream():
                size = 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_FILE_BYTES + 64 * 1024:
                        raise UploadTooLarge('Upload a file of 10 MB or less.')
                    yield chunk
            parser = MultiPartParser(request.headers, bounded_stream(), max_files=1, max_fields=0)
            try:
                form = await parser.parse()
                try:
                    upload = form.get('file')
                    if not isinstance(upload, UploadFile):
                        raise HTTPException(400, 'Choose a guidelines file to import.')
                    data = await upload.read(MAX_FILE_BYTES + 1)
                    return await asyncio.to_thread(extract_guidelines, upload.filename or '', data)
                finally:
                    await form.close()
            except UploadTooLarge:
                raise HTTPException(413, 'Upload a file of 10 MB or less.') from None
            except MultiPartException:
                raise HTTPException(400, 'Upload one guidelines file at a time.') from None
        finally:
            _import_capacity.release()

    @app.post('/api/client/{client_id}/guidelines/organize')
    async def organize(client_id: str, payload: OrganizeInput, request: Request):
        own_offer(request, client_id)
        if not _organize_capacity.acquire(blocking=False):
            raise HTTPException(429, 'Text organization is busy. Please retry shortly.', headers={'Retry-After': '10'})
        try:
            return await organize_guidelines(payload.text)
        finally:
            _organize_capacity.release()

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
