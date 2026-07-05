from __future__ import annotations
import os, uuid
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from .review_pipeline.models import ReviewRequestMeta, JobRecord, ComplianceReport
from .review_pipeline.storage import get_report as get_stored_report, get_status, job_dir
from .review_pipeline.queue import enqueue_job, start_job_workers, stop_job_workers

@asynccontextmanager
async def lifespan(app: FastAPI):
    await start_job_workers()
    yield
    await stop_job_workers()

app=FastAPI(title='Ad Compliance Video Reviewer', lifespan=lifespan)
allowed_hosts=[h.strip() for h in os.getenv('APP_ALLOWED_HOSTS','*').split(',') if h.strip()]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])

@app.middleware('http')
async def optional_password_gate(request: Request, call_next):
    password = os.getenv('APP_PASSWORD')
    if password and request.url.path.startswith('/api') and request.headers.get('x-app-password') != password:
        return JSONResponse({'detail':'Invalid or missing x-app-password'}, status_code=401)
    return await call_next(request)

@app.post('/api/reviews', response_model=JobRecord)
async def create_review(video:UploadFile=File(...), ad_copy:str=Form(...), policy_text:str=Form(...), notes:str=Form(''), manual_transcript:str=Form(''), model:str=Form(''), frame_interval_seconds:float=Form(1.0), scene_detection:bool=Form(False)):
    max_mb=int(os.getenv('MAX_UPLOAD_MB','200'))
    job_id=uuid.uuid4().hex; jd=job_dir(job_id)
    file_name=Path(video.filename or 'upload.mp4').name or 'upload.mp4'
    video_path=jd/file_name
    size=0
    with video_path.open('wb') as f:
        while chunk:=await video.read(1024*1024):
            size += len(chunk)
            if size > max_mb*1024*1024: raise HTTPException(413, f'Max upload is {max_mb} MB')
            f.write(chunk)
    meta=ReviewRequestMeta(ad_copy=ad_copy, policy_text=policy_text, notes=notes, manual_transcript=manual_transcript, model=model or None, frame_interval_seconds=frame_interval_seconds, scene_detection=scene_detection)
    (jd/'request.json').write_text(meta.model_dump_json(indent=2), encoding='utf-8')
    rec=await enqueue_job(job_id, video_path, meta, file_name)
    return rec

@app.get('/api/reviews/{job_id}', response_model=JobRecord)
def review_status(job_id:str):
    try:
        return get_status(job_id)
    except FileNotFoundError:
        raise HTTPException(404,'Review job not found') from None

@app.get('/api/reviews/{job_id}/report', response_model=ComplianceReport)
def get_report(job_id:str):
    report=get_stored_report(job_id)
    if report is None: raise HTTPException(404,'Report not ready')
    return report

@app.get('/api/reviews/{job_id}/report.json')
def download_report(job_id:str):
    report=get_stored_report(job_id)
    if report is None: raise HTTPException(404,'Report not ready')
    return JSONResponse(report, headers={'content-disposition':f'attachment; filename="{job_id}-report.json"'})

@app.get('/api/reviews/{job_id}/frames/{filename}')
def frame(job_id:str, filename:str):
    p=job_dir(job_id)/'frames'/filename
    if not p.exists(): raise HTTPException(404,'Frame not found')
    return FileResponse(p)

static=Path('frontend/dist')
if static.exists():
    app.mount('/', StaticFiles(directory=static, html=True), name='static')
