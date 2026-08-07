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
from .storage import get_status, job_dir, set_status, write_json
from .live_scan_storage import finish_live_review
from .telegram import finish_batch_item_and_notify
from .recovery import (
    RecoveredReviewPayload,
    delete_job_payload,
    fail_unrecoverable_jobs,
    list_interrupted_reviews,
    load_recovery_payloads,
    persist_job_payload,
    reconstruct_drive_payloads,
    restore_media,
)
from .automation_storage import (
    heartbeat_automation_run,
    record_review_automation_job_result,
    release_review_automation_claim,
)

logger = logging.getLogger(__name__)

DEFAULT_WORKER_CONCURRENCY = 4
MAX_WORKER_CONCURRENCY = 8
DEFAULT_JOB_TIMEOUT_SECONDS = 30 * 60
MAX_JOB_TIMEOUT_SECONDS = 2 * 60 * 60


@dataclass(frozen=True)
class QueuedReviewJob:
    job_id: str
    media_path: Path | None
    media_kind: MediaKind
    meta: ReviewRequestMeta
    drive_file: DriveFile | None = None
    recovery_payload: RecoveredReviewPayload | None = None


_queue: asyncio.Queue[QueuedReviewJob] = asyncio.Queue()
_workers: list[asyncio.Task[None]] = []
_stopping_workers = False
_workers_requested_to_stop: set[asyncio.Task[None]] = set()
_active_jobs: set[str] = set()
_queue_diagnostics: dict[str, int | str] = {
    'cancelled_count': 0,
    'dequeued_count': 0,
    'enqueued_count': 0,
    'failure_count': 0,
    'finished_count': 0,
    'last_error_type': '',
    'started_count': 0,
    'terminal_count': 0,
}
_recovery_lock = asyncio.Lock()
_drain_lock = asyncio.Lock()
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


def _job_timeout_seconds() -> int:
    try:
        configured = int(os.getenv(
            'JOB_PROCESSING_TIMEOUT_SECONDS',
            str(DEFAULT_JOB_TIMEOUT_SECONDS),
        ))
    except ValueError:
        configured = DEFAULT_JOB_TIMEOUT_SECONDS
    return max(60, min(configured, MAX_JOB_TIMEOUT_SECONDS))


def queue_state() -> dict[str, int | str | bool]:
    return {
        'active': len(_active_jobs),
        'cancelled_count': int(_queue_diagnostics['cancelled_count']),
        'dequeued_count': int(_queue_diagnostics['dequeued_count']),
        'drain_locked': _drain_lock.locked(),
        'enqueued_count': int(_queue_diagnostics['enqueued_count']),
        'failure_count': int(_queue_diagnostics['failure_count']),
        'finished_count': int(_queue_diagnostics['finished_count']),
        'last_error_type': str(_queue_diagnostics['last_error_type']),
        'pending': _queue.qsize(),
        'recovery_locked': _recovery_lock.locked(),
        'started_count': int(_queue_diagnostics['started_count']),
        'terminal_count': int(_queue_diagnostics['terminal_count']),
        'unfinished': int(_queue._unfinished_tasks),
        'workers': len(_workers),
        'workers_done': sum(worker.done() for worker in _workers),
    }


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
        _queue_diagnostics['failure_count'] = int(
            _queue_diagnostics['failure_count']
        ) + 1
        _queue_diagnostics['last_error_type'] = 'CancelledError'
        logger.error('Queue worker %s was cancelled unexpectedly; restarting.', worker_index + 1)
    else:
        error=task.exception()
        _queue_diagnostics['failure_count'] = int(
            _queue_diagnostics['failure_count']
        ) + 1
        _queue_diagnostics['last_error_type'] = (
            type(error).__name__ if error is not None else 'UnexpectedExit'
        )
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
    *,
    persist_payload: bool = True,
    recovery_payload: RecoveredReviewPayload | None = None,
):
    if persist_payload:
        await persist_job_payload(
            job_id,
            media_path,
            media_kind,
            meta,
            file_name,
            file_size,
            drive_file,
        )
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
        await _queue.put(QueuedReviewJob(
            job_id,
            media_path,
            media_kind,
            meta,
            drive_file,
            recovery_payload,
        ))
        _queue_diagnostics['enqueued_count'] = int(
            _queue_diagnostics['enqueued_count']
        ) + 1
    except BaseException:
        await _release_automation_heartbeat(job_id)
        raise
    return record


async def recover_interrupted_jobs() -> dict[str, int]:
    async with _recovery_lock:
        interrupted = await asyncio.to_thread(list_interrupted_reviews)
        job_ids = [review.job_id for review in interrupted]
        if not job_ids:
            return {'failed': 0, 'requeued': 0}
        payloads = await load_recovery_payloads(job_ids)
        reconstructed = await asyncio.to_thread(
            reconstruct_drive_payloads,
            [review for review in interrupted if review.job_id not in payloads],
        )
        payloads.update(reconstructed)
        requeued = 0
        unrecoverable_ids: set[str] = set()
        for job_id in job_ids:
            payload = payloads.get(job_id)
            if payload is None:
                unrecoverable_ids.add(job_id)
                continue
            if (
                payload.media_kind != 'copy_only'
                and payload.drive_file is None
                and payload.media_url is None
            ):
                unrecoverable_ids.add(job_id)
                continue
            file_name = Path(payload.file_name).name
            media_path = (
                job_dir(job_id) / file_name
                if payload.media_kind != 'copy_only'
                else None
            )
            write_json(
                job_dir(job_id) / 'request.json',
                payload.meta.model_dump(mode='json'),
            )
            try:
                await enqueue_job(
                    job_id,
                    media_path,
                    payload.media_kind,
                    payload.meta,
                    file_name,
                    file_size=payload.file_size,
                    drive_file=payload.drive_file,
                    persist_payload=job_id in reconstructed,
                    recovery_payload=payload,
                )
            except Exception:
                logger.exception('Could not requeue interrupted review %s.', job_id)
                continue
            requeued += 1
        failed = await asyncio.to_thread(
            fail_unrecoverable_jobs,
            list(unrecoverable_ids),
        )
        return {'failed': len(failed), 'requeued': requeued}


async def monitor_interrupted_jobs(interval_seconds: float = 60) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        state = queue_state()
        if int(state['active']) > 0 or int(state['pending']) > 0:
            continue
        try:
            recovered = await recover_interrupted_jobs()
        except Exception:
            logger.exception('Periodic interrupted review recovery failed.')
            continue
        if recovered['requeued'] or recovered['failed']:
            logger.warning(
                'Periodic recovery requeued %s review(s) and failed %s unrecoverable review(s).',
                recovered['requeued'],
                recovered['failed'],
            )


async def recover_and_drain_review_queue(
    timeout_seconds: float = 12 * 60,
) -> dict[str, object]:
    """Keep a scheduled request open while background review workers make progress."""
    if _drain_lock.locked():
        return {
            'already_draining': True,
            'drained': False,
            'queue': queue_state(),
            'recovered': {'failed': 0, 'requeued': 0},
        }
    async with _drain_lock:
        return await _recover_and_drain_review_queue(timeout_seconds)


async def _recover_and_drain_review_queue(
    timeout_seconds: float,
) -> dict[str, object]:
    recovered = {'failed': 0, 'requeued': 0}
    state = queue_state()
    if int(state['active']) == 0 and int(state['pending']) == 0:
        recovered = await recover_interrupted_jobs()
    drained = False
    try:
        async with asyncio.timeout(max(1.0, timeout_seconds)):
            await _queue.join()
        drained = True
    except TimeoutError:
        logger.info(
            'Scheduled review queue drain yielded with %s active and %s pending.',
            queue_state()['active'],
            queue_state()['pending'],
        )
    return {
        'already_draining': False,
        'drained': drained,
        'queue': queue_state(),
        'recovered': recovered,
    }


async def _download_drive_file(job: QueuedReviewJob) -> None:
    if job.drive_file is None or job.media_path is None:
        return
    max_bytes = int(os.getenv('MAX_UPLOAD_MB', '400')) * 1024 * 1024
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


async def _restore_recovery_file(job: QueuedReviewJob) -> None:
    payload = job.recovery_payload
    if (
        payload is None
        or payload.media_url is None
        or job.media_path is None
        or job.drive_file is not None
    ):
        return
    set_status(
        job.job_id,
        JobStatus.queued,
        1,
        'Restoring uploaded creative after processing restart',
    )
    await restore_media(payload, job.media_path)


async def _process_queue(worker_index: int) -> None:
    while True:
        job = await _queue.get()
        _queue_diagnostics['dequeued_count'] = int(
            _queue_diagnostics['dequeued_count']
        ) + 1
        _active_jobs.add(job.job_id)
        _register_automation_heartbeat(job.job_id, job.meta)
        terminal = False
        try:
            async with asyncio.timeout(_job_timeout_seconds()):
                set_status(job.job_id, JobStatus.queued, 0, f'Starting worker {worker_index + 1}')
                _queue_diagnostics['started_count'] = int(
                    _queue_diagnostics['started_count']
                ) + 1
                await _restore_recovery_file(job)
                await _download_drive_file(job)
                await process_job(job.job_id, job.media_path, job.media_kind, job.meta)
            record = await asyncio.to_thread(get_status, job.job_id)
            terminal = record.status in {JobStatus.complete, JobStatus.failed}
        except asyncio.CancelledError:
            _queue_diagnostics['cancelled_count'] = int(
                _queue_diagnostics['cancelled_count']
            ) + 1
            raise
        except Exception as exc:
            _queue_diagnostics['failure_count'] = int(
                _queue_diagnostics['failure_count']
            ) + 1
            _queue_diagnostics['last_error_type'] = type(exc).__name__
            logger.exception(
                'Queue worker %s failed while processing job %s',
                worker_index + 1,
                job.job_id,
            )
            try:
                message = (
                    f'Queue processing timed out after {_job_timeout_seconds() // 60} minutes'
                    if isinstance(exc, TimeoutError)
                    else f'Queue processing failed: {type(exc).__name__}'
                )
                set_status(
                    job.job_id,
                    JobStatus.failed,
                    100,
                    message,
                )
                terminal = True
                try:
                    release_review_automation_claim(job.meta)
                except Exception:
                    logger.exception('Could not release automation claim for failed job %s', job.job_id)
                if job.meta.live_scan_kind and job.meta.live_scan_key:
                    try:
                        finish_live_review(
                            job.meta.live_scan_kind,
                            job.meta.live_scan_key,
                            job.job_id,
                            status='failed',
                        )
                    except Exception:
                        logger.exception('Could not fail live scan review %s',job.job_id)
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
                        message=message,
                    )
            except Exception:
                logger.exception(
                    'Queue worker %s could not mark job %s as failed',
                    worker_index + 1,
                    job.job_id,
                )
        finally:
            await _release_automation_heartbeat(job.job_id)
            if terminal:
                _queue_diagnostics['terminal_count'] = int(
                    _queue_diagnostics['terminal_count']
                ) + 1
                await delete_job_payload(job.job_id)
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
            _active_jobs.discard(job.job_id)
            _queue_diagnostics['finished_count'] = int(
                _queue_diagnostics['finished_count']
            ) + 1
            _queue.task_done()
