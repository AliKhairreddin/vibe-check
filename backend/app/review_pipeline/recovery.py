from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

from . import storage
from .drive import DriveFile
from .media import MediaKind, detect_media_kind
from .models import ReviewRequestMeta
from .verticals import ReviewVertical, classify_review_vertical

logger = logging.getLogger(__name__)

PAYLOAD_VERSION = 1
UPLOAD_TIMEOUT = httpx.Timeout(125.0, connect=20.0)
DOWNLOAD_TIMEOUT = httpx.Timeout(300.0, connect=20.0)
MANIFEST_DOWNLOAD_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
MANIFEST_DOWNLOAD_CONCURRENCY = 8
MANIFEST_DOWNLOAD_DEADLINE_SECONDS = 35
MANIFEST_BATCH_DEADLINE_SECONDS = 35
INTERRUPTED_MESSAGE = (
    'Review processing was interrupted and its durable recovery copy is unavailable. '
    'Please re-upload this creative to retry.'
)


@dataclass(frozen=True)
class RecoveredReviewPayload:
    job_id: str
    file_name: str
    file_size: int | None
    media_kind: MediaKind
    meta: ReviewRequestMeta
    media_url: str | None = None
    drive_file: DriveFile | None = None


@dataclass(frozen=True)
class InterruptedReview:
    job_id: str
    file_name: str
    file_size: int | None
    source_kind: str | None
    source_file_id: str | None
    source_url: str | None
    batch_id: str | None
    batch_item_id: str | None
    offer_ids: tuple[str, ...]
    has_ad_copy: bool
    vertical: ReviewVertical = 'auto-insurance'


def _upload_blob(value: bytes | Path, content_type: str) -> str:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            upload_url = storage._convex_call(
                'mutation',
                'reviewPayloads:generateUploadUrl',
                {},
            )
            if not isinstance(upload_url, str) or not upload_url.startswith('https://'):
                raise RuntimeError('Convex returned an invalid payload upload URL.')
            headers = {'content-type': content_type}
            with httpx.Client(timeout=UPLOAD_TIMEOUT, follow_redirects=True) as client:
                if isinstance(value, Path):
                    headers['content-length'] = str(value.stat().st_size)
                    with value.open('rb') as body:
                        response = client.post(upload_url, headers=headers, content=body)
                else:
                    headers['content-length'] = str(len(value))
                    response = client.post(upload_url, headers=headers, content=value)
            response.raise_for_status()
            payload = response.json()
            storage_id = payload.get('storageId') if isinstance(payload, dict) else None
            if not isinstance(storage_id, str) or not storage_id:
                raise RuntimeError('Convex did not return a payload storage ID.')
            return storage_id
        except (httpx.HTTPError, OSError, ValueError, RuntimeError) as exc:
            last_error = exc
            if attempt == 3:
                break
    raise RuntimeError(
        f'Could not save a durable recovery copy: {type(last_error).__name__}'
    ) from last_error


def _persist_job_payload_sync(
    job_id: str,
    media_path: Path | None,
    media_kind: MediaKind,
    meta: ReviewRequestMeta,
    file_name: str,
    file_size: int | None,
    drive_file: DriveFile | None,
) -> None:
    if not storage.convex_enabled() or meta.automation_run_id:
        return
    manifest = {
        'version': PAYLOAD_VERSION,
        'job_id': job_id,
        'file_name': file_name,
        'file_size': file_size,
        'media_kind': media_kind,
        'meta': meta.model_dump(mode='json'),
        'drive_file': asdict(drive_file) if drive_file else None,
    }
    manifest_storage_id: str | None = None
    media_storage_id: str | None = None
    try:
        manifest_storage_id = _upload_blob(
            json.dumps(manifest, ensure_ascii=False).encode('utf-8'),
            'application/json',
        )
        if media_path is not None and drive_file is None:
            media_storage_id = _upload_blob(media_path, 'application/octet-stream')
        args: dict[str, Any] = {
            'jobId': job_id,
            'manifestStorageId': manifest_storage_id,
        }
        if media_storage_id:
            args['mediaStorageId'] = media_storage_id
        storage._convex_call('mutation', 'reviewPayloads:save', args)
    except Exception:
        orphaned = [
            storage_id
            for storage_id in (manifest_storage_id, media_storage_id)
            if storage_id
        ]
        if orphaned:
            with contextlib.suppress(Exception):
                storage._convex_call(
                    'mutation',
                    'reviewPayloads:removeFiles',
                    {'storageIds': orphaned},
                )
        raise


async def persist_job_payload(
    job_id: str,
    media_path: Path | None,
    media_kind: MediaKind,
    meta: ReviewRequestMeta,
    file_name: str,
    file_size: int | None,
    drive_file: DriveFile | None,
) -> None:
    await asyncio.to_thread(
        _persist_job_payload_sync,
        job_id,
        media_path,
        media_kind,
        meta,
        file_name,
        file_size,
        drive_file,
    )


def list_interrupted_reviews(limit: int = 500) -> list[InterruptedReview]:
    if not storage.convex_enabled():
        return []
    rows = storage._convex_call(
        'query',
        'reviews:listInterrupted',
        {'limit': max(1, min(limit, 500))},
    )
    if not isinstance(rows, list):
        raise RuntimeError('Interrupted review lookup returned an invalid response.')
    interrupted: list[InterruptedReview] = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('jobId'), str):
            continue
        raw_offer_ids = row.get('offerIds')
        offer_ids = tuple(
            str(offer_id)
            for offer_id in raw_offer_ids
            if isinstance(offer_id, str)
        ) if isinstance(raw_offer_ids, list) else ('acp',)
        interrupted.append(InterruptedReview(
            job_id=row['jobId'],
            file_name=str(row.get('fileName') or ''),
            file_size=(
                int(row['fileSize'])
                if row.get('fileSize') is not None
                else None
            ),
            source_kind=(
                str(row['sourceKind'])
                if row.get('sourceKind') is not None
                else None
            ),
            source_file_id=(
                str(row['sourceFileId'])
                if row.get('sourceFileId') is not None
                else None
            ),
            source_url=(
                str(row['sourceUrl'])
                if row.get('sourceUrl') is not None
                else None
            ),
            batch_id=(
                str(row['batchId'])
                if row.get('batchId') is not None
                else None
            ),
            batch_item_id=(
                str(row['batchItemId'])
                if row.get('batchItemId') is not None
                else None
            ),
            offer_ids=offer_ids or ('acp',),
            has_ad_copy=bool(row.get('hasAdCopy')),
            vertical=(
                row['vertical']
                if row.get('vertical') in {'auto-insurance', 'home-insurance'}
                else classify_review_vertical(str(row.get('fileName') or ''))
            ),
        ))
    return interrupted


def reconstruct_drive_payloads(
    reviews: list[InterruptedReview],
) -> dict[str, RecoveredReviewPayload]:
    candidates = [
        review
        for review in reviews
        if (
            review.source_kind == 'google_drive_file'
            and review.source_file_id
            and review.file_name
            and not review.has_ad_copy
        )
    ]
    if not candidates:
        return {}
    active_profiles, offer_outcomes = storage.resolve_review_offer_snapshot()
    profiles_by_id = {profile.offer_id: profile for profile in active_profiles}
    recovered: dict[str, RecoveredReviewPayload] = {}
    for review in candidates:
        try:
            media_kind = detect_media_kind(review.file_name)
            offer_profiles = [
                profiles_by_id[offer_id].model_copy(deep=True)
                for offer_id in review.offer_ids
            ]
            if len(offer_profiles) != len(review.offer_ids):
                continue
            meta = ReviewRequestMeta(
                batch_id=review.batch_id,
                batch_item_id=review.batch_item_id,
                vertical=review.vertical,
                offer_profiles=offer_profiles,
                offer_outcomes=[
                    outcome.model_copy(deep=True)
                    for outcome in offer_outcomes
                ],
            )
            recovered[review.job_id] = RecoveredReviewPayload(
                job_id=review.job_id,
                file_name=Path(review.file_name).name,
                file_size=review.file_size,
                media_kind=media_kind,
                meta=meta,
                drive_file=DriveFile(
                    file_id=review.source_file_id or '',
                    name=Path(review.file_name).name,
                    mime_type=(
                        'video/mp4'
                        if media_kind == 'video'
                        else 'application/octet-stream'
                    ),
                    parents=(),
                    web_view_link=(
                        review.source_url
                        or f'https://drive.google.com/file/d/{review.source_file_id}/view'
                    ),
                    size=review.file_size,
                ),
            )
        except (KeyError, TypeError, ValueError):
            logger.exception(
                'Could not reconstruct Google Drive recovery data for job %s.',
                review.job_id,
            )
    return recovered


def _drive_file(value: Any) -> DriveFile | None:
    if not isinstance(value, dict):
        return None
    return DriveFile(
        file_id=str(value['file_id']),
        name=str(value['name']),
        mime_type=str(value['mime_type']),
        parents=tuple(str(parent) for parent in value.get('parents', [])),
        web_view_link=str(value['web_view_link']),
        size=int(value['size']) if value.get('size') is not None else None,
        modified_time=(
            str(value['modified_time'])
            if value.get('modified_time') is not None
            else None
        ),
        can_download=bool(value.get('can_download', True)),
    )


def _list_payload_rows_sync(job_ids: list[str]) -> list[dict[str, Any]]:
    payload_rows: list[dict[str, Any]] = []
    for offset in range(0, len(job_ids), 100):
        rows = storage._convex_call(
            'query',
            'reviewPayloads:listForJobs',
            {'jobIds': job_ids[offset:offset + 100]},
        )
        if not isinstance(rows, list):
            raise RuntimeError('Review payload lookup returned an invalid response.')
        payload_rows.extend(row for row in rows if isinstance(row, dict))
    return payload_rows


async def _load_payload_row(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    row: dict[str, Any],
) -> RecoveredReviewPayload | None:
    job_id = row.get('jobId')
    try:
        manifest_url = row.get('manifestUrl')
        if not isinstance(job_id, str) or not isinstance(manifest_url, str):
            return None
        async with semaphore:
            async with asyncio.timeout(MANIFEST_DOWNLOAD_DEADLINE_SECONDS):
                response = await client.get(manifest_url)
        response.raise_for_status()
        manifest = response.json()
        if (
            not isinstance(manifest, dict)
            or manifest.get('version') != PAYLOAD_VERSION
            or manifest.get('job_id') != job_id
        ):
            raise RuntimeError('Review payload manifest is invalid.')
        media_kind = manifest.get('media_kind')
        if media_kind not in {'video', 'image', 'copy_only'}:
            raise RuntimeError('Review payload media type is invalid.')
        file_name = str(manifest.get('file_name') or '')
        if media_kind != 'copy_only' and not Path(file_name).name:
            raise RuntimeError('Review payload file name is invalid.')
        media_url = row.get('mediaUrl')
        return RecoveredReviewPayload(
            job_id=job_id,
            file_name=file_name,
            file_size=(
                int(manifest['file_size'])
                if manifest.get('file_size') is not None
                else None
            ),
            media_kind=media_kind,
            meta=ReviewRequestMeta.model_validate(manifest.get('meta')),
            media_url=media_url if isinstance(media_url, str) else None,
            drive_file=_drive_file(manifest.get('drive_file')),
        )
    except Exception:
        logger.exception(
            'Could not load durable recovery manifest for job %s.',
            job_id if isinstance(job_id, str) else 'unknown',
        )
        return None


async def load_recovery_payloads(
    job_ids: list[str],
) -> dict[str, RecoveredReviewPayload]:
    if not job_ids:
        return {}
    rows = await asyncio.to_thread(_list_payload_rows_sync, job_ids)
    semaphore = asyncio.Semaphore(MANIFEST_DOWNLOAD_CONCURRENCY)
    async with httpx.AsyncClient(
        timeout=MANIFEST_DOWNLOAD_TIMEOUT,
        follow_redirects=True,
        limits=httpx.Limits(
            max_connections=MANIFEST_DOWNLOAD_CONCURRENCY,
            max_keepalive_connections=MANIFEST_DOWNLOAD_CONCURRENCY,
        ),
    ) as client:
        tasks = [
            asyncio.create_task(_load_payload_row(client, semaphore, row))
            for row in rows
        ]
        done, pending = await asyncio.wait(
            tasks,
            timeout=MANIFEST_BATCH_DEADLINE_SECONDS,
        )
        if pending:
            logger.warning(
                'Durable recovery manifest batch deadline expired with %s request(s) pending.',
                len(pending),
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        loaded = [
            task.result()
            for task in done
            if not task.cancelled()
        ]
    return {
        payload.job_id: payload
        for payload in loaded
        if payload is not None
    }


def _restore_media_sync(payload: RecoveredReviewPayload, destination: Path) -> None:
    if not payload.media_url:
        raise RuntimeError(f'Recovery media is unavailable for job {payload.job_id}.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f'.{destination.name}.recovering')
    downloaded = 0
    try:
        with httpx.stream(
            'GET',
            payload.media_url,
            timeout=DOWNLOAD_TIMEOUT,
            follow_redirects=True,
        ) as response:
            response.raise_for_status()
            with temporary.open('wb') as output:
                for chunk in response.iter_bytes(1024 * 1024):
                    output.write(chunk)
                    downloaded += len(chunk)
        if payload.file_size is not None and downloaded != payload.file_size:
            raise RuntimeError(
                f'Restored media size mismatch for job {payload.job_id}: '
                f'expected {payload.file_size}, received {downloaded}.'
            )
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


async def restore_media(
    payload: RecoveredReviewPayload,
    destination: Path,
) -> None:
    await asyncio.to_thread(_restore_media_sync, payload, destination)


def fail_unrecoverable_jobs(job_ids: list[str]) -> list[str]:
    failed: list[str] = []
    for offset in range(0, len(job_ids), 100):
        result = storage._convex_call(
            'mutation',
            'reviews:failInterrupted',
            {
                'jobIds': job_ids[offset:offset + 100],
                'message': INTERRUPTED_MESSAGE,
            },
        )
        if isinstance(result, dict) and isinstance(result.get('failedJobIds'), list):
            failed.extend(str(job_id) for job_id in result['failedJobIds'])
    return failed


async def delete_job_payload(job_id: str) -> None:
    if not storage.convex_enabled():
        return
    try:
        await asyncio.to_thread(
            storage._convex_call,
            'mutation',
            'reviewPayloads:remove',
            {'jobId': job_id},
        )
    except Exception:
        logger.exception('Could not delete durable recovery payload for job %s.', job_id)
