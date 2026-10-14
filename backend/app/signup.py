"""Self-serve provisioning through the existing signed-session authentication."""
import os
import re
import secrets
import uuid

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import billing, workspaces
from .review_pipeline import storage
from .review_pipeline.models import OfferProfileInput


class SignupInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    workspace_name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)

    @field_validator('email')
    @classmethod
    def email_address(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value):
            raise ValueError('Enter a valid email address.')
        return value

    @field_validator('workspace_name')
    @classmethod
    def workspace_name_text(cls, value):
        if len(value.strip()) < 2:
            raise ValueError('Enter your workspace name.')
        return value.strip()


class SetupInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    official_guidelines: str = Field(max_length=12000)


def register(app):
    @app.post('/api/client/signup', status_code=201)
    def signup(payload: SignupInput, request: Request):
        from .main import CLIENT_PORTALS, CLIENT_SESSION_COOKIE, client_cookie_session, credential_fingerprint, encode_session_token, public_client_session, set_session_cookie
        secret = os.getenv('CONVEX_HTTP_SECRET', '')
        ip_hash = request.headers.get('x-signup-ip', '')
        if not secret or not secrets.compare_digest(request.headers.get('x-signup-gateway', ''), secret) or not re.fullmatch(r'[a-f0-9]{64}', ip_hash):
            raise HTTPException(403, 'Use the signup page to create your account.')
        if not os.getenv('SESSION_SECRET'):
            raise HTTPException(503, 'Account signup is temporarily unavailable.')
        if client_cookie_session(request):
            raise HTTPException(409, 'Sign out before creating another account.')
        if not billing.call('signup', 'admit', {'ipHash': ip_hash}, 'mutation'):
            raise HTTPException(429, 'Too many signup attempts. Please try again in an hour.', headers={'Retry-After': '3600'})
        reserved = [os.getenv('CLIENT_ADMIN_USERNAME', 'admin')] + [os.getenv(c['username_env'], c['username_default']) for c in CLIENT_PORTALS.values()]
        if payload.email in [name.strip().lower() for name in reserved]:
            raise HTTPException(409, 'This email is already in use. Sign in instead.')
        row = billing.call('signup', 'create', {'clientId': f'workspace-{uuid.uuid4().hex}', 'email': payload.email, 'name': payload.workspace_name, 'passwordHash': workspaces.hash_password(payload.password)}, 'mutation')
        session = billing.advertiser_session(row)
        response = JSONResponse(public_client_session(session), status_code=201)
        token = encode_session_token('client', {**session, 'credential_fingerprint': credential_fingerprint(row['username'], str(row['authVersion']))})
        set_session_cookie(response, request, CLIENT_SESSION_COOKIE, token)
        response.headers['cache-control'] = 'no-store'
        return response

    def own_workspace(client_id, request):
        billing.authorize(request, client_id, manager=True)
        row = billing.account(clientId=client_id)
        if not row or not row.get('selfServe') or row['status'] != 'active':
            raise HTTPException(404, 'Workspace setup is unavailable.')
        return row

    @app.get('/api/client/{client_id}/setup')
    def setup(client_id: str, request: Request):
        row = own_workspace(client_id, request)
        # A direct lookup avoids loading other customers' policies.
        profile = billing.call('offers', 'get', {'offerId': client_id})
        return {'name': row['name'], 'official_guidelines': profile['official_guidelines'], 'configured': profile['enabled']}

    @app.put('/api/client/{client_id}/setup')
    def save_setup(client_id: str, payload: SetupInput, request: Request):
        row = own_workspace(client_id, request)
        guidelines = payload.official_guidelines.strip()
        existing = billing.call('offers', 'get', {'offerId': client_id})
        profile = storage.upsert_offer_profile(client_id, OfferProfileInput(display_name=row['name'], official_guidelines=guidelines, internal_overrides=existing.get('internal_overrides', []), enabled=bool(guidelines), is_default=False))
        return {'name': row['name'], 'official_guidelines': profile.official_guidelines, 'configured': profile.enabled}
