from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from .drive import DriveFile, get_google_drive_client
from .jobs import process_job
from .media import MediaKind
from .models import JobStatus, ReviewRequestMeta
from .storage import set_status
from .telegram import finish_batch_item_and_notify

logger = logging.getLogger(__name__)

DEFAULT_WORKER_CONCURRENCY = 4
MAX_WORKER_CONCURRENCY = 8


@dataclass(frozen=True)
class QueuedReviewJob:
    job_id: str
    media_path: Path | None
    media_kind: MediaKind
    meta: ReviewRequestMeta
    drive_file: DriveFile | None = None


_queue: asyncio.Queue[QueuedReviewJob] = asyncio.Queue()
_workers: list[asyncio.Task[None]] = []


def _worker_count() -> int:
    try:
        configured = int(os.getenv('JOB_WORKER_CONCURRENCY', str(DEFAULT_WORKER_CONCURRENCY)))
    except ValueError:
        configured = DEFAULT_WORKER_CONCURRENCY
    return max(1, min(configured, MAX_WORKER_CONCURRENCY))


async def start_job_workers() -> None:
    if _workers:
        return
    for index in range(_worker_count()):
        _workers.append(asyncio.create_task(_process_queue(index)))


async def stop_job_workers() -> None:
    for worker in _workers:
        worker.cancel()
    for worker in _workers:
        with contextlib.suppress(asyncio.CancelledError):
            await worker
    _workers.clear()


async def enqueue_job(
    job_id: str,
    media_path: Path | None,
    media_kind: MediaKind,
    meta: ReviewRequestMeta,
    file_name: str,
    file_size: int | None = None,
    drive_file: DriveFile | None = None,
):
    position = _queue.qsize() + 1
    message = 'Queued for processing'
    if position > _worker_count():
        message = f'Queued for processing ({position - _worker_count()} ahead)'
    record = set_status(
        job_id,
        JobStatus.queued,
        0,
        message,
        file_name,
        file_size,
        has_ad_copy=meta.has_ad_copy,
        has_creative=media_kind != 'copy_only',
        batch_id=meta.batch_id,
        batch_item_id=meta.batch_item_id,
        offer_ids=meta.offer_ids,
        primary_offer_id=meta.primary_offer_id,
    )
    await _queue.put(QueuedReviewJob(job_id, media_path, media_kind, meta, drive_file))
    return record


async def _download_drive_file(job: QueuedReviewJob) -> None:
    if job.drive_file is None or job.media_path is None:
        return
    max_bytes = int(os.getenv('MAX_UPLOAD_MB', '200')) * 1024 * 1024
    last_progress = -1

    def update_progress(downloaded: int, expected: int | None) -> None:
        nonlocal last_progress
        if expected and expected > 0:
            progress = max(1, min(9, int((downloaded / expected) * 9)))
        else:
            progress = 5
        if progress == last_progress:
            return
        last_progress = progress
        set_status(
            job.job_id,
            JobStatus.downloading_from_drive,
            progress,
            f'Downloading from Google Drive ({progress * 100 // 9}%)',
        )

    set_status(
        job.job_id,
        JobStatus.downloading_from_drive,
        1,
        'Downloading from Google Drive',
    )
    await asyncio.to_thread(
        get_google_drive_client().download_file,
        job.drive_file,
        job.media_path,
        max_bytes=max_bytes,
        progress_callback=update_progress,
    )


async def _process_queue(worker_index: int) -> None:
    while True:
        job = await _queue.get()
        try:
            set_status(job.job_id, JobStatus.queued, 0, f'Starting worker {worker_index + 1}')
            await _download_drive_file(job)
            await process_job(job.job_id, job.media_path, job.media_kind, job.meta)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception(
                'Queue worker %s failed while processing job %s',
                worker_index + 1,
                job.job_id,
            )
            try:
                set_status(
                    job.job_id,
                    JobStatus.failed,
                    100,
                    f'Queue processing failed: {type(exc).__name__}',
                )
                if job.meta.has_batch:
                    finish_batch_item_and_notify(
                        job.meta.batch_id or '',
                        job.meta.batch_item_id or '',
                        status='failed',
                        job_id=job.job_id,
                        message=f'Queue processing failed: {type(exc).__name__}',
                    )
            except Exception:
                logger.exception(
                    'Queue worker %s could not mark job %s as failed',
                    worker_index + 1,
                    job.job_id,
                )
        finally:
            if job.drive_file is not None and job.media_path is not None:
                job.media_path.unlink(missing_ok=True)
                job.media_path.with_name(f'.{job.media_path.name}.drive-download').unlink(missing_ok=True)
            _queue.task_done()
