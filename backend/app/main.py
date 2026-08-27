from __future__ import annotations
import asyncio, base64, binascii, hashlib, hmac, json, logging, os, re, secrets, shutil, time, uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
import httpx
from fastapi import FastAPI, UploadFile, File, Form, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from .review_pipeline.models import (
    BatchReviewContext,
    BatchFailure,
    AutomationRunResult,
    ClientReviewDecisionInput,
    ComplianceReport,
    CreateDriveReview,
    CreateReviewBatch,
    DeletedReview,
    DriveBrowserItem,
    DriveBrowserList,
    DriveCreativeFile,
    DriveCreativeList,
    DriveFolder,
    DriveOption,
    DriveOptionList,
    DriveSelectionResult,
    JobRecord,
    JobStatus,
    LiveScanDay,
    LiveScanIngestResult,
    LiveScanMediaRequest,
    LiveScanObservation,
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
    RetryBatchItem,
    ReviewRequestMeta,
)
from .review_pipeline.storage import (
    backfill_review_offer_stats,
    clear_client_review_decision,
    claim_batch_item_retry,
    create_batch,
    delete_review,
    disable_offer_profile,
    get_batch,
    get_batches,
    get_report as get_stored_report,
    get_offer_profile_revision,
    get_status,
    job_dir,
    list_reviews,
    list_reviews_page,
    list_client_reviews,
    client_review_exists,
    get_client_review_detail,
    get_client_review_report,
    get_review_stats,
    list_offer_profiles,
    now_ms,
    resolve_active_offer_profiles,
    resolve_review_offer_snapshot,
    set_status,
    set_review_source,
    set_client_review_decision,
    upsert_offer_profile,
    update_batch_item,
)
from .review_pipeline.queue import (
    enqueue_job,
    queue_state,
    recover_and_drain_review_queue,
    start_job_workers,
    stop_job_workers,
)
from .review_pipeline.media import detect_media_kind
from .review_pipeline.verticals import classify_review_vertical
from .review_pipeline.drive import (
    FOLDER_MIME_TYPE,
    MAX_DRIVE_SELECTION_FILES,
    DriveLookupError,
    configured_drive_options,
    get_google_drive_client,
)
from .review_pipeline.source_links import resolve_review_sources
from .review_pipeline.telegram import finish_batch_item_and_notify
from .review_pipeline.pdf_reports import (
    PdfArtifact,
    ensure_batch_pdf,
    ensure_review_pdf,
    read_pdf_artifact,
)
from .review_pipeline.evidence_frames import (
    list_review_evidence_frames,
    read_remote_evidence_frame,
    resolve_review_evidence_frame,
)
from .review_pipeline.live_scan_storage import (
    claim_live_review,
    get_live_scan_day,
    mark_live_review_queued,
    exact_creative_key,
    normalize_primary_text,
    observe_live_account,
    primary_text_key,
    release_live_review,
)
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
from .review_pipeline.partner_api import (
    API_SCOPES,
    ApiJobInput,
    ApiKeyInput,
    ApiPartnerInput,
    ApiPrincipal,
    PartnerApiUnavailable,
    PartnerMediaError,
    authenticate_api_token,
    claim_api_review,
    claim_api_scan_review,
    create_api_partner,
    deliver_pending_api_webhooks,
    download_api_media,
    finalize_api_review,
    get_api_evidence,
    get_api_review,
    get_api_scan_ad,
    issue_api_key,
    list_api_partners,
    list_api_reviews,
    list_api_scan_ads,
    list_api_scan_observations,
    mark_api_review_deleted,
    prune_expired_api_evidence,
    reconcile_terminal_api_reviews,
    revoke_api_key,
    rotate_webhook_secret,
    save_api_partner,
)

COPY_LABEL_MAX_LENGTH = 72
UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
UPLOAD_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')
UPLOAD_METADATA_FILE = 'upload.json'
UPLOAD_CHUNKS_DIR = 'upload_chunks'
BATCH_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')
JOB_ID_PATTERN = re.compile(r'^[0-9a-f]{32}$')
OBSERVATION_DATE_PATTERN = re.compile(r'^\d{4}-\d{2}-\d{2}$')
OFFER_ID_PATTERN = re.compile(r'^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$')
REVIEW_VERTICALS = {'auto-insurance', 'home-insurance'}
PARTNER_ID_PATTERN = re.compile(r'^partner_[0-9a-f]{32}$')
API_KEY_ID_PATTERN = re.compile(r'^key_[0-9a-f]{32}$')
MAX_BATCH_ITEMS = 100
MAX_LIVE_SCAN_GROUPS = 500
MAX_LIVE_SCAN_NAMES = 100
ADMIN_PASSWORD_HEADER = 'x-admin-password'
CLIENT_USERNAME_HEADER = 'x-client-username'
CLIENT_PASSWORD_HEADER = 'x-client-password'
AUTOMATION_SECRET_HEADER = 'x-automation-secret'
ADMIN_SESSION_COOKIE = 'adchecked_admin_session'
CLIENT_SESSION_COOKIE = 'adchecked_client_session'
SESSION_TTL_SECONDS = 12 * 60 * 60
CLIENT_PORTALS = {
    'acp': {
        'display_name': 'ACP',
        'offer_id': 'acp',
        'username_env': 'ACP_CLIENT_USERNAME',
        'username_default': 'acp',
        'password_env': 'ACP_CLIENT_PASSWORD',
        'category': 'Auto Insurance',
    },
    'kissterra': {
        'display_name': 'Kissterra',
        'offer_id': 'kissterra',
        'username_env': 'KISSTERRA_CLIENT_USERNAME',
        'username_default': 'kissterra',
        'password_env': 'KISSTERRA_CLIENT_PASSWORD',
        'category': 'Auto Insurance',
    },
    'lead-economy': {
        'display_name': 'Lead Economy',
        'offer_id': 'lead-economy',
        'username_env': 'LEAD_ECONOMY_CLIENT_USERNAME',
        'username_default': 'lead-economy',
        'password_env': 'LEAD_ECONOMY_CLIENT_PASSWORD',
        'category': 'Auto Insurance',
    },
    'smart-financial': {
        'display_name': 'Smart Financial',
        'offer_id': 'smart-financial',
        'username_env': 'SMART_FINANCIAL_CLIENT_USERNAME',
        'username_default': 'smart-financial',
        'password_env': 'SMART_FINANCIAL_CLIENT_PASSWORD',
        'category': 'Auto Insurance',
    },
}
CLIENT_PORTAL_ORDER = ('kissterra', 'acp', 'lead-economy', 'smart-financial')
logger = logging.getLogger(__name__)
background_tasks:set[asyncio.Task]=set()


async def deliver_batch_notifications_in_background()->None:
    try:
        await asyncio.to_thread(deliver_pending_batch_notifications, limit=1)
    except Exception:
        logger.exception('Could not deliver a pending batch notification.')


async def maintain_partner_api_in_background()->None:
    try:
        await asyncio.to_thread(reconcile_terminal_api_reviews, 100)
        await deliver_pending_api_webhooks(limit=5)
        await asyncio.to_thread(prune_expired_api_evidence, 100)
    except PartnerApiUnavailable:
        return
    except Exception:
        logger.exception('Could not complete partner API webhook or retention maintenance.')


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
    if not 0.25 <= frame_interval_seconds <= 30:
        raise HTTPException(400, 'frame_interval_seconds must be between 0.25 and 30.')
    validate_review_text(ad_copy,policy_text,notes,manual_transcript)
    offer_profiles,offer_outcomes=resolve_review_offer_snapshot()
    if not offer_profiles:
        raise HTTPException(
            409,
            'No offers are available for review. Save official guidelines and enable at least one offer in Settings.',
        )
    if offer_ids is not None:
        requested_offer_ids=list(dict.fromkeys(
            offer_id.strip().lower()
            for offer_id in offer_ids
            if offer_id.strip()
        ))
        if not requested_offer_ids:
            raise HTTPException(400, 'Select at least one offer to include in the review.')
        profiles_by_id={profile.offer_id:profile for profile in offer_profiles}
        unavailable=[
            offer_id for offer_id in requested_offer_ids
            if offer_id not in profiles_by_id
        ]
        if unavailable:
            raise HTTPException(
                409,
                f'The selected offers are unavailable for review: {", ".join(unavailable)}.',
            )
        outcomes_by_id={outcome.offer_id:outcome for outcome in offer_outcomes}
        offer_profiles=[profiles_by_id[offer_id] for offer_id in requested_offer_ids]
        offer_outcomes=[
            outcomes_by_id[offer_id]
            for offer_id in requested_offer_ids
            if offer_id in outcomes_by_id
        ]
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


def parse_offer_ids(value:str)->list[str]|None:
    value=value.strip()
    if not value:
        return None
    try:
        parsed=json.loads(value)
    except json.JSONDecodeError:
        parsed=[part.strip() for part in value.split(',')]
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise HTTPException(400, 'offer_ids must be a JSON array of offer IDs.')
    offer_ids=list(dict.fromkeys(item.strip().lower() for item in parsed if item.strip()))
    if not offer_ids:
        raise HTTPException(400, 'Select at least one offer to include in the review.')
    return offer_ids


def parse_review_vertical(value:str):
    normalized=value.strip().lower()
    if normalized not in REVIEW_VERTICALS:
        raise HTTPException(400,'Select Auto Insurance or Home Insurance for this review.')
    return normalized


def live_scan_request_meta(
    *,
    kind:str,
    key:str,
    creative_name:str,
    account_id:str,
    account_name:str,
    observation_date:str,
    ad_copy:str='',
)->ReviewRequestMeta:
    meta=review_meta(ad_copy,'','','','',1.0,False,'','')
    return meta.model_copy(update={
        'live_scan_kind':kind,
        'live_scan_key':key,
        'live_scan_creative_name':creative_name,
        'live_scan_account_id':account_id,
        'live_scan_account_name':account_name,
        'live_scan_observation_date':observation_date,
    })


def clean_live_source_url(value:str|None)->str|None:
    if not value:
        return None
    normalized=value.strip()
    if not normalized.startswith('https://'):
        return None
    host=normalized.split('/',3)[2].split(':',1)[0].casefold()
    if host != 'facebook.com' and not host.endswith('.facebook.com'):
        return None
    return normalized[:4_000]

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
    start_background_task(maintain_partner_api_in_background())
    yield
    await stop_job_workers()

app=FastAPI(
    title='AdChecked',
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)
allowed_hosts=[h.strip() for h in os.getenv('APP_ALLOWED_HOSTS','*').split(',') if h.strip()]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
cors_origins=[
    origin.strip()
    for origin in os.getenv(
        'CORS_ALLOWED_ORIGINS',
        'https://admin.adchecked.com,https://app.adchecked.com,http://localhost:5173',
    ).split(',')
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=['DELETE','GET','OPTIONS','POST','PUT'],
    allow_headers=[
        'authorization',
        'content-type',
        'idempotency-key',
        'x-admin-password',
        'x-api-key',
        'x-app-password',
        'x-request-id',
        'x-vibe-ad-id',
        'x-vibe-backend-shard',
    ],
    expose_headers=['content-disposition','x-request-id'],
)

@app.middleware('http')
async def optional_password_gate(request: Request, call_next):
    path=str(request.scope.get('path') or '')
    if request.method == 'OPTIONS':
        return await call_next(request)
    raw_host=request.headers.get('host','').casefold()
    hostname=raw_host.split(':',1)[0]
    admin_hosts={
        value.strip().casefold()
        for value in os.getenv('APP_ADMIN_HOSTS','admin.adchecked.com').split(',')
        if value.strip()
    }
    legacy_hosts={
        value.strip().casefold()
        for value in os.getenv('APP_LEGACY_HOSTS','vibe-check.thatcanadian.dev').split(',')
        if value.strip()
    }
    password = os.getenv('APP_PASSWORD')
    is_client_portal = path == '/api/client/check' or path.startswith('/api/client/')
    is_partner_api = path == '/api/v1' or path.startswith('/api/v1/')
    is_internal_api = path.startswith('/api/internal/') or path.startswith('/api/automations/internal/')
    is_admin_session = path == '/api/admin/session'
    is_scanner_session = path == '/api/scanner/session'
    is_scanner_api = path in {'/api/live-scans/observe','/api/live-scans/creative'}
    is_state_change = request.method in {'DELETE','PATCH','POST','PUT'}
    if is_state_change and not is_internal_api and not is_scanner_api and not is_scanner_session:
        expected_origin=''
        if hostname in admin_hosts:
            if hostname in {'localhost','127.0.0.1'}:
                configured_origins={
                    origin.strip()
                    for origin in os.getenv('CORS_ALLOWED_ORIGINS','http://localhost:5173').split(',')
                    if origin.strip()
                }
                if request.headers.get('origin','') not in configured_origins:
                    return JSONResponse({'detail':'Invalid request origin.'},status_code=403)
            else:
                expected_origin=f'https://{hostname}'
        elif hostname == 'app.adchecked.com':
            expected_origin='https://app.adchecked.com'
        if expected_origin and request.headers.get('origin','') != expected_origin:
            return JSONResponse({'detail':'Invalid request origin.'},status_code=403)
    is_operator_api = (
        path.startswith('/api/')
        and not is_client_portal
        and not is_partner_api
        and not is_internal_api
        and not is_admin_session
        and not is_scanner_session
    )
    if hostname in admin_hosts and is_operator_api and is_scanner_api:
        expected=os.getenv('ADMIN_PASSWORD','')
        provided=request.headers.get(ADMIN_PASSWORD_HEADER,'')
        scanner_session=read_scanner_session(request)
        has_legacy_password=(
            bool(expected)
            and bool(provided)
            and secrets.compare_digest(provided,expected)
        )
        if not expected or (scanner_session is None and not has_legacy_password):
            return JSONResponse(
                {'detail':'Invalid or missing scanner authorization.'},
                status_code=401,
            )
    elif hostname in legacy_hosts and is_scanner_api:
        admin_password=os.getenv('ADMIN_PASSWORD','')
        app_password=os.getenv('APP_PASSWORD','')
        scanner_session=read_scanner_session(request)
        provided_app_password=request.headers.get('x-app-password','')
        provided_admin_password=request.headers.get(ADMIN_PASSWORD_HEADER,'')
        has_legacy_password=(
            bool(app_password)
            and bool(provided_app_password)
            and secrets.compare_digest(provided_app_password,app_password)
        ) or (
            bool(admin_password)
            and bool(provided_admin_password)
            and secrets.compare_digest(provided_admin_password,admin_password)
        )
        if scanner_session is None and not has_legacy_password:
            return JSONResponse(
                {'detail':'Invalid or missing scanner authorization.'},
                status_code=401,
            )
    elif hostname in admin_hosts and is_operator_api:
        if read_session_cookie(request, ADMIN_SESSION_COOKIE, 'admin') is None:
            return JSONResponse(
                {'detail':'Sign in to continue.'},
                status_code=401,
            )
    if (
        password
        and hostname not in admin_hosts
        and path.startswith('/api')
        and not is_client_portal
        and not is_partner_api
        and not is_internal_api
        and not is_scanner_api
        and not secrets.compare_digest(request.headers.get('x-app-password',''),password)
    ):
        return JSONResponse({'detail':'Invalid or missing x-app-password'}, status_code=401)
    response=await call_next(request)
    if is_partner_api:
        response.headers['x-request-id']=request.headers.get('x-request-id') or uuid.uuid4().hex
        response.headers['cache-control']='no-store'
    return response


def require_admin(request:Request)->dict:
    expected=os.getenv('ADMIN_PASSWORD','')
    if not expected:
        raise HTTPException(
            503,
            'Admin access is not configured. Set the ADMIN_PASSWORD Worker secret first.',
        )
    provided=request.headers.get(ADMIN_PASSWORD_HEADER,'')
    has_password=bool(provided) and secrets.compare_digest(provided, expected)
    if has_password:
        return {'role':'owner'}
    session=read_session_cookie(request, ADMIN_SESSION_COOKIE, 'admin')
    if session is None:
        raise HTTPException(401, 'Invalid or missing admin password.')
    return session


def require_settings_admin(request:Request)->dict:
    session=require_admin(request)
    if session.get('role','owner') != 'owner':
        raise HTTPException(403, 'Owner access is required to change settings.')
    return session


async def require_api_principal(request:Request, scope:str)->ApiPrincipal:
    authorization=request.headers.get('authorization','').strip()
    scheme,separator,token=authorization.partition(' ')
    if not separator or scheme.casefold() != 'bearer' or not token.strip():
        raise HTTPException(
            401,
            'Provide the API key as Authorization: Bearer <key>.',
            headers={'WWW-Authenticate':'Bearer'},
        )
    try:
        principal=await asyncio.to_thread(authenticate_api_token, token.strip())
    except PartnerApiUnavailable as exc:
        raise HTTPException(503, str(exc)) from None
    except Exception:
        logger.exception('Partner API authentication failed unexpectedly.')
        raise HTTPException(503, 'Partner API authentication is temporarily unavailable.') from None
    if principal is None:
        raise HTTPException(
            401,
            'The API key is invalid, expired, revoked, or suspended.',
            headers={'WWW-Authenticate':'Bearer'},
        )
    try:
        principal.require_scope(scope)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from None
    return principal


def partner_review_meta(
    principal:ApiPrincipal,
    *,
    ad_copy:str,
    policy_text:str,
    notes:str,
    manual_transcript:str,
    frame_interval_seconds:float,
    scene_detection:bool,
    external_id:str,
)->ReviewRequestMeta:
    if policy_text.strip() and not principal.allow_custom_policy:
        raise HTTPException(403, 'This partner is not permitted to submit custom policy supplements.')
    if not 0.25 <= frame_interval_seconds <= 30:
        raise HTTPException(400, 'frame_interval_seconds must be between 0.25 and 30.')
    profiles,outcomes=resolve_review_offer_snapshot()
    if principal.allowed_offer_ids:
        allowed=set(principal.allowed_offer_ids)
        profiles=[profile for profile in profiles if profile.offer_id in allowed]
        outcomes=[outcome for outcome in outcomes if outcome.offer_id in allowed]
    if not profiles:
        raise HTTPException(
            409,
            'No enabled offer with saved guidelines is available to this API partner.',
        )
    return ReviewRequestMeta(
        ad_copy=ad_copy.strip(),
        policy_text=policy_text.strip(),
        notes=notes.strip(),
        manual_transcript=manual_transcript.strip(),
        frame_interval_seconds=frame_interval_seconds,
        scene_detection=scene_detection,
        offer_profiles=profiles,
        offer_outcomes=outcomes,
        api_partner_id=principal.partner_id,
        api_key_id=principal.api_key_id,
        api_external_id=external_id,
    )


def validate_external_id(value:str)->str:
    normalized=value.strip()
    if len(normalized) > 200:
        raise HTTPException(400, 'external_id must be 200 characters or fewer.')
    return normalized


def api_idempotency_key(request:Request)->str:
    value=request.headers.get('idempotency-key','').strip()
    if len(value) > 200:
        raise HTTPException(400, 'Idempotency-Key must be 200 characters or fewer.')
    if value and any(ord(character) < 33 or ord(character) > 126 for character in value):
        raise HTTPException(400, 'Idempotency-Key must contain visible ASCII characters only.')
    return value


def partner_storage_error(error:Exception)->HTTPException:
    message=str(error).strip() or 'Partner API request failed.'
    lowered=message.casefold()
    if 'not found' in lowered:
        return HTTPException(404, message)
    if 'limit reached' in lowered:
        return HTTPException(429, message, headers={'Retry-After':'60'})
    if 'no longer active' in lowered or 'not permitted' in lowered:
        return HTTPException(403, message)
    if isinstance(error, PartnerApiUnavailable):
        return HTTPException(503, message)
    return HTTPException(409, message)


def partner_api_base_url()->str:
    public_origin=os.getenv('API_PUBLIC_URL','').strip().rstrip('/')
    return f'{public_origin}/api/v1' if public_origin else '/api/v1'


async def owned_api_review(principal:ApiPrincipal, job_id:str)->dict:
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(404, 'Review not found.')
    try:
        value=await asyncio.to_thread(get_api_review, principal, job_id)
    except Exception as exc:
        raise partner_storage_error(exc) from None
    if value is None:
        raise HTTPException(404, 'Review not found.')
    return value


def client_portal(client_id:str)->dict[str, str]:
    config=CLIENT_PORTALS.get(client_id)
    if config is None:
        raise HTTPException(404, 'Workspace not found.')
    return config


def public_client_portal(client_id:str, config:dict[str, str])->dict[str, str]:
    return {
        'category':config['category'],
        'client_id':client_id,
        'display_name':config['display_name'],
    }


def session_ttl_seconds()->int:
    try:
        configured=int(os.getenv('SESSION_TTL_SECONDS', str(SESSION_TTL_SECONDS)))
    except ValueError:
        configured=SESSION_TTL_SECONDS
    return max(300, min(configured, 24 * 60 * 60))


def encode_session_token(kind:str, payload:dict)->str:
    secret=os.getenv('SESSION_SECRET','')
    if not secret:
        raise HTTPException(503, 'Browser sessions are not configured.')
    value={
        **payload,
        'exp':int(time.time()) + session_ttl_seconds(),
        'kind':kind,
    }
    encoded=base64.urlsafe_b64encode(
        json.dumps(value,separators=(',',':'),sort_keys=True).encode('utf-8')
    ).rstrip(b'=').decode('ascii')
    signature=hmac.new(secret.encode('utf-8'),encoded.encode('ascii'),hashlib.sha256).digest()
    encoded_signature=base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')
    return f'{encoded}.{encoded_signature}'


def decode_session_token(token:str, kind:str)->dict|None:
    secret=os.getenv('SESSION_SECRET','')
    if not secret or not token:
        return None
    encoded,separator,encoded_signature=token.partition('.')
    if not separator or not encoded or not encoded_signature:
        return None
    try:
        expected=hmac.new(secret.encode('utf-8'),encoded.encode('ascii'),hashlib.sha256).digest()
        signature=base64.urlsafe_b64decode(encoded_signature + '=' * (-len(encoded_signature) % 4))
    except (binascii.Error,UnicodeEncodeError,ValueError,TypeError):
        return None
    if not secrets.compare_digest(signature,expected):
        return None
    try:
        decoded=base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))
        payload=json.loads(decoded.decode('utf-8'))
    except (binascii.Error,ValueError,TypeError,UnicodeDecodeError,json.JSONDecodeError):
        return None
    if not isinstance(payload,dict) or payload.get('kind') != kind:
        return None
    expires_at=payload.get('exp')
    if not isinstance(expires_at,int) or expires_at <= int(time.time()):
        return None
    return payload


def credential_fingerprint(username:str, password:str)->str:
    session_secret=os.getenv('SESSION_SECRET','')
    if not session_secret:
        return ''
    return hmac.new(
        session_secret.encode('utf-8'),
        f'{username}\0{password}'.encode('utf-8'),
        hashlib.sha256,
    ).hexdigest()


def current_client_credential_fingerprint(session:dict)->str:
    username=str(session.get('username') or '')
    if session.get('role') == 'admin':
        return credential_fingerprint(username,os.getenv('CLIENT_ADMIN_PASSWORD',''))
    portal_ids=session.get('portal_ids')
    if not isinstance(portal_ids,list) or len(portal_ids) != 1:
        return ''
    config=CLIENT_PORTALS.get(str(portal_ids[0]))
    if config is None:
        return ''
    return credential_fingerprint(username,os.getenv(config['password_env'],''))


def current_admin_credential_fingerprint(session:dict)->str:
    role=str(session.get('role') or 'owner')
    if role == 'owner':
        return credential_fingerprint('admin',os.getenv('ADMIN_PASSWORD',''))
    if role == 'employee':
        return credential_fingerprint('employee',os.getenv('EMPLOYEE_ADMIN_PASSWORD',''))
    return ''


def read_session_cookie(request:Request, cookie_name:str, kind:str)->dict|None:
    session=decode_session_token(request.cookies.get(cookie_name,''),kind)
    if session is None:
        return None
    fingerprint=str(session.get('credential_fingerprint') or '')
    if kind == 'admin':
        expected=current_admin_credential_fingerprint(session)
    else:
        expected=current_client_credential_fingerprint(session)
    if not fingerprint or not expected or not secrets.compare_digest(fingerprint,expected):
        return None
    return session


def read_scanner_session(request:Request)->dict|None:
    authorization=request.headers.get('authorization','').strip()
    scheme,separator,token=authorization.partition(' ')
    if not separator or scheme.casefold() != 'bearer':
        return None
    session=decode_session_token(token.strip(),'scanner')
    if session is None:
        return None
    fingerprint=str(session.get('credential_fingerprint') or '')
    expected=credential_fingerprint('admin',os.getenv('ADMIN_PASSWORD',''))
    if not fingerprint or not expected or not secrets.compare_digest(fingerprint,expected):
        return None
    return session


def set_session_cookie(response:Response, request:Request, name:str, value:str)->None:
    forwarded_proto=request.headers.get('x-forwarded-proto','').split(',',1)[0].strip().casefold()
    response.set_cookie(
        name,
        value,
        httponly=True,
        max_age=session_ttl_seconds(),
        path='/',
        samesite='strict',
        secure=request.url.scheme == 'https' or forwarded_proto == 'https',
    )


def clear_session_cookie(response:Response, request:Request, name:str)->None:
    forwarded_proto=request.headers.get('x-forwarded-proto','').split(',',1)[0].strip().casefold()
    response.delete_cookie(
        name,
        path='/',
        samesite='strict',
        secure=request.url.scheme == 'https' or forwarded_proto == 'https',
    )


def authenticate_client_credentials(username:str,password:str)->dict:
    username=username.strip()
    if not username or not password:
        raise HTTPException(401, 'The username or password is incorrect.')

    admin_username=os.getenv('CLIENT_ADMIN_USERNAME', 'admin').strip() or 'admin'
    admin_password=os.getenv('CLIENT_ADMIN_PASSWORD', '')
    if (
        admin_password
        and secrets.compare_digest(username, admin_username)
        and secrets.compare_digest(password, admin_password)
    ):
        return {
            'role':'admin',
            'username':admin_username,
            'portal_ids':list(CLIENT_PORTAL_ORDER),
        }

    for client_id,config in CLIENT_PORTALS.items():
        expected_username=(
            os.getenv(config['username_env'], config['username_default']).strip()
            or config['username_default']
        )
        expected_password=os.getenv(config['password_env'], '')
        if (
            expected_password
            and secrets.compare_digest(username, expected_username)
            and secrets.compare_digest(password, expected_password)
        ):
            return {
                'role':'client',
                'username':expected_username,
                'portal_ids':[client_id],
            }
    raise HTTPException(401, 'The username or password is incorrect.')


def client_cookie_session(request:Request)->dict|None:
    session=read_session_cookie(request,CLIENT_SESSION_COOKIE,'client')
    if session is None:
        return None
    portal_ids=session.get('portal_ids')
    username=session.get('username')
    role=session.get('role')
    if (
        not isinstance(portal_ids,list)
        or not portal_ids
        or any(not isinstance(client_id,str) or client_id not in CLIENT_PORTALS for client_id in portal_ids)
        or not isinstance(username,str)
        or role not in {'admin','client'}
    ):
        return None
    return {'portal_ids':portal_ids,'role':role,'username':username}


def authenticate_client(request:Request)->dict:
    session=client_cookie_session(request)
    if session is not None:
        return session
    raw_host=request.headers.get('host','').casefold()
    hostname=raw_host.split(':',1)[0]
    if hostname == 'app.adchecked.com':
        raise HTTPException(401, 'Sign in to continue.')
    return authenticate_client_credentials(
        request.headers.get(CLIENT_USERNAME_HEADER,''),
        request.headers.get(CLIENT_PASSWORD_HEADER,''),
    )


def public_client_session(session:dict)->dict:
    return {
        'portals':[
            public_client_portal(client_id, CLIENT_PORTALS[client_id])
            for client_id in session['portal_ids']
        ],
        'role':session['role'],
        'username':session['username'],
    }


def require_client(request:Request, client_id:str)->dict[str, str]:
    config=client_portal(client_id)
    session=authenticate_client(request)
    if client_id not in session['portal_ids']:
        raise HTTPException(404, 'Workspace not found.')
    return config


def require_automation_secret(request:Request)->None:
    expected=os.getenv('CONVEX_HTTP_SECRET','')
    provided=request.headers.get(AUTOMATION_SECRET_HEADER,'')
    if not expected or not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(401, 'Invalid or missing automation secret.')


@app.post('/api/admin/session')
async def create_admin_session(request:Request):
    owner_password=os.getenv('ADMIN_PASSWORD','')
    employee_password=os.getenv('EMPLOYEE_ADMIN_PASSWORD','')
    if not owner_password:
        raise HTTPException(503,'Admin access is not configured.')
    try:
        payload=await request.json()
    except (ValueError,json.JSONDecodeError):
        raise HTTPException(400,'Provide a JSON password.') from None
    password=str(payload.get('password') or '') if isinstance(payload,dict) else ''
    if password and secrets.compare_digest(password,owner_password):
        role='owner'
        username='owner'
        fingerprint=credential_fingerprint('admin',owner_password)
    elif (
        employee_password
        and password
        and secrets.compare_digest(password,employee_password)
    ):
        role='employee'
        username='employee'
        fingerprint=credential_fingerprint(username,employee_password)
    else:
        raise HTTPException(401,'Invalid or missing admin password.')
    token=encode_session_token('admin',{
        'credential_fingerprint':fingerprint,
        'role':role,
        'username':username,
    })
    response=JSONResponse({
        'authorized':True,
        'can_manage_settings':role == 'owner',
        'role':role,
        'username':username,
    })
    set_session_cookie(response,request,ADMIN_SESSION_COOKIE,token)
    response.headers['cache-control']='no-store'
    return response


@app.post('/api/scanner/session')
async def create_scanner_session(request:Request):
    expected=os.getenv('ADMIN_PASSWORD','')
    if not expected:
        raise HTTPException(503,'Scanner access is not configured.')
    try:
        payload=await request.json()
    except (ValueError,json.JSONDecodeError):
        raise HTTPException(400,'Provide a JSON password.') from None
    password=str(payload.get('password') or '') if isinstance(payload,dict) else ''
    if not password or not secrets.compare_digest(password,expected):
        raise HTTPException(401,'Invalid or missing scanner password.')
    expires_at=int(time.time()) + session_ttl_seconds()
    token=encode_session_token('scanner',{
        'credential_fingerprint':credential_fingerprint('admin',expected),
        'exp':expires_at,
    })
    return JSONResponse(
        {'expires_at':expires_at,'token':token,'token_type':'Bearer'},
        headers={'cache-control':'no-store'},
    )


@app.get('/api/admin/session')
def get_admin_session(request:Request):
    session=read_session_cookie(request,ADMIN_SESSION_COOKIE,'admin')
    if session is None:
        raise HTTPException(401,'Sign in to continue.')
    role=str(session.get('role') or 'owner')
    return {
        'authorized':True,
        'can_manage_settings':role == 'owner',
        'role':role,
        'username':str(session.get('username') or role),
    }


@app.delete('/api/admin/session')
def delete_admin_session(request:Request):
    response=JSONResponse({'signed_out':True})
    clear_session_cookie(response,request,ADMIN_SESSION_COOKIE)
    response.headers['cache-control']='no-store'
    return response


@app.get('/api/admin/check')
def admin_check(request:Request):
    session=require_admin(request)
    role=str(session.get('role') or 'owner')
    return {
        'authorized':True,
        'can_manage_settings':role == 'owner',
        'role':role,
    }


@app.get('/api/admin/api/partners')
def api_partner_list(request:Request):
    require_admin(request)
    try:
        partners=list_api_partners()
    except Exception as exc:
        raise partner_storage_error(exc) from None
    return {
        'base_url':partner_api_base_url(),
        'available_scopes':list(API_SCOPES),
        'partners':partners,
    }


@app.post('/api/admin/api/partners', status_code=201)
def api_partner_create(payload:ApiPartnerInput, request:Request):
    require_settings_admin(request)
    try:
        return create_api_partner(payload)
    except Exception as exc:
        raise partner_storage_error(exc) from None


@app.put('/api/admin/api/partners/{partner_id}')
def api_partner_save(partner_id:str, payload:ApiPartnerInput, request:Request):
    require_settings_admin(request)
    if not PARTNER_ID_PATTERN.fullmatch(partner_id):
        raise HTTPException(404, 'API partner not found.')
    try:
        return save_api_partner(partner_id, payload)
    except Exception as exc:
        raise partner_storage_error(exc) from None


@app.post('/api/admin/api/partners/{partner_id}/keys', status_code=201)
def api_key_issue(partner_id:str, payload:ApiKeyInput, request:Request):
    require_settings_admin(request)
    if not PARTNER_ID_PATTERN.fullmatch(partner_id):
        raise HTTPException(404, 'API partner not found.')
    if payload.expires_at is not None and payload.expires_at <= now_ms():
        raise HTTPException(400, 'API key expiration must be in the future.')
    try:
        return issue_api_key(partner_id, payload)
    except Exception as exc:
        raise partner_storage_error(exc) from None


@app.delete('/api/admin/api/partners/{partner_id}/keys/{key_id}')
def api_key_revoke(partner_id:str, key_id:str, request:Request):
    require_settings_admin(request)
    if not PARTNER_ID_PATTERN.fullmatch(partner_id) or not API_KEY_ID_PATTERN.fullmatch(key_id):
        raise HTTPException(404, 'API key not found.')
    try:
        return revoke_api_key(partner_id, key_id)
    except Exception as exc:
        raise partner_storage_error(exc) from None


@app.post('/api/admin/api/partners/{partner_id}/webhook-secret')
def api_webhook_secret_rotate(partner_id:str, request:Request):
    require_settings_admin(request)
    if not PARTNER_ID_PATTERN.fullmatch(partner_id):
        raise HTTPException(404, 'API partner not found.')
    try:
        return rotate_webhook_secret(partner_id)
    except Exception as exc:
        raise partner_storage_error(exc) from None


def public_client_review(value:dict)->dict:
    decision=value.get('decision') if isinstance(value.get('decision'), dict) else None
    preview=value.get('preview') if isinstance(value.get('preview'), dict) else {}
    return {
        'ai_status':value.get('aiStatus'),
        'effective_status':value.get('effectiveStatus') or value.get('aiStatus'),
        'batch_created_at':value.get('batchCreatedAt') or value.get('createdAt'),
        'batch_id':value.get('batchId'),
        'batch_source_label':value.get('batchSourceLabel'),
        'created_at':value.get('createdAt'),
        'decision':({
            'decided_at':decision.get('decidedAt'),
            'decision':decision.get('decision'),
            'feedback_note':decision.get('feedbackNote'),
            'feedback_reason':decision.get('feedbackReason'),
        } if decision else None),
        'file_name':value.get('fileName'),
        'issue_summary':value.get('issueSummary'),
        'job_id':value.get('jobId'),
        'media_kind':value.get('mediaKind'),
        'vertical':value.get('vertical') or 'auto-insurance',
        'preview':{
            'finding_count':int(preview.get('findingCount') or 0),
            'findings':[
                str(finding)
                for finding in preview.get('findings', [])
                if isinstance(finding, str)
            ][:3],
            'google_drive_url':preview.get('googleDriveUrl'),
            'summary':str(
                preview.get('summary')
                or value.get('issueSummary')
                or 'No policy issues were identified.'
            ),
        },
    }


def public_evidence_frames(job_id:str, frames:list[dict]|None=None)->list[dict]:
    return [{
        'filename':str(frame.get('filename') or ''),
        'timestamp':frame.get('timestamp'),
        'url':f'/api/reviews/{job_id}/frames/{frame.get("filename")}',
    } for frame in (frames if frames is not None else list_review_evidence_frames(job_id)) if frame.get('filename')]


def evidence_frame_response(job_id:str, filename:str)->Response:
    cache_headers={'cache-control':'private, max-age=3600'}
    resolved=resolve_review_evidence_frame(job_id, filename)
    if isinstance(resolved, Path):
        return FileResponse(resolved, headers=cache_headers)
    if isinstance(resolved, str):
        try:
            content,content_type=read_remote_evidence_frame(resolved)
        except httpx.HTTPError:
            raise HTTPException(404, 'Evidence frame not found') from None
        return Response(content, media_type=content_type, headers=cache_headers)
    raise HTTPException(404, 'Evidence frame not found')


@app.get('/api/client/check')
def client_session_check(request:Request):
    return public_client_session(authenticate_client(request))


@app.post('/api/client/session')
async def create_client_session(request:Request):
    try:
        payload=await request.json()
    except (ValueError,json.JSONDecodeError):
        raise HTTPException(400,'Provide a JSON username and password.') from None
    if not isinstance(payload,dict):
        raise HTTPException(400,'Provide a JSON username and password.')
    session=authenticate_client_credentials(
        str(payload.get('username') or ''),
        str(payload.get('password') or ''),
    )
    session_payload={
        **session,
        'credential_fingerprint':current_client_credential_fingerprint(session),
    }
    response=JSONResponse(public_client_session(session))
    set_session_cookie(
        response,
        request,
        CLIENT_SESSION_COOKIE,
        encode_session_token('client',session_payload),
    )
    response.headers['cache-control']='no-store'
    return response


@app.get('/api/client/session')
def get_client_session(request:Request):
    session=client_cookie_session(request)
    if session is None:
        raise HTTPException(401,'Sign in to continue.')
    return public_client_session(session)


@app.delete('/api/client/session')
def delete_client_session(request:Request):
    response=JSONResponse({'signed_out':True})
    clear_session_cookie(response,request,CLIENT_SESSION_COOKIE)
    response.headers['cache-control']='no-store'
    return response


@app.get('/api/client/{client_id}/check')
def client_check(client_id:str, request:Request):
    config=require_client(request, client_id)
    return {'authorized':True, 'client_id':client_id, 'display_name':config['display_name']}


@app.get('/api/client/{client_id}/reviews')
def client_reviews(client_id:str, request:Request, limit:int=1000):
    config=require_client(request, client_id)
    reviews=list_client_reviews(client_id, config['offer_id'], limit)
    return {
        'client_id':client_id,
        'display_name':config['display_name'],
        'reviews':[public_client_review(review) for review in reviews],
    }


@app.get('/api/client/{client_id}/reviews/{job_id}')
def client_review_detail(client_id:str, job_id:str, request:Request):
    config=require_client(request, client_id)
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(404, 'Review not found.')
    fast_detail=get_client_review_detail(client_id, config['offer_id'], job_id)
    if fast_detail:
        return {
            'client_id':client_id,
            'display_name':config['display_name'],
            'review':public_client_review(fast_detail.get('review') or {}),
            'report':fast_detail.get('report'),
            'evidence_frames':public_evidence_frames(
                job_id,
                fast_detail.get('evidenceFrames')
                if isinstance(fast_detail.get('evidenceFrames'), list)
                else [],
            ),
            'google_drive_url':fast_detail.get('googleDriveUrl'),
            'report_pdf_url':f'/api/client/{client_id}/reviews/{job_id}/report.pdf',
        }
    report=get_client_review_report(client_id, config['offer_id'], job_id)
    if report is None:
        raise HTTPException(404, 'Review not found.')
    matching=next((
        review for review in list_client_reviews(client_id, config['offer_id'], 1000)
        if review.get('jobId') == job_id
    ), None)
    try:
        status=get_status(job_id)
    except FileNotFoundError:
        raise HTTPException(404, 'Review not found.') from None
    return {
        'client_id':client_id,
        'display_name':config['display_name'],
        'review':public_client_review(matching or {
            'aiStatus':report.get('overall_status'),
            'batchCreatedAt':status.created_at or 0,
            'batchId':status.batch_id,
            'batchSourceLabel':None,
            'createdAt':status.created_at or 0,
            'decision':None,
            'fileName':status.file_name,
            'issueSummary':report.get('summary') if report.get('overall_status') != 'green' else None,
            'jobId':status.job_id,
            'mediaKind':'copy_only' if not status.has_creative else (
                'image' if Path(status.file_name).suffix.lower() in {'.jpg','.jpeg','.png','.webp'} else 'video'
            ),
        }),
        'report':report,
        'evidence_frames':public_evidence_frames(job_id),
        'google_drive_url':(
            status.source_url
            if (
                status.source_kind == 'google_drive_file'
                and status.source_status == 'linked'
                and status.source_url
            )
            else None
        ),
        'report_pdf_url':f'/api/client/{client_id}/reviews/{job_id}/report.pdf',
    }


@app.get('/api/client/{client_id}/reviews/{job_id}/report.pdf')
def client_review_pdf(client_id:str, job_id:str, request:Request):
    config=require_client(request, client_id)
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(404, 'Review not found.')
    if get_client_review_report(client_id, config['offer_id'], job_id) is None:
        raise HTTPException(404, 'Review not found.')
    try:
        return pdf_artifact_response(ensure_review_pdf(job_id, config['offer_id']))
    except FileNotFoundError:
        raise HTTPException(404, 'Report not ready.') from None
    except KeyError:
        raise HTTPException(404, 'Report not ready.') from None


@app.put('/api/client/{client_id}/reviews/{job_id}/decision')
def decide_client_review(
    client_id:str,
    job_id:str,
    payload:ClientReviewDecisionInput,
    request:Request,
):
    config=require_client(request, client_id)
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(404, 'Review not found.')
    if payload.decision == 'pending':
        try:
            clear_client_review_decision(client_id, config['offer_id'], job_id)
        except FileNotFoundError:
            raise HTTPException(404, 'Review not found.') from None
        return None
    try:
        value=set_client_review_decision(
            client_id,
            config['offer_id'],
            job_id,
            payload.decision,
            payload.feedback_reason,
            payload.feedback_note,
        )
    except FileNotFoundError:
        raise HTTPException(404, 'Review not found.') from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {
        'decided_at':value.get('decidedAt'),
        'decision':value.get('decision'),
        'feedback_note':value.get('feedbackNote'),
        'feedback_reason':value.get('feedbackReason'),
    }


@app.get('/api/client/{client_id}/reviews/{job_id}/thumbnail')
def client_review_thumbnail(client_id:str, job_id:str, request:Request):
    config=require_client(request, client_id)
    if not client_review_exists(config['offer_id'], job_id):
        raise HTTPException(404, 'Review not found.')
    frames=list_review_evidence_frames(job_id)
    if not frames:
        raise HTTPException(404, 'Creative thumbnail not found')
    return evidence_frame_response(job_id, str(frames[0].get('filename') or ''))


@app.get('/api/client/{client_id}/reviews/{job_id}/frames/{filename}')
def client_review_frame(client_id:str, job_id:str, filename:str, request:Request):
    config=require_client(request, client_id)
    if not client_review_exists(config['offer_id'], job_id):
        raise HTTPException(404, 'Review not found.')
    return evidence_frame_response(job_id, filename)


def validate_review_text(
    ad_copy:str,
    policy_text:str,
    notes:str,
    manual_transcript:str,
)->None:
    limits={
        'ad_copy':(ad_copy,20_000),
        'policy_text':(policy_text,100_000),
        'notes':(notes,10_000),
        'manual_transcript':(manual_transcript,100_000),
    }
    for name,(value,limit) in limits.items():
        if len(value) > limit:
            raise HTTPException(413, f'{name} must be {limit:,} characters or fewer.')


def normalize_scan_text(value:str)->str:
    return re.sub(r'\s+', ' ', value).strip()


def validate_scan_field(name:str, value:str, *, maximum:int, required:bool=False)->str:
    normalized=value.strip()
    if required and not normalized:
        raise HTTPException(400, f'{name} is required.')
    if len(normalized) > maximum:
        raise HTTPException(413, f'{name} must be {maximum:,} characters or fewer.')
    if any(ord(character) < 32 for character in normalized):
        raise HTTPException(400, f'{name} cannot contain control characters.')
    return normalized


def scan_ad_copy_context(
    *,
    ad_copy:str,
    headline:str,
    description:str,
    call_to_action:str,
    destination_url:str,
)->str:
    fields=[
        ('Primary text',ad_copy),
        ('Headline',headline),
        ('Description',description),
        ('Call to action',call_to_action),
        ('Destination URL',destination_url),
    ]
    populated=[(label,value.strip()) for label,value in fields if value.strip()]
    if len(populated) == 1 and populated[0][0] == 'Primary text':
        return populated[0][1]
    return '\n\n'.join(f'{label}:\n{value}' for label,value in populated)


def scan_review_fingerprints(
    *,
    media_sha256:str,
    meta:ReviewRequestMeta,
    ad_copy:str,
    headline:str,
    description:str,
    call_to_action:str,
    destination_url:str,
)->tuple[str,str]:
    fields_payload={
        'schema_version':1,
        'platform_fields':{
            'ad_copy':normalize_scan_text(ad_copy),
            'call_to_action':normalize_scan_text(call_to_action),
            'description':normalize_scan_text(description),
            'destination_url':destination_url.strip(),
            'headline':normalize_scan_text(headline),
        },
        'review_context':{
            'frame_interval_seconds':meta.frame_interval_seconds,
            'manual_transcript':normalize_scan_text(meta.manual_transcript),
            'notes':normalize_scan_text(meta.notes),
            'policy_text':normalize_scan_text(meta.policy_text),
            'scene_detection':meta.scene_detection,
        },
        'offer_profiles':[
            profile.model_dump(mode='json')
            for profile in sorted(meta.offer_profiles,key=lambda value:value.offer_id)
        ],
        'offer_outcomes':[
            outcome.model_dump(mode='json')
            for outcome in sorted(meta.offer_outcomes,key=lambda value:value.offer_id)
        ],
    }
    canonical=json.dumps(
        fields_payload,
        ensure_ascii=False,
        separators=(',',':'),
        sort_keys=True,
    ).encode('utf-8')
    fields_sha256=hashlib.sha256(canonical).hexdigest()
    content_fingerprint=hashlib.sha256(
        f'v1:{media_sha256}:{fields_sha256}'.encode('ascii')
    ).hexdigest()
    return fields_sha256,content_fingerprint


def scan_submission_response(claim:dict, review:dict)->dict:
    review_id=str(claim['review_id'])
    return {
        'ad_id':claim.get('external_ad_id'),
        'change_status':claim.get('change_status'),
        'changed':claim.get('change_status') != 'unchanged',
        'content_fingerprint':claim.get('content_fingerprint'),
        'fields_sha256':claim.get('fields_sha256'),
        'media_sha256':claim.get('media_sha256'),
        'observation_id':claim.get('observation_id'),
        'observed_at':claim.get('observed_at'),
        'previous_content_fingerprint':claim.get('previous_content_fingerprint'),
        'report_ready':bool(review.get('report_ready')),
        'result_url':f'/api/v1/reviews/{review_id}/result',
        'review_created':bool(claim.get('created')),
        'review_id':review_id,
        'status':review.get('status','queued'),
        'status_url':f'/api/v1/reviews/{review_id}',
    }


def api_submission_response(record:JobRecord, external_id:str)->dict:
    return {
        'created_at':record.created_at,
        'external_id':external_id or None,
        'file_name':record.file_name,
        'file_size':record.file_size,
        'message':record.message,
        'offer_ids':record.offer_ids,
        'progress':record.progress,
        'report_ready':record.report_ready,
        'result_url':f'/api/v1/reviews/{record.job_id}/result',
        'job_id':record.job_id,
        'review_id':record.job_id,
        'status':record.status.value,
        'status_url':f'/api/v1/reviews/{record.job_id}',
    }


def simple_job_status(value:str)->str:
    normalized=value.strip().casefold()
    if normalized == 'queued':
        return 'queued'
    if normalized in {'complete','completed'}:
        return 'completed'
    if normalized in {'failed','deleted'}:
        return 'failed'
    return 'processing'


def simple_job_response(review:dict)->dict:
    job_id=str(review.get('job_id') or review.get('review_id') or '')
    return {
        'asset_id':review.get('asset_id') or review.get('external_id'),
        'job_id':job_id,
        'creative_name':review.get('creative_name'),
        'status':simple_job_status(str(review.get('status') or 'queued')),
        'progress':int(review.get('progress') or 0),
        'message':str(review.get('message') or ''),
        'status_url':f'/api/v1/jobs/{job_id}',
        'result_url':f'/api/v1/jobs/{job_id}/result',
    }


async def fail_claimed_api_review(
    job_id:str,
    *,
    file_name:str,
    file_size:int|None,
    has_ad_copy:bool,
    has_creative:bool,
    message:str,
)->None:
    try:
        await asyncio.to_thread(
            set_status,
            job_id,
            JobStatus.failed,
            100,
            message,
            file_name,
            file_size,
            has_ad_copy,
            has_creative,
        )
        await asyncio.to_thread(finalize_api_review, job_id, 'failed')
    except Exception:
        logger.exception('Could not finalize failed partner API submission %s.', job_id)


@app.get('/api/v1')
def partner_api_index():
    return {
        'name':'AdChecked Partner API',
        'version':'v1',
        'authentication':'Authorization: Bearer <api-key>',
        'base_url':partner_api_base_url(),
        'documentation_url':'/developers/api?view=guide',
        'interactive_reference_url':'/developers/api?view=reference',
        'openapi_url':'/api/v1/openapi.json',
        'max_platform_upload_mb':int(os.getenv('MAX_UPLOAD_MB','400')),
    }


@app.get('/api/v1/docs', include_in_schema=False)
def partner_api_docs():
    return RedirectResponse('/developers/api?view=guide')


@app.get('/api/v1/reference', include_in_schema=False)
def partner_api_reference():
    return RedirectResponse('/developers/api?view=reference')


@app.get('/api/v1/openapi.json', include_in_schema=False)
def partner_api_openapi():
    routes=[
        route
        for route in app.routes
        if isinstance(route,APIRoute)
        and route.path.startswith('/api/v1')
        and route.path not in {'/api/v1/docs','/api/v1/reference','/api/v1/openapi.json'}
    ]
    schema=get_openapi(
        title='AdChecked Partner API',
        version='1.0.0',
        description=(
            'Server-to-server API for fingerprinting live ad media, reviewing changed '
            'creatives, and retrieving owned status, reports, transcripts, OCR, visual '
            'observations, and evidence.'
        ),
        routes=routes,
    )
    components=schema.setdefault('components',{})
    security_schemes=components.setdefault('securitySchemes',{})
    security_schemes['BearerAuth']={
        'type':'http',
        'scheme':'bearer',
        'bearerFormat':'AdChecked API key',
    }
    for path,item in schema.get('paths',{}).items():
        if path == '/api/v1':
            continue
        for operation in item.values():
            if isinstance(operation,dict):
                operation['security']=[{'BearerAuth':[]}]
    return JSONResponse(schema)


@app.get('/api/v1/me')
async def partner_api_me(request:Request):
    principal=await require_api_principal(request, 'reviews:read')
    return {
        'partner':{
            'partner_id':principal.partner_id,
            'name':principal.partner_name,
            'allowed_offer_ids':list(principal.allowed_offer_ids),
            'allow_custom_policy':principal.allow_custom_policy,
            'concurrent_review_limit':principal.concurrent_review_limit,
            'max_upload_mb':principal.max_upload_mb,
            'monthly_review_limit':principal.monthly_review_limit,
            'monthly_reviews_created':principal.monthly_reviews_created,
            'retention_days':principal.retention_days,
            'unlimited_concurrency':principal.unlimited_concurrency,
            'unlimited_reviews':principal.unlimited_reviews,
            'webhook_configured':principal.webhook_configured,
        },
        'api_key':{
            'key_id':principal.api_key_id,
            'name':principal.api_key_name,
            'prefix':principal.api_key_prefix,
            'scopes':sorted(principal.scopes),
        },
    }


@app.post('/api/v1/jobs', status_code=202)
async def partner_create_job(payload:ApiJobInput,request:Request):
    principal=await require_api_principal(request,'reviews:create')
    idempotency_key=api_idempotency_key(request)
    meta=partner_review_meta(
        principal,
        ad_copy='',
        policy_text='',
        notes='',
        manual_transcript='',
        frame_interval_seconds=1.0,
        scene_detection=False,
        external_id=payload.asset_id,
    )
    max_bytes=min(
        principal.max_upload_mb,
        int(os.getenv('MAX_UPLOAD_MB','400')),
    )*1024*1024
    job_id=uuid.uuid4().hex
    jd=job_dir(job_id)
    claimed=False
    downloaded=None
    try:
        downloaded=await download_api_media(
            payload.media_url,
            payload.creative_name,
            jd,
            max_bytes,
        )
        claim=await asyncio.to_thread(
            claim_api_review,
            principal,
            job_id=job_id,
            creative_name=payload.creative_name,
            external_id=payload.asset_id,
            idempotency_key=idempotency_key,
            media_kind=downloaded.media_kind,
            file_name=downloaded.file_name,
            file_size=downloaded.file_size,
        )
        if not claim.get('created'):
            shutil.rmtree(jd,ignore_errors=True)
            review=await owned_api_review(principal,str(claim['review_id']))
            return simple_job_response(review)
        claimed=True
        (jd/'request.json').write_text(meta.model_dump_json(indent=2),encoding='utf-8')
        record=await enqueue_job(
            job_id,
            downloaded.path,
            downloaded.media_kind,
            meta,
            downloaded.file_name,
            file_size=downloaded.file_size,
        )
        return simple_job_response({
            'asset_id':payload.asset_id,
            'creative_name':payload.creative_name,
            'job_id':record.job_id,
            'message':record.message,
            'progress':record.progress,
            'status':record.status.value,
        })
    except PartnerMediaError as exc:
        shutil.rmtree(jd,ignore_errors=True)
        raise HTTPException(exc.status_code,exc.detail) from None
    except HTTPException:
        shutil.rmtree(jd,ignore_errors=True)
        raise
    except Exception as exc:
        if claimed and downloaded is not None:
            await fail_claimed_api_review(
                job_id,
                file_name=downloaded.file_name,
                file_size=downloaded.file_size,
                has_ad_copy=False,
                has_creative=True,
                message=f'Submission failed: {type(exc).__name__}',
            )
        shutil.rmtree(jd,ignore_errors=True)
        if claimed:
            raise HTTPException(
                503,
                'The review could not be queued. Retry with a new Idempotency-Key.',
            ) from None
        raise partner_storage_error(exc) from None


@app.post('/api/v1/reviews', status_code=202)
async def partner_create_review(
    request:Request,
    creative:UploadFile|None=File(None),
    video:UploadFile|None=File(None),
    creative_name:str=Form(''),
    ad_copy:str=Form(''),
    policy_text:str=Form(''),
    notes:str=Form(''),
    manual_transcript:str=Form(''),
    external_id:str=Form(''),
    frame_interval_seconds:float=Form(1.0),
    scene_detection:bool=Form(False),
):
    principal=await require_api_principal(request, 'reviews:create')
    creative_name=validate_scan_field('creative_name',creative_name,maximum=300)
    external_id=validate_external_id(external_id)
    idempotency_key=api_idempotency_key(request)
    validate_review_text(ad_copy,policy_text,notes,manual_transcript)
    meta=partner_review_meta(
        principal,
        ad_copy=ad_copy,
        policy_text=policy_text,
        notes=notes,
        manual_transcript=manual_transcript,
        frame_interval_seconds=frame_interval_seconds,
        scene_detection=scene_detection,
        external_id=external_id,
    )
    upload=creative or video
    if upload is None:
        if not meta.has_ad_copy:
            raise HTTPException(400, 'Submit a creative file or non-empty ad_copy.')
        job_id=uuid.uuid4().hex
        file_name=copy_review_file_name(meta.ad_copy)
        file_size=len(meta.ad_copy.encode('utf-8'))
        try:
            claim=await asyncio.to_thread(
                claim_api_review,
                principal,
                job_id=job_id,
                creative_name=creative_name,
                external_id=external_id,
                idempotency_key=idempotency_key,
                media_kind='copy_only',
                file_name=file_name,
                file_size=file_size,
            )
        except Exception as exc:
            raise partner_storage_error(exc) from None
        if not claim.get('created'):
            return await owned_api_review(principal, str(claim['review_id']))
        jd=job_dir(job_id)
        try:
            (jd/'request.json').write_text(meta.model_dump_json(indent=2),encoding='utf-8')
            record=await enqueue_job(job_id,None,'copy_only',meta,file_name,file_size=file_size)
        except Exception as exc:
            await fail_claimed_api_review(
                job_id,
                file_name=file_name,
                file_size=file_size,
                has_ad_copy=True,
                has_creative=False,
                message=f'Submission failed: {type(exc).__name__}',
            )
            raise HTTPException(503, 'The review could not be queued. Retry with a new Idempotency-Key.') from None
        return api_submission_response(record,external_id)

    file_name=Path(upload.filename or 'upload').name or 'upload'
    try:
        media_kind=detect_media_kind(file_name,upload.content_type)
    except ValueError as exc:
        raise HTTPException(415,str(exc)) from None
    max_bytes=min(
        principal.max_upload_mb,
        int(os.getenv('MAX_UPLOAD_MB','400')),
    )*1024*1024
    job_id=uuid.uuid4().hex
    jd=job_dir(job_id)
    media_path=jd/file_name
    size=0
    try:
        with media_path.open('wb') as output:
            while chunk:=await upload.read(1024*1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413,f'Max upload for this API partner is {max_bytes // (1024*1024)} MB.')
                output.write(chunk)
        if size == 0:
            raise HTTPException(400,'The creative file is empty.')
        claim=await asyncio.to_thread(
            claim_api_review,
            principal,
            job_id=job_id,
            creative_name=creative_name,
            external_id=external_id,
            idempotency_key=idempotency_key,
            media_kind=media_kind,
            file_name=file_name,
            file_size=size,
        )
        if not claim.get('created'):
            shutil.rmtree(jd,ignore_errors=True)
            return await owned_api_review(principal,str(claim['review_id']))
        (jd/'request.json').write_text(meta.model_dump_json(indent=2),encoding='utf-8')
        record=await enqueue_job(job_id,media_path,media_kind,meta,file_name,file_size=size)
        return api_submission_response(record,external_id)
    except HTTPException:
        shutil.rmtree(jd,ignore_errors=True)
        raise
    except Exception as exc:
        claimed='claim' in locals() and bool(claim.get('created'))
        if claimed:
            await fail_claimed_api_review(
                job_id,
                file_name=file_name,
                file_size=size or None,
                has_ad_copy=meta.has_ad_copy,
                has_creative=True,
                message=f'Submission failed: {type(exc).__name__}',
            )
        shutil.rmtree(jd,ignore_errors=True)
        if claimed:
            raise HTTPException(503,'The review could not be queued. Retry with a new Idempotency-Key.') from None
        raise partner_storage_error(exc) from None


@app.post('/api/v1/scans/creative', status_code=202)
async def partner_scan_creative(
    request:Request,
    response:Response,
    x_vibe_ad_id:str=Header(...,alias='X-Vibe-Ad-Id'),
    creative:UploadFile=File(...),
    ad_id:str=Form(...),
    account_id:str=Form(''),
    account_name:str=Form(''),
    campaign_id:str=Form(''),
    campaign_name:str=Form(''),
    ad_set_id:str=Form(''),
    ad_set_name:str=Form(''),
    creative_name:str=Form(''),
    ad_copy:str=Form(''),
    headline:str=Form(''),
    description:str=Form(''),
    call_to_action:str=Form(''),
    destination_url:str=Form(''),
    policy_text:str=Form(''),
    notes:str=Form(''),
    manual_transcript:str=Form(''),
    frame_interval_seconds:float=Form(1.0),
    scene_detection:bool=Form(False),
):
    principal=await require_api_principal(request,'scans:write')
    ad_id=validate_scan_field('ad_id',ad_id,maximum=200,required=True)
    routed_ad_id=validate_scan_field('X-Vibe-Ad-Id',x_vibe_ad_id,maximum=200,required=True)
    if not secrets.compare_digest(routed_ad_id,ad_id):
        raise HTTPException(400,'X-Vibe-Ad-Id must exactly match the ad_id form field.')
    account_id=validate_scan_field('account_id',account_id,maximum=200)
    account_name=validate_scan_field('account_name',account_name,maximum=300)
    campaign_id=validate_scan_field('campaign_id',campaign_id,maximum=200)
    campaign_name=validate_scan_field('campaign_name',campaign_name,maximum=500)
    ad_set_id=validate_scan_field('ad_set_id',ad_set_id,maximum=200)
    ad_set_name=validate_scan_field('ad_set_name',ad_set_name,maximum=500)
    creative_name=validate_scan_field('creative_name',creative_name,maximum=500)
    headline=validate_scan_field('headline',headline,maximum=5_000)
    description=validate_scan_field('description',description,maximum=10_000)
    call_to_action=validate_scan_field('call_to_action',call_to_action,maximum=500)
    destination_url=validate_scan_field('destination_url',destination_url,maximum=4_000)
    structured_ad_copy=scan_ad_copy_context(
        ad_copy=ad_copy,
        headline=headline,
        description=description,
        call_to_action=call_to_action,
        destination_url=destination_url,
    )
    validate_review_text(structured_ad_copy,policy_text,notes,manual_transcript)
    meta=partner_review_meta(
        principal,
        ad_copy=structured_ad_copy,
        policy_text=policy_text,
        notes=notes,
        manual_transcript=manual_transcript,
        frame_interval_seconds=frame_interval_seconds,
        scene_detection=scene_detection,
        external_id=ad_id,
    )
    file_name=Path(creative.filename or 'creative').name or 'creative'
    try:
        media_kind=detect_media_kind(file_name,creative.content_type)
    except ValueError as exc:
        raise HTTPException(415,str(exc)) from None
    max_bytes=min(principal.max_upload_mb,int(os.getenv('MAX_UPLOAD_MB','400')))*1024*1024
    job_id=uuid.uuid4().hex
    observation_id=f'obs_{uuid.uuid4().hex}'
    jd=job_dir(job_id)
    media_path=jd/file_name
    media_hash=hashlib.sha256()
    size=0
    claimed=False
    try:
        with media_path.open('wb') as output:
            while chunk:=await creative.read(1024*1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413,f'Max upload for this API partner is {max_bytes // (1024*1024)} MB.')
                media_hash.update(chunk)
                output.write(chunk)
        if size == 0:
            raise HTTPException(400,'The creative file is empty.')
        media_sha256=media_hash.hexdigest()
        fields_sha256,content_fingerprint=scan_review_fingerprints(
            media_sha256=media_sha256,
            meta=meta,
            ad_copy=ad_copy,
            headline=headline,
            description=description,
            call_to_action=call_to_action,
            destination_url=destination_url,
        )
        claim=await asyncio.to_thread(
            claim_api_scan_review,
            principal,
            observation_id=observation_id,
            job_id=job_id,
            external_ad_id=ad_id,
            media_sha256=media_sha256,
            fields_sha256=fields_sha256,
            content_fingerprint=content_fingerprint,
            media_kind=media_kind,
            file_name=file_name,
            file_size=size,
            account_id=account_id,
            account_name=account_name,
            campaign_id=campaign_id,
            campaign_name=campaign_name,
            ad_set_id=ad_set_id,
            ad_set_name=ad_set_name,
            creative_name=creative_name,
        )
        claim['external_ad_id']=ad_id
        if not claim.get('created'):
            shutil.rmtree(jd,ignore_errors=True)
            review=await owned_api_review(principal,str(claim['review_id']))
            response.status_code=200
            return scan_submission_response(claim,review)
        claimed=True
        (jd/'request.json').write_text(meta.model_dump_json(indent=2),encoding='utf-8')
        record=await enqueue_job(job_id,media_path,media_kind,meta,file_name,file_size=size)
        return scan_submission_response(claim,api_submission_response(record,ad_id))
    except HTTPException:
        shutil.rmtree(jd,ignore_errors=True)
        raise
    except Exception as exc:
        if claimed:
            await fail_claimed_api_review(
                job_id,
                file_name=file_name,
                file_size=size or None,
                has_ad_copy=meta.has_ad_copy,
                has_creative=True,
                message=f'Scan submission failed: {type(exc).__name__}',
            )
        shutil.rmtree(jd,ignore_errors=True)
        if claimed:
            raise HTTPException(503,'The changed creative could not be queued. Scan it again to retry.') from None
        raise partner_storage_error(exc) from None


@app.get('/api/v1/scans/ads')
async def partner_scan_ads(request:Request,limit:int=50,cursor:str|None=None):
    principal=await require_api_principal(request,'scans:read')
    try:
        return await asyncio.to_thread(
            list_api_scan_ads,
            principal,
            limit=limit,
            cursor=cursor,
        )
    except Exception as exc:
        raise partner_storage_error(exc) from None


@app.get('/api/v1/scans/ads/{ad_id}')
async def partner_scan_ad(ad_id:str,request:Request):
    principal=await require_api_principal(request,'scans:read')
    ad_id=validate_scan_field('ad_id',ad_id,maximum=200,required=True)
    try:
        scan=await asyncio.to_thread(get_api_scan_ad,principal,ad_id)
    except Exception as exc:
        raise partner_storage_error(exc) from None
    if scan is None:
        raise HTTPException(404,'Scanned ad not found.')
    review=await owned_api_review(principal,str(scan['current_review_id']))
    return {
        **scan,
        'review':{
            **review,
            'result_url':f'/api/v1/reviews/{scan["current_review_id"]}/result',
            'status_url':f'/api/v1/reviews/{scan["current_review_id"]}',
        },
    }


@app.get('/api/v1/scans/ads/{ad_id}/observations')
async def partner_scan_observations(
    ad_id:str,
    request:Request,
    limit:int=50,
    cursor:str|None=None,
):
    principal=await require_api_principal(request,'scans:read')
    ad_id=validate_scan_field('ad_id',ad_id,maximum=200,required=True)
    try:
        return await asyncio.to_thread(
            list_api_scan_observations,
            principal,
            external_ad_id=ad_id,
            limit=limit,
            cursor=cursor,
        )
    except Exception as exc:
        raise partner_storage_error(exc) from None


@app.post('/api/v1/uploads', status_code=201)
async def partner_start_upload(request:Request):
    principal=await require_api_principal(request,'reviews:create')
    try:
        payload=await request.json()
    except (ValueError,UnicodeDecodeError):
        raise HTTPException(400,'Invalid upload metadata.') from None
    if not isinstance(payload,dict):
        raise HTTPException(400,'Invalid upload metadata.')
    file_name=Path(str(payload.get('file_name','upload'))).name or 'upload'
    content_type=str(payload.get('content_type',''))
    try:
        size=int(payload.get('size',0))
    except (TypeError,ValueError):
        raise HTTPException(400,'Invalid upload size.') from None
    max_bytes=min(principal.max_upload_mb,int(os.getenv('MAX_UPLOAD_MB','400')))*1024*1024
    if size <= 0:
        raise HTTPException(400,'The creative file is empty.')
    if size > max_bytes:
        raise HTTPException(413,f'Max upload for this API partner is {max_bytes // (1024*1024)} MB.')
    try:
        media_kind=detect_media_kind(file_name,content_type)
    except ValueError as exc:
        raise HTTPException(415,str(exc)) from None
    upload_id=uuid.uuid4().hex
    upload_dir=job_dir(upload_id)
    (upload_dir/UPLOAD_CHUNKS_DIR).mkdir(parents=True,exist_ok=True)
    chunk_count=(size+UPLOAD_CHUNK_SIZE-1)//UPLOAD_CHUNK_SIZE
    metadata={
        'api_partner_id':principal.partner_id,
        'api_key_id':principal.api_key_id,
        'created_at':now_ms(),
        'expires_at':now_ms()+3600*1000,
        'file_name':file_name,
        'media_kind':media_kind,
        'size':size,
        'chunk_size':UPLOAD_CHUNK_SIZE,
        'chunk_count':chunk_count,
    }
    (upload_dir/UPLOAD_METADATA_FILE).write_text(json.dumps(metadata),encoding='utf-8')
    return {
        'upload_id':upload_id,
        'chunk_size':UPLOAD_CHUNK_SIZE,
        'chunk_count':chunk_count,
        'expires_in_seconds':3600,
    }


async def owned_api_upload(request:Request,upload_id:str)->tuple[ApiPrincipal,Path,dict]:
    principal=await require_api_principal(request,'reviews:create')
    upload_dir,metadata=read_upload_metadata(upload_id)
    if metadata.get('api_partner_id') != principal.partner_id:
        raise HTTPException(404,'Upload not found.')
    if int(metadata.get('expires_at',0)) <= now_ms():
        shutil.rmtree(upload_dir,ignore_errors=True)
        raise HTTPException(410,'Upload expired. Start a new upload.')
    return principal,upload_dir,metadata


@app.put('/api/v1/uploads/{upload_id}/chunks/{chunk_index}')
async def partner_upload_chunk(upload_id:str,chunk_index:int,request:Request):
    _,upload_dir,metadata=await owned_api_upload(request,upload_id)
    chunk_count=int(metadata['chunk_count'])
    if chunk_index < 0 or chunk_index >= chunk_count:
        raise HTTPException(400,'Invalid upload chunk.')
    expected_size=min(
        int(metadata['chunk_size']),
        int(metadata['size'])-chunk_index*int(metadata['chunk_size']),
    )
    chunks_dir=upload_dir/UPLOAD_CHUNKS_DIR
    chunk_path=chunks_dir/f'{chunk_index:06d}.part'
    if chunk_path.exists() and chunk_path.stat().st_size == expected_size:
        return {'received':expected_size}
    temporary=chunks_dir/f'.{chunk_index:06d}.{uuid.uuid4().hex}.tmp'
    received=0
    try:
        with temporary.open('wb') as output:
            async for data in request.stream():
                received += len(data)
                if received > expected_size:
                    raise HTTPException(413,'Upload chunk is larger than expected.')
                output.write(data)
        if received != expected_size:
            raise HTTPException(400,'Upload chunk is incomplete; retry it.')
        temporary.replace(chunk_path)
    finally:
        temporary.unlink(missing_ok=True)
    return {'received':received}


@app.post('/api/v1/uploads/{upload_id}/complete', status_code=202)
async def partner_complete_upload(
    upload_id:str,
    request:Request,
    creative_name:str=Form(''),
    ad_copy:str=Form(''),
    policy_text:str=Form(''),
    notes:str=Form(''),
    manual_transcript:str=Form(''),
    external_id:str=Form(''),
    frame_interval_seconds:float=Form(1.0),
    scene_detection:bool=Form(False),
):
    principal,upload_dir,metadata=await owned_api_upload(request,upload_id)
    creative_name=validate_scan_field('creative_name',creative_name,maximum=300)
    external_id=validate_external_id(external_id)
    idempotency_key=api_idempotency_key(request)
    validate_review_text(ad_copy,policy_text,notes,manual_transcript)
    if metadata.get('completed') or (upload_dir/'status.json').exists():
        return await owned_api_review(principal,upload_id)
    meta=partner_review_meta(
        principal,
        ad_copy=ad_copy,
        policy_text=policy_text,
        notes=notes,
        manual_transcript=manual_transcript,
        frame_interval_seconds=frame_interval_seconds,
        scene_detection=scene_detection,
        external_id=external_id,
    )
    chunks_dir=upload_dir/UPLOAD_CHUNKS_DIR
    chunk_paths=[chunks_dir/f'{index:06d}.part' for index in range(int(metadata['chunk_count']))]
    if any(not path.exists() for path in chunk_paths):
        raise HTTPException(409,'Upload is incomplete; retry the missing chunks.')
    if sum(path.stat().st_size for path in chunk_paths) != int(metadata['size']):
        raise HTTPException(409,'Upload size does not match; restart this upload.')
    media_path=upload_dir/str(metadata['file_name'])
    claimed=False
    try:
        with media_path.open('wb') as output:
            for chunk_path in chunk_paths:
                with chunk_path.open('rb') as chunk:
                    shutil.copyfileobj(chunk,output)
        claim=await asyncio.to_thread(
            claim_api_review,
            principal,
            job_id=upload_id,
            creative_name=creative_name,
            external_id=external_id,
            idempotency_key=idempotency_key,
            media_kind=str(metadata['media_kind']),
            file_name=str(metadata['file_name']),
            file_size=int(metadata['size']),
        )
        if not claim.get('created'):
            shutil.rmtree(upload_dir,ignore_errors=True)
            return await owned_api_review(principal,str(claim['review_id']))
        claimed=True
        (upload_dir/'request.json').write_text(meta.model_dump_json(indent=2),encoding='utf-8')
        record=await enqueue_job(
            upload_id,
            media_path,
            str(metadata['media_kind']),
            meta,
            str(metadata['file_name']),
            file_size=int(metadata['size']),
        )
        metadata['completed']=True
        (upload_dir/UPLOAD_METADATA_FILE).write_text(json.dumps(metadata),encoding='utf-8')
        shutil.rmtree(chunks_dir,ignore_errors=True)
        return api_submission_response(record,external_id)
    except HTTPException:
        raise
    except Exception as exc:
        media_path.unlink(missing_ok=True)
        if claimed:
            await fail_claimed_api_review(
                upload_id,
                file_name=str(metadata['file_name']),
                file_size=int(metadata['size']),
                has_ad_copy=meta.has_ad_copy,
                has_creative=True,
                message=f'Submission failed: {type(exc).__name__}',
            )
            raise HTTPException(503,'The review could not be queued. Retry with a new Idempotency-Key.') from None
        raise partner_storage_error(exc) from None


@app.get('/api/v1/reviews')
async def partner_review_history(request:Request,limit:int=50,cursor:str|None=None):
    principal=await require_api_principal(request,'history:read')
    try:
        return await asyncio.to_thread(
            list_api_reviews,
            principal,
            limit=limit,
            cursor=cursor,
        )
    except Exception as exc:
        raise partner_storage_error(exc) from None


@app.get('/api/v1/jobs/{job_id}')
async def partner_job_status(job_id:str,request:Request):
    principal=await require_api_principal(request,'reviews:read')
    review=await owned_api_review(principal,job_id)
    return simple_job_response(review)


@app.get('/api/v1/jobs/{job_id}/result')
async def partner_job_result(job_id:str,request:Request):
    principal=await require_api_principal(request,'reviews:read')
    review=await owned_api_review(principal,job_id)
    normalized_status=simple_job_status(str(review.get('status') or 'queued'))
    if normalized_status == 'failed':
        raise HTTPException(409,'Job processing failed; inspect the status response for details.')
    if not review.get('report_ready'):
        raise HTTPException(409,'Job result is not ready yet.',headers={'Retry-After':'5'})
    report=await asyncio.to_thread(get_stored_report,job_id)
    if report is None:
        raise HTTPException(404,'Job result not found.')
    return {
        'asset_id':review.get('asset_id') or review.get('external_id'),
        'job_id':job_id,
        'creative_name':review.get('creative_name'),
        'status':'completed',
        'result':report,
    }


@app.get('/api/v1/reviews/{job_id}')
async def partner_review_status(job_id:str,request:Request):
    principal=await require_api_principal(request,'reviews:read')
    return await owned_api_review(principal,job_id)


@app.get('/api/v1/reviews/{job_id}/result')
async def partner_review_result(job_id:str,request:Request):
    principal=await require_api_principal(request,'reviews:read')
    review=await owned_api_review(principal,job_id)
    if review.get('status') == 'failed':
        raise HTTPException(409,'Review processing failed; inspect the status response for details.')
    if not review.get('report_ready'):
        raise HTTPException(409,'Review result is not ready yet.',headers={'Retry-After':'5'})
    report=await asyncio.to_thread(get_stored_report,job_id)
    if report is None:
        raise HTTPException(404,'Review result not found.')
    return {
        'review':review,
        'report':report,
        'artifacts':{
            'evidence_url':f'/api/v1/reviews/{job_id}/evidence',
            'json_url':f'/api/v1/reviews/{job_id}/report.json',
            'pdf_url':f'/api/v1/reviews/{job_id}/report.pdf',
        },
    }


@app.get('/api/v1/reviews/{job_id}/evidence')
async def partner_review_evidence(job_id:str,request:Request):
    principal=await require_api_principal(request,'evidence:read')
    await owned_api_review(principal,job_id)
    try:
        evidence=await asyncio.to_thread(get_api_evidence,principal,job_id)
    except Exception as exc:
        raise partner_storage_error(exc) from None
    if evidence is None:
        raise HTTPException(404,'Review evidence not found.')
    if evidence.get('expired'):
        raise HTTPException(410,'Review evidence has expired under this partner’s retention policy.')
    bundle=evidence.get('bundle')
    if bundle is None:
        raise HTTPException(409,'Review evidence is not ready yet.',headers={'Retry-After':'5'})
    frames=[{
        'filename':frame.get('filename'),
        'timestamp':frame.get('timestamp'),
        'url':f'/api/v1/reviews/{job_id}/frames/{frame.get("filename")}',
    } for frame in list_review_evidence_frames(job_id) if frame.get('filename')]
    return {**evidence,'bundle':bundle,'evidence_frames':frames}


@app.get('/api/v1/reviews/{job_id}/report.json')
async def partner_report_json(job_id:str,request:Request):
    principal=await require_api_principal(request,'reports:download')
    review=await owned_api_review(principal,job_id)
    if not review.get('report_ready'):
        raise HTTPException(409,'Review result is not ready yet.',headers={'Retry-After':'5'})
    report=await asyncio.to_thread(get_stored_report,job_id)
    if report is None:
        raise HTTPException(404,'Review result not found.')
    return JSONResponse(
        report,
        headers={'content-disposition':f'attachment; filename="{job_id}-report.json"'},
    )


@app.get('/api/v1/reviews/{job_id}/report.pdf')
async def partner_report_pdf(job_id:str,request:Request,offer_id:str|None=None):
    principal=await require_api_principal(request,'reports:download')
    review=await owned_api_review(principal,job_id)
    if not review.get('report_ready'):
        raise HTTPException(409,'Review result is not ready yet.',headers={'Retry-After':'5'})
    normalized=(offer_id or review.get('primary_offer_id') or '').strip().lower()
    if not OFFER_ID_PATTERN.fullmatch(normalized) or normalized not in review.get('offer_ids',[]):
        raise HTTPException(404,'Offer report not found.')
    try:
        artifact=await asyncio.to_thread(ensure_review_pdf,job_id,normalized)
        return pdf_artifact_response(artifact)
    except (FileNotFoundError,ValueError):
        raise HTTPException(404,'Offer report not found.') from None


@app.get('/api/v1/reviews/{job_id}/thumbnail')
async def partner_review_thumbnail(job_id:str,request:Request):
    principal=await require_api_principal(request,'evidence:read')
    await owned_api_review(principal,job_id)
    frames=list_review_evidence_frames(job_id)
    if not frames:
        raise HTTPException(404,'Creative thumbnail not found.')
    return evidence_frame_response(job_id,str(frames[0].get('filename') or ''))


@app.get('/api/v1/reviews/{job_id}/frames/{filename}')
async def partner_review_frame(job_id:str,filename:str,request:Request):
    principal=await require_api_principal(request,'evidence:read')
    await owned_api_review(principal,job_id)
    return evidence_frame_response(job_id,filename)


@app.delete('/api/v1/reviews/{job_id}')
async def partner_delete_review(job_id:str,request:Request):
    principal=await require_api_principal(request,'reviews:delete')
    review=await owned_api_review(principal,job_id)
    if review.get('status') not in {'complete','failed'}:
        raise HTTPException(409,'Only completed or failed reviews can be deleted.')
    try:
        deleted=await asyncio.to_thread(delete_review,job_id)
    except ValueError as exc:
        raise HTTPException(409,str(exc)) from None
    except FileNotFoundError:
        # The durable review may already be soft-deleted from an interrupted
        # prior request. The ownership record still authorizes this cleanup.
        deleted={'job_id':job_id,'deleted_at':now_ms()}
    except Exception as exc:
        raise partner_storage_error(exc) from None
    try:
        await asyncio.to_thread(mark_api_review_deleted,principal,job_id)
    except Exception as exc:
        raise partner_storage_error(exc) from None
    return deleted


@app.get('/api/health')
def health_check():
    return {'status':'ok', 'queue':queue_state()}


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
    start_background_task(maintain_partner_api_in_background())
    return {'runs':[result.model_dump(mode='json') for result in results]}


@app.get('/api/internal/queue-state')
def internal_queue_state(request:Request):
    require_automation_secret(request)
    return queue_state()


@app.post('/api/internal/review-recovery')
async def internal_review_recovery(request:Request):
    require_automation_secret(request)
    return await recover_and_drain_review_queue()


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
    require_settings_admin(request)
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
    require_settings_admin(request)
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
async def create_review(creative:UploadFile|None=File(None), video:UploadFile|None=File(None), ad_copy:str=Form(''), policy_text:str=Form(''), notes:str=Form(''), manual_transcript:str=Form(''), model:str=Form(''), frame_interval_seconds:float=Form(1.0), scene_detection:bool=Form(False), batch_id:str=Form(''), batch_item_id:str=Form(''), offer_ids:str=Form(''), vertical:str=Form('auto-insurance')):
    upload=creative or video
    meta=review_meta(ad_copy, policy_text, notes, manual_transcript, model, frame_interval_seconds, scene_detection, batch_id, batch_item_id, parse_offer_ids(offer_ids))
    meta=meta.model_copy(update={'vertical':parse_review_vertical(vertical)})
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
    max_mb=int(os.getenv('MAX_UPLOAD_MB','400'))
    job_id=uuid.uuid4().hex; jd=job_dir(job_id)
    media_path=jd/file_name
    size=0
    try:
        with media_path.open('wb') as f:
            while chunk:=await upload.read(1024*1024):
                size += len(chunk)
                if size > max_mb*1024*1024:
                    raise HTTPException(413, f'Max upload is {max_mb} MB')
                f.write(chunk)
        if size == 0:
            raise HTTPException(400,'The creative file is empty.')
    except HTTPException:
        shutil.rmtree(jd,ignore_errors=True)
        raise
    (jd/'request.json').write_text(meta.model_dump_json(indent=2), encoding='utf-8')
    rec=await enqueue_job(job_id, media_path, media_kind, meta, file_name, file_size=size)
    return rec


@app.post('/api/live-scans/observe', response_model=LiveScanIngestResult)
async def observe_live_scan(payload:LiveScanObservation):
    source_url=clean_live_source_url(payload.source_url)
    live_ads=[ad for ad in payload.ads if ad.is_live]
    creative_groups:dict[str,dict]=defaultdict(lambda:{
        'ad_ids':set(),
        'ad_set_names':set(),
        'campaign_names':set(),
        'delivery_statuses':set(),
        'media_url':None,
        'media_type':'unknown',
        'creative_name':'',
    })
    copy_groups:dict[tuple[str,str],dict]=defaultdict(lambda:{
        'ad_ids':set(),
        'creative_name':'',
        'primary_text':'',
    })

    for ad in live_ads:
        creative_key=exact_creative_key(ad.creative_name)
        if not creative_key.strip():
            continue
        creative=creative_groups[creative_key]
        creative['creative_name']=ad.creative_name
        creative['ad_ids'].add(ad.ad_id)
        if ad.ad_set_name:
            creative['ad_set_names'].add(ad.ad_set_name)
        if ad.campaign_name:
            creative['campaign_names'].add(ad.campaign_name)
        if ad.delivery_status:
            creative['delivery_statuses'].add(ad.delivery_status)
        if ad.media_url and not creative['media_url']:
            creative['media_url']=ad.media_url
            creative['media_type']=ad.media_type
        for raw_text in ad.primary_texts:
            text=normalize_primary_text(raw_text)
            if not text:
                continue
            copy_key=primary_text_key(text)
            copy=copy_groups[(creative_key,copy_key)]
            copy['creative_name']=ad.creative_name
            copy['primary_text']=text
            copy['ad_ids'].add(ad.ad_id)

    if len(creative_groups) > MAX_LIVE_SCAN_GROUPS:
        raise HTTPException(413, f'A live scan can contain at most {MAX_LIVE_SCAN_GROUPS} creatives.')
    if len(copy_groups) > MAX_LIVE_SCAN_GROUPS:
        raise HTTPException(413, f'A live scan can contain at most {MAX_LIVE_SCAN_GROUPS} copy variants.')

    media_requests=[]
    for key,value in creative_groups.items():
        claim=await asyncio.to_thread(
            claim_live_review,
            'creative',
            key,
            value['creative_name'],
            start_review=False,
        )
        if claim.get('needs_media'):
            media_requests.append(LiveScanMediaRequest(
                creative_key=key,
                creative_name=value['creative_name'],
                job_id=claim['job_id'],
                media_type=value['media_type'],
                media_url=value['media_url'],
            ))

    queued_copy_jobs=0
    for (_creative_key,copy_key),value in copy_groups.items():
        claim=await asyncio.to_thread(
            claim_live_review,
            'copy',
            copy_key,
            value['primary_text'][:160],
            start_review=True,
        )
        if not claim.get('should_submit'):
            continue
        job_id=claim['job_id']
        try:
            meta=live_scan_request_meta(
                kind='copy',
                key=copy_key,
                creative_name=value['creative_name'],
                account_id=payload.account_id,
                account_name=payload.account_name,
                observation_date=payload.observation_date,
                ad_copy=value['primary_text'],
            )
            jd=job_dir(job_id)
            (jd/'request.json').write_text(meta.model_dump_json(indent=2),encoding='utf-8')
            await enqueue_job(
                job_id,
                None,
                'copy_only',
                meta,
                copy_review_file_name(value['primary_text']),
            )
        except Exception as exc:
            logger.exception('Could not queue live ad-copy review %s',job_id)
            await asyncio.to_thread(
                release_live_review,'copy',copy_key,job_id,str(exc)
            )
            continue
        try:
            await asyncio.to_thread(mark_live_review_queued,'copy',copy_key,job_id)
        except Exception:
            logger.exception('Could not mark live ad-copy review %s as queued',job_id)
        try:
            set_review_source(job_id,ReviewSource(
                kind='meta_ads',
                status='linked',
                url=source_url,
                label='Open Meta Ads Manager',
                message=(
                    f'Observed live in Meta ad account “{payload.account_name}” '
                    f'with creative “{value["creative_name"]}”.'
                ),
                checked_at=payload.observed_at,
            ))
        except Exception:
            logger.exception('Could not link Meta source for live ad-copy review %s',job_id)
        queued_copy_jobs += 1

    creatives=[
        {
            'creative_key':key,
            'creative_name':value['creative_name'],
            'ad_ids':sorted(value['ad_ids']),
            'ad_count':len(value['ad_ids']),
            'campaign_names':sorted(value['campaign_names'])[:MAX_LIVE_SCAN_NAMES],
            'ad_set_names':sorted(value['ad_set_names'])[:MAX_LIVE_SCAN_NAMES],
            'delivery_statuses':sorted(value['delivery_statuses'])[:MAX_LIVE_SCAN_NAMES],
        }
        for key,value in creative_groups.items()
    ]
    copies=[
        {
            'copy_key':copy_key,
            'creative_key':creative_key,
            'creative_name':value['creative_name'],
            'primary_text':value['primary_text'],
            'ad_ids':sorted(value['ad_ids']),
            'ad_count':len(value['ad_ids']),
        }
        for (creative_key,copy_key),value in copy_groups.items()
    ]
    await asyncio.to_thread(
        observe_live_account,
        account_id=payload.account_id,
        account_name=payload.account_name,
        observation_date=payload.observation_date,
        observed_at=payload.observed_at,
        source_url=source_url,
        observed_ad_ids=sorted({ad.ad_id for ad in payload.ads}),
        creatives=creatives,
        copies=copies,
    )
    return LiveScanIngestResult(
        account_id=payload.account_id,
        observation_date=payload.observation_date,
        observed_at=payload.observed_at,
        live_ads=len(live_ads),
        unique_creatives=len(creatives),
        unique_primary_texts=len({copy_key for _,copy_key in copy_groups}),
        queued_copy_jobs=queued_copy_jobs,
        media_requests=media_requests,
    )


@app.post('/api/live-scans/creative')
async def upload_live_scan_creative(
    creative:UploadFile=File(...),
    creative_name:str=Form(...),
    account_id:str=Form(...),
    account_name:str=Form(...),
    observation_date:str=Form(...),
    source_url:str=Form(''),
):
    if not creative_name.strip() or len(creative_name) > 300:
        raise HTTPException(400,'Creative name must be between 1 and 300 characters.')
    if not account_id.strip() or len(account_id) > 256:
        raise HTTPException(400,'Meta ad account ID is invalid.')
    if not OBSERVATION_DATE_PATTERN.fullmatch(observation_date):
        raise HTTPException(400,'Observation date must use YYYY-MM-DD.')
    creative_key=exact_creative_key(creative_name)
    if not creative_key.strip():
        raise HTTPException(400,'Creative name cannot be blank.')
    claim=await asyncio.to_thread(
        claim_live_review,
        'creative',
        creative_key,
        creative_name,
        start_review=True,
    )
    if not claim.get('should_submit'):
        try:
            return get_status(claim['job_id'])
        except FileNotFoundError:
            return {
                'job_id':claim['job_id'],
                'status':claim['status'],
                'message':'Creative review is already claimed.',
            }

    job_id=claim['job_id']
    upload_name=Path(creative.filename or creative_name or 'meta-creative').name
    try:
        media_kind=detect_media_kind(upload_name,creative.content_type)
    except ValueError as exc:
        await asyncio.to_thread(
            release_live_review,'creative',creative_key,job_id,str(exc)
        )
        raise HTTPException(415,str(exc)) from None
    max_bytes=int(os.getenv('MAX_UPLOAD_MB','400')) * 1024 * 1024
    jd=job_dir(job_id)
    media_path=jd/upload_name
    size=0
    record=None
    try:
        with media_path.open('wb') as handle:
            while chunk:=await creative.read(1024*1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        413,
                        f'Max upload is {os.getenv("MAX_UPLOAD_MB","400")} MB',
                    )
                handle.write(chunk)
        meta=live_scan_request_meta(
            kind='creative',
            key=creative_key,
            creative_name=creative_name,
            account_id=account_id.strip(),
            account_name=account_name.strip() or account_id.strip(),
            observation_date=observation_date,
        )
        (jd/'request.json').write_text(meta.model_dump_json(indent=2),encoding='utf-8')
        record=await enqueue_job(
            job_id,
            media_path,
            media_kind,
            meta,
            creative_name,
            file_size=size,
        )
    except HTTPException:
        media_path.unlink(missing_ok=True)
        await asyncio.to_thread(
            release_live_review,'creative',creative_key,job_id,'Upload failed'
        )
        raise
    except Exception as exc:
        media_path.unlink(missing_ok=True)
        await asyncio.to_thread(
            release_live_review,'creative',creative_key,job_id,str(exc)
        )
        raise
    try:
        await asyncio.to_thread(
            mark_live_review_queued,'creative',creative_key,job_id
        )
    except Exception:
        logger.exception('Could not mark live creative review %s as queued',job_id)
    try:
        set_review_source(job_id,ReviewSource(
            kind='meta_ads',
            status='linked',
            url=clean_live_source_url(source_url),
            label='Open Meta Ads Manager',
            message=(
                f'Captured automatically from live Meta ad account '
                f'“{account_name.strip() or account_id.strip()}”.'
            ),
            checked_at=now_ms(),
        ))
    except Exception:
        logger.exception('Could not link Meta source for live creative review %s',job_id)
    return record


@app.get('/api/live-scans', response_model=LiveScanDay)
def live_scans(date:str):
    if not OBSERVATION_DATE_PATTERN.fullmatch(date):
        raise HTTPException(400,'Date must use YYYY-MM-DD.')
    return get_live_scan_day(date)


def drive_creative_model(file)->DriveCreativeFile:
    return DriveCreativeFile(
        file_id=file.file_id,
        name=file.name,
        mime_type=file.mime_type,
        size=file.size,
        modified_time=file.modified_time,
        web_view_link=file.web_view_link,
    )


@app.get('/api/drive/options', response_model=DriveOptionList)
def drive_options():
    try:
        options=configured_drive_options()
    except DriveLookupError as exc:
        raise HTTPException(503, str(exc)) from None
    return DriveOptionList(options=[
        DriveOption(drive_id=option.drive_id, name=option.name)
        for option in options
    ])


@app.get('/api/drive/browse', response_model=DriveBrowserList)
def browse_drive(folder_id:str|None=None, drive_id:str='default'):
    try:
        drive=get_google_drive_client(drive_id)
        current=drive.get_file(folder_id or drive.root_folder_id)
        children=drive.list_folder_children(current.file_id)
    except DriveLookupError as exc:
        raise HTTPException(503, str(exc)) from None
    max_bytes=int(os.getenv('MAX_UPLOAD_MB','400')) * 1024 * 1024
    items=[]
    for child in children:
        is_folder=child.mime_type == FOLDER_MIME_TYPE
        too_large=not is_folder and child.size is not None and child.size > max_bytes
        items.append(DriveBrowserItem(
            **drive_creative_model(child).model_dump(),
            kind='folder' if is_folder else 'creative',
            selectable=not too_large,
            disabled_reason=(f'Exceeds the {os.getenv("MAX_UPLOAD_MB", "400")} MB limit' if too_large else None),
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
    max_bytes=int(os.getenv('MAX_UPLOAD_MB','400')) * 1024 * 1024
    try:
        files=get_google_drive_client(payload.drive_id).resolve_selection(
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
def drive_creatives(drive_id:str='default'):
    try:
        files = get_google_drive_client(drive_id).list_creative_files()
    except DriveLookupError as exc:
        raise HTTPException(503, str(exc)) from None
    return DriveCreativeList(files=[
        drive_creative_model(file)
        for file in files
    ])


@app.post('/api/drive/reviews', response_model=JobRecord)
async def create_drive_review(payload: CreateDriveReview):
    drive=get_google_drive_client(payload.drive_id)
    try:
        drive_file = await asyncio.to_thread(
            drive.get_file,
            payload.file_id,
        )
    except DriveLookupError as exc:
        raise HTTPException(400, str(exc)) from None

    file_name = Path(drive_file.name).name or 'drive-creative'
    try:
        media_kind = detect_media_kind(file_name, drive_file.mime_type)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from None
    max_bytes = int(os.getenv('MAX_UPLOAD_MB', '400')) * 1024 * 1024
    if not drive_file.can_download:
        raise HTTPException(403, 'This Google Drive file cannot be downloaded by the service account.')
    if drive_file.size is not None and drive_file.size > max_bytes:
        raise HTTPException(413, f'Max upload is {os.getenv("MAX_UPLOAD_MB", "400")} MB')

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
    meta=meta.model_copy(update={'vertical':payload.vertical})
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

    max_bytes = int(os.getenv('MAX_UPLOAD_MB', '400')) * 1024 * 1024
    if size <= 0:
        raise HTTPException(400, 'The creative file is empty.')
    if size > max_bytes:
        raise HTTPException(413, f'Max upload is {os.getenv("MAX_UPLOAD_MB", "400")} MB')

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
    offer_ids: str = Form(''),
    vertical: str = Form('auto-insurance'),
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
    meta=meta.model_copy(update={'vertical':parse_review_vertical(vertical)})
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
    offer_snapshot=review_meta(
        '', '', '', '', '', 1.0, False, '', '', payload.offer_ids or None
    )
    return create_batch(
        payload.batch_id,
        payload.items,
        offer_snapshot.offer_outcomes,
        source_label=payload.source_label,
        review_context=payload.review_context,
    )

@app.get('/api/batches', response_model=list[ReviewBatch])
def review_batches(batch_ids:str=''):
    normalized=list(dict.fromkeys(
        batch_id.strip().lower()
        for batch_id in batch_ids.split(',')
        if batch_id.strip()
    ))
    if len(normalized) > MAX_BATCH_ITEMS:
        raise HTTPException(400, f'Load no more than {MAX_BATCH_ITEMS} batches at once.')
    if any(not BATCH_ID_PATTERN.fullmatch(batch_id) for batch_id in normalized):
        raise HTTPException(400, 'Invalid batch id')
    return get_batches(normalized)

@app.get('/api/batches/{batch_id}', response_model=ReviewBatch)
def review_batch(batch_id:str):
    if not BATCH_ID_PATTERN.fullmatch(batch_id):
        raise HTTPException(404, 'Review batch not found')
    try:
        return get_batch(batch_id)
    except FileNotFoundError:
        raise HTTPException(404, 'Review batch not found') from None


def pdf_artifact_response(artifact:PdfArtifact):
    headers={'content-disposition':f'attachment; filename="{artifact.filename}"'}
    if artifact.path is not None:
        return FileResponse(
            artifact.path,
            media_type='application/pdf',
            filename=artifact.filename,
        )
    try:
        content=read_pdf_artifact(artifact)
    except (FileNotFoundError, httpx.HTTPError):
        raise HTTPException(503, 'PDF report storage is temporarily unavailable.') from None
    return Response(content=content, media_type='application/pdf', headers=headers)


@app.get('/api/batches/{batch_id}/report.pdf')
def download_batch_pdf(batch_id:str, offer_id:str|None=None):
    if not BATCH_ID_PATTERN.fullmatch(batch_id):
        raise HTTPException(404, 'Review batch not found')
    normalized_offer_id=offer_id.strip().lower() if offer_id else None
    if normalized_offer_id and not OFFER_ID_PATTERN.fullmatch(normalized_offer_id):
        raise HTTPException(404, 'Offer report not found')
    try:
        return pdf_artifact_response(ensure_batch_pdf(batch_id, normalized_offer_id))
    except FileNotFoundError:
        raise HTTPException(404, 'Review batch not found') from None
    except KeyError:
        raise HTTPException(404, 'Offer report not found') from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None

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


async def resolve_retry_drive_file(item, payload:RetryBatchItem):
    selected_drive_id=item.drive_id or payload.drive_id
    selected_file_id=item.drive_file_id or payload.file_id
    if selected_drive_id and selected_file_id:
        drive=get_google_drive_client(selected_drive_id)
        try:
            return selected_drive_id, await asyncio.to_thread(
                drive.get_file,
                selected_file_id,
            )
        except DriveLookupError as exc:
            raise HTTPException(409, str(exc)) from None

    try:
        options=[
            option
            for option in configured_drive_options()
            if not selected_drive_id or option.drive_id == selected_drive_id
        ]
    except DriveLookupError as exc:
        raise HTTPException(503, str(exc)) from None
    if not options:
        raise HTTPException(409, 'The original Google Drive is no longer configured.')

    matches=[]
    for option in options:
        try:
            files=await asyncio.to_thread(
                get_google_drive_client(option.drive_id).find_files_by_exact_name,
                item.file_name,
            )
        except DriveLookupError as exc:
            raise HTTPException(503, str(exc)) from None
        matches.extend((option.drive_id, file) for file in files)
    if not matches:
        raise HTTPException(409, 'The original creative could not be found in the configured Drive folders.')
    if len(matches) > 1:
        raise HTTPException(409, 'More than one Drive creative has this name. Reopen the workspace and select the exact file.')
    return matches[0]


@app.post('/api/batches/{batch_id}/items/{item_id}/retry-drive', response_model=JobRecord)
async def retry_batch_drive_item(
    batch_id:str,
    item_id:str,
    payload:RetryBatchItem,
):
    if not BATCH_ID_PATTERN.fullmatch(batch_id) or not BATCH_ID_PATTERN.fullmatch(item_id):
        raise HTTPException(404, 'Review batch item not found')
    try:
        batch=get_batch(batch_id)
        item=next(value for value in batch.items if value.item_id == item_id)
    except (FileNotFoundError, StopIteration):
        raise HTTPException(404, 'Review batch item not found') from None
    if item.status != 'upload_failed':
        raise HTTPException(409, 'Only a Drive item that failed before processing can be retried.')
    if item.media_kind == 'copy_only':
        raise HTTPException(409, 'This batch item is not a Google Drive creative.')

    drive_id,drive_file=await resolve_retry_drive_file(item,payload)
    file_name=Path(drive_file.name).name or 'drive-creative'
    try:
        media_kind=detect_media_kind(file_name,drive_file.mime_type)
    except ValueError as exc:
        raise HTTPException(415,str(exc)) from None
    max_bytes=int(os.getenv('MAX_UPLOAD_MB','400')) * 1024 * 1024
    if not drive_file.can_download:
        raise HTTPException(403,'This Google Drive file cannot be downloaded by the service account.')
    if drive_file.size is not None and drive_file.size > max_bytes:
        raise HTTPException(413,f'Max upload is {os.getenv("MAX_UPLOAD_MB","400")} MB')

    context=batch.review_context or BatchReviewContext(
        drive_id=drive_id,
        ad_copy=payload.ad_copy,
        policy_text=payload.policy_text,
        notes=payload.notes,
        manual_transcript=payload.manual_transcript,
        model=payload.model,
        frame_interval_seconds=payload.frame_interval_seconds,
        scene_detection=payload.scene_detection,
    )
    offer_ids=context.offer_ids or [
        outcome.offer_id
        for outcome in item.offer_outcomes
        if outcome.evaluation_state == 'evaluated'
    ]
    if not offer_ids:
        raise HTTPException(409,'The original offer selection is unavailable. Resubmit this creative from the workspace.')
    meta=review_meta(
        context.ad_copy,
        context.policy_text,
        context.notes,
        context.manual_transcript,
        context.model or '',
        context.frame_interval_seconds,
        context.scene_detection,
        batch_id,
        item_id,
        offer_ids,
    )
    meta=meta.model_copy(update={
        'vertical':item.vertical or classify_review_vertical(file_name),
    })
    try:
        claimed=await asyncio.to_thread(claim_batch_item_retry,batch_id,item_id)
    except (FileNotFoundError,KeyError):
        raise HTTPException(404,'Review batch item not found') from None
    if not claimed:
        raise HTTPException(409,'This batch item has already been retried or is no longer failed.')

    job_id=uuid.uuid4().hex
    jd=job_dir(job_id)
    media_path=jd/file_name
    (jd/'request.json').write_text(meta.model_dump_json(indent=2),encoding='utf-8')
    try:
        record=await enqueue_job(
            job_id,
            media_path,
            media_kind,
            meta,
            file_name,
            file_size=drive_file.size,
            drive_file=drive_file,
        )
        set_review_source(job_id,ReviewSource(
            kind='google_drive_file',
            status='linked',
            url=drive_file.web_view_link,
            file_id=drive_file.file_id,
            label='Open creative in Google Drive',
            message=f'Retried “{file_name}” in its original batch.',
            checked_at=now_ms(),
        ))
        return get_status(record.job_id)
    except Exception as exc:
        logger.exception('Could not retry Drive batch item %s/%s',batch_id,item_id)
        try:
            await asyncio.to_thread(
                update_batch_item,
                batch_id,
                item_id,
                status='upload_failed',
                message=str(exc),
            )
        except Exception:
            logger.exception('Could not restore failed batch status for %s/%s',batch_id,item_id)
        raise


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
    require_settings_admin(request)
    normalized=offer_id.strip().lower()
    if not OFFER_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(400, 'Offer ID must be a lowercase slug using letters, numbers, hyphens, or underscores.')
    try:
        return upsert_offer_profile(normalized, payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.delete('/api/offers/{offer_id}', response_model=OfferProfile)
def disable_offer(offer_id:str, request:Request):
    require_settings_admin(request)
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
def review_stats(
    offer_id:str|None=None,
    offer_ids:str|None=None,
    vertical:str|None=None,
):
    requested=(offer_ids.split(',') if offer_ids is not None else [offer_id or 'acp'])
    normalized=list(dict.fromkeys(value.strip().lower() for value in requested if value.strip()))
    if not normalized:
        normalized=['acp']
    if len(normalized) > 10 or any(not OFFER_ID_PATTERN.fullmatch(value) for value in normalized):
        raise HTTPException(400, 'Invalid offer IDs')
    normalized_vertical=vertical.strip().lower() if vertical else None
    if normalized_vertical is not None and normalized_vertical not in REVIEW_VERTICALS:
        raise HTTPException(400, 'Invalid review vertical')
    return get_review_stats(normalized, normalized_vertical)


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


@app.get('/api/reviews/{job_id}/report.pdf')
def download_pdf_report(job_id:str, offer_id:str|None=None):
    if not JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(404, 'Review job not found')
    normalized_offer_id=offer_id.strip().lower() if offer_id else None
    if normalized_offer_id and not OFFER_ID_PATTERN.fullmatch(normalized_offer_id):
        raise HTTPException(404, 'Offer report not found')
    try:
        return pdf_artifact_response(ensure_review_pdf(job_id, normalized_offer_id))
    except FileNotFoundError:
        raise HTTPException(404, 'Report not ready') from None
    except KeyError:
        raise HTTPException(404, 'Offer report not found') from None


@app.get('/api/reviews/{job_id}/evidence')
def review_evidence(job_id:str):
    try:
        get_status(job_id)
    except FileNotFoundError:
        raise HTTPException(404, 'Review job not found') from None
    return {'frames':public_evidence_frames(job_id)}


@app.get('/api/reviews/{job_id}/thumbnail')
def review_thumbnail(job_id:str):
    frames=list_review_evidence_frames(job_id)
    if not frames:
        raise HTTPException(404, 'Creative thumbnail not found')
    return evidence_frame_response(job_id, str(frames[0].get('filename') or ''))


@app.get('/api/reviews/{job_id}/frames/{filename}')
def frame(job_id:str, filename:str):
    legacy=job_dir(job_id)/'frames'/Path(filename).name
    if legacy.exists():
        return FileResponse(legacy)
    return evidence_frame_response(job_id, filename)

static=Path('frontend/dist')
if static.exists():
    app.mount('/', StaticFiles(directory=static, html=True), name='static')
