from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import socket
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field, field_validator

from . import storage

logger = logging.getLogger(__name__)

API_SCOPES = (
    'reviews:create',
    'reviews:read',
    'history:read',
    'evidence:read',
    'reports:download',
    'scans:write',
    'scans:read',
    'reviews:delete',
)
DEFAULT_API_SCOPES = API_SCOPES[:-1]
PARTNER_ID_PREFIX = 'partner_'
KEY_ID_PREFIX = 'key_'
MAX_EVIDENCE_BUNDLE_BYTES = 750_000


class PartnerApiUnavailable(RuntimeError):
    pass


class ApiPartnerInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default='', max_length=1_000)
    status: Literal['active', 'suspended'] = 'active'
    allowed_offer_ids: list[str] = Field(default_factory=list, max_length=10)
    allow_custom_policy: bool = False
    monthly_review_limit: int = Field(default=500, ge=1, le=100_000)
    concurrent_review_limit: int = Field(default=5, ge=1, le=50)
    max_upload_mb: int = Field(default=400, ge=1, le=400)
    retention_days: int = Field(default=30, ge=1, le=365)
    unlimited_reviews: bool = False
    unlimited_concurrency: bool = False
    webhook_url: str | None = Field(default=None, max_length=2_000)

    @field_validator('name', 'description')
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator('allowed_offer_ids')
    @classmethod
    def normalize_offer_ids(cls, values: list[str]) -> list[str]:
        normalized = []
        for value in values:
            offer_id = value.strip().lower()
            if not storage.OFFER_ID_PATTERN.fullmatch(offer_id):
                raise ValueError(f'Invalid offer ID: {value}')
            if offer_id not in normalized:
                normalized.append(offer_id)
        return normalized

    @field_validator('webhook_url')
    @classmethod
    def validate_webhook(cls, value: str | None) -> str | None:
        return validate_webhook_url(value)


class ApiKeyInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    scopes: list[str] = Field(default_factory=lambda: list(DEFAULT_API_SCOPES))
    expires_at: int | None = Field(default=None, ge=1)

    @field_validator('name')
    @classmethod
    def strip_name(cls, value: str) -> str:
        return value.strip()

    @field_validator('scopes')
    @classmethod
    def validate_scopes(cls, values: list[str]) -> list[str]:
        normalized = sorted(set(value.strip() for value in values if value.strip()))
        if not normalized:
            raise ValueError('Choose at least one API permission.')
        invalid = [scope for scope in normalized if scope not in API_SCOPES]
        if invalid:
            raise ValueError(f'Invalid API permission: {invalid[0]}')
        return normalized


@dataclass(frozen=True)
class ApiPrincipal:
    partner_id: str
    partner_name: str
    api_key_id: str
    api_key_name: str
    api_key_prefix: str
    scopes: frozenset[str]
    allowed_offer_ids: tuple[str, ...]
    allow_custom_policy: bool
    monthly_review_limit: int
    monthly_reviews_created: int
    concurrent_review_limit: int
    max_upload_mb: int
    retention_days: int
    unlimited_reviews: bool
    unlimited_concurrency: bool
    webhook_configured: bool

    def require_scope(self, scope: str) -> None:
        if scope not in self.scopes:
            raise PermissionError(f'This API key does not include the {scope} permission.')


def _convex_call(kind: str, path: str, args: dict[str, Any]) -> Any:
    if not storage.convex_enabled():
        raise PartnerApiUnavailable('Partner API storage is unavailable because Convex is not configured.')
    return storage._convex_call_with_retry(kind, path, args)


def hash_api_token(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def validate_webhook_url(value: str | None) -> str | None:
    normalized = (value or '').strip()
    if not normalized:
        return None
    parsed = urlsplit(normalized)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Webhook URL must be a public HTTPS URL without embedded credentials.')
    if parsed.port not in {None, 443}:
        raise ValueError('Webhook URL must use the standard HTTPS port.')
    hostname = parsed.hostname.rstrip('.').lower()
    if hostname == 'localhost' or hostname.endswith('.localhost') or hostname.endswith('.local'):
        raise ValueError('Webhook URL must use a public hostname.')
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError('Webhook URL must use a public IP address.')
    return normalized


def _assert_public_webhook_destination(url: str) -> None:
    parsed = urlsplit(url)
    hostname = parsed.hostname or ''
    addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    if not addresses:
        raise ValueError('Webhook hostname did not resolve.')
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError('Webhook hostname resolves to a non-public address.')


def list_api_partners() -> list[dict[str, Any]]:
    value = _convex_call('query', 'apiPartners:list', {})
    return value if isinstance(value, list) else []


def save_api_partner(partner_id: str, payload: ApiPartnerInput) -> dict[str, Any]:
    args: dict[str, Any] = {
        'allowedOfferIds': payload.allowed_offer_ids,
        'allowCustomPolicy': payload.allow_custom_policy,
        'concurrentReviewLimit': payload.concurrent_review_limit,
        'description': payload.description,
        'maxUploadMb': payload.max_upload_mb,
        'monthlyReviewLimit': payload.monthly_review_limit,
        'name': payload.name,
        'partnerId': partner_id,
        'retentionDays': payload.retention_days,
        'status': payload.status,
        'unlimitedConcurrency': payload.unlimited_concurrency,
        'unlimitedReviews': payload.unlimited_reviews,
    }
    if payload.webhook_url is not None:
        args['webhookUrl'] = payload.webhook_url
    value = _convex_call('mutation', 'apiPartners:upsert', args)
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid partner record.')
    return value


def create_api_partner(payload: ApiPartnerInput) -> dict[str, Any]:
    partner_id = f'{PARTNER_ID_PREFIX}{uuid.uuid4().hex}'
    return save_api_partner(partner_id, payload)


def issue_api_key(partner_id: str, payload: ApiKeyInput) -> dict[str, Any]:
    token = f'vc_live_{secrets.token_urlsafe(36)}'
    prefix = f'{token[:16]}…'
    key_id = f'{KEY_ID_PREFIX}{uuid.uuid4().hex}'
    args: dict[str, Any] = {
        'keyId': key_id,
        'name': payload.name,
        'partnerId': partner_id,
        'prefix': prefix,
        'scopes': payload.scopes,
        'tokenHash': hash_api_token(token),
    }
    if payload.expires_at is not None:
        args['expiresAt'] = payload.expires_at
    value = _convex_call('mutation', 'apiPartners:issueKey', args)
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid key record.')
    return {**value, 'token': token}


def revoke_api_key(partner_id: str, key_id: str) -> dict[str, Any]:
    value = _convex_call('mutation', 'apiPartners:revokeKey', {
        'keyId': key_id,
        'partnerId': partner_id,
    })
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid revocation response.')
    return value


def rotate_webhook_secret(partner_id: str) -> dict[str, Any]:
    webhook_secret = f'whsec_{secrets.token_urlsafe(36)}'
    value = _convex_call('mutation', 'apiPartners:rotateWebhookSecret', {
        'partnerId': partner_id,
        'webhookSigningSecret': webhook_secret,
    })
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid webhook response.')
    return {**value, 'webhook_signing_secret': webhook_secret}


def authenticate_api_token(token: str) -> ApiPrincipal | None:
    token = token.strip()
    if not token.startswith('vc_live_') or len(token) < 32:
        return None
    value = _convex_call('mutation', 'apiPartners:authenticate', {
        'now': storage.now_ms(),
        'tokenHash': hash_api_token(token),
    })
    if not isinstance(value, dict):
        return None
    return ApiPrincipal(
        partner_id=str(value['partner_id']),
        partner_name=str(value['name']),
        api_key_id=str(value['api_key_id']),
        api_key_name=str(value['api_key_name']),
        api_key_prefix=str(value['api_key_prefix']),
        scopes=frozenset(str(scope) for scope in value.get('scopes', [])),
        allowed_offer_ids=tuple(str(offer_id) for offer_id in value.get('allowed_offer_ids', [])),
        allow_custom_policy=bool(value.get('allow_custom_policy')),
        monthly_review_limit=int(value.get('monthly_review_limit') or 0),
        monthly_reviews_created=int(value.get('monthly_reviews_created') or 0),
        concurrent_review_limit=int(value.get('concurrent_review_limit') or 0),
        max_upload_mb=int(value.get('max_upload_mb') or 0),
        retention_days=int(value.get('retention_days') or 0),
        unlimited_reviews=bool(value.get('unlimited_reviews')),
        unlimited_concurrency=bool(value.get('unlimited_concurrency')),
        webhook_configured=bool(value.get('webhook_configured')),
    )


def claim_api_review(
    principal: ApiPrincipal,
    *,
    job_id: str,
    external_id: str,
    idempotency_key: str,
    media_kind: str,
    file_name: str,
    file_size: int | None,
) -> dict[str, Any]:
    args: dict[str, Any] = {
        'apiKeyId': principal.api_key_id,
        'fileName': file_name,
        'jobId': job_id,
        'mediaKind': media_kind,
        'partnerId': principal.partner_id,
    }
    if external_id:
        args['externalId'] = external_id
    if file_size is not None:
        args['fileSize'] = file_size
    if idempotency_key:
        args['idempotencyKey'] = idempotency_key
    value = _convex_call('mutation', 'apiPartners:claimReview', args)
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid review claim.')
    return value


def claim_api_scan_review(
    principal: ApiPrincipal,
    *,
    observation_id: str,
    job_id: str,
    external_ad_id: str,
    media_sha256: str,
    fields_sha256: str,
    content_fingerprint: str,
    media_kind: str,
    file_name: str,
    file_size: int,
    account_id: str = '',
    account_name: str = '',
    campaign_id: str = '',
    campaign_name: str = '',
    ad_set_id: str = '',
    ad_set_name: str = '',
    creative_name: str = '',
) -> dict[str, Any]:
    args: dict[str, Any] = {
        'apiKeyId': principal.api_key_id,
        'contentFingerprint': content_fingerprint,
        'externalAdId': external_ad_id,
        'fieldsSha256': fields_sha256,
        'fileName': file_name,
        'fileSize': file_size,
        'jobId': job_id,
        'mediaKind': media_kind,
        'mediaSha256': media_sha256,
        'observationId': observation_id,
        'partnerId': principal.partner_id,
    }
    optional_fields = {
        'accountId': account_id,
        'accountName': account_name,
        'campaignId': campaign_id,
        'campaignName': campaign_name,
        'adSetId': ad_set_id,
        'adSetName': ad_set_name,
        'creativeName': creative_name,
    }
    args.update({key: value for key, value in optional_fields.items() if value})
    value = _convex_call('mutation', 'apiPartners:claimScanReview', args)
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid scan claim.')
    return value


def get_api_scan_ad(principal: ApiPrincipal, external_ad_id: str) -> dict[str, Any] | None:
    value = _convex_call('query', 'apiPartners:getScanAd', {
        'externalAdId': external_ad_id,
        'partnerId': principal.partner_id,
    })
    return value if isinstance(value, dict) else None


def list_api_scan_ads(
    principal: ApiPrincipal,
    *,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    value = _convex_call('query', 'apiPartners:listScanAds', {
        'paginationOpts': {'cursor': cursor, 'numItems': max(1, min(limit, 100))},
        'partnerId': principal.partner_id,
    })
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid scanned-ad page.')
    return {
        'data': value.get('page', []),
        'has_more': not bool(value.get('isDone')),
        'next_cursor': None if value.get('isDone') else value.get('continueCursor'),
    }


def list_api_scan_observations(
    principal: ApiPrincipal,
    *,
    external_ad_id: str,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    value = _convex_call('query', 'apiPartners:listScanObservations', {
        'externalAdId': external_ad_id,
        'paginationOpts': {'cursor': cursor, 'numItems': max(1, min(limit, 100))},
        'partnerId': principal.partner_id,
    })
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid scan-observation page.')
    return {
        'data': value.get('page', []),
        'has_more': not bool(value.get('isDone')),
        'next_cursor': None if value.get('isDone') else value.get('continueCursor'),
    }


def get_api_review(principal: ApiPrincipal, job_id: str) -> dict[str, Any] | None:
    value = _convex_call('query', 'apiPartners:getReview', {
        'jobId': job_id,
        'partnerId': principal.partner_id,
    })
    return value if isinstance(value, dict) else None


def list_api_reviews(
    principal: ApiPrincipal,
    *,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    value = _convex_call('query', 'apiPartners:listReviews', {
        'paginationOpts': {'cursor': cursor, 'numItems': max(1, min(limit, 100))},
        'partnerId': principal.partner_id,
    })
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid review page.')
    return {
        'data': value.get('page', []),
        'has_more': not bool(value.get('isDone')),
        'next_cursor': None if value.get('isDone') else value.get('continueCursor'),
    }


def persist_api_evidence(
    *,
    job_id: str,
    partner_id: str,
    bundle: dict[str, Any],
) -> dict[str, Any]:
    size = len(json.dumps(bundle, ensure_ascii=False).encode('utf-8'))
    if size > MAX_EVIDENCE_BUNDLE_BYTES:
        raise ValueError(
            f'The extracted evidence bundle is {size:,} bytes; the API limit is '
            f'{MAX_EVIDENCE_BUNDLE_BYTES:,} bytes.'
        )
    value = _convex_call('mutation', 'apiPartners:saveEvidence', {
        'bundle': bundle,
        'jobId': job_id,
        'partnerId': partner_id,
    })
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid evidence response.')
    return value


def get_api_evidence(principal: ApiPrincipal, job_id: str) -> dict[str, Any] | None:
    value = _convex_call('query', 'apiPartners:getEvidence', {
        'jobId': job_id,
        'now': storage.now_ms(),
        'partnerId': principal.partner_id,
    })
    return value if isinstance(value, dict) else None


def finalize_api_review(job_id: str, status: Literal['complete', 'failed']) -> dict[str, Any]:
    value = _convex_call('mutation', 'apiPartners:finalizeReview', {
        'jobId': job_id,
        'status': status,
    })
    return value if isinstance(value, dict) else {'finalized': False}


def mark_api_review_deleted(principal: ApiPrincipal, job_id: str) -> dict[str, Any]:
    value = _convex_call('mutation', 'apiPartners:markReviewDeleted', {
        'jobId': job_id,
        'partnerId': principal.partner_id,
    })
    if not isinstance(value, dict):
        raise RuntimeError('Partner API storage returned an invalid deletion response.')
    return value


def prune_expired_api_evidence(limit: int = 100) -> int:
    value = _convex_call('mutation', 'apiPartners:pruneExpiredEvidence', {
        'limit': max(1, min(limit, 100)),
        'now': storage.now_ms(),
    })
    return int(value.get('removed') or 0) if isinstance(value, dict) else 0


def reconcile_terminal_api_reviews(limit: int = 100) -> int:
    value = _convex_call('mutation', 'apiPartners:reconcileTerminalReviews', {
        'limit': max(1, min(limit, 100)),
    })
    return int(value.get('finalized') or 0) if isinstance(value, dict) else 0


def api_tick_state() -> dict[str, bool]:
    value = _convex_call('query', 'apiPartners:tickState', {'now': storage.now_ms()})
    return value if isinstance(value, dict) else {}


async def deliver_pending_api_webhooks(limit: int = 5) -> int:
    deliveries = await asyncio.to_thread(
        _convex_call,
        'mutation',
        'apiPartners:claimWebhookDeliveries',
        {'limit': max(1, min(limit, 20)), 'now': storage.now_ms()},
    )
    if not isinstance(deliveries, list) or not deliveries:
        return 0
    completed = 0
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        for delivery in deliveries:
            delivery_id = str(delivery.get('delivery_id') or '')
            webhook_url = str(delivery.get('webhook_url') or '')
            signing_secret = str(delivery.get('signing_secret') or '')
            payload = delivery.get('payload')
            response_status: int | None = None
            error = ''
            success = False
            try:
                await asyncio.to_thread(_assert_public_webhook_destination, webhook_url)
                body = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
                timestamp = str(int(time.time()))
                signed = f'{timestamp}.{body}'.encode('utf-8')
                signature = hmac.new(
                    signing_secret.encode('utf-8'),
                    signed,
                    hashlib.sha256,
                ).hexdigest()
                response = await client.post(
                    webhook_url,
                    content=body.encode('utf-8'),
                    headers={
                        'content-type': 'application/json',
                        'user-agent': 'Vibe-Check-Webhooks/1.0',
                        'x-vibe-event-id': delivery_id,
                        'x-vibe-signature': f'v1={signature}',
                        'x-vibe-timestamp': timestamp,
                    },
                )
                response_status = response.status_code
                success = 200 <= response.status_code < 300
                if not success:
                    error = f'Webhook returned HTTP {response.status_code}'
            except Exception as exc:
                error = f'{type(exc).__name__}: {str(exc)[:300]}'
            completion_args: dict[str, Any] = {
                'deliveryId': delivery_id,
                'now': storage.now_ms(),
                'success': success,
            }
            if error:
                completion_args['error'] = error
            if response_status is not None:
                completion_args['responseStatus'] = response_status
            await asyncio.to_thread(
                _convex_call,
                'mutation',
                'apiPartners:completeWebhookDelivery',
                completion_args,
            )
            if success:
                completed += 1
            elif error:
                logger.warning(
                    'Partner webhook delivery failed. delivery_id=%s error_type=%s',
                    delivery_id,
                    error.split(':', 1)[0],
                )
    return completed
