"""Stripe ownership is resolved from signed sessions, never browser customer IDs."""
from __future__ import annotations

import re
import secrets
import time
from typing import Literal

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import workspaces
from .review_pipeline import storage


def call(module: str, function: str, args: dict, kind: str = 'query'):
    if not storage.convex_enabled():
        raise HTTPException(503, 'Billing storage is temporarily unavailable.')
    try:
        return storage._convex_call(kind, f'{module}:{function}', args)
    except Exception as exc:
        for message in (
            'This email is already in use. Sign in instead.',
            'Workspace already exists or is invalid', 'Configure an enabled offer and its guidelines first',
            'Invitation expired or already used', 'Username already exists',
            'This workspace does not need a subscription.', 'Live billing is not available yet. Contact AdChecked.',
            'Manage your existing subscription instead of starting another.',
            'Checkout is being prepared. Please retry in a moment.',
            'Finish your open checkout or wait 35 minutes before choosing another plan.',
            'Checkout has finished. Refresh billing status before trying again.',
            'Contact AdChecked to arrange this plan.',
        ):
            if message in str(exc):
                raise HTTPException(409, message) from None
        raise HTTPException(503, 'Billing is temporarily unavailable. Please retry or contact AdChecked.') from None


def account(**args) -> dict | None:
    return call('advertiserAccounts', 'get', args)


def advertiser_session(row: dict) -> dict:
    return {'role': 'client', 'username': row['username'], 'portal_ids': [row['clientId']]}


def authenticate(username: str, password: str) -> dict | None:
    if not username.startswith('advertiser.') and '@' not in username:
        return None
    row = account(username=username.lower())
    if row and row['status'] == 'active' and workspaces.verify_password(password, row.get('passwordHash', '')):
        return advertiser_session(row)
    return None


def fingerprint(session: dict) -> str:
    from .main import credential_fingerprint
    ids = session.get('portal_ids', [])
    if len(ids) != 1:
        return ''
    row = account(clientId=ids[0])
    if not row or row['status'] != 'active' or row['username'] != session.get('username'):
        return ''
    return credential_fingerprint(row['username'], str(row['authVersion']))


def authorize(request: Request, client_id: str, *, manager: bool = False):
    from .main import authenticate_client
    session = authenticate_client(request)
    if client_id not in session['portal_ids']:
        raise HTTPException(404, 'Workspace not found.')
    if manager and session['role'] == 'publisher':
        raise HTTPException(403, 'Only the advertiser can manage billing.')
    return session


def require_access(client_id: str):
    from .main import CLIENT_PORTALS
    if client_id in CLIENT_PORTALS:  # Explicit frozen legacy cohort, not a missing-row fallback.
        return
    state = call('billing', 'status', {'clientId': client_id})
    if not state['allowed']:
        raise HTTPException(402, 'An active paid subscription is required for this workspace.')


class CheckoutInput(BaseModel):
    plan: Literal['starter', 'growth']
    interval: Literal['month', 'year']


class AdvertiserInput(BaseModel):
    client_id: str = Field(pattern=r'^[a-z0-9][a-z0-9_-]{0,79}$')
    category: str = Field(default='Advertising', min_length=1, max_length=100)


def register(app):
    @app.get('/api/client/{client_id}/billing')
    def status(client_id: str, request: Request):
        authorize(request, client_id)
        return call('billing', 'status', {'clientId': client_id})

    @app.post('/api/client/{client_id}/billing/checkout')
    def checkout(client_id: str, payload: CheckoutInput, request: Request):
        authorize(request, client_id, manager=True)
        return call('stripeBilling', 'checkout', {'clientId': client_id, **payload.model_dump()}, 'action')

    @app.post('/api/client/{client_id}/billing/portal')
    def portal(client_id: str, request: Request):
        authorize(request, client_id, manager=True)
        return call('stripeBilling', 'portal', {'clientId': client_id}, 'action')

    @app.post('/api/client/{client_id}/billing/refresh')
    def refresh(client_id: str, request: Request):
        authorize(request, client_id, manager=True)
        call('billing', 'requestSync', {'clientId': client_id}, 'mutation')
        return {'pending': True}

    @app.post('/api/admin/advertiser-workspaces', status_code=201)
    def create_workspace(payload: AdvertiserInput, request: Request):
        from .main import require_settings_admin
        require_settings_admin(request)
        token = secrets.token_urlsafe(32)
        call('advertiserAccounts', 'create', {'clientId': payload.client_id, 'category': payload.category, 'inviteHash': workspaces.token_hash(token)}, 'mutation')
        return {'username': f'advertiser.{payload.client_id}', 'invite_url': f'https://app.adchecked.com/invite/{token}?type=advertiser'}

    @app.post('/api/admin/advertiser-workspaces/{client_id}/invite')
    def reset_invite(client_id: str, request: Request):
        from .main import require_settings_admin
        require_settings_admin(request)
        token = secrets.token_urlsafe(32)
        call('advertiserAccounts', 'resetInvite', {'clientId': client_id, 'inviteHash': workspaces.token_hash(token)}, 'mutation')
        return {'username': f'advertiser.{client_id}', 'invite_url': f'https://app.adchecked.com/invite/{token}?type=advertiser'}

    @app.get('/api/client/advertiser-invitations/{token}')
    def invitation(token: str):
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            raise HTTPException(404, 'Invitation unavailable.')
        row = account(inviteHash=workspaces.token_hash(token))
        if not row or row['status'] != 'invited' or row.get('inviteExpiresAt', 0) <= time.time() * 1000:
            raise HTTPException(404, 'Invitation expired or already used. Contact AdChecked for a new link.')
        return {'name': row['name'], 'advertiser': row['name'], 'username': row['username']}

    @app.post('/api/client/advertiser-invitations/accept')
    def accept(payload: workspaces.InviteInput, request: Request):
        from .main import public_client_session, set_session_cookie, encode_session_token, CLIENT_SESSION_COOKIE
        row = call('advertiserAccounts', 'acceptInvite', {'inviteHash': workspaces.token_hash(payload.token), 'passwordHash': workspaces.hash_password(payload.password)}, 'mutation')
        session = advertiser_session(row)
        response = JSONResponse(public_client_session(session))
        set_session_cookie(response, request, CLIENT_SESSION_COOKIE, encode_session_token('client', {**session, 'credential_fingerprint': fingerprint(session)}))
        return response
