from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any

from .models import ReviewAutomation, ReviewAutomationInput, ReviewBatch, ReviewRequestMeta
from .storage import JOB_DATA_DIR, _convex_call, convex_enabled, now_ms, read_json, write_json


_LOCAL_LOCK = threading.Lock()
AUTOMATION_RUN_LEASE_MS = 30 * 60 * 1000
MAX_AUTOMATION_RUN_ATTEMPTS = 3


def _automations_path() -> Path:
    return JOB_DATA_DIR / 'settings' / 'review_automations.json'


def _runs_path() -> Path:
    return JOB_DATA_DIR / 'settings' / 'review_automation_runs.json'


def _claims_path() -> Path:
    return JOB_DATA_DIR / 'settings' / 'review_automation_file_claims.json'


def _read_list(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        value = read_json(path)
    except (OSError, ValueError, TypeError):
        return []
    return value if isinstance(value, list) else []


def list_review_automations(*, include_disabled: bool = True) -> list[ReviewAutomation]:
    remote = _convex_call(
        'query',
        'automations:list',
        {'includeDisabled': include_disabled},
    )
    if remote is not None:
        return [ReviewAutomation.model_validate(value) for value in remote]
    values = [
        ReviewAutomation.model_validate(value)
        for value in _read_list(_automations_path())
    ]
    if not include_disabled:
        values = [automation for automation in values if automation.enabled]
    return sorted(values, key=lambda automation: automation.name.casefold())


def get_review_automation(automation_id: str) -> ReviewAutomation:
    for automation in list_review_automations(include_disabled=True):
        if automation.automation_id == automation_id:
            return automation
    raise KeyError(automation_id)


def upsert_review_automation(
    automation_id: str,
    payload: ReviewAutomationInput,
) -> ReviewAutomation:
    args = {
        'automationId': automation_id,
        'daysOfWeek': payload.days_of_week,
        'driveFolderId': payload.folder_id.strip(),
        'enabled': payload.enabled,
        'fileNamePattern': payload.file_name_pattern.strip(),
        'includeSubfolders': payload.include_subfolders,
        'localTime': payload.time_of_day,
        'name': payload.name.strip(),
        'timeZone': payload.timezone,
    }
    remote = _convex_call('mutation', 'automations:upsert', args)
    if remote is not None:
        return ReviewAutomation.model_validate(remote)

    with _LOCAL_LOCK:
        values = _read_list(_automations_path())
        by_id = {
            value.get('automation_id'): value
            for value in values
            if isinstance(value, dict) and value.get('automation_id')
        }
        existing = by_id.get(automation_id)
        timestamp = now_ms()
        automation = ReviewAutomation(
            automation_id=automation_id,
            created_at=(existing or {}).get('created_at', timestamp),
            updated_at=timestamp,
            last_run_at=(existing or {}).get('last_run_at'),
            last_run_status=(existing or {}).get('last_run_status'),
            last_run_message=(existing or {}).get('last_run_message', ''),
            last_batch_id=(existing or {}).get('last_batch_id'),
            last_scheduled_for=(existing or {}).get('last_scheduled_for'),
            **payload.model_dump(),
        )
        by_id[automation_id] = automation.model_dump(mode='json')
        write_json(_automations_path(), list(by_id.values()))
        return automation


def delete_review_automation(automation_id: str) -> None:
    # Resolve first so a missing durable row consistently maps to a 404 instead
    # of an opaque Convex mutation error.
    get_review_automation(automation_id)
    remote = _convex_call(
        'mutation',
        'automations:remove',
        {'automationId': automation_id},
    )
    if remote is not None:
        return
    if convex_enabled():
        raise KeyError(automation_id)
    with _LOCAL_LOCK:
        if any(
            run.get('automation_id') == automation_id
            and run.get('status') in {'running', 'queued', 'failed'}
            for run in _read_list(_runs_path())
        ):
            raise RuntimeError('Finish or exhaust the pending automation retry before deleting it.')
        values = _read_list(_automations_path())
        remaining = [
            value
            for value in values
            if value.get('automation_id') != automation_id
        ]
        if len(remaining) == len(values):
            raise KeyError(automation_id)
        write_json(_automations_path(), remaining)


def claim_automation_run(
    automation: ReviewAutomation,
    scheduled_for: str,
    *,
    allow_disabled: bool = False,
) -> str | None:
    run_id = uuid.uuid4().hex
    remote = _convex_call('mutation', 'automations:claimRun', {
        'automationId': automation.automation_id,
        'runId': run_id,
        'scheduledFor': scheduled_for,
        'allowDisabled': allow_disabled,
    })
    if remote is not None:
        return run_id if remote.get('claimed') else None

    with _LOCAL_LOCK:
        if not automation.enabled and not allow_disabled:
            return None
        runs = _read_list(_runs_path())
        existing = next((run for run in runs if (
            run.get('automation_id') == automation.automation_id
            and run.get('scheduled_for') == scheduled_for
        )), None)
        timestamp = now_ms()
        if existing is None and any(
            run.get('automation_id') == automation.automation_id
            and run.get('status') in {'running', 'queued', 'failed'}
            for run in runs
        ):
            return None
        if existing is not None:
            attempts = max(1, int(existing.get('attempts') or 1))
            status = str(existing.get('status') or '')
            lease_expired = int(existing.get('lease_expires_at') or 0) <= timestamp
            reclaimable = status == 'failed' or (status == 'running' and lease_expired)
            if not reclaimable:
                return None
            old_run_id = str(existing.get('run_id') or '')
            retained_claims=[]
            for claim in _read_list(_claims_path()):
                if claim.get('run_id') != old_run_id:
                    retained_claims.append(claim)
                    continue
                job_id=str(claim.get('job_id') or '')
                if job_id:
                    status_path=JOB_DATA_DIR/job_id/'status.json'
                    if status_path.exists():
                        review_status=read_json(status_path).get('status')
                        if review_status == 'complete':
                            retained_claims.append(claim)
            write_json(_claims_path(), retained_claims)
            if attempts >= MAX_AUTOMATION_RUN_ATTEMPTS:
                existing.update({
                    'message':'Automation retry limit reached for this schedule.',
                    'status':'failed_exhausted',
                    'updated_at':timestamp,
                })
                write_json(_runs_path(), runs)
                _update_local_last_run(
                    automation.automation_id,
                    status='failed_exhausted',
                    message='Automation retry limit reached for this schedule.',
                    scheduled_for=scheduled_for,
                )
                return None
            existing.update({
                'attempts': attempts + 1,
                'job_ids': [],
                'lease_expires_at': timestamp + AUTOMATION_RUN_LEASE_MS,
                'matched_count': 0,
                'message': 'Retrying Google Drive scan for matching creatives.',
                'queued_count': 0,
                'retry_required': False,
                'run_id': run_id,
                'status': 'running',
                'updated_at': timestamp,
            })
            write_json(_runs_path(), runs)
            _update_local_last_run(
                automation.automation_id,
                status='running',
                message='Retrying Google Drive scan for matching creatives.',
                scheduled_for=scheduled_for,
            )
            return run_id

        runs.append({
            'attempts': 1,
            'automation_id': automation.automation_id,
            'created_at': timestamp,
            'job_ids': [],
            'lease_expires_at': timestamp + AUTOMATION_RUN_LEASE_MS,
            'matched_count': 0,
            'message': 'Scanning Google Drive for matching creatives.',
            'queued_count': 0,
            'retry_required': False,
            'run_id': run_id,
            'scheduled_for': scheduled_for,
            'status': 'running',
            'updated_at': timestamp,
        })
        write_json(_runs_path(), runs)
        _update_local_last_run(
            automation.automation_id,
            status='running',
            message='Scanning Google Drive for matching creatives.',
            scheduled_for=scheduled_for,
        )
        return run_id


def claim_automation_files(
    automation_id: str,
    run_id: str,
    files: list[dict[str, str]],
) -> list[dict[str, str]]:
    remote = _convex_call('mutation', 'automations:claimFiles', {
        'automationId': automation_id,
        'runId': run_id,
        'files': [
            {
                'fileId': file['file_id'],
                'fileName': file['file_name'],
                'modifiedTime': file.get('modified_time', ''),
                **({'jobId': file['job_id']} if file.get('job_id') else {}),
            }
            for file in files
        ],
    })
    if remote is not None:
        return [
            {
                'file_id': value['fileId'],
                'file_name': value['fileName'],
                'modified_time': value['modifiedTime'],
                'job_id': value.get('jobId', ''),
            }
            for value in remote
        ]

    with _LOCAL_LOCK:
        timestamp = now_ms()
        run = next((value for value in _read_list(_runs_path()) if (
            value.get('automation_id') == automation_id
            and value.get('run_id') == run_id
        )), None)
        if (
            run is None
            or run.get('status') != 'running'
            or int(run.get('lease_expires_at') or 0) <= timestamp
        ):
            raise RuntimeError('Automation run lease is no longer active.')
        claims = _read_list(_claims_path())
        claimed_keys = {
            (
                claim.get('automation_id'),
                claim.get('file_id'),
                claim.get('modified_time', ''),
            )
            for claim in claims
        }
        newly_claimed = []
        for file in files[:100]:
            key = (automation_id, file['file_id'], file.get('modified_time', ''))
            if key in claimed_keys:
                continue
            claimed_keys.add(key)
            newly_claimed.append(file)
            claims.append({
                'automation_id': automation_id,
                'claimed_at': timestamp,
                'file_id': file['file_id'],
                'file_name': file['file_name'],
                'job_id': file.get('job_id', ''),
                'modified_time': file.get('modified_time', ''),
                'run_id': run_id,
            })
        write_json(_claims_path(), claims)
        return newly_claimed


def attach_automation_batch_items(
    automation_id:str,
    run_id:str,
    items:list[dict[str, str]],
) -> None:
    remote=_convex_call('mutation', 'automations:attachBatchItems', {
        'automationId':automation_id,
        'runId':run_id,
        'items':[
            {
                'batchId':item['batch_id'],
                'batchItemId':item['batch_item_id'],
                'jobId':item['job_id'],
            }
            for item in items
        ],
    })
    if remote is not None:
        return
    with _LOCAL_LOCK:
        claims=_read_list(_claims_path())
        by_job_id={
            claim.get('job_id'):claim
            for claim in claims
            if claim.get('run_id') == run_id and claim.get('job_id')
        }
        for item in items:
            claim=by_job_id.get(item['job_id'])
            if claim is None or claim.get('automation_id') != automation_id:
                raise RuntimeError('Automation job claim was not found.')
            claim['batch_id']=item['batch_id']
            claim['batch_item_id']=item['batch_item_id']
        write_json(_claims_path(), claims)


def heartbeat_automation_run(automation_id: str, run_id: str) -> None:
    remote = _convex_call('mutation', 'automations:heartbeatRun', {
        'automationId': automation_id,
        'runId': run_id,
    })
    if remote is not None:
        return
    with _LOCAL_LOCK:
        runs=_read_list(_runs_path())
        timestamp=now_ms()
        for run in runs:
            if (
                run.get('automation_id') == automation_id
                and run.get('run_id') == run_id
                and run.get('status') in {'running', 'queued'}
                and int(run.get('lease_expires_at') or 0) > timestamp
            ):
                run['lease_expires_at']=timestamp + AUTOMATION_RUN_LEASE_MS
                run['updated_at']=timestamp
                write_json(_runs_path(), runs)
                _update_local_last_run(
                    automation_id,
                    status=str(run.get('status') or 'running'),
                    message=str(run.get('message') or 'Automation is running.'),
                    expected_scheduled_for=str(run.get('scheduled_for') or ''),
                )
                return
    raise RuntimeError('Automation run lease is no longer active.')


def mark_automation_run_retry_required(automation_id: str, run_id: str) -> None:
    remote = _convex_call('mutation', 'automations:markRetryRequired', {
        'automationId': automation_id,
        'runId': run_id,
    })
    if remote is not None:
        return
    with _LOCAL_LOCK:
        runs=_read_list(_runs_path())
        timestamp=now_ms()
        for run in runs:
            if (
                run.get('automation_id') == automation_id
                and run.get('run_id') == run_id
                and run.get('status') == 'running'
                and int(run.get('lease_expires_at') or 0) > timestamp
            ):
                run.update({
                    'lease_expires_at': timestamp + AUTOMATION_RUN_LEASE_MS,
                    'message': 'One or more matched creatives must be retried after queued reviews finish.',
                    'retry_required': True,
                    'updated_at': timestamp,
                })
                write_json(_runs_path(), runs)
                return
    raise RuntimeError('Automation run lease is no longer active.')


def release_automation_files(
    automation_id: str,
    run_id: str,
    files: list[dict[str, str]],
) -> None:
    remote = _convex_call('mutation', 'automations:releaseFiles', {
        'automationId': automation_id,
        'runId': run_id,
        'files': [
            {
                'fileId': file['file_id'],
                'modifiedTime': file.get('modified_time', ''),
            }
            for file in files
        ],
    })
    if remote is not None:
        return
    with _LOCAL_LOCK:
        released_keys = {
            (automation_id, file['file_id'], file.get('modified_time', ''), run_id)
            for file in files
        }
        claims = [
            claim
            for claim in _read_list(_claims_path())
            if (
                claim.get('automation_id'),
                claim.get('file_id'),
                claim.get('modified_time', ''),
                claim.get('run_id'),
            ) not in released_keys
        ]
        write_json(_claims_path(), claims)


def release_review_automation_claim(meta: ReviewRequestMeta) -> None:
    if not (
        meta.automation_id
        and meta.automation_run_id
        and meta.automation_file_id
    ):
        return
    release_automation_files(
        meta.automation_id,
        meta.automation_run_id,
        [{
            'file_id': meta.automation_file_id,
            'modified_time': meta.automation_file_modified_time,
        }],
    )


def record_review_automation_job_result(meta: ReviewRequestMeta, job_id: str) -> None:
    if not (meta.automation_id and meta.automation_run_id):
        return
    remote=_convex_call('mutation', 'automations:finishJob', {
        'runId': meta.automation_run_id,
        'jobId': job_id,
    })
    if remote is not None:
        return
    with _LOCAL_LOCK:
        runs=_read_list(_runs_path())
        run=next((value for value in runs if value.get('run_id') == meta.automation_run_id), None)
        if run is None or job_id not in run.get('job_ids', []):
            return
        statuses=[]
        for tracked_job_id in run.get('job_ids', []):
            status_path=JOB_DATA_DIR/tracked_job_id/'status.json'
            if not status_path.exists():
                return
            status_value=read_json(status_path).get('status')
            if status_value not in {'complete', 'failed'}:
                return
            statuses.append(status_value)
        retry_required=bool(run.get('retry_required'))
        failed='failed' in statuses or retry_required
        status='failed' if failed else 'complete'
        message=(
            'One or more automated reviews failed or could not be queued and will be retried.'
            if failed
            else 'All automated reviews completed.'
        )
        timestamp=now_ms()
        run.update({
            'finished_at': timestamp,
            'message': message,
            'status': status,
            'updated_at': timestamp,
        })
        write_json(_runs_path(), runs)
        _update_local_last_run(
            meta.automation_id,
            status=status,
            message=message,
            expected_scheduled_for=str(run.get('scheduled_for') or ''),
        )


def recover_interrupted_automation_jobs() -> int:
    if not convex_enabled():
        return 0
    recovered=0
    # Each mutation is intentionally bounded to keep Convex transaction reads
    # predictable. Repeat until no running/queued parent runs remain.
    for _page in range(10):
        remote=_convex_call('mutation', 'automations:recoverInterrupted', {})
        processed=int(remote.get('processed', 0)) if isinstance(remote, dict) else 0
        recovered += processed
        if processed == 0:
            break
    return recovered


def deliver_pending_batch_notifications(*, limit:int=1) -> int:
    if not convex_enabled():
        return 0
    from .storage import mark_batch_notification
    from .telegram import send_batch_message

    delivered=0
    for _notification in range(max(1, min(limit, 10))):
        value=_convex_call('mutation', 'batches:claimNotification', {})
        if not isinstance(value, dict):
            break
        batch=ReviewBatch.model_validate(value)
        success=send_batch_message(batch)
        mark_batch_notification(batch.batch_id, success)
        delivered += 1
    return delivered


def finish_automation_run(
    run_id: str,
    automation_id: str,
    *,
    status: str,
    message: str,
    matched_count: int,
    queued_count: int,
    batch_id: str | None = None,
    job_ids: list[str] | None = None,
    retry_required: bool = False,
) -> ReviewAutomation:
    job_ids = job_ids or []
    args: dict[str, Any] = {
        'runId': run_id,
        'status': status,
        'message': message,
        'matchedCount': matched_count,
        'queuedCount': queued_count,
        'jobIds': job_ids,
        'retryRequired': retry_required,
    }
    if batch_id:
        args['batchId'] = batch_id
    remote = _convex_call('mutation', 'automations:finishRun', args)
    if remote is not None:
        return ReviewAutomation.model_validate(remote)

    with _LOCAL_LOCK:
        runs = _read_list(_runs_path())
        timestamp = now_ms()
        run=next((value for value in runs if (
            value.get('automation_id') == automation_id
            and value.get('run_id') == run_id
            and value.get('status') == 'running'
        )), None)
        if run is None:
            raise RuntimeError('Automation run lease is no longer active.')
        final_status=status
        final_message=message
        if status == 'queued' and job_ids:
            statuses=[]
            for job_id in job_ids:
                status_path=JOB_DATA_DIR/job_id/'status.json'
                if not status_path.exists():
                    break
                job_status=read_json(status_path).get('status')
                if job_status not in {'complete', 'failed'}:
                    break
                statuses.append(job_status)
            if len(statuses) == len(job_ids):
                final_status=(
                    'failed'
                    if 'failed' in statuses or retry_required
                    else 'complete'
                )
                final_message=(
                    'One or more automated reviews failed or could not be queued and will be retried.'
                    if final_status == 'failed'
                    else 'All automated reviews completed.'
                )
        run.update({
            'batch_id': batch_id,
            'finished_at': timestamp,
            'job_ids': job_ids,
            'matched_count': matched_count,
            'message': final_message,
            'queued_count': queued_count,
            'retry_required': retry_required,
            'status': final_status,
            'updated_at': timestamp,
        })
        write_json(_runs_path(), runs)
        _update_local_last_run(
            automation_id,
            status=final_status,
            message=final_message,
            batch_id=batch_id,
            expected_scheduled_for=str(run.get('scheduled_for') or ''),
        )
        return get_review_automation(automation_id)


def _update_local_last_run(
    automation_id: str,
    *,
    status: str,
    message: str,
    batch_id: str | None = None,
    scheduled_for: str | None = None,
    expected_scheduled_for: str | None = None,
) -> None:
    values = _read_list(_automations_path())
    timestamp = now_ms()
    for value in values:
        if value.get('automation_id') != automation_id:
            continue
        if (
            expected_scheduled_for is not None
            and value.get('last_scheduled_for') != expected_scheduled_for
        ):
            return
        value['last_run_at'] = timestamp
        value['last_run_status'] = status
        value['last_run_message'] = message
        value['last_batch_id'] = batch_id
        if scheduled_for is not None:
            value['last_scheduled_for'] = scheduled_for
        value['updated_at'] = timestamp
        break
    write_json(_automations_path(), values)
