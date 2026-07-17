from __future__ import annotations
import asyncio, json, logging, os, re, secrets, shutil, uuid
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from .review_pipeline.models import (
    BatchFailure,
    AutomationRunResult,
    ComplianceReport,
    CreateDriveReview,
    CreateReviewBatch,
    DeletedReview,
    DriveBrowserItem,
    DriveBrowserList,
    DriveCreativeFile,
    DriveCreativeList,
    DriveFolder,
    DriveSelectionResult,
    JobRecord,
    OfferProfile,
    OfferProfileInput,
    OfferProfileList,
    ReviewSource,
    ReviewSources,
    ReviewBatch,
    ReviewAutomation,
    ReviewAutomationInput,
    ReviewAutomationList,
    ReviewHistoryItem,
    ReviewHistoryPage,
    ReviewStats,
    ResolveDriveSelection,
    ReviewRequestMeta,
)
from .review_pipeline.storage import (
    backfill_review_offer_stats,
    create_batch,
    delete_review,
    disable_offer_profile,
    get_batch,
    get_report as get_stored_report,
    get_offer_profile_revision,
    get_status,
    job_dir,
    list_reviews,
    list_reviews_page,
    get_review_stats,
    list_offer_profiles,
    now_ms,
    resolve_active_offer_profiles,
    resolve_review_offer_snapshot,
    set_review_source,
    upsert_offer_profile,
)
from .review_pipeline.queue import enqueue_job, start_job_workers, stop_job_workers
from .review_pipeline.media import detect_media_kind
from .review_pipeline.drive import (
    FOLDER_MIME_TYPE,
    MAX_DRIVE_SELECTION_FILES,
    DriveLookupError,
    get_google_drive_client,
)
from .review_pipeline.source_links import resolve_review_sources
from .review_pipeline.telegram import finish_batch_item_and_notify
from .review_pipeline.automation_storage import (
    delete_review_automation,
    deliver_pending_batch_notifications,
    get_review_automation,
    list_review_automations,
    recover_interrupted_automation_jobs,
    upsert_review_automation,
)
from .review_pipeline.automations import (
    run_due_review_automations,
    run_review_automation,
)

COPY_LABEL_MAX_LENGTH = 72
UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
UPLOAD_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')
UPLOAD_METADATA_FILE = 'upload.json'
UPLOAD_CHUNKS_DIR = 'upload_chunks'
BATCH_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')
JOB_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')
OFFER_ID_PATTERN = re.compile(r'^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$')
MAX_BATCH_ITEMS = 100
ADMIN_PASSWORD_HEADER = 'x-admin-password'
AUTOMATION_SECRET_HEADER = 'x-automation-secret'
logger = logging.getLogger(__name__)
background_tasks:set[asyncio.Task]=set()


async def deliver_batch_notifications_in_background()->None:
    try:
        await asyncio.to_thread(deliver_pending_batch_notifications, limit=1)
    except Exception:
        logger.exception('Could not deliver a pending batch notification.')


def start_background_task(coroutine)->None:
    task=asyncio.create_task(coroutine)
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)


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
    offer_ids: list[str] | None = None,
) -> ReviewRequestMeta:
    # Offer eligibility is server-owned. The legacy offer_ids input remains accepted
    # for backwards compatibility, but a caller cannot force a disabled/unconfigured
    # offer to run or omit an eligible one.
    offer_profiles,offer_outcomes=resolve_review_offer_snapshot()
    if not offer_profiles:
        raise HTTPException(
            409,
            'No offers are available for review. Save official guidelines and enable at least one offer in Settings.',
        )
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
        offer_profiles=offer_profiles,
        offer_outcomes=offer_outcomes,
    )


def parse_offer_ids(value:str)->list[str]:
    value=value.strip()
    if not value:
        return ['acp']
    try:
        parsed=json.loads(value)
    except json.JSONDecodeError:
        parsed=[part.strip() for part in value.split(',')]
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise HTTPException(400, 'offer_ids must be a JSON array of offer IDs.')
    return list(dict.fromkeys(item.strip().lower() for item in parsed if item.strip())) or ['acp']

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        migration=await asyncio.to_thread(backfill_review_offer_stats)
        if migration['processed']:
            logger.info(
                'Backfilled offer stats for %s existing review(s).',
                migration['processed'],
            )
        if not migration['is_done']:
            logger.warning('Offer stats backfill will resume on the next automation tick.')
    except Exception:
        logger.exception('Could not backfill review offer stats at startup.')
    try:
        recovered=await asyncio.to_thread(recover_interrupted_automation_jobs)
        if recovered:
            logger.warning('Recovered %s interrupted automation run(s) at startup.', recovered)
    except Exception:
        logger.exception('Could not reconcile interrupted automation jobs at startup.')
    await start_job_workers()
    start_background_task(deliver_batch_notifications_in_background())
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


def require_admin(request:Request)->None:
    expected=os.getenv('ADMIN_PASSWORD','')
    if not expected:
        raise HTTPException(
            503,
            'Admin access is not configured. Set the ADMIN_PASSWORD Worker secret first.',
        )
    provided=request.headers.get(ADMIN_PASSWORD_HEADER,'')
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(401, 'Invalid or missing admin password.')


def require_automation_secret(request:Request)->None:
    expected=os.getenv('CONVEX_HTTP_SECRET','')
    provided=request.headers.get(AUTOMATION_SECRET_HEADER,'')
    if not expected or not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(401, 'Invalid or missing automation secret.')


@app.get('/api/admin/check')
def admin_check(request:Request):
    require_admin(request)
    return {'authorized':True}


@app.post('/api/automations/internal/tick')
async def tick_review_automations(request:Request):
    require_automation_secret(request)
    try:
        await asyncio.to_thread(backfill_review_offer_stats)
    except Exception:
        logger.exception('Could not resume the review offer stats backfill.')
    await asyncio.to_thread(recover_interrupted_automation_jobs)
    results=await run_due_review_automations()
    start_background_task(deliver_batch_notifications_in_background())
    return {'runs':[result.model_dump(mode='json') for result in results]}


@app.get('/api/automations', response_model=ReviewAutomationList)
def review_automations(request:Request):
    require_admin(request)
    return ReviewAutomationList(
        automations=list_review_automations(include_disabled=True)
    )


@app.put('/api/automations/{automation_id}', response_model=ReviewAutomation)
def save_review_automation(
    automation_id:str,
    payload:ReviewAutomationInput,
    request:Request,
):
    require_admin(request)
    normalized=automation_id.strip().lower()
    if not OFFER_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(400, 'Automation ID must be a lowercase slug.')
    if payload.enabled:
        if not resolve_active_offer_profiles():
            raise HTTPException(
                409,
                'Enable at least one offer with saved official guidelines before enabling an automation.',
            )
        try:
            folder=get_google_drive_client().get_file(payload.folder_id)
        except DriveLookupError as exc:
            raise HTTPException(400, str(exc)) from None
        if folder.mime_type != FOLDER_MIME_TYPE:
            raise HTTPException(400, 'The automation source must be a Google Drive folder.')
    return upsert_review_automation(normalized, payload)


@app.delete('/api/automations/{automation_id}')
def remove_review_automation(automation_id:str, request:Request):
    require_admin(request)
    normalized=automation_id.strip().lower()
    if not OFFER_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(404, 'Review automation not found')
    try:
        delete_review_automation(normalized)
    except KeyError:
        raise HTTPException(404, 'Review automation not found') from None
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from None
    return {'automation_id':normalized}


@app.post('/api/automations/{automation_id}/run', response_model=AutomationRunResult)
async def run_saved_review_automation(automation_id:str, request:Request):
    require_admin(request)
    normalized=automation_id.strip().lower()
    if not OFFER_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(404, 'Review automation not found')
    try:
        automation=get_review_automation(normalized)
    except KeyError:
        raise HTTPException(404, 'Review automation not found') from None
    return await run_review_automation(automation, manual=True)

@app.post('/api/reviews', response_model=JobRecord)
async def create_review(creative:UploadFile|None=File(None), video:UploadFile|None=File(None), ad_copy:str=Form(''), policy_text:str=Form(''), notes:str=Form(''), manual_transcript:str=Form(''), model:str=Form(''), frame_interval_seconds:float=Form(1.0), scene_detection:bool=Form(False), batch_id:str=Form(''), batch_item_id:str=Form(''), offer_ids:str=Form('["acp"]')):
    upload=creative or video
    meta=review_meta(ad_copy, policy_text, notes, manual_transcript, model, frame_interval_seconds, scene_detection, batch_id, batch_item_id, parse_offer_ids(offer_ids))
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


def drive_creative_model(file)->DriveCreativeFile:
    return DriveCreativeFile(
        file_id=file.file_id,
        name=file.name,
        mime_type=file.mime_type,
        size=file.size,
        modified_time=file.modified_time,
        web_view_link=file.web_view_link,
    )


@app.get('/api/drive/browse', response_model=DriveBrowserList)
def browse_drive(folder_id:str|None=None):
    try:
        drive=get_google_drive_client()
        current=drive.get_file(folder_id or drive.root_folder_id)
        children=drive.list_folder_children(current.file_id)
    except DriveLookupError as exc:
        raise HTTPException(503, str(exc)) from None
    max_bytes=int(os.getenv('MAX_UPLOAD_MB','200')) * 1024 * 1024
    items=[]
    for child in children:
        is_folder=child.mime_type == FOLDER_MIME_TYPE
        too_large=not is_folder and child.size is not None and child.size > max_bytes
        items.append(DriveBrowserItem(
            **drive_creative_model(child).model_dump(),
            kind='folder' if is_folder else 'creative',
            selectable=not too_large,
            disabled_reason=(f'Exceeds the {os.getenv("MAX_UPLOAD_MB", "200")} MB limit' if too_large else None),
        ))
    return DriveBrowserList(
        current_folder=DriveFolder(
            folder_id=current.file_id,
            name=current.name,
            web_view_link=current.web_view_link,
        ),
        items=items,
        max_selection=MAX_DRIVE_SELECTION_FILES,
    )


@app.post('/api/drive/selection/resolve', response_model=DriveSelectionResult)
def resolve_drive_selection(payload:ResolveDriveSelection):
    if not payload.folder_ids and not payload.file_ids:
        raise HTTPException(400, 'Select at least one Google Drive folder or creative.')
    max_bytes=int(os.getenv('MAX_UPLOAD_MB','200')) * 1024 * 1024
    try:
        files=get_google_drive_client().resolve_selection(
            payload.folder_ids,
            payload.file_ids,
            max_file_size=max_bytes,
        )
    except DriveLookupError as exc:
        raise HTTPException(400, str(exc)) from None
    if not files:
        raise HTTPException(400, 'The selection contains no supported creatives within the upload limit.')
    return DriveSelectionResult(
        files=[drive_creative_model(file) for file in files],
        max_selection=MAX_DRIVE_SELECTION_FILES,
    )


@app.get('/api/drive/files', response_model=DriveCreativeList)
def drive_creatives():
    try:
        files = get_google_drive_client().list_creative_files()
    except DriveLookupError as exc:
        raise HTTPException(503, str(exc)) from None
    return DriveCreativeList(files=[
        drive_creative_model(file)
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

    meta = review_meta(
        payload.ad_copy,
        payload.policy_text,
        payload.notes,
        payload.manual_transcript,
        payload.model or '',
        payload.frame_interval_seconds,
        payload.scene_detection,
        payload.batch_id or '',
        payload.batch_item_id or '',
        payload.offer_ids,
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
    offer_ids: str = Form('["acp"]'),
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

    meta = review_meta(ad_copy, policy_text, notes, manual_transcript, model, frame_interval_seconds, scene_detection, batch_id, batch_item_id, parse_offer_ids(offer_ids))
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
    if len(payload.items) > MAX_BATCH_ITEMS:
        raise HTTPException(400, f'A batch can contain at most {MAX_BATCH_ITEMS} items.')
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


@app.get('/api/offers/catalog')
def offer_catalog():
    offers=list_offer_profiles(include_disabled=True)
    return {'offers':[
        {
            'offer_id':offer.offer_id,
            'display_name':offer.display_name,
            'enabled':offer.enabled,
            'configured':offer.configured,
            'is_default':offer.is_default,
            'version':offer.version,
            'override_count':sum(1 for override in offer.internal_overrides if override.enabled),
        }
        for offer in offers
    ]}


@app.get('/api/offers', response_model=OfferProfileList)
def offer_profiles(request:Request):
    require_admin(request)
    return OfferProfileList(offers=list_offer_profiles(include_disabled=True))


@app.get('/api/offers/{offer_id}/versions/{version}', response_model=OfferProfile)
def offer_profile_revision(offer_id:str, version:int, request:Request):
    require_admin(request)
    normalized=offer_id.strip().lower()
    if not OFFER_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(404, 'Offer profile revision not found')
    try:
        return get_offer_profile_revision(normalized, version)
    except KeyError:
        raise HTTPException(404, 'Offer profile revision not found') from None


@app.put('/api/offers/{offer_id}', response_model=OfferProfile)
def save_offer_profile(offer_id:str, payload:OfferProfileInput, request:Request):
    require_admin(request)
    normalized=offer_id.strip().lower()
    if not OFFER_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(400, 'Offer ID must be a lowercase slug using letters, numbers, hyphens, or underscores.')
    try:
        return upsert_offer_profile(normalized, payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.delete('/api/offers/{offer_id}', response_model=OfferProfile)
def disable_offer(offer_id:str, request:Request):
    require_admin(request)
    normalized=offer_id.strip().lower()
    if not OFFER_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(404, 'Offer profile not found')
    try:
        return disable_offer_profile(normalized)
    except KeyError:
        raise HTTPException(404, 'Offer profile not found') from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.get('/api/reviews', response_model=list[ReviewHistoryItem])
def review_history(limit:int=50):
    return list_reviews(limit)

@app.get('/api/reviews/history', response_model=ReviewHistoryPage)
def full_review_history(limit:int=50, cursor:str|None=None):
    return list_reviews_page(limit, cursor)


@app.get('/api/reviews/stats', response_model=ReviewStats)
def review_stats(offer_id:str='acp'):
    normalized=offer_id.strip().lower() or 'acp'
    if not OFFER_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(400, 'Invalid offer ID')
    return get_review_stats(normalized)


@app.delete('/api/reviews/{job_id}', response_model=DeletedReview)
def remove_review(job_id:str, request:Request):
    require_admin(request)
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(404, 'Review job not found')
    try:
        return delete_review(job_id)
    except FileNotFoundError:
        raise HTTPException(404, 'Review job not found') from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None

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
