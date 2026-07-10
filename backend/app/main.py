from __future__ import annotations
import asyncio, json, os, re, shutil, uuid
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from .review_pipeline.models import (
    BatchFailure,
    ComplianceReport,
    CreateDriveReview,
    CreateReviewBatch,
    DriveCreativeFile,
    DriveCreativeList,
    JobRecord,
    ReviewSource,
    ReviewSources,
    ReviewBatch,
    ReviewHistoryItem,
    ReviewRequestMeta,
)
from .review_pipeline.storage import (
    create_batch,
    get_batch,
    get_report as get_stored_report,
    get_status,
    job_dir,
    list_reviews,
    now_ms,
    set_review_source,
)
from .review_pipeline.queue import enqueue_job, start_job_workers, stop_job_workers
from .review_pipeline.media import detect_media_kind
from .review_pipeline.drive import DriveLookupError, get_google_drive_client
from .review_pipeline.source_links import resolve_review_sources
from .review_pipeline.telegram import finish_batch_item_and_notify

COPY_LABEL_MAX_LENGTH = 72
UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
UPLOAD_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')
UPLOAD_METADATA_FILE = 'upload.json'
UPLOAD_CHUNKS_DIR = 'upload_chunks'
BATCH_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')


def copy_review_file_name(ad_copy: str) -> str:
    prefix = 'Ad copy: '
    preview = ' '.join(ad_copy.split())
    if not preview:
        return 'Ad copy'
    max_preview = max(1, COPY_LABEL_MAX_LENGTH - len(prefix))
    if len(preview) > max_preview:
        preview = preview[: max_preview - 3].rstrip() + '...'
    return f'{prefix}{preview}'


def upload_job_dir(upload_id: str) -> Path:
    if not UPLOAD_ID_PATTERN.fullmatch(upload_id):
        raise HTTPException(404, 'Upload not found')
    path = job_dir(upload_id)
    if not (path / UPLOAD_METADATA_FILE).exists():
        raise HTTPException(404, 'Upload not found')
    return path


def read_upload_metadata(upload_id: str) -> tuple[Path, dict]:
    path = upload_job_dir(upload_id)
    try:
        metadata = json.loads((path / UPLOAD_METADATA_FILE).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise HTTPException(409, 'Upload metadata is unavailable; restart this upload.') from None
    return path, metadata


def review_meta(
    ad_copy: str,
    policy_text: str,
    notes: str,
    manual_transcript: str,
    model: str,
    frame_interval_seconds: float,
    scene_detection: bool,
    batch_id: str,
    batch_item_id: str,
) -> ReviewRequestMeta:
    return ReviewRequestMeta(
        ad_copy=ad_copy.strip(),
        policy_text=policy_text,
        notes=notes,
        manual_transcript=manual_transcript,
        model=model or None,
        frame_interval_seconds=frame_interval_seconds,
        scene_detection=scene_detection,
        batch_id=batch_id or None,
        batch_item_id=batch_item_id or None,
    )

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
async def create_review(creative:UploadFile|None=File(None), video:UploadFile|None=File(None), ad_copy:str=Form(''), policy_text:str=Form(''), notes:str=Form(''), manual_transcript:str=Form(''), model:str=Form(''), frame_interval_seconds:float=Form(1.0), scene_detection:bool=Form(False), batch_id:str=Form(''), batch_item_id:str=Form('')):
    upload=creative or video
    meta=review_meta(ad_copy, policy_text, notes, manual_transcript, model, frame_interval_seconds, scene_detection, batch_id, batch_item_id)
    if upload is None:
        if not meta.has_ad_copy:
            raise HTTPException(400, 'Choose a creative file or enter ad copy to review.')
        job_id=uuid.uuid4().hex; jd=job_dir(job_id)
        (jd/'request.json').write_text(meta.model_dump_json(indent=2), encoding='utf-8')
        rec=await enqueue_job(job_id, None, 'copy_only', meta, copy_review_file_name(meta.ad_copy))
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
    rec=await enqueue_job(job_id, media_path, media_kind, meta, file_name, file_size=size)
    return rec


@app.get('/api/drive/files', response_model=DriveCreativeList)
def drive_creatives():
    try:
        files = get_google_drive_client().list_creative_files()
    except DriveLookupError as exc:
        raise HTTPException(503, str(exc)) from None
    return DriveCreativeList(files=[
        DriveCreativeFile(
            file_id=file.file_id,
            name=file.name,
            mime_type=file.mime_type,
            size=file.size,
            modified_time=file.modified_time,
            web_view_link=file.web_view_link,
        )
        for file in files
    ])


@app.post('/api/drive/reviews', response_model=JobRecord)
async def create_drive_review(payload: CreateDriveReview):
    try:
        drive_file = await asyncio.to_thread(get_google_drive_client().get_file, payload.file_id)
    except DriveLookupError as exc:
        raise HTTPException(400, str(exc)) from None

    file_name = Path(drive_file.name).name or 'drive-creative'
    try:
        media_kind = detect_media_kind(file_name, drive_file.mime_type)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from None
    max_bytes = int(os.getenv('MAX_UPLOAD_MB', '200')) * 1024 * 1024
    if not drive_file.can_download:
        raise HTTPException(403, 'This Google Drive file cannot be downloaded by the service account.')
    if drive_file.size is not None and drive_file.size > max_bytes:
        raise HTTPException(413, f'Max upload is {os.getenv("MAX_UPLOAD_MB", "200")} MB')

    meta = ReviewRequestMeta(
        ad_copy=payload.ad_copy.strip(),
        policy_text=payload.policy_text,
        notes=payload.notes,
        manual_transcript=payload.manual_transcript,
        model=payload.model or None,
        frame_interval_seconds=payload.frame_interval_seconds,
        scene_detection=payload.scene_detection,
        batch_id=payload.batch_id or None,
        batch_item_id=payload.batch_item_id or None,
    )
    job_id = uuid.uuid4().hex
    jd = job_dir(job_id)
    media_path = jd / file_name
    (jd/'request.json').write_text(meta.model_dump_json(indent=2), encoding='utf-8')
    record = await enqueue_job(
        job_id,
        media_path,
        media_kind,
        meta,
        file_name,
        file_size=drive_file.size,
        drive_file=drive_file,
    )
    set_review_source(job_id, ReviewSource(
        kind='google_drive_file',
        status='linked',
        url=drive_file.web_view_link,
        file_id=drive_file.file_id,
        label='Open creative in Google Drive',
        message=f'Selected “{file_name}” directly from the shared Drive folder.',
        checked_at=now_ms(),
    ))
    return get_status(record.job_id)


@app.post('/api/uploads')
async def start_chunked_upload(request: Request):
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, 'Invalid upload metadata') from None
    if not isinstance(payload, dict):
        raise HTTPException(400, 'Invalid upload metadata')

    file_name = Path(str(payload.get('file_name', 'upload'))).name or 'upload'
    content_type = str(payload.get('content_type', ''))
    try:
        size = int(payload.get('size', 0))
    except (TypeError, ValueError):
        raise HTTPException(400, 'Invalid upload size') from None

    max_bytes = int(os.getenv('MAX_UPLOAD_MB', '200')) * 1024 * 1024
    if size <= 0:
        raise HTTPException(400, 'The creative file is empty.')
    if size > max_bytes:
        raise HTTPException(413, f'Max upload is {os.getenv("MAX_UPLOAD_MB", "200")} MB')

    try:
        media_kind = detect_media_kind(file_name, content_type)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from None

    upload_id = uuid.uuid4().hex
    upload_dir = job_dir(upload_id)
    (upload_dir / UPLOAD_CHUNKS_DIR).mkdir(parents=True, exist_ok=True)
    chunk_count = (size + UPLOAD_CHUNK_SIZE - 1) // UPLOAD_CHUNK_SIZE
    metadata = {
        'file_name': file_name,
        'media_kind': media_kind,
        'size': size,
        'chunk_size': UPLOAD_CHUNK_SIZE,
        'chunk_count': chunk_count,
    }
    (upload_dir / UPLOAD_METADATA_FILE).write_text(json.dumps(metadata), encoding='utf-8')
    return {'upload_id': upload_id, **metadata}


@app.put('/api/uploads/{upload_id}/chunks/{chunk_index}')
async def upload_chunk(upload_id: str, chunk_index: int, request: Request):
    upload_dir, metadata = read_upload_metadata(upload_id)
    chunk_count = int(metadata['chunk_count'])
    if chunk_index < 0 or chunk_index >= chunk_count:
        raise HTTPException(400, 'Invalid upload chunk')

    expected_size = min(
        int(metadata['chunk_size']),
        int(metadata['size']) - chunk_index * int(metadata['chunk_size']),
    )
    chunks_dir = upload_dir / UPLOAD_CHUNKS_DIR
    chunk_path = chunks_dir / f'{chunk_index:06d}.part'
    if chunk_path.exists() and chunk_path.stat().st_size == expected_size:
        return {'received': expected_size}

    temp_path = chunks_dir / f'.{chunk_index:06d}.{uuid.uuid4().hex}.tmp'
    received = 0
    try:
        with temp_path.open('wb') as output:
            async for data in request.stream():
                received += len(data)
                if received > expected_size:
                    raise HTTPException(413, 'Upload chunk is larger than expected')
                output.write(data)
        if received != expected_size:
            raise HTTPException(400, 'Upload chunk is incomplete; retry it.')
        temp_path.replace(chunk_path)
    finally:
        temp_path.unlink(missing_ok=True)

    return {'received': received}


@app.post('/api/uploads/{upload_id}/complete', response_model=JobRecord)
async def complete_chunked_upload(
    upload_id: str,
    ad_copy: str = Form(''),
    policy_text: str = Form(''),
    notes: str = Form(''),
    manual_transcript: str = Form(''),
    model: str = Form(''),
    frame_interval_seconds: float = Form(1.0),
    scene_detection: bool = Form(False),
    batch_id: str = Form(''),
    batch_item_id: str = Form(''),
):
    upload_dir, metadata = read_upload_metadata(upload_id)
    if metadata.get('completed') or (upload_dir / 'status.json').exists():
        return get_status(upload_id)

    chunks_dir = upload_dir / UPLOAD_CHUNKS_DIR
    chunk_paths = [chunks_dir / f'{index:06d}.part' for index in range(int(metadata['chunk_count']))]
    if any(not path.exists() for path in chunk_paths):
        raise HTTPException(409, 'Upload is incomplete; retry the missing chunks.')
    if sum(path.stat().st_size for path in chunk_paths) != int(metadata['size']):
        raise HTTPException(409, 'Upload size does not match; restart this upload.')

    meta = review_meta(ad_copy, policy_text, notes, manual_transcript, model, frame_interval_seconds, scene_detection, batch_id, batch_item_id)
    media_path = upload_dir / str(metadata['file_name'])
    enqueued = False
    try:
        with media_path.open('wb') as output:
            for chunk_path in chunk_paths:
                with chunk_path.open('rb') as chunk:
                    shutil.copyfileobj(chunk, output)
        (upload_dir / 'request.json').write_text(meta.model_dump_json(indent=2), encoding='utf-8')
        record = await enqueue_job(
            upload_id,
            media_path,
            metadata['media_kind'],
            meta,
            metadata['file_name'],
            file_size=metadata['size'],
        )
        enqueued = True
        metadata['completed'] = True
        (upload_dir / UPLOAD_METADATA_FILE).write_text(json.dumps(metadata), encoding='utf-8')
        shutil.rmtree(chunks_dir, ignore_errors=True)
        return record
    except Exception:
        if not enqueued:
            media_path.unlink(missing_ok=True)
        raise

@app.post('/api/batches', response_model=ReviewBatch)
def create_review_batch(payload:CreateReviewBatch):
    if not BATCH_ID_PATTERN.fullmatch(payload.batch_id):
        raise HTTPException(400, 'Invalid batch id')
    if len(payload.items) < 2:
        raise HTTPException(400, 'A batch must contain at least two items.')
    if len({item.item_id for item in payload.items}) != len(payload.items):
        raise HTTPException(400, 'Batch item ids must be unique.')
    if any(not BATCH_ID_PATTERN.fullmatch(item.item_id) for item in payload.items):
        raise HTTPException(400, 'Invalid batch item id')
    return create_batch(payload.batch_id, payload.items)

@app.get('/api/batches/{batch_id}', response_model=ReviewBatch)
def review_batch(batch_id:str):
    if not BATCH_ID_PATTERN.fullmatch(batch_id):
        raise HTTPException(404, 'Review batch not found')
    try:
        return get_batch(batch_id)
    except FileNotFoundError:
        raise HTTPException(404, 'Review batch not found') from None

@app.post('/api/batches/{batch_id}/items/{item_id}/failed', response_model=ReviewBatch)
def fail_batch_upload(batch_id:str, item_id:str, payload:BatchFailure):
    if not BATCH_ID_PATTERN.fullmatch(batch_id) or not BATCH_ID_PATTERN.fullmatch(item_id):
        raise HTTPException(404, 'Review batch item not found')
    try:
        return finish_batch_item_and_notify(
            batch_id,
            item_id,
            status='upload_failed',
            message=payload.message,
        )
    except (FileNotFoundError, KeyError):
        raise HTTPException(404, 'Review batch item not found') from None

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

@app.get('/api/reviews/{job_id}/source', response_model=ReviewSources)
def review_source(job_id:str):
    try:
        return resolve_review_sources(job_id)
    except FileNotFoundError:
        raise HTTPException(404,'Review job not found') from None

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
