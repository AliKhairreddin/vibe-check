from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any

from .models import JobRecord, JobStatus, ReviewHistoryItem

JOB_DATA_DIR = Path(os.getenv('JOB_DATA_DIR', 'data/jobs'))
CONVEX_URL = os.getenv('CONVEX_URL', '').rstrip('/')
CONVEX_HTTP_SECRET = os.getenv('CONVEX_HTTP_SECRET', '')
RESULT_STATUSES = {'pass','needs_review','likely_violation'}

def job_dir(job_id:str)->Path:
    p=JOB_DATA_DIR/job_id; p.mkdir(parents=True, exist_ok=True); return p

def write_json(path:Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')

def read_json(path:Path):
    return json.loads(path.read_text(encoding='utf-8'))

def now_ms()->int:
    return int(time.time() * 1000)

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

def set_status(job_id:str, status:JobStatus, progress:int, message:str='', file_name:str='', has_ad_copy:bool|None=None, has_creative:bool|None=None)->JobRecord:
    current_file_name=file_name
    current_has_ad_copy=True if has_ad_copy is None else has_ad_copy
    current_has_creative=True if has_creative is None else has_creative
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
        created_at=current.created_at or created_at

    rec=JobRecord(job_id=job_id,file_name=current_file_name,status=status,progress=progress,message=message,report_ready=(status==JobStatus.complete),has_creative=current_has_creative,has_ad_copy=current_has_ad_copy,created_at=created_at,updated_at=now_ms())
    write_json(local_path, rec.model_dump(mode='json'))
    _convex_call('mutation', 'reviews:upsertStatus', {
        'fileName': rec.file_name,
        'hasAdCopy': rec.has_ad_copy,
        'hasCreative': rec.has_creative,
        'jobId': rec.job_id,
        'message': rec.message,
        'progress': rec.progress,
        'reportReady': rec.report_ready,
        'status': rec.status.value,
    })
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

def _overall_status(report:dict[str, Any]|None)->str|None:
    status=report.get('overall_status') if isinstance(report, dict) else None
    return status if status in {'pass','needs_review','likely_violation'} else None

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
    return status if status in RESULT_STATUSES else None

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
        return 'pass' if status in RESULT_STATUSES else None
    if any(isinstance(finding, dict) and finding.get('severity') == 'high' for finding in relevant):
        return 'likely_violation'
    return 'needs_review'

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
