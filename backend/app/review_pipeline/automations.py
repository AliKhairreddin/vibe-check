from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import logging
import os
import re
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from .automation_storage import (
    attach_automation_batch_items,
    claim_automation_files,
    claim_automation_run,
    finish_automation_run,
    get_review_automation,
    heartbeat_automation_run,
    list_review_automations,
    mark_automation_run_retry_required,
    release_automation_files,
)
from .drive import (
    FOLDER_MIME_TYPE,
    MAX_DRIVE_SELECTION_FILES,
    MAX_DRIVE_SELECTION_FOLDERS,
    DriveFile,
    DriveLookupError,
    get_google_drive_client,
)
from .media import detect_media_kind
from .models import (
    AutomationRunResult,
    CreateBatchItem,
    OfferOutcome,
    OfferProfile,
    ReviewAutomation,
    ReviewRequestMeta,
    ReviewSource,
)
from .queue import enqueue_job
from .storage import (
    create_batch,
    job_dir,
    now_ms,
    resolve_review_offer_snapshot,
    set_review_source,
)
from .telegram import finish_batch_item_and_notify

logger = logging.getLogger(__name__)


async def _keep_run_lease_alive(automation_id:str, run_id:str)->None:
    delay_seconds=5 * 60
    while True:
        await asyncio.sleep(delay_seconds)
        try:
            await asyncio.to_thread(
                heartbeat_automation_run,
                automation_id,
                run_id,
            )
        except RuntimeError as exc:
            if 'lease is no longer active' in str(exc).casefold():
                return
            logger.warning('Automation scan heartbeat failed; retrying run %s.', run_id)
            delay_seconds=60
        except Exception:
            logger.warning('Automation scan heartbeat failed; retrying run %s.', run_id)
            delay_seconds=60
        else:
            delay_seconds=5 * 60


def rendered_file_pattern(automation: ReviewAutomation, local_now: datetime) -> str:
    replacements = {
        '{date}': local_now.strftime('%Y-%m-%d'),
        '{YYYY-MM-DD}': local_now.strftime('%Y-%m-%d'),
        '{YYYY}': local_now.strftime('%Y'),
        '{MM}': local_now.strftime('%m'),
        '{DD}': local_now.strftime('%d'),
    }
    pattern = automation.file_name_pattern.strip() or '*'
    for token, value in replacements.items():
        pattern = pattern.replace(token, value)
    return pattern


def due_schedule_key(
    automation: ReviewAutomation,
    current_time: datetime | None = None,
) -> str | None:
    now = current_time or datetime.now(timezone.utc)
    local_now = now.astimezone(ZoneInfo(automation.timezone))
    if local_now.weekday() not in automation.days_of_week:
        return None
    hour, minute = (int(part) for part in automation.time_of_day.split(':', 1))
    if (local_now.hour, local_now.minute) < (hour, minute):
        return None
    return f'{local_now.date().isoformat()}@{automation.time_of_day}'


def _scheduled_local_time(automation:ReviewAutomation, scheduled_for:str|None)->datetime:
    match=re.fullmatch(r'(\d{4}-\d{2}-\d{2})@(\d{2}:\d{2})', scheduled_for or '')
    if match:
        return datetime.fromisoformat(
            f'{match.group(1)}T{match.group(2)}:00'
        ).replace(tzinfo=ZoneInfo(automation.timezone))
    return datetime.now(timezone.utc).astimezone(ZoneInfo(automation.timezone))


def _matching_drive_files(
    automation: ReviewAutomation,
    scheduled_for: str | None = None,
) -> list[DriveFile]:
    drive = get_google_drive_client()
    folder = drive.get_file(automation.folder_id)
    if folder.mime_type != FOLDER_MIME_TYPE:
        raise ValueError('The automation source must be a Google Drive folder.')
    max_bytes = int(os.getenv('MAX_UPLOAD_MB', '200')) * 1024 * 1024
    local_now = _scheduled_local_time(automation, scheduled_for)
    pattern = rendered_file_pattern(automation, local_now).casefold()
    pending=deque([folder.file_id])
    visited:set[str]=set()
    matches:dict[str, DriveFile]={}
    while pending:
        folder_id=pending.popleft()
        if folder_id in visited:
            continue
        visited.add(folder_id)
        if len(visited) > MAX_DRIVE_SELECTION_FOLDERS:
            raise DriveLookupError('The automation folder has too many nested folders.')
        for file in drive.list_folder_children(folder_id):
            if file.mime_type == FOLDER_MIME_TYPE:
                if automation.include_subfolders:
                    pending.append(file.file_id)
                continue
            if (
                not file.can_download
                or (file.size is not None and file.size > max_bytes)
                or not fnmatch.fnmatchcase(file.name.casefold(), pattern)
            ):
                continue
            matches[file.file_id]=file
            if len(matches) > MAX_DRIVE_SELECTION_FILES:
                raise DriveLookupError(
                    f'An automation can match at most {MAX_DRIVE_SELECTION_FILES} creatives per run.'
                )
    return list(matches.values())


async def _enqueue_automation_file(
    automation: ReviewAutomation,
    drive_file: DriveFile,
    *,
    job_id: str,
    run_id: str,
    batch_id: str | None,
    batch_item_id: str | None,
    active_profiles: list[OfferProfile],
    offer_outcomes: list[OfferOutcome],
) -> str:
    file_name = Path(drive_file.name).name or 'drive-creative'
    media_kind = detect_media_kind(file_name, drive_file.mime_type)
    meta = ReviewRequestMeta(
        batch_id=batch_id,
        batch_item_id=batch_item_id,
        offer_profiles=active_profiles,
        offer_outcomes=offer_outcomes,
        automation_id=automation.automation_id,
        automation_run_id=run_id,
        automation_file_id=drive_file.file_id,
        automation_file_modified_time=drive_file.modified_time or '',
    )
    destination = job_dir(job_id) / file_name
    (job_dir(job_id) / 'request.json').write_text(
        meta.model_dump_json(indent=2),
        encoding='utf-8',
    )
    record = await enqueue_job(
        job_id,
        destination,
        media_kind,
        meta,
        file_name,
        file_size=drive_file.size,
        drive_file=drive_file,
    )
    try:
        set_review_source(job_id, ReviewSource(
            kind='google_drive_file',
            status='linked',
            url=drive_file.web_view_link,
            file_id=drive_file.file_id,
            label='Open creative in Google Drive',
            message=f'Queued automatically by “{automation.name}”.',
            checked_at=now_ms(),
        ))
    except Exception:
        # The job is already durable and queued. Source-link metadata is useful
        # but must never make the automation release its claim and enqueue a duplicate.
        logger.exception('Could not attach Drive source metadata to automated job %s', job_id)
    return record.job_id


async def run_review_automation(
    automation: ReviewAutomation,
    *,
    manual: bool = False,
    scheduled_for: str | None = None,
) -> AutomationRunResult:
    schedule_key = scheduled_for or (
        automation.last_scheduled_for
        if manual and automation.last_run_status == 'failed' and automation.last_scheduled_for
        else f'manual:{uuid.uuid4().hex}' if manual
        else due_schedule_key(automation)
    )
    if not schedule_key:
        return AutomationRunResult(
            automation=automation,
            status='not_due',
            message='This automation is not due yet.',
        )
    run_id = claim_automation_run(
        automation,
        schedule_key,
        allow_disabled=manual,
    )
    if run_id is None:
        return AutomationRunResult(
            automation=get_review_automation(automation.automation_id),
            status='already_claimed',
            message='This scheduled run has already been claimed.',
        )

    matched_count = 0
    claimed_values:list[dict[str, str]]=[]
    queued_file_ids:set[str]=set()
    batch_id:str|None=None
    batch_items:list[CreateBatchItem]=[]
    batch_item_by_file_id:dict[str, CreateBatchItem]={}
    job_ids:list[str]=[]
    failures:list[str]=[]
    heartbeat_task=asyncio.create_task(
        _keep_run_lease_alive(automation.automation_id, run_id)
    )
    try:
        active_profiles,offer_outcomes=resolve_review_offer_snapshot()
        if not active_profiles:
            raise ValueError(
                'No offers are available. Save official guidelines and enable at least one offer first.'
            )
        matching_files = await asyncio.to_thread(
            _matching_drive_files,
            automation,
            schedule_key,
        )
        heartbeat_automation_run(automation.automation_id, run_id)
        matched_count = len(matching_files)
        claim_values = claim_automation_files(
            automation.automation_id,
            run_id,
            [
                {
                    'file_id': file.file_id,
                    'file_name': file.name,
                    'job_id': uuid.uuid4().hex,
                    'modified_time': file.modified_time or '',
                }
                for file in matching_files
            ],
        )
        claimed_values=claim_values
        claims_by_file={value['file_id']:value for value in claim_values}
        files = [file for file in matching_files if file.file_id in claims_by_file]
        if not files:
            message = (
                'No creatives matched the folder and filename rule.'
                if not matching_files
                else 'All matching creatives were already reviewed at their current Drive version.'
            )
            updated = finish_automation_run(
                run_id,
                automation.automation_id,
                status='no_matches',
                message=message,
                matched_count=matched_count,
                queued_count=0,
            )
            return AutomationRunResult(
                automation=updated,
                status='no_matches',
                message=message,
                matched_count=matched_count,
            )

        # Every automated run uses a batch, including a single match, so its
        # Telegram notification benefits from the durable batch outbox.
        batch_id = uuid.uuid4().hex
        batch_items = [
            CreateBatchItem(
                item_id=uuid.uuid4().hex,
                file_name=file.name,
                media_kind=(
                    'video'
                    if file.mime_type.startswith('video/') or file.name.casefold().endswith('.mp4')
                    else 'image'
                ),
            )
            for file in files
        ]
        batch_item_by_file_id={
            file.file_id:item
            for file,item in zip(files, batch_items, strict=True)
        }
        if batch_id:
            # Setup failures are reconciled by the unified outer handler. It
            # only releases a file claim after its mapped batch item is known
            # terminal, preserving recovery metadata when createBatch commits
            # but the caller loses the response.
            attach_automation_batch_items(
                automation.automation_id,
                run_id,
                [
                    {
                        'batch_id':batch_id,
                        'batch_item_id':item.item_id,
                        'job_id':claims_by_file[file.file_id]['job_id'],
                    }
                    for file,item in zip(files, batch_items, strict=True)
                ],
            )
            create_batch(batch_id, batch_items, offer_outcomes)

        for file,item in zip(files, batch_items, strict=True):
            try:
                heartbeat_automation_run(automation.automation_id, run_id)
                job_ids.append(await _enqueue_automation_file(
                    automation,
                    file,
                    job_id=claims_by_file[file.file_id]['job_id'],
                    run_id=run_id,
                    batch_id=batch_id,
                    batch_item_id=item.item_id if batch_id else None,
                    active_profiles=active_profiles,
                    offer_outcomes=offer_outcomes,
                ))
                queued_file_ids.add(file.file_id)
            except Exception as exc:
                failures.append(f'{file.name}: {type(exc).__name__}')
                try:
                    mark_automation_run_retry_required(
                        automation.automation_id,
                        run_id,
                    )
                except Exception:
                    # Keep the claim if the durable retry marker could not be
                    # saved. Recovery can safely release this unqueued file.
                    raise
                if batch_id:
                    await asyncio.to_thread(
                        finish_batch_item_and_notify,
                        batch_id,
                        item.item_id,
                        status='upload_failed',
                        message='The automated Drive import could not be queued.',
                    )
                release_automation_files(
                    automation.automation_id,
                    run_id,
                    [{
                        'file_id':file.file_id,
                        'modified_time':file.modified_time or '',
                    }],
                )

        if not job_ids:
            status = 'failed'
            message = 'Matching creatives were found, but none could be queued for review.'
        elif failures:
            status = 'queued'
            message = (
                f'Queued {len(job_ids)} creative(s), but {len(failures)} creative(s) '
                'could not be queued and will be retried after the queued reviews finish.'
            )
        else:
            status = 'queued'
            message = f'Queued {len(job_ids)} creative(s) for automatic review.'
        updated = finish_automation_run(
            run_id,
            automation.automation_id,
            status=status,
            message=message,
            matched_count=matched_count,
            queued_count=len(job_ids),
            batch_id=batch_id,
            job_ids=job_ids,
            retry_required=bool(failures),
        )
        return AutomationRunResult(
            automation=updated,
            status=status,
            message=message,
            matched_count=matched_count,
            queued_count=len(job_ids),
            batch_id=batch_id,
            job_ids=job_ids,
        )
    except Exception as exc:
        unqueued_claims=[
            claim
            for claim in claimed_values
            if claim['file_id'] not in queued_file_ids
        ]
        claims_can_be_released=True
        if unqueued_claims:
            try:
                mark_automation_run_retry_required(
                    automation.automation_id,
                    run_id,
                )
            except Exception:
                claims_can_be_released=False
                logger.exception(
                    'Could not persist the retry marker for automation %s.',
                    automation.automation_id,
                )
        releasable_claims=[]
        unreconciled_job_ids=[]
        for claim in unqueued_claims:
            item=batch_item_by_file_id.get(claim['file_id'])
            batch_item_closed=not batch_id
            if batch_id and item:
                try:
                    await asyncio.to_thread(
                        finish_batch_item_and_notify,
                        batch_id,
                        item.item_id,
                        status='upload_failed',
                        message='The automated Drive import could not be queued.',
                    )
                    batch_item_closed=True
                except Exception:
                    logger.exception(
                        'Could not close unqueued automation batch item %s.',
                        item.item_id,
                    )
            if claims_can_be_released and batch_item_closed:
                releasable_claims.append(claim)
            elif claim.get('job_id'):
                # Keep the mapped state in the parent run. Lease recovery can
                # then fence it, fail the pending batch item, and release the
                # file claim without leaving an orphaned batch forever.
                unreconciled_job_ids.append(claim['job_id'])
        if releasable_claims:
            try:
                release_automation_files(
                    automation.automation_id,
                    run_id,
                    releasable_claims,
                )
            except Exception:
                logger.exception('Could not release unqueued claims for automation %s', automation.automation_id)
                unreconciled_job_ids.extend(
                    claim['job_id']
                    for claim in releasable_claims
                    if claim.get('job_id')
                )
        tracked_job_ids=list(dict.fromkeys([*job_ids, *unreconciled_job_ids]))
        if tracked_job_ids:
            status='queued'
            message=(
                f'Queued {len(job_ids)} creative(s); remaining automation work '
                'will be retried after those reviews finish.'
            )
        else:
            status='failed'
            message=f'Automation failed: {type(exc).__name__}. Check the Drive source and schedule settings.'
        updated = finish_automation_run(
            run_id,
            automation.automation_id,
            status=status,
            message=message,
            matched_count=matched_count,
            queued_count=len(job_ids),
            batch_id=batch_id,
            job_ids=tracked_job_ids,
            retry_required=bool(unqueued_claims),
        )
        return AutomationRunResult(
            automation=updated,
            status=status,
            message=message,
            matched_count=matched_count,
            queued_count=len(job_ids),
            batch_id=batch_id,
            job_ids=job_ids,
        )
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task


async def run_due_review_automations() -> list[AutomationRunResult]:
    now = datetime.now(timezone.utc)
    results=[]
    for automation in list_review_automations(include_disabled=False):
        if automation.last_run_status == 'failed' and automation.last_scheduled_for:
            results.append(await run_review_automation(
                automation,
                scheduled_for=automation.last_scheduled_for,
            ))
            continue
        schedule_key = due_schedule_key(automation, now)
        if schedule_key is None:
            continue
        results.append(await run_review_automation(
            automation,
            scheduled_for=schedule_key,
        ))
    return results
