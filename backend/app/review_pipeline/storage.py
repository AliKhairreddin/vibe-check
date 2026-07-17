from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path
from typing import Any

from .models import (
    CreateBatchItem,
    DeletedReview,
    JobRecord,
    JobStatus,
    OfferProfile,
    OfferProfileInput,
    ReviewBatch,
    ReviewBatchItem,
    ReviewHistoryItem,
    ReviewHistoryPage,
    ReviewOutcomeCounts,
    ReviewStats,
    ReviewSource,
)
from .guidelines import built_in_acp_profile

JOB_DATA_DIR = Path(os.getenv('JOB_DATA_DIR', 'data/jobs'))
CONVEX_URL = os.getenv('CONVEX_URL', '').rstrip('/')
CONVEX_HTTP_SECRET = os.getenv('CONVEX_HTTP_SECRET', '')
OFFER_SETTINGS_FILE = 'offer_profiles.json'
OFFER_REVISIONS_FILE = 'offer_profile_revisions.json'
MAX_OFFER_PROFILE_BYTES = 850_000
MAX_REPORT_RESULT_BYTES = 800_000
MAX_OFFER_OVERRIDES = 100
OFFER_ID_PATTERN = re.compile(r'^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$')
RESULT_STATUSES = {'green','yellow','orange','red'}
LEGACY_RESULT_STATUSES = {
    'pass': 'green',
    'needs_review': 'orange',
    'likely_violation': 'red',
}

def _normalize_result_status(status:Any)->str|None:
    if status in RESULT_STATUSES:
        return status
    return LEGACY_RESULT_STATUSES.get(status)

def job_dir(job_id:str)->Path:
    p=JOB_DATA_DIR/job_id; p.mkdir(parents=True, exist_ok=True); return p

def write_json(path:Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')

def read_json(path:Path):
    return json.loads(path.read_text(encoding='utf-8'))

def now_ms()->int:
    return int(time.time() * 1000)

def batch_path(batch_id:str)->Path:
    return JOB_DATA_DIR/'batches'/f'{batch_id}.json'

def convex_enabled()->bool:
    return bool(CONVEX_URL and CONVEX_HTTP_SECRET)

def _convex_call(kind:str, path:str, args:dict[str, Any])->Any:
    if not convex_enabled():
        return None
    payload={
        'path': path,
        'args': {**args, 'secret': CONVEX_HTTP_SECRET},
        'format': 'json',
    }
    req=urllib.request.Request(
        f'{CONVEX_URL}/api/{kind}',
        data=json.dumps(payload).encode('utf-8'),
        headers={'content-type':'application/json','accept':'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        data=json.loads(response.read().decode('utf-8'))
    if data.get('status') != 'success':
        raise RuntimeError(data.get('errorMessage') or 'Convex request failed')
    return data.get('value')

def set_status(job_id:str, status:JobStatus, progress:int, message:str='', file_name:str='', file_size:int|None=None, has_ad_copy:bool|None=None, has_creative:bool|None=None, batch_id:str|None=None, batch_item_id:str|None=None, offer_ids:list[str]|None=None, primary_offer_id:str|None=None)->JobRecord:
    current_file_name=file_name
    current_file_size=file_size
    current_has_ad_copy=True if has_ad_copy is None else has_ad_copy
    current_has_creative=True if has_creative is None else has_creative
    current_batch_id=batch_id
    current_batch_item_id=batch_item_id
    current_offer_ids=offer_ids or ['acp']
    current_primary_offer_id=primary_offer_id or current_offer_ids[0]
    source_values:dict[str, Any]={}
    local_path=job_dir(job_id)/'status.json'
    created_at=now_ms()
    if local_path.exists():
        current=JobRecord.model_validate(read_json(local_path))
        if not current_file_name:
            current_file_name=current.file_name
        if current_file_size is None:
            current_file_size=current.file_size
        if has_ad_copy is None:
            current_has_ad_copy=current.has_ad_copy
        if has_creative is None:
            current_has_creative=current.has_creative
        if current_batch_id is None:
            current_batch_id=current.batch_id
        if current_batch_item_id is None:
            current_batch_item_id=current.batch_item_id
        if offer_ids is None:
            current_offer_ids=current.offer_ids
        if primary_offer_id is None:
            current_primary_offer_id=current.primary_offer_id
        source_values={
            'source_kind':current.source_kind,
            'source_status':current.source_status,
            'source_url':current.source_url,
            'source_file_id':current.source_file_id,
            'source_message':current.source_message,
            'source_checked_at':current.source_checked_at,
        }
        created_at=current.created_at or created_at

    rec=JobRecord(job_id=job_id,file_name=current_file_name,file_size=current_file_size,status=status,progress=progress,message=message,report_ready=(status==JobStatus.complete),has_creative=current_has_creative,has_ad_copy=current_has_ad_copy,batch_id=current_batch_id,batch_item_id=current_batch_item_id,offer_ids=current_offer_ids,primary_offer_id=current_primary_offer_id,created_at=created_at,updated_at=now_ms(),**source_values)
    write_json(local_path, rec.model_dump(mode='json'))
    review_args = {
        'fileName': rec.file_name,
        'hasAdCopy': rec.has_ad_copy,
        'hasCreative': rec.has_creative,
        'jobId': rec.job_id,
        'message': rec.message,
        'progress': rec.progress,
        'reportReady': rec.report_ready,
        'status': rec.status.value,
        'offerIds': rec.offer_ids,
        'primaryOfferId': rec.primary_offer_id,
    }
    if rec.batch_id:
        review_args['batchId'] = rec.batch_id
    if rec.batch_item_id:
        review_args['batchItemId'] = rec.batch_item_id
    if rec.file_size is not None:
        review_args['fileSize'] = rec.file_size
    _convex_call('mutation', 'reviews:upsertStatus', review_args)
    if rec.batch_id and rec.batch_item_id:
        update_batch_item(
            rec.batch_id,
            rec.batch_item_id,
            status=rec.status.value,
            job_id=rec.job_id,
            message=rec.message,
        )
    return rec

def set_review_source(job_id:str, source:ReviewSource)->None:
    local_path=JOB_DATA_DIR/job_id/'status.json'
    if local_path.exists():
        current=JobRecord.model_validate(read_json(local_path))
        current.source_kind=source.kind
        current.source_status=source.status
        current.source_url=source.url
        current.source_file_id=source.file_id
        current.source_message=source.message
        current.source_checked_at=source.checked_at
        current.updated_at=now_ms()
        write_json(local_path, current.model_dump(mode='json'))
    args:dict[str, Any]={
        'jobId':job_id,
        'status':source.status,
        'message':source.message,
        'checkedAt':source.checked_at,
    }
    if source.kind:
        args['kind']=source.kind
    if source.url:
        args['url']=source.url
    if source.file_id:
        args['fileId']=source.file_id
    _convex_call('mutation', 'reviews:setSource', args)

def get_status(job_id:str)->JobRecord:
    remote=_convex_call('query', 'reviews:getStatus', {'jobId': job_id})
    if convex_enabled():
        if remote:
            return JobRecord.model_validate(remote)
        raise FileNotFoundError(job_id)
    if (JOB_DATA_DIR/job_id/'deleted.json').exists():
        raise FileNotFoundError(job_id)
    p=job_dir(job_id)/'status.json'
    if not p.exists(): raise FileNotFoundError(job_id)
    return JobRecord.model_validate(read_json(p))

def set_report(job_id:str, report:dict[str, Any])->None:
    offer_results=report.get('offer_results')
    results=offer_results if isinstance(offer_results, list) and offer_results else [report]
    for result in results:
        if not isinstance(result, dict):
            raise ValueError('Offer report results must be JSON objects.')
        result_size=len(json.dumps(result, ensure_ascii=False).encode('utf-8'))
        if result_size > MAX_REPORT_RESULT_BYTES:
            offer_id=result.get('offer_id') or 'unknown offer'
            raise ValueError(
                f'The generated report for {offer_id} is too large to save. '
                'Run the review again with shorter policy supplements or fewer findings.'
            )
    write_json(job_dir(job_id)/'report.json', report)
    _convex_call('mutation', 'reviews:setReport', {'jobId': job_id, 'report': report})

def get_report(job_id:str)->dict[str, Any]|None:
    remote=_convex_call('query', 'reviews:getReport', {'jobId': job_id})
    if convex_enabled():
        return remote
    if (JOB_DATA_DIR/job_id/'deleted.json').exists():
        return None
    p=job_dir(job_id)/'report.json'
    if not p.exists():
        return None
    return read_json(p)

def create_batch(batch_id:str, items:list[CreateBatchItem])->ReviewBatch:
    timestamp=now_ms()
    batch=ReviewBatch(
        batch_id=batch_id,
        created_at=timestamp,
        updated_at=timestamp,
        expected_count=len(items),
        items=[ReviewBatchItem(**item.model_dump()) for item in items],
    )
    write_json(batch_path(batch_id), batch.model_dump(mode='json'))
    remote=_convex_call('mutation', 'batches:createBatch', {
        'batchId': batch_id,
        'items': [
            {
                'itemId': item.item_id,
                'fileName': item.file_name,
                'mediaKind': item.media_kind,
            }
            for item in items
        ],
    })
    return ReviewBatch.model_validate(remote) if remote is not None else batch

def get_batch(batch_id:str)->ReviewBatch:
    remote=_convex_call('query', 'batches:getBatch', {'batchId': batch_id})
    if remote is not None:
        return ReviewBatch.model_validate(remote)
    path=batch_path(batch_id)
    if not path.exists():
        raise FileNotFoundError(batch_id)
    return ReviewBatch.model_validate(read_json(path))

def _update_local_batch_item(
    batch_id:str,
    item_id:str,
    *,
    status:str,
    job_id:str|None=None,
    result:str|None=None,
    message:str='',
    claim_notification:bool=False,
)->tuple[ReviewBatch,bool]:
    batch=get_batch(batch_id) if not convex_enabled() else ReviewBatch.model_validate(read_json(batch_path(batch_id)))
    found=False
    for item in batch.items:
        if item.item_id != item_id:
            continue
        found=True
        item.status=status
        if job_id:
            item.job_id=job_id
        if result in RESULT_STATUSES:
            item.result=result
        item.message=message
        break
    if not found:
        raise KeyError(item_id)
    batch.updated_at=now_ms()
    should_notify=(
        claim_notification
        and batch.notification_status == 'pending'
        and all(item.status in {'complete','failed','upload_failed'} for item in batch.items)
    )
    if should_notify:
        batch.notification_status='claimed'
    write_json(batch_path(batch_id), batch.model_dump(mode='json'))
    return batch, should_notify

def update_batch_item(batch_id:str, item_id:str, *, status:str, job_id:str|None=None, message:str='')->ReviewBatch:
    local,_=_update_local_batch_item(
        batch_id,
        item_id,
        status=status,
        job_id=job_id,
        message=message,
    )
    args={'batchId':batch_id,'itemId':item_id,'status':status,'message':message}
    if job_id:
        args['jobId']=job_id
    remote=_convex_call('mutation', 'batches:updateItemStatus', args)
    return ReviewBatch.model_validate(remote) if remote is not None else local

def finish_batch_item(batch_id:str, item_id:str, *, status:str, job_id:str|None=None, result:str|None=None, message:str='')->tuple[ReviewBatch,bool]:
    local,local_should_notify=_update_local_batch_item(
        batch_id,
        item_id,
        status=status,
        job_id=job_id,
        result=result,
        message=message,
        claim_notification=True,
    )
    args={'batchId':batch_id,'itemId':item_id,'status':status,'message':message}
    if job_id:
        args['jobId']=job_id
    if result in RESULT_STATUSES:
        args['result']=result
    remote=_convex_call('mutation', 'batches:finishItem', args)
    if remote is None:
        return local,local_should_notify
    return ReviewBatch.model_validate(remote['batch']),bool(remote['shouldNotify'])

def mark_batch_notification(batch_id:str, success:bool)->None:
    batch=ReviewBatch.model_validate(read_json(batch_path(batch_id)))
    batch.notification_status='sent' if success else 'failed'
    batch.updated_at=now_ms()
    write_json(batch_path(batch_id), batch.model_dump(mode='json'))
    _convex_call('mutation', 'batches:markNotification', {
        'batchId':batch_id,
        'status':batch.notification_status,
    })

def _overall_status(report:dict[str, Any]|None)->str|None:
    status=report.get('overall_status') if isinstance(report, dict) else None
    return _normalize_result_status(status)

def _finding_source(finding:Any)->str:
    if not isinstance(finding, dict):
        return ''
    source=finding.get('source')
    return source if isinstance(source, str) else ''

def _source_result_status(report:dict[str, Any]|None, key:str)->str|None:
    if not isinstance(report, dict):
        return None
    results=report.get('source_results')
    if not isinstance(results, dict):
        return None
    result=results.get(key)
    if not isinstance(result, dict):
        return None
    status=result.get('status')
    return _normalize_result_status(status)

def _split_result(report:dict[str, Any]|None, source_matches)->str|None:
    status=_overall_status(report)
    if not isinstance(report, dict):
        return None

    findings=report.get('findings')
    if not isinstance(findings, list) or not findings:
        return status

    relevant=[
        finding for finding in findings
        if source_matches(_finding_source(finding))
    ]
    if not relevant:
        return 'green' if status in RESULT_STATUSES else None
    if any(isinstance(finding, dict) and finding.get('severity') == 'high' for finding in relevant):
        return 'red'
    if any(isinstance(finding, dict) and finding.get('severity') == 'medium' for finding in relevant):
        return 'orange'
    return 'yellow'

def _creative_result(report:dict[str, Any]|None, has_creative:bool=True)->str|None:
    if not has_creative:
        return None
    return _source_result_status(report, 'creative') or _split_result(report, lambda source: source != 'ad_copy')

def _ad_copy_result(report:dict[str, Any]|None, has_ad_copy:bool)->str|None:
    if not has_ad_copy:
        return None
    return _source_result_status(report, 'ad_copy') or _split_result(report, lambda source: source == 'ad_copy')

def _local_reviews()->list[ReviewHistoryItem]:
    if not JOB_DATA_DIR.exists():
        return []

    items=[]
    for status_path in JOB_DATA_DIR.glob('*/status.json'):
        if (status_path.parent/'deleted.json').exists():
            continue
        try:
            rec=JobRecord.model_validate(read_json(status_path))
        except (OSError, ValueError):
            continue
        stat=status_path.stat()
        report_path=status_path.parent/'report.json'
        report=read_json(report_path) if report_path.exists() else None
        data=rec.model_dump(mode='json')
        data['created_at']=rec.created_at or int(stat.st_ctime * 1000)
        data['updated_at']=rec.updated_at or int(stat.st_mtime * 1000)
        data['overall_status']=_overall_status(report)
        data['creative_result']=_creative_result(report, rec.has_creative)
        data['ad_copy_result']=_ad_copy_result(report, rec.has_ad_copy)
        items.append(ReviewHistoryItem(**data))

    items.sort(key=lambda item: item.created_at or 0, reverse=True)
    return items

def list_reviews(limit:int=50)->list[ReviewHistoryItem]:
    limit=max(1, min(limit, 100))
    remote=_convex_call('query', 'reviews:listRecent', {'limit': limit})
    if remote is not None:
        return [ReviewHistoryItem.model_validate(item) for item in remote]
    return _local_reviews()[:limit]

def list_reviews_page(limit:int=50, cursor:str|None=None)->ReviewHistoryPage:
    limit=max(1, min(limit, 100))
    remote=_convex_call('query', 'reviews:listPage', {
        'paginationOpts': {'numItems':limit, 'cursor':cursor},
    })
    if remote is not None:
        return ReviewHistoryPage(
            reviews=[ReviewHistoryItem.model_validate(item) for item in remote['page']],
            next_cursor=None if remote['isDone'] else remote['continueCursor'],
            has_more=not remote['isDone'],
        )

    items=_local_reviews()

    try:
        offset=max(0, int(cursor or '0'))
    except ValueError:
        offset=0
    page=items[offset:offset + limit]
    next_offset=offset + len(page)
    has_more=next_offset < len(items)
    return ReviewHistoryPage(
        reviews=page,
        next_cursor=str(next_offset) if has_more else None,
        has_more=has_more,
    )


def _offer_settings_path()->Path:
    return JOB_DATA_DIR/'settings'/OFFER_SETTINGS_FILE


def _read_local_offer_profiles()->list[OfferProfile]:
    path=_offer_settings_path()
    if not path.exists():
        return []
    try:
        payload=read_json(path)
        return [OfferProfile.model_validate(item) for item in payload]
    except (OSError, ValueError, TypeError):
        return []


def _write_local_offer_profiles(profiles:list[OfferProfile])->None:
    write_json(_offer_settings_path(), [profile.model_dump(mode='json') for profile in profiles])


def _offer_revisions_path()->Path:
    return JOB_DATA_DIR/'settings'/OFFER_REVISIONS_FILE


def _read_local_offer_revisions()->list[OfferProfile]:
    path=_offer_revisions_path()
    if not path.exists():
        return []
    try:
        payload=read_json(path)
        return [OfferProfile.model_validate(item) for item in payload]
    except (OSError, ValueError, TypeError):
        return []


def _write_local_offer_revision(profile:OfferProfile)->None:
    revisions=_read_local_offer_revisions()
    revisions=[
        revision
        for revision in revisions
        if not (
            revision.offer_id == profile.offer_id
            and revision.version == profile.version
        )
    ]
    revisions.append(profile)
    revisions.sort(key=lambda revision:(revision.offer_id, revision.version))
    write_json(_offer_revisions_path(), [revision.model_dump(mode='json') for revision in revisions])


def _validate_offer_payload(args:dict[str, Any])->None:
    overrides=args['internalOverrides']
    if len(overrides) > MAX_OFFER_OVERRIDES:
        raise ValueError(f'An offer can have at most {MAX_OFFER_OVERRIDES} internal overrides.')
    seen:set[str]=set()
    for override in overrides:
        override_id=str(override['overrideId']).strip()
        if not OFFER_ID_PATTERN.fullmatch(override_id):
            raise ValueError('Internal override IDs must be lowercase slugs.')
        if override_id in seen:
            raise ValueError(f'Duplicate internal override ID: {override_id}.')
        seen.add(override_id)
    payload_size=len(json.dumps(args, ensure_ascii=False).encode('utf-8'))
    if payload_size > MAX_OFFER_PROFILE_BYTES:
        raise ValueError(
            'This offer profile is too large to save. Shorten the guidelines or internal overrides.'
        )


def list_offer_profiles(*, include_disabled:bool=True)->list[OfferProfile]:
    remote=_convex_call('query', 'offers:list', {'includeDisabled': include_disabled})
    if remote is not None:
        profiles=[OfferProfile.model_validate(item) for item in remote]
    else:
        profiles=_read_local_offer_profiles()

    if not any(profile.offer_id == 'acp' for profile in profiles):
        acp=built_in_acp_profile()
        if any(profile.is_default for profile in profiles):
            acp=acp.model_copy(update={'is_default':False})
        profiles.append(acp)
    if not include_disabled:
        profiles=[profile for profile in profiles if profile.enabled]
    return sorted(profiles, key=lambda profile: (not profile.is_default, profile.display_name.casefold()))


def get_offer_profile(offer_id:str)->OfferProfile:
    for profile in list_offer_profiles(include_disabled=True):
        if profile.offer_id == offer_id:
            return profile
    raise KeyError(offer_id)


def upsert_offer_profile(offer_id:str, payload:OfferProfileInput)->OfferProfile:
    args={
        'offerId':offer_id,
        'displayName':payload.display_name.strip(),
        'officialGuidelines':payload.official_guidelines.strip(),
        'internalOverrides':[
            {
                'overrideId':override.override_id,
                'title':override.title,
                'guidance':override.guidance,
                'rationale':override.rationale,
                'enabled':override.enabled,
            }
            for override in payload.internal_overrides
        ],
        'enabled':payload.enabled,
        'isDefault':payload.is_default,
    }
    _validate_offer_payload(args)
    remote=_convex_call('mutation', 'offers:upsert', args)
    if remote is not None:
        profile=OfferProfile.model_validate(remote)
        return profile

    existing={profile.offer_id:profile for profile in _read_local_offer_profiles()}
    try:
        previous=get_offer_profile(offer_id)
    except KeyError:
        previous=None
    timestamp=now_ms()
    profile=OfferProfile(
        offer_id=offer_id,
        display_name=payload.display_name.strip(),
        official_guidelines=payload.official_guidelines.strip(),
        internal_overrides=payload.internal_overrides,
        enabled=payload.enabled,
        is_default=payload.is_default,
        version=(previous.version + 1) if previous else 1,
        created_at=previous.created_at if previous else timestamp,
        updated_at=timestamp,
    )
    if profile.is_default:
        for current_id,current in list(existing.items()):
            if current.is_default:
                existing[current_id]=current.model_copy(update={'is_default':False})
    existing[offer_id]=profile
    _write_local_offer_profiles(list(existing.values()))
    _write_local_offer_revision(profile)
    return profile


def get_offer_profile_revision(offer_id:str, version:int)->OfferProfile:
    if version < 1:
        raise KeyError(f'{offer_id}@{version}')
    remote=_convex_call(
        'query',
        'offers:getRevision',
        {'offerId':offer_id, 'version':version},
    )
    if remote is not None:
        return OfferProfile.model_validate(remote)
    if offer_id == 'acp' and version == 1:
        return built_in_acp_profile()
    for revision in _read_local_offer_revisions():
        if revision.offer_id == offer_id and revision.version == version:
            return revision
    raise KeyError(f'{offer_id}@{version}')


def disable_offer_profile(offer_id:str)->OfferProfile:
    if offer_id == 'acp':
        raise ValueError('ACP is the built-in fallback and cannot be disabled.')
    remote=_convex_call('mutation', 'offers:disable', {'offerId':offer_id})
    if remote is not None:
        return OfferProfile.model_validate(remote)
    existing=get_offer_profile(offer_id)
    return upsert_offer_profile(
        offer_id,
        OfferProfileInput(
            display_name=existing.display_name,
            official_guidelines=existing.official_guidelines,
            internal_overrides=existing.internal_overrides,
            enabled=False,
            is_default=False,
        ),
    )


def resolve_offer_profiles(offer_ids:list[str])->list[OfferProfile]:
    unique_ids=list(dict.fromkeys(offer_id.strip().lower() for offer_id in offer_ids if offer_id.strip()))
    if not unique_ids:
        unique_ids=['acp']
    if len(unique_ids) > 10:
        raise ValueError('Select no more than 10 offers per review.')
    available={profile.offer_id:profile for profile in list_offer_profiles(include_disabled=False)}
    missing=[offer_id for offer_id in unique_ids if offer_id not in available]
    if missing:
        raise KeyError(', '.join(missing))
    return [available[offer_id].model_copy(deep=True) for offer_id in unique_ids]


def _report_offer_result(report:dict[str, Any]|None, offer_id:str)->dict[str, Any]|None:
    if not isinstance(report, dict):
        return None
    results=report.get('offer_results')
    if isinstance(results, list):
        for result in results:
            if isinstance(result, dict) and result.get('offer_id') == offer_id:
                return result
    primary=report.get('primary_offer_id') or report.get('offer_id') or 'acp'
    return report if primary == offer_id else None


def get_review_stats(offer_id:str='acp')->ReviewStats:
    remote=_convex_call('query', 'reviews:getStats', {'offerId':offer_id})
    if remote is not None:
        return ReviewStats.model_validate(remote)

    stats=ReviewStats(offer_id=offer_id)
    outcomes=stats.outcomes.model_dump()
    if not JOB_DATA_DIR.exists():
        return stats
    for status_path in JOB_DATA_DIR.glob('*/status.json'):
        if (status_path.parent/'deleted.json').exists():
            continue
        try:
            record=JobRecord.model_validate(read_json(status_path))
        except (OSError, ValueError):
            continue
        if offer_id not in record.offer_ids:
            continue
        stats.total_reviews += 1
        if record.has_creative:
            stats.creative_reviews += 1
        else:
            stats.copy_only_reviews += 1
        if record.status == JobStatus.failed:
            stats.failed_reviews += 1
            continue
        if record.status != JobStatus.complete:
            stats.in_progress_reviews += 1
            continue
        stats.completed_reviews += 1
        report_path=status_path.parent/'report.json'
        report=read_json(report_path) if report_path.exists() else None
        result=_report_offer_result(report, offer_id)
        status=_overall_status(result)
        if status:
            outcomes[status] += 1
        if isinstance(result, dict) and result.get('internal_disposition') == 'accepted_with_override':
            stats.accepted_overrides += 1
    stats.outcomes=ReviewOutcomeCounts(**outcomes)
    return stats


def delete_review(job_id:str)->DeletedReview:
    record=get_status(job_id)
    if record.status not in {JobStatus.complete, JobStatus.failed}:
        raise ValueError('Only completed or failed reviews can be removed from history.')
    remote=_convex_call('mutation', 'reviews:softDelete', {'jobId':job_id})
    deleted_at=int(remote.get('deleted_at')) if isinstance(remote, dict) else now_ms()
    write_json(JOB_DATA_DIR/job_id/'deleted.json', {'job_id':job_id, 'deleted_at':deleted_at})
    return DeletedReview(job_id=job_id, deleted_at=deleted_at)
