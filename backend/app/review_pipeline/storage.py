from __future__ import annotations
import json, os
from pathlib import Path
from .models import JobRecord, JobStatus

JOB_DATA_DIR = Path(os.getenv('JOB_DATA_DIR','data/jobs'))

def job_dir(job_id:str)->Path:
    p=JOB_DATA_DIR/job_id; p.mkdir(parents=True, exist_ok=True); return p

def write_json(path:Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')

def read_json(path:Path):
    return json.loads(path.read_text(encoding='utf-8'))

def set_status(job_id:str, status:JobStatus, progress:int, message:str='')->JobRecord:
    rec=JobRecord(job_id=job_id,status=status,progress=progress,message=message,report_ready=(status==JobStatus.complete))
    write_json(job_dir(job_id)/'status.json', rec.model_dump(mode='json'))
    return rec

def get_status(job_id:str)->JobRecord:
    p=job_dir(job_id)/'status.json'
    if not p.exists(): return set_status(job_id, JobStatus.queued, 0)
    return JobRecord.model_validate(read_json(p))
