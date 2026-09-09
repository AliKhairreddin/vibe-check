"""Advertiser-owned publisher access and revocable creative sharing.

Uses the existing signed browser sessions and server-to-Convex boundary. Only
one-way password/token hashes are persisted; every request rechecks membership.
"""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
import time
import uuid
from typing import Literal

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .review_pipeline import storage


def call(function: str, args: dict, *, mutation: bool = False):
    if not storage.convex_enabled():
        raise HTTPException(503, 'Workspace storage is unavailable. Configure Convex to continue.')
    try:
        return storage._convex_call('mutation' if mutation else 'query', f'workspaces:{function}', args)
    except HTTPException:
        raise
    except RuntimeError as exc:
        # Only expose our known business errors, never backend traces or secrets.
        message = str(exc)
        for public in ('Publisher limit reached. Contact AdChecked to upgrade.', 'Monthly review allowance reached. Contact your advertiser to upgrade.', 'Invitation expired or already used', 'Only completed, available creatives can be shared', 'Username already exists', 'This login is managed by the publisher organization'):
            if public in message:
                raise HTTPException(409, public) from None
        raise HTTPException(503, 'Could not update the workspace. Please retry.') from None
    except Exception:
        raise HTTPException(503, 'Workspace storage is temporarily unavailable.') from None


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_password(password: str) -> str:
    if not 12 <= len(password) <= 128:
        raise HTTPException(400, 'Choose a password between 12 and 128 characters.')
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return f'scrypt${salt.hex()}${digest.hex()}'


def verify_password(password: str, encoded: str) -> bool:
    if not 12 <= len(password) <= 128:
        return False
    try:
        algorithm, salt, digest = encoded.split('$')
        if algorithm != 'scrypt':
            return False
        candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
        return secrets.compare_digest(candidate.hex(), digest)
    except (ValueError, TypeError):
        return False


def publisher_session(row: dict) -> dict:
    if row.get('organizationId') == 'digital-nudge':
        memberships = call('digitalNudgeMemberships', {})
        return {'role': 'publisher', 'username': row['username'], 'portal_ids': [p['clientId'] for p in memberships], 'publisher_id': row['publisherId'], 'publisher_name': 'Digital Nudge', 'publisher_ids': {p['clientId']: p['publisherId'] for p in memberships}}
    return {'role': 'publisher', 'username': row['username'], 'portal_ids': [row['clientId']],
            'publisher_id': row['publisherId'], 'publisher_name': row['name']}


def authenticate_publisher(username: str, password: str) -> dict | None:
    if not storage.convex_enabled():
        return None
    row = call('getPublisher', {'username': username.lower()})
    if not row or row['status'] != 'active' or not verify_password(password, row.get('passwordHash', '')):
        return None
    return publisher_session(row)


def publisher_fingerprint(session: dict) -> str:
    from .main import credential_fingerprint
    row = call('getPublisher', {'publisherId': str(session.get('publisher_id', ''))})
    expected_session = publisher_session(row) if row and row['status'] == 'active' else None
    if not row or not expected_session or session.get('portal_ids') != expected_session['portal_ids'] or session.get('publisher_ids') != expected_session.get('publisher_ids') or session.get('username') != row['username']:
        return ''
    return credential_fingerprint(row['publisherId'], str(row['authVersion']))


def require_manager(request: Request, client_id: str) -> dict:
    from .main import authenticate_client, require_client
    config = require_client(request, client_id)
    if authenticate_client(request)['role'] == 'publisher':
        raise HTTPException(403, 'Only the advertiser can manage this workspace.')
    return config


def require_submission(request: Request, client_id: str, job_id: str) -> None:
    from .main import authenticate_client
    session = authenticate_client(request)
    if session['role'] == 'publisher':
        row = call('getSubmission', {'clientId': client_id, 'jobId': job_id})
        if not row or row['clientId'] != client_id or row['publisherId'] != session.get('publisher_ids', {}).get(client_id, session['publisher_id']):
            raise HTTPException(404, 'Creative not found.')


def preview_scope(request: Request, client_id: str) -> dict:
    """Only a signed-in publisher can preview their own unreleased results."""
    from .main import authenticate_client
    session = authenticate_client(request)
    if session['role'] != 'publisher':
        return {}
    return {'preview_publisher_id': session.get('publisher_ids', {}).get(client_id, session['publisher_id'])}


class ReleaseSelectionInput(BaseModel):
    job_ids: list[str] | None = Field(default=None, min_length=1, max_length=100)
    batch_id: str | None = None


class ReleaseInput(BaseModel):
    job_ids: list[str] = Field(min_length=1, max_length=100)
    offer_ids: list[str] = Field(min_length=1, max_length=20)
    confirmed: bool = False


def release_call(function: str, args: dict, *, mutation: bool = False):
    if not storage.convex_enabled():
        raise HTTPException(503, 'Release storage is unavailable. Please retry later.')
    try:
        return storage._convex_call('mutation' if mutation else 'query', f'reviewReleases:{function}', args)
    except RuntimeError as exc:
        for public in ('Creative unavailable', 'Batch unavailable', 'Select creatives or a batch', 'Select up to 100 creatives', 'Wait for the batch to finish processing before release', 'Select between 1 and 100 completed creatives', 'Only completed creatives can be released', 'Confirm the release before continuing', 'Choose offers that were evaluated for these creatives'):
            if public in str(exc):
                raise HTTPException(409, public) from None
        raise HTTPException(503, 'Could not save the release. Please retry.') from None


def release_scope(request: Request, client_id: str | None = None) -> dict:
    from .main import require_admin
    if client_id:
        context = upload_context(request)
        return {key: context[key] for key in ('clientId', 'publisherId')}
    require_admin(request)
    return {}


def upload_context(request: Request) -> dict | None:
    if not request.url.path.startswith('/api/client/'):
        return None
    from .main import authenticate_client, require_client
    client_id = request.path_params['client_id']
    config = require_client(request, client_id)
    session = authenticate_client(request)
    if session['role'] != 'publisher':
        raise HTTPException(403, 'Use a publisher login to submit creatives.')
    return {'clientId': client_id, 'publisherId': session.get('publisher_ids', {}).get(client_id, session['publisher_id']), 'offerId': config['offer_id']}


def check_upload_owner(context: dict | None, metadata: dict):
    if context and (metadata.get('publisherId') != context['publisherId'] or metadata.get('clientId') != context['clientId']):
        raise HTTPException(404, 'Upload not found.')


def claim_submission(context: dict | None, job_id: str):
    if context:
        call('claimSubmission', {k: context[k] for k in ('clientId', 'publisherId')} | {'jobId': job_id}, mutation=True)


def release_unstarted_submission(context: dict | None, job_id: str):
    if context:
        try:
            call('releaseUnstartedSubmission', {k: context[k] for k in ('clientId', 'publisherId')} | {'jobId': job_id}, mutation=True)
        except Exception:
            logging.getLogger(__name__).warning('Could not release unstarted publisher submission %s', job_id)


class PublisherInput(BaseModel):
    name: str = Field(min_length=2, max_length=100)


class InviteInput(BaseModel):
    token: str = Field(min_length=40, max_length=100)
    password: str = Field(min_length=12, max_length=128)


class ShareInput(BaseModel):
    job_ids: list[str] = Field(min_length=1, max_length=100)
    title: str = Field(default='Creative review', min_length=1, max_length=120)
    offer_id: str | None = None
    expires_in_days: Literal[7, 30, 90] = 30


class PlanInput(BaseModel):
    plan: Literal['pilot', 'starter', 'growth', 'enterprise']
    publisher_limit: int = Field(default=100, ge=1, le=1000)
    monthly_review_limit: int = Field(default=3000, ge=1, le=10000)


def share_owner(request: Request, client_id: str | None = None) -> dict:
    from .main import authenticate_client, require_admin, require_client
    if client_id:
        require_client(request, client_id)
        session = authenticate_client(request)
        if session['role'] == 'publisher':
            publisher_id = session.get('publisher_ids', {}).get(client_id, session['publisher_id'])
            return {'ownerKey': f'publisher:{publisher_id}', 'publisherId': publisher_id, 'clientId': client_id}
        return {'ownerKey': f'client:{client_id}', 'clientId': client_id}
    require_admin(request)
    return {'ownerKey': 'admin'}


def new_share(payload: ShareInput, request: Request, client_id: str | None = None):
    from .main import client_portal, get_status, get_client_review_report, JOB_ID_PATTERN
    owner = share_owner(request, client_id)
    items = []
    for job_id in dict.fromkeys(payload.job_ids):
        if not JOB_ID_PATTERN.fullmatch(job_id):
            raise HTTPException(400, 'Invalid creative selection.')
        if client_id:
            require_submission(request, client_id, job_id)
            offer_id = client_portal(client_id)['offer_id']
        else:
            try:
                record = get_status(job_id)
            except FileNotFoundError:
                raise HTTPException(404, 'Creative not found.') from None
            released = record.released_offer_ids
            offer_id = payload.offer_id or (released[0] if released else record.primary_offer_id) or 'acp'
        if get_client_review_report(client_id or offer_id, offer_id, job_id) is None:
            raise HTTPException(409, 'Release these creatives to the selected offer before sharing.')
        items.append({'jobId': job_id, 'offerId': offer_id})
    token = secrets.token_urlsafe(32)
    share_id = uuid.uuid4().hex
    call('createShare', {**owner, 'items': items, 'shareId': share_id, 'tokenHash': token_hash(token),
                        'title': payload.title.strip() or 'Creative review', 'expiresAt': int(time.time() * 1000) + payload.expires_in_days * 86400000}, mutation=True)
    return {'share_id': share_id, 'url': f'https://app.adchecked.com/share/{token}'}


def active_share(token: str) -> dict:
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        raise HTTPException(404, 'This shared link is unavailable or has expired.')
    row = call('getShare', {'tokenHash': token_hash(token)})
    if not row:
        raise HTTPException(404, 'This shared link is unavailable or has expired.')
    return row


def shared_item(token: str, job_id: str):
    from .main import get_client_review_detail
    row = active_share(token)
    item = next((item for item in row['items'] if item['jobId'] == job_id), None)
    if not item:
        raise HTTPException(404, 'Creative not found.')
    detail = get_client_review_detail(row.get('clientId') or item['offerId'], item['offerId'], job_id)
    if not detail:
        raise HTTPException(404, 'This creative is no longer available.')
    return row, detail


def register(app):
    @app.get('/api/client/{client_id}/publishers')
    def list_publishers(client_id: str, request: Request):
        require_manager(request, client_id)
        return call('listPublishers', {'clientId': client_id})

    @app.post('/api/client/{client_id}/publishers', status_code=201)
    def create_publisher(client_id: str, payload: PublisherInput, request: Request):
        require_manager(request, client_id)
        name = payload.name.strip()
        if len(name) < 2:
            raise HTTPException(400, 'Enter a publisher company name.')
        publisher_id = uuid.uuid4().hex
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:30] or 'publisher'
        username = f'{client_id}.{slug}.{publisher_id[:6]}'
        token = secrets.token_urlsafe(32)
        call('invitePublisher', {'clientId': client_id, 'publisherId': publisher_id, 'name': name, 'username': username, 'inviteHash': token_hash(token)}, mutation=True)
        return {'publisher_id': publisher_id, 'username': username, 'invite_url': f'https://app.adchecked.com/invite/{token}'}

    @app.post('/api/client/{client_id}/publishers/{publisher_id}/invite')
    def reset_invite(client_id: str, publisher_id: str, request: Request):
        require_manager(request, client_id)
        row = call('getPublisher', {'publisherId': publisher_id})
        if not row or row['clientId'] != client_id:
            raise HTTPException(404, 'Publisher not found.')
        if row.get('organizationId'):
            raise HTTPException(403, 'Digital Nudge manages its organization login. Contact the platform administrator.')
        token = secrets.token_urlsafe(32)
        call('invitePublisher', {'clientId': client_id, 'publisherId': publisher_id, 'name': row['name'], 'username': row['username'], 'inviteHash': token_hash(token)}, mutation=True)
        return {'publisher_id': publisher_id, 'username': row['username'], 'invite_url': f'https://app.adchecked.com/invite/{token}'}

    @app.delete('/api/client/{client_id}/publishers/{publisher_id}')
    def suspend_publisher(client_id: str, publisher_id: str, request: Request):
        require_manager(request, client_id)
        row = call('getPublisher', {'publisherId': publisher_id})
        if not row or row['clientId'] != client_id:
            raise HTTPException(404, 'Publisher not found.')
        call('suspendPublisher', {'clientId': client_id, 'publisherId': publisher_id}, mutation=True)
        return {'suspended': True}

    @app.get('/api/client/invitations/{token}')
    def get_invitation(token: str):
        from .main import client_portal
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            raise HTTPException(404, 'Invitation unavailable.')
        row = call('getPublisher', {'inviteHash': token_hash(token)})
        if not row or row['status'] != 'invited' or row.get('inviteExpiresAt', 0) <= time.time() * 1000:
            raise HTTPException(404, 'Invitation expired or already used. Ask your advertiser for a new link.')
        return {'name': row['name'], 'advertiser': client_portal(row['clientId'])['display_name'], 'username': row['username']}

    @app.post('/api/client/invitations/accept')
    def accept_invitation(payload: InviteInput, request: Request):
        from .main import public_client_session, set_session_cookie, encode_session_token, CLIENT_SESSION_COOKIE
        row = call('acceptInvite', {'inviteHash': token_hash(payload.token), 'passwordHash': hash_password(payload.password)}, mutation=True)
        session = publisher_session(row)
        response = JSONResponse(public_client_session(session))
        set_session_cookie(response, request, CLIENT_SESSION_COOKIE, encode_session_token('client', {**session, 'credential_fingerprint': publisher_fingerprint(session)}))
        response.headers['cache-control'] = 'no-store'
        return response

    @app.get('/api/client/{client_id}/submissions')
    def submissions(client_id: str, request: Request, publisher_id: str | None = None):
        from .main import authenticate_client, require_client
        require_client(request, client_id)
        session = authenticate_client(request)
        if session['role'] == 'publisher':
            publisher_id = session.get('publisher_ids', {}).get(client_id, session['publisher_id'])
        return call('listSubmissions', {'clientId': client_id, **({'publisherId': publisher_id} if publisher_id else {}), **({'previewPublisherId': publisher_id} if session['role'] == 'publisher' else {})})

    def release_selection(payload: ReleaseSelectionInput, request: Request, client_id: str | None = None):
        scope = release_scope(request, client_id)
        return release_call('getSelection', {**scope, **({'jobIds': payload.job_ids} if payload.job_ids else {}), **({'batchId': payload.batch_id} if payload.batch_id else {})})

    def release_creatives(payload: ReleaseInput, request: Request, client_id: str | None = None):
        scope = release_scope(request, client_id)
        return release_call('release', {**scope, 'jobIds': payload.job_ids, 'offerIds': payload.offer_ids, 'confirmed': payload.confirmed, 'releasedBy': 'admin'}, mutation=True)

    @app.post('/api/reviews/release-selection')
    def admin_release_selection(payload: ReleaseSelectionInput, request: Request):
        return release_selection(payload, request)

    @app.post('/api/reviews/release')
    def admin_release(payload: ReleaseInput, request: Request):
        return release_creatives(payload, request)

    @app.post('/api/client/{client_id}/reviews/release-selection')
    def publisher_release_selection(client_id: str, payload: ReleaseSelectionInput, request: Request):
        return release_selection(payload, request, client_id)

    @app.post('/api/client/{client_id}/reviews/release')
    def publisher_release(client_id: str, payload: ReleaseInput, request: Request):
        return release_creatives(payload, request, client_id)

    @app.delete('/api/client/{client_id}/submissions/{job_id}')
    def delete_submission(client_id: str, job_id: str, request: Request):
        from .main import JOB_ID_PATTERN
        release_scope(request, client_id)
        require_submission(request, client_id, job_id)
        if not JOB_ID_PATTERN.fullmatch(job_id):
            raise HTTPException(404, 'Creative not found.')
        # Shared internal uploads may belong to more than one publisher workspace;
        # deleting an unreleased job is allowed only before any advertiser release.
        try:
            return storage.delete_review(job_id)
        except FileNotFoundError:
            raise HTTPException(404, 'Creative not found.') from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None

    @app.get('/api/client/{client_id}/plan')
    def get_plan(client_id: str, request: Request):
        require_manager(request, client_id)
        return call('getPlan', {'clientId': client_id})

    @app.post('/api/admin/digital-nudge/invite')
    def digital_nudge_invite(request: Request):
        from .main import require_settings_admin
        require_settings_admin(request)
        token = secrets.token_urlsafe(32)
        call('setupDigitalNudge', {'inviteHash': token_hash(token)}, mutation=True)
        return {'publisher_id': 'digital-nudge-kissterra', 'username': 'digital-nudge', 'invite_url': f'https://app.adchecked.com/invite/{token}'}

    @app.get('/api/admin/workspaces')
    def admin_workspaces(request: Request):
        from .main import require_settings_admin, CLIENT_PORTALS
        require_settings_admin(request)
        return [{'name': config['display_name'], **call('getPlan', {'clientId': client_id})} for client_id, config in CLIENT_PORTALS.items()]

    @app.put('/api/admin/workspaces/{client_id}/plan')
    def set_plan(client_id: str, payload: PlanInput, request: Request):
        from .main import require_settings_admin, client_portal
        require_settings_admin(request)
        client_portal(client_id)
        limits = {'pilot': (5, 250), 'starter': (5, 250), 'growth': (25, 1000), 'enterprise': (payload.publisher_limit, payload.monthly_review_limit)}
        publishers, reviews = limits[payload.plan]
        call('setPlan', {'clientId': client_id, 'plan': payload.plan, 'publisherLimit': publishers, 'monthlyReviewLimit': reviews}, mutation=True)
        return {'saved': True}

    @app.post('/api/client/{client_id}/shares', status_code=201)
    def create_client_share(client_id: str, payload: ShareInput, request: Request):
        return new_share(payload, request, client_id)

    @app.post('/api/shares', status_code=201)
    def create_admin_share(payload: ShareInput, request: Request):
        return new_share(payload, request)

    def list_links(request, client_id=None):
        owner = share_owner(request, client_id)
        return call('listShares', {'ownerKey': owner['ownerKey'], **({'clientId': client_id} if client_id and 'publisherId' not in owner else {})})

    @app.get('/api/client/{client_id}/shares')
    def client_links(client_id: str, request: Request):
        return list_links(request, client_id)

    @app.get('/api/shares')
    def admin_links(request: Request):
        return list_links(request)

    def revoke(request, share_id, client_id=None):
        owner = share_owner(request, client_id)
        call('revokeShare', {'shareId': share_id, 'ownerKey': owner['ownerKey'], **({'clientId': client_id} if client_id and 'publisherId' not in owner else {})}, mutation=True)
        return {'revoked': True}

    @app.delete('/api/client/{client_id}/shares/{share_id}')
    def revoke_client_link(client_id: str, share_id: str, request: Request):
        return revoke(request, share_id, client_id)

    @app.delete('/api/shares/{share_id}')
    def revoke_admin_link(share_id: str, request: Request):
        return revoke(request, share_id)

    @app.get('/api/public/shares/{token}')
    def public_collection(token: str):
        row = active_share(token)
        return {'title': row['title'], 'expires_at': row['expiresAt'], 'job_ids': [item['jobId'] for item in row['items']]}

    @app.get('/api/public/shares/{token}/reviews/{job_id}')
    def public_detail(token: str, job_id: str):
        from .main import public_client_review
        row, detail = shared_item(token, job_id)
        report = detail['report']
        # This explicit projection deliberately omits internal overrides, policy
        # documents, other offers, source URLs and processing metadata.
        safe_report = {key: report.get(key) for key in ('offer_name', 'overall_status', 'summary', 'findings', 'source_results')}
        review = public_client_review(detail['review'])
        review['preview']['google_drive_url'] = None
        base = f'/api/public/shares/{token}/reviews/{job_id}'
        return {'review': review, 'report': safe_report, 'media_url': f'{base}/media', 'evidence_frames': [
            {'filename': f['filename'], 'timestamp': f.get('timestamp'), 'url': f'{base}/frames/{f["filename"]}'} for f in detail.get('evidenceFrames', [])
        ]}

    @app.get('/api/public/shares/{token}/reviews/{job_id}/frames/{filename}')
    def public_frame(token: str, job_id: str, filename: str):
        from .main import evidence_frame_response
        _, detail = shared_item(token, job_id)
        if not any(f['filename'] == filename for f in detail.get('evidenceFrames', [])):
            raise HTTPException(404, 'Evidence frame not found.')
        return evidence_frame_response(job_id, filename)

    @app.api_route('/api/public/shares/{token}/reviews/{job_id}/media', methods=['GET', 'HEAD'])
    def public_media(token: str, job_id: str, request: Request):
        from .main import review_media_response
        shared_item(token, job_id)
        return review_media_response(job_id, request)
