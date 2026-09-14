"""Compose released batch emails behind the existing browser-session boundary.

Delivery runs in the Cloudflare Worker after this API authorizes the sender.
Previewing never sends mail; Convex atomically claims each explicit send once.
"""
from __future__ import annotations

import secrets
import uuid

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator

from .review_pipeline import storage
from .workspaces import release_scope


def call(function: str, args: dict, *, mutation: bool = False):
    if not storage.convex_enabled():
        raise HTTPException(503, 'Email storage is unavailable. Please retry later.')
    try:
        return storage._convex_call('mutation' if mutation else 'query', f'releaseEmails:{function}', args)
    except RuntimeError as exc:
        for message in ('Release every completed creative in each selected batch to this advertiser first',
                        'Select between 1 and 10 distinct released batches', 'Email unavailable',
                        'Enter valid email addresses and a reply-to address (up to 50 recipients)',
                        'Enter a subject and message within the allowed lengths'):
            if message in str(exc):
                raise HTTPException(409, message) from None
        raise HTTPException(503, 'Could not prepare the email. Please retry.') from None
    except Exception:
        raise HTTPException(503, 'Email storage is temporarily unavailable.') from None


class BatchLinkInput(BaseModel):
    batch_id: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=120)


class EmailInput(BaseModel):
    email_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    offer_id: str = Field(min_length=1, max_length=100)
    batches: list[BatchLinkInput] = Field(min_length=1, max_length=10)
    to: list[str] = Field(min_length=1, max_length=50)
    cc: list[str] = Field(default_factory=list, max_length=49)
    reply_to: str = Field(min_length=3, max_length=254)
    subject: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=10000)
    signature: str = Field(default='', max_length=1000)

    @field_validator('to', 'cc')
    @classmethod
    def normalize_recipients(cls, addresses: list[str]):
        import re
        normalized = list(dict.fromkeys(address.strip().lower() for address in addresses))
        if any(len(address) > 254 or not re.fullmatch(r'[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+', address) for address in normalized):
            raise ValueError('Use email addresses separated by commas, without display names.')
        return normalized

    @model_validator(mode='after')
    def validate_content(self):
        self.reply_to = self.normalize_recipients([self.reply_to])[0]
        self.cc = [address for address in self.cc if address not in self.to]
        if len(self.to) + len(self.cc) > 50:
            raise ValueError('An email can have up to 50 recipients.')
        if not self.subject.strip() or '\r' in self.subject or '\n' in self.subject or not self.message.strip():
            raise ValueError('Enter a subject and message. The subject must be one line.')
        if len({batch.batch_id for batch in self.batches}) != len(self.batches) or any(not batch.label.strip() for batch in self.batches):
            raise ValueError('Select distinct batches and give each link a label.')
        return self


class SendInput(BaseModel):
    confirmed: bool = False


def register(app):
    def scope_for(request, client_id=None, offer_id=None):
        from .main import client_portal
        scope = release_scope(request, client_id)
        if offer_id:
            client_portal(offer_id)
            if client_id and offer_id != client_id:
                raise HTTPException(404, 'Advertiser unavailable.')
        return scope

    @app.get('/api/release-emails/options')
    @app.get('/api/client/{client_id}/release-emails/options')
    def options(request: Request, client_id: str | None = None):
        from .main import CLIENT_PORTALS
        scope_for(request, client_id)
        return {'advertisers': [{'id': key, 'name': value['display_name']} for key, value in CLIENT_PORTALS.items() if not client_id or key == client_id],
                'sender': '', 'sending_enabled': False}

    @app.get('/api/release-emails/batches')
    @app.get('/api/client/{client_id}/release-emails/batches')
    def batches(request: Request, offer_id: str, cursor: str | None = None, initial_batch_id: str | None = None, client_id: str | None = None,
                initial_batch_ids: list[str] | None = Query(default=None, max_length=10)):
        scope = scope_for(request, client_id, offer_id)
        selected = list(dict.fromkeys(([initial_batch_id] if initial_batch_id else []) + (initial_batch_ids or [])))
        if len(selected) > 10 or any(not batch_id or len(batch_id) > 100 for batch_id in selected):
            raise HTTPException(422, 'Select up to 10 valid batch IDs.')
        return call('batches', {**scope, 'offerId': offer_id, 'cursor': cursor, **({'initialBatchIds': selected} if selected else {})})

    @app.get('/api/release-emails/recent')
    @app.get('/api/client/{client_id}/release-emails/recent')
    def recent(request: Request, offer_id: str, client_id: str | None = None):
        return call('recent', {**scope_for(request, client_id, offer_id), 'offerId': offer_id})

    @app.post('/api/release-emails/preview')
    @app.post('/api/client/{client_id}/release-emails/preview')
    def preview(payload: EmailInput, request: Request, client_id: str | None = None):
        scope = scope_for(request, client_id, payload.offer_id)
        return call('prepare', {**scope, 'emailId': payload.email_id, 'offerId': payload.offer_id, 'to': payload.to, 'cc': payload.cc,
                               'replyTo': payload.reply_to, 'subject': payload.subject, 'message': payload.message, 'signature': payload.signature,
                               'batches': [{'batchId': batch.batch_id, 'label': batch.label, 'shareId': uuid.uuid4().hex, 'token': secrets.token_urlsafe(32)} for batch in payload.batches]}, mutation=True)

    @app.post('/api/release-emails/{email_id}/send')
    @app.post('/api/client/{client_id}/release-emails/{email_id}/send')
    def authorize_send(email_id: str, payload: SendInput, request: Request, client_id: str | None = None):
        scope = scope_for(request, client_id)
        if not payload.confirmed:
            raise HTTPException(409, 'Review the email and confirm sending first.')
        if not storage.CONVEX_HTTP_SECRET or not secrets.compare_digest(request.headers.get('x-release-email-transport', ''), storage.CONVEX_HTTP_SECRET):
            raise HTTPException(503, 'Email delivery is available through the deployed Adchecked app.')
        owner = f"publisher:{scope['publisherId']}" if scope.get('publisherId') else 'admin'
        return {'email_id': email_id, 'owner_key': owner}
