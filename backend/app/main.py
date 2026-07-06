from __future__ import annotations
import os, uuid
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from .review_pipeline.models import ReviewRequestMeta, JobRecord, ComplianceReport, ReviewHistoryItem
from .review_pipeline.storage import get_report as get_stored_report, get_status, job_dir, list_reviews
from .review_pipeline.queue import enqueue_job, start_job_workers, stop_job_workers
from .review_pipeline.media import detect_media_kind

COPY_LABEL_MAX_LENGTH = 72


def copy_review_file_name(ad_copy: str) -> str:
    prefix = 'Ad copy: '
    preview = ' '.join(ad_copy.split())
    if not preview:
        return 'Ad copy'
    max_preview = max(1, COPY_LABEL_MAX_LENGTH - len(prefix))
    if len(preview) > max_preview:
        preview = preview[: max_preview - 3].rstrip() + '...'
    return f'{prefix}{preview}'

@asynccontextmanager
async def lifespan(app: FastAPI):
    await start_job_workers()
    yield
    await stop_job_workers()

app=FastAPI(title='Ad Compliance Creative Reviewer', lifespan=lifespan)
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
async def create_review(creative:UploadFile|None=File(None), video:UploadFile|None=File(None), ad_copy:str=Form(''), policy_text:str=Form(''), notes:str=Form(''), manual_transcript:str=Form(''), model:str=Form(''), frame_interval_seconds:float=Form(1.0), scene_detection:bool=Form(False)):
    upload=creative or video
    ad_copy=ad_copy.strip()
    meta=ReviewRequestMeta(ad_copy=ad_copy, policy_text=policy_text, notes=notes, manual_transcript=manual_transcript, model=model or None, frame_interval_seconds=frame_interval_seconds, scene_detection=scene_detection)
    if upload is None:
        if not meta.has_ad_copy:
            raise HTTPException(400, 'Choose a creative file or enter ad copy to review.')
        job_id=uuid.uuid4().hex; jd=job_dir(job_id)
        (jd/'request.json').write_text(meta.model_dump_json(indent=2), encoding='utf-8')
        rec=await enqueue_job(job_id, None, 'copy_only', meta, copy_review_file_name(ad_copy))
        return rec
    file_name=Path(upload.filename or 'upload').name or 'upload'
    try:
        media_kind=detect_media_kind(file_name, upload.content_type)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from None
    max_mb=int(os.getenv('MAX_UPLOAD_MB','200'))
    job_id=uuid.uuid4().hex; jd=job_dir(job_id)
    media_path=jd/file_name
    size=0
    with media_path.open('wb') as f:
        while chunk:=await upload.read(1024*1024):
            size += len(chunk)
            if size > max_mb*1024*1024: raise HTTPException(413, f'Max upload is {max_mb} MB')
            f.write(chunk)
    (jd/'request.json').write_text(meta.model_dump_json(indent=2), encoding='utf-8')
    rec=await enqueue_job(job_id, media_path, media_kind, meta, file_name)
    return rec

@app.get('/api/reviews', response_model=list[ReviewHistoryItem])
def review_history(limit:int=50):
    return list_reviews(limit)

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
