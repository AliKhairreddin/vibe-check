from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from .jobs import process_job
from .media import MediaKind
from .models import JobStatus, ReviewRequestMeta
from .storage import set_status

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class QueuedReviewJob:
    job_id: str
    media_path: Path | None
    media_kind: MediaKind
    meta: ReviewRequestMeta


_queue: asyncio.Queue[QueuedReviewJob] = asyncio.Queue()
_workers: list[asyncio.Task[None]] = []


def _worker_count() -> int:
    try:
        return max(1, int(os.getenv('JOB_WORKER_CONCURRENCY', '1')))
    except ValueError:
        return 1


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
        has_ad_copy=meta.has_ad_copy,
        has_creative=media_kind != 'copy_only',
    )
    await _queue.put(QueuedReviewJob(job_id, media_path, media_kind, meta))
    return record


async def _process_queue(worker_index: int) -> None:
    while True:
        job = await _queue.get()
        try:
            set_status(job.job_id, JobStatus.queued, 0, f'Starting worker {worker_index + 1}')
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
            except Exception:
                logger.exception(
                    'Queue worker %s could not mark job %s as failed',
                    worker_index + 1,
                    job.job_id,
                )
        finally:
            _queue.task_done()
