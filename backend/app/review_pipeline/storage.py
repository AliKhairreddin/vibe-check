from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any

from .models import (
    CreateBatchItem,
    JobRecord,
    JobStatus,
    ReviewBatch,
    ReviewBatchItem,
    ReviewHistoryItem,
)

JOB_DATA_DIR = Path(os.getenv('JOB_DATA_DIR', 'data/jobs'))
CONVEX_URL = os.getenv('CONVEX_URL', '').rstrip('/')
CONVEX_HTTP_SECRET = os.getenv('CONVEX_HTTP_SECRET', '')
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

def set_status(job_id:str, status:JobStatus, progress:int, message:str='', file_name:str='', has_ad_copy:bool|None=None, has_creative:bool|None=None, batch_id:str|None=None, batch_item_id:str|None=None)->JobRecord:
    current_file_name=file_name
    current_has_ad_copy=True if has_ad_copy is None else has_ad_copy
    current_has_creative=True if has_creative is None else has_creative
    current_batch_id=batch_id
    current_batch_item_id=batch_item_id
    local_path=job_dir(job_id)/'status.json'
    created_at=now_ms()
    if local_path.exists():
        current=JobRecord.model_validate(read_json(local_path))
        if not current_file_name:
            current_file_name=current.file_name
        if has_ad_copy is None:
            current_has_ad_copy=current.has_ad_copy
        if has_creative is None:
            current_has_creative=current.has_creative
        if current_batch_id is None:
            current_batch_id=current.batch_id
        if current_batch_item_id is None:
            current_batch_item_id=current.batch_item_id
        created_at=current.created_at or created_at

    rec=JobRecord(job_id=job_id,file_name=current_file_name,status=status,progress=progress,message=message,report_ready=(status==JobStatus.complete),has_creative=current_has_creative,has_ad_copy=current_has_ad_copy,batch_id=current_batch_id,batch_item_id=current_batch_item_id,created_at=created_at,updated_at=now_ms())
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
    }
    if rec.batch_id:
        review_args['batchId'] = rec.batch_id
    if rec.batch_item_id:
        review_args['batchItemId'] = rec.batch_item_id
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

def get_status(job_id:str)->JobRecord:
    remote=_convex_call('query', 'reviews:getStatus', {'jobId': job_id})
    if remote:
        return JobRecord.model_validate(remote)
    p=job_dir(job_id)/'status.json'
    if not p.exists(): raise FileNotFoundError(job_id)
    return JobRecord.model_validate(read_json(p))

def set_report(job_id:str, report:dict[str, Any])->None:
    write_json(job_dir(job_id)/'report.json', report)
    _convex_call('mutation', 'reviews:setReport', {'jobId': job_id, 'report': report})

def get_report(job_id:str)->dict[str, Any]|None:
    remote=_convex_call('query', 'reviews:getReport', {'jobId': job_id})
    if remote is not None:
        return remote
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

def list_reviews(limit:int=50)->list[ReviewHistoryItem]:
    limit=max(1, min(limit, 100))
    remote=_convex_call('query', 'reviews:listRecent', {'limit': limit})
    if remote is not None:
        return [ReviewHistoryItem.model_validate(item) for item in remote]

    if not JOB_DATA_DIR.exists():
        return []

    items=[]
    for status_path in JOB_DATA_DIR.glob('*/status.json'):
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
    return items[:limit]
