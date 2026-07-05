from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path
from typing import Any

from .models import JobRecord, JobStatus

JOB_DATA_DIR = Path(os.getenv('JOB_DATA_DIR', 'data/jobs'))
CONVEX_URL = os.getenv('CONVEX_URL', '').rstrip('/')
CONVEX_HTTP_SECRET = os.getenv('CONVEX_HTTP_SECRET', '')

def job_dir(job_id:str)->Path:
    p=JOB_DATA_DIR/job_id; p.mkdir(parents=True, exist_ok=True); return p

def write_json(path:Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')

def read_json(path:Path):
    return json.loads(path.read_text(encoding='utf-8'))

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

def set_status(job_id:str, status:JobStatus, progress:int, message:str='', file_name:str='')->JobRecord:
    current_file_name=file_name
    local_path=job_dir(job_id)/'status.json'
    if not current_file_name and local_path.exists():
        current_file_name=JobRecord.model_validate(read_json(local_path)).file_name

    rec=JobRecord(job_id=job_id,file_name=current_file_name,status=status,progress=progress,message=message,report_ready=(status==JobStatus.complete))
    write_json(local_path, rec.model_dump(mode='json'))
    _convex_call('mutation', 'reviews:upsertStatus', {
        'fileName': rec.file_name,
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
