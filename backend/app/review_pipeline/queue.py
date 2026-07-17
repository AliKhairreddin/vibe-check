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
from .automation_storage import (
    heartbeat_automation_run,
    record_review_automation_job_result,
    release_review_automation_claim,
)

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
_stopping_workers = False
_workers_requested_to_stop: set[asyncio.Task[None]] = set()
_automation_heartbeat_jobs: dict[str, tuple[str, str]] = {}
_automation_heartbeat_ref_counts: dict[tuple[str, str], int] = {}
_automation_heartbeat_tasks: dict[tuple[str, str], asyncio.Task[None]] = {}


async def _keep_automation_lease_alive(meta: ReviewRequestMeta) -> None:
    if not (meta.automation_id and meta.automation_run_id):
        return
    delay_seconds = 5 * 60
    while True:
        await asyncio.sleep(delay_seconds)
        try:
            await asyncio.to_thread(
                heartbeat_automation_run,
                meta.automation_id,
                meta.automation_run_id,
            )
        except RuntimeError as exc:
            if 'lease is no longer active' in str(exc).casefold():
                logger.warning(
                    'Automation lease is no longer active for run %s.',
                    meta.automation_run_id,
                )
                return
            logger.warning(
                'Automation heartbeat temporarily failed for run %s; retrying.',
                meta.automation_run_id,
            )
            delay_seconds = 60
        except Exception:
            logger.warning(
                'Automation heartbeat temporarily failed for run %s; retrying.',
                meta.automation_run_id,
            )
            delay_seconds = 60
        else:
            delay_seconds = 5 * 60


def _register_automation_heartbeat(job_id: str, meta: ReviewRequestMeta) -> None:
    if not (meta.automation_id and meta.automation_run_id):
        return
    if job_id in _automation_heartbeat_jobs:
        return
    key=(meta.automation_id, meta.automation_run_id)
    _automation_heartbeat_jobs[job_id]=key
    _automation_heartbeat_ref_counts[key]=_automation_heartbeat_ref_counts.get(key, 0) + 1
    task=_automation_heartbeat_tasks.get(key)
    if task is None or task.done():
        _automation_heartbeat_tasks[key]=asyncio.create_task(
            _keep_automation_lease_alive(meta)
        )


async def _release_automation_heartbeat(job_id: str) -> None:
    key=_automation_heartbeat_jobs.pop(job_id, None)
    if key is None:
        return
    remaining=_automation_heartbeat_ref_counts.get(key, 1) - 1
    if remaining > 0:
        _automation_heartbeat_ref_counts[key]=remaining
        return
    _automation_heartbeat_ref_counts.pop(key, None)
    task=_automation_heartbeat_tasks.pop(key, None)
    if task is not None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


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
        _spawn_worker(index)


def _spawn_worker(index: int) -> None:
    task=asyncio.create_task(_process_queue(index))
    _workers.append(task)
    task.add_done_callback(lambda completed, worker_index=index: _worker_finished(
        completed,
        worker_index,
    ))


def _worker_finished(task: asyncio.Task[None], worker_index: int) -> None:
    if task in _workers:
        _workers.remove(task)
    stop_requested=task in _workers_requested_to_stop
    _workers_requested_to_stop.discard(task)
    if _stopping_workers or stop_requested:
        return
    if task.cancelled():
        logger.error('Queue worker %s was cancelled unexpectedly; restarting.', worker_index + 1)
    else:
        error=task.exception()
        logger.error(
            'Queue worker %s stopped unexpectedly; restarting. error_type=%s',
            worker_index + 1,
            type(error).__name__ if error is not None else 'UnexpectedExit',
        )
    try:
        _spawn_worker(worker_index)
    except RuntimeError:
        logger.exception('Could not restart queue worker %s.', worker_index + 1)


async def stop_job_workers() -> None:
    global _stopping_workers
    _stopping_workers=True
    workers=list(_workers)
    _workers_requested_to_stop.update(workers)
    for worker in workers:
        worker.cancel()
    for worker in workers:
        with contextlib.suppress(asyncio.CancelledError):
            await worker
    _workers.clear()
    heartbeat_tasks=list(_automation_heartbeat_tasks.values())
    for task in heartbeat_tasks:
        task.cancel()
    for task in heartbeat_tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task
    _automation_heartbeat_jobs.clear()
    _automation_heartbeat_ref_counts.clear()
    _automation_heartbeat_tasks.clear()
    _stopping_workers=False


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
        automation_run_id=meta.automation_run_id,
    )
    _register_automation_heartbeat(job_id, meta)
    try:
        await _queue.put(QueuedReviewJob(job_id, media_path, media_kind, meta, drive_file))
    except BaseException:
        await _release_automation_heartbeat(job_id)
        raise
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
        _register_automation_heartbeat(job.job_id, job.meta)
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
                try:
                    release_review_automation_claim(job.meta)
                except Exception:
                    logger.exception('Could not release automation claim for failed job %s', job.job_id)
                try:
                    record_review_automation_job_result(job.meta, job.job_id)
                except Exception:
                    logger.exception('Could not finalize automation run for failed job %s', job.job_id)
                if job.meta.has_batch:
                    await asyncio.to_thread(
                        finish_batch_item_and_notify,
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
            await _release_automation_heartbeat(job.job_id)
            if job.drive_file is not None and job.media_path is not None:
                for path in (
                    job.media_path,
                    job.media_path.with_name(f'.{job.media_path.name}.drive-download'),
                ):
                    try:
                        path.unlink(missing_ok=True)
                    except OSError:
                        logger.warning(
                            'Could not remove temporary Drive file for job %s.',
                            job.job_id,
                        )
            _queue.task_done()
