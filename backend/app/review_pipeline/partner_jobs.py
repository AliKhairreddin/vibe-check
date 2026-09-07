"""Durable URL batch jobs, executed by the existing bounded review workers."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import shutil
import uuid
from typing import Any

from . import storage
from .jobs import process_job
from .models import JobStatus, ReviewRequestMeta
from .partner_api import ApiBatchJobInput, ApiPrincipal, PartnerMediaError, _convex_call, download_api_media

logger = logging.getLogger(__name__)
_work_available = True
_claim_lock = asyncio.Lock()
_running_jobs: set[str] = set()


def wake_partner_jobs() -> None:
    global _work_available
    _work_available = True


async def drain_partner_jobs(timeout_seconds: float = 10 * 60) -> dict:
    """Keep the container awake while its normal workers pull durable jobs."""
    wake_partner_jobs()
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(3)
        if not _work_available and not _running_jobs:
            break
    return {'active': len(_running_jobs), 'drained': not _work_available and not _running_jobs}


def submit_batch(principal: ApiPrincipal, payload: ApiBatchJobInput, meta: ReviewRequestMeta, idempotency_key: str, max_bytes: int) -> dict:
    canonical = payload.model_dump(mode='json')
    canonical['offer_name'] = meta.primary_offer_id
    args = {
        'partnerId': principal.partner_id, 'apiKeyId': principal.api_key_id,
        'batchId': f'batch_{uuid.uuid4().hex}',
        'requestHash': hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        'offerId': meta.primary_offer_id, 'offerName': meta.offer_profiles[0].display_name,
        'requestMeta': meta.model_dump_json(), 'maxBytes': max_bytes,
        'creatives': [{'jobId': uuid.uuid4().hex, 'assetId': c.asset_id, 'creativeName': c.creative_name, 'mediaUrl': c.media_url} for c in payload.creatives],
    }
    if idempotency_key:
        args['idempotencyKey'] = idempotency_key
    return _convex_call('mutation', 'apiJobs:submit', args)


def get_batch(principal: ApiPrincipal, batch_id: str) -> dict | None:
    return _convex_call('query', 'apiJobs:getBatch', {'partnerId': principal.partner_id, 'batchId': batch_id})


def get_asset(principal: ApiPrincipal, asset_id: str, offer_id: str | None = None, review_id: str | None = None) -> dict | None:
    args = {'partnerId': principal.partner_id, 'assetId': asset_id}
    if offer_id:
        args['offerId'] = offer_id
    if review_id:
        args['reviewId'] = review_id
    return _convex_call('query', 'apiJobs:getAsset', args)


def status_colors(principal: ApiPrincipal, asset_ids: list[str], offer_id: str | None = None) -> dict:
    args: dict[str, Any] = {'partnerId': principal.partner_id, 'assetIds': asset_ids}
    if offer_id:
        args['offerId'] = offer_id
    return {'data': _convex_call('query', 'apiJobs:statusColors', args)}


async def claim_next_partner_job() -> dict | None:
    global _work_available
    if not _work_available or not storage.convex_enabled():
        return None
    async with _claim_lock:
        if not _work_available:
            return None
        try:
            claim = await asyncio.to_thread(_convex_call, 'mutation', 'apiJobs:claim', {})
        except Exception:
            logger.exception('Could not claim a durable partner job; the next scheduled wake will retry.')
            _work_available = False
            return None
        if claim is None:
            _work_available = False
        return claim


async def _heartbeat(job_id: str, lease_id: str) -> None:
    while True:
        await asyncio.sleep(30)
        await asyncio.wait_for(asyncio.to_thread(
            _convex_call, 'mutation', 'apiJobs:heartbeat', {'jobId': job_id, 'leaseId': lease_id},
        ), timeout=45)


async def _process_remote_job(claim: dict) -> tuple[bool, bool, str]:
    job_id = claim['job_id']
    meta = ReviewRequestMeta.model_validate_json(claim['request_meta'])
    meta.api_external_id = claim['asset_id']
    jd = storage.job_dir(job_id)
    downloaded = await download_api_media(claim['media_url'], claim['creative_name'], jd, claim['max_bytes'])
    (jd / 'request.json').write_text(meta.model_dump_json(indent=2), encoding='utf-8')
    initial_status = JobStatus.processing_image if downloaded.media_kind == 'image' else JobStatus.processing_video
    await asyncio.to_thread(storage.set_status, job_id, initial_status, 1, 'Creative downloaded; starting analysis',
                            downloaded.file_name, downloaded.file_size, False, True,
                            offer_ids=meta.offer_ids, primary_offer_id=meta.primary_offer_id)
    await process_job(job_id, downloaded.path, downloaded.media_kind, meta)
    record = await asyncio.to_thread(storage.get_status, job_id)
    return record.status == JobStatus.complete, True, record.message


async def run_partner_job(claim: dict, timeout_seconds: float) -> None:
    job_id, lease_id = claim['job_id'], claim['lease_id']
    token = storage.api_job_lease.set(lease_id)
    _running_jobs.add(job_id)
    heartbeat = asyncio.create_task(_heartbeat(job_id, lease_id))
    processing = asyncio.create_task(_process_remote_job(claim))
    try:
        try:
            async with asyncio.timeout(timeout_seconds):
                done, _ = await asyncio.wait({heartbeat, processing}, return_when=asyncio.FIRST_COMPLETED)
                if heartbeat in done:
                    # Stop work on any uncertain lease. Convex will reclaim it;
                    # fencing protects against thread work finishing after cancellation.
                    await heartbeat
                success, retryable, message = await processing
        except PartnerMediaError as exc:
            success, retryable, message = False, exc.status_code >= 500, exc.detail
        except Exception as exc:
            logger.warning('Partner job attempt interrupted. job_id=%s error_type=%s', job_id, type(exc).__name__)
            success, retryable, message = False, True, f'Processing interrupted: {type(exc).__name__}'
        for task in (processing, heartbeat):
            if not task.done():
                task.cancel()
        await asyncio.gather(processing, heartbeat, return_exceptions=True)
        try:
            await asyncio.to_thread(_convex_call, 'mutation', 'apiJobs:finish', {
                'jobId': job_id, 'leaseId': lease_id, 'success': success, 'retryable': retryable, 'message': message,
            })
        except Exception:
            logger.exception('Could not finish durable partner job %s; lease recovery will reconcile it.', job_id)
    finally:
        for task in (processing, heartbeat):
            task.cancel()
        await asyncio.gather(processing, heartbeat, return_exceptions=True)
        storage.api_job_lease.reset(token)
        _running_jobs.discard(job_id)
        with contextlib.suppress(OSError):
            shutil.rmtree(storage.job_dir(job_id))
        wake_partner_jobs()
