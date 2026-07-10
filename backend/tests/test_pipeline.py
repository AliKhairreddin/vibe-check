import json
import asyncio
import logging
from pathlib import Path

import httpx
import pytest

from app.main import app, copy_review_file_name
from app.review_pipeline import queue as review_queue
from app.review_pipeline.models import ComplianceReport, JobRecord, JobStatus, ReviewRequestMeta
from app.review_pipeline.audio import extract_audio_command, transcribe
from app.review_pipeline.guidelines import build_policy_context, load_default_guidelines
from app.review_pipeline.jobs import build_review_evidence, process_job
from app.review_pipeline.llm import parse_report_json
from app.review_pipeline.media import detect_media_kind, prepare_image_frame
from app.review_pipeline.ocr import normalize_text, dedupe_ocr
from app.review_pipeline.storage import set_status, get_status, set_report, get_report, list_reviews
from app.review_pipeline.telegram import build_review_message, send_review_message
from app.review_pipeline.video import ffprobe_command, extract_frames_command
from app.review_pipeline.vision import select_frame_records
from PIL import Image


@pytest.fixture
def anyio_backend():
    return 'asyncio'

def test_report_schema_validation():
    r=ComplianceReport.model_validate({'overall_status':'pass','summary':'ok','findings':[],'safe_rewrite':{'ad_copy':'','onscreen_text':[]},'limitations':[]})
    assert r.overall_status=='pass'

def test_review_request_meta_tracks_optional_ad_copy():
    assert not ReviewRequestMeta().has_ad_copy
    assert not ReviewRequestMeta(ad_copy='   ').has_ad_copy
    assert ReviewRequestMeta(ad_copy='Save up to 20%.').has_ad_copy

def test_review_evidence_keeps_ad_copy_independent_from_audio_and_ocr():
    meta=ReviewRequestMeta(ad_copy='Facebook caption text.', notes='Brand note.')
    evidence=build_review_evidence(
        'video',
        meta,
        'Policy text.',
        ['Saved rules'],
        {'source':'manual','chunks':[{'text':'Spoken transcript.'}]},
        [{'text':'On-screen words.'}],
        [{'filename':'frame_000001.jpg','timestamp':1.0}],
        {'source':'openrouter_vision','observations':[{'filename':'frame_000001.jpg','timestamp_start':'1','scene':'Person holding paperwork.'}]},
        'Evidence note.',
    )
    assert 'ad_copy' not in evidence
    assert evidence['submitted_ad_copy'] == {'present': True, 'text': 'Facebook caption text.'}
    assert evidence['audio_transcript']['chunks'][0]['text'] == 'Spoken transcript.'
    assert evidence['onscreen_text_ocr'][0]['text'] == 'On-screen words.'
    assert evidence['visual_observations']['observations'][0]['scene'] == 'Person holding paperwork.'
    assert 'platform caption/body' in evidence['source_definitions']['ad_copy']

def test_review_evidence_supports_copy_only_jobs():
    meta=ReviewRequestMeta(ad_copy='Standalone ad copy.', notes='Brand note.')
    evidence=build_review_evidence(
        'copy_only',
        meta,
        'Policy text.',
        ['Saved rules'],
        {'source':'not_applicable','chunks':[], 'limitations':['No creative was submitted.']},
        [],
        [],
        {'source':'not_applicable','observations':[]},
        'No creative was submitted; review is based on submitted ad copy, policy text, and notes only.',
    )
    assert evidence['media_type']=='copy_only'
    assert evidence['submitted_ad_copy'] == {'present': True, 'text': 'Standalone ad copy.'}
    assert evidence['audio_transcript']['chunks'] == []
    assert evidence['onscreen_text_ocr'] == []
    assert evidence['visual_frame_references'] == []
    assert evidence['visual_observations']['observations'] == []

def test_copy_review_file_name_uses_copy_preview():
    label=copy_review_file_name('  Save money now with a very long claim that should still make a compact history label for reviewers.  ')
    assert label.startswith('Ad copy: Save money now')
    assert len(label) <= 72


@pytest.mark.anyio
async def test_chunked_upload_reassembles_and_enqueues_large_creative(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.setattr('app.main.UPLOAD_CHUNK_SIZE', 5)
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    creative = b'fake-mp4-payload'
    enqueued = {}

    async def fake_enqueue(job_id, media_path, media_kind, meta, file_name):
        enqueued.update({
            'job_id': job_id,
            'payload': media_path.read_bytes(),
            'media_kind': media_kind,
            'model': meta.model,
            'file_name': file_name,
        })
        return JobRecord(job_id=job_id, file_name=file_name, has_ad_copy=meta.has_ad_copy)

    monkeypatch.setattr('app.main.enqueue_job', fake_enqueue)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        started = await client.post('/api/uploads', json={
            'file_name': 'creative.mp4',
            'content_type': 'video/mp4',
            'size': len(creative),
        })
        assert started.status_code == 200
        upload = started.json()
        assert upload['chunk_count'] == 4
        for index in range(upload['chunk_count']):
            start = index * upload['chunk_size']
            chunk = await client.put(
                f"/api/uploads/{upload['upload_id']}/chunks/{index}",
                content=creative[start:start + upload['chunk_size']],
                headers={'content-type': 'application/octet-stream'},
            )
            assert chunk.status_code == 200
        completed = await client.post(
            f"/api/uploads/{upload['upload_id']}/complete",
            data={'ad_copy': 'Caption', 'model': 'example/model'},
        )

    assert completed.status_code == 200
    assert enqueued == {
        'job_id': upload['upload_id'],
        'payload': creative,
        'media_kind': 'video',
        'model': 'example/model',
        'file_name': 'creative.mp4',
    }

def test_openrouter_json_repair_fallback():
    text='Here is JSON {"overall_status":"needs_review","summary":"x","findings":[],"safe_rewrite":{"ad_copy":"","onscreen_text":[]},"limitations":[]} done'
    assert parse_report_json(text).overall_status=='needs_review'

def test_openrouter_report_without_verdict_or_findings_fails_closed():
    report=parse_report_json(json.dumps({
        'summary':'The response omitted a verdict.',
        'findings':[],
        'limitations':{'unexpected':'shape'},
    }))
    assert report.overall_status=='needs_review'
    assert any('did not include a recognized explicit compliance verdict' in item for item in report.limitations)

def test_openrouter_report_preserves_explicit_pass_without_findings():
    report=parse_report_json(json.dumps({
        'overall_status':'pass',
        'summary':'No policy issues were identified.',
        'findings':[],
    }))
    assert report.overall_status=='pass'
    assert not any('did not include a recognized explicit compliance verdict' in item for item in report.limitations)

def test_openrouter_report_normalizes_policy_compliance_wrapper():
    text=json.dumps({
        'policy_compliance': {
            'overall_compliance': 'non-compliant',
            'issues': [{
                'risk_level': 'high',
                'source': 'ad copy',
                'issue': 'Mentions a savings claim without a required disclaimer.',
                'policy_rule': 'Claims that imply financial savings need clear support.',
                'recommendation': 'Add a clear disclaimer and substantiation for the savings claim.',
                'confidence': 'high',
            }],
        }
    })
    report=parse_report_json(text)
    assert report.overall_status=='likely_violation'
    assert report.summary=='Mentions a savings claim without a required disclaimer.'
    assert report.findings[0].source=='ad_copy'
    assert report.findings[0].severity=='high'

def test_openrouter_report_normalizes_source_results():
    text=json.dumps({
        'overall_status':'needs_review',
        'summary':'split result',
        'sourceResults': {
            'creative': {'result':'pass', 'summary':'Creative surfaces are clear.'},
            'adCopy': {'verdict':'needs review', 'details':'Caption claim needs substantiation.'},
        },
        'findings': [],
        'safeRewrite': {'ad_copy':'', 'onscreen_text': []},
    })
    report=parse_report_json(text)
    assert report.source_results.creative is not None
    assert report.source_results.creative.status == 'pass'
    assert report.source_results.ad_copy is not None
    assert report.source_results.ad_copy.status == 'needs_review'
    assert report.source_results.ad_copy.summary == 'Caption claim needs substantiation.'

def test_openrouter_report_normalizes_review_list_wrapper():
    text=json.dumps({
        'review': [{
            'policy_rule': 'TCPA',
            'compliance': 'non-compliant',
            'evidence': 'The ad includes a call prompt without consent language.',
            'suggested_fix': 'Add opt-in consent language before asking users to call.',
        }]
    })
    report=parse_report_json(text)
    assert report.overall_status=='likely_violation'
    assert report.summary=='The ad includes a call prompt without consent language.'
    assert report.findings[0].policy_reason=='TCPA'

def test_default_guidelines_are_loaded_and_combined():
    guidelines=load_default_guidelines()
    assert 'General Publisher Ad Copy & Creative Guidelines' in guidelines
    assert 'No imagery of car wrecks' in guidelines
    policy_text, sources=build_policy_context('Extra rule.')
    assert 'Extra rule.' in policy_text
    assert sources == ['Saved General Publisher Ad Copy & Creative Guidelines', 'Additional pasted policy/guidelines']

def test_ocr_normalization_deduping():
    items=dedupe_ocr([{'text':' Big   Sale ','timestamp':0},{'text':'big sale','timestamp':1},{'text':'','timestamp':2}])
    assert len(items)==1 and items[0]['text']=='Big Sale'

def test_job_status_transitions(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    set_status('j1', JobStatus.queued, 0)
    set_status('j1', JobStatus.running_ocr, 60)
    assert get_status('j1').status == JobStatus.running_ocr

def test_review_history_lists_local_jobs(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('j1', JobStatus.queued, 0, 'Queued', 'creative.mp4')
    set_report('j1', {'overall_status':'pass','summary':'ok','findings':[]})
    set_status('j1', JobStatus.complete, 100, 'Complete')
    history=list_reviews()
    assert len(history)==1
    assert history[0].file_name=='creative.mp4'
    assert history[0].overall_status=='pass'
    assert history[0].created_at is not None

def test_review_history_splits_creative_and_ad_copy_results(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('j1', JobStatus.queued, 0, 'Queued', 'creative.mp4', has_ad_copy=True)
    set_report('j1', {
        'overall_status':'likely_violation',
        'summary':'mixed issues',
        'findings':[
            {
                'severity':'high',
                'source':'visual',
                'evidence':'Crash imagery',
                'policy_reason':'No wreck imagery',
                'suggested_fix':'Use a neutral driving scene.',
                'confidence':'high',
            },
            {
                'severity':'medium',
                'source':'ad_copy',
                'evidence':'Limited time savings claim',
                'policy_reason':'Urgency claims need review',
                'suggested_fix':'Remove urgency language.',
                'confidence':'medium',
            },
        ],
    })
    set_status('j1', JobStatus.complete, 100, 'Complete')
    history=list_reviews()
    assert history[0].has_ad_copy
    assert history[0].creative_result=='likely_violation'
    assert history[0].ad_copy_result=='needs_review'

def test_review_history_marks_missing_ad_copy_result_empty(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('j1', JobStatus.queued, 0, 'Queued', 'creative.png', has_ad_copy=False)
    set_report('j1', {
        'overall_status':'needs_review',
        'summary':'creative needs review',
        'findings':[{
            'severity':'medium',
            'source':'onscreen_text',
            'evidence':'Unsupported savings claim',
            'policy_reason':'Savings claims need substantiation',
            'suggested_fix':'Add substantiation.',
            'confidence':'medium',
        }],
    })
    set_status('j1', JobStatus.complete, 100, 'Complete')
    history=list_reviews()
    assert not history[0].has_ad_copy
    assert history[0].creative_result=='needs_review'
    assert history[0].ad_copy_result is None

def test_process_job_completes_copy_only_without_media(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)
    asyncio.run(process_job('j1', None, 'copy_only', ReviewRequestMeta(ad_copy='Save today.')))
    status=get_status('j1')
    report=get_report('j1')
    assert status.status == JobStatus.complete
    assert status.report_ready
    assert not status.has_creative
    assert report is not None
    assert 'No creative was submitted' in report['limitations'][-1]

def test_queue_uses_bounded_parallel_workers(monkeypatch):
    monkeypatch.delenv('JOB_WORKER_CONCURRENCY', raising=False)
    assert review_queue._worker_count() == 4

    monkeypatch.setenv('JOB_WORKER_CONCURRENCY', '6')
    assert review_queue._worker_count() == 6

    monkeypatch.setenv('JOB_WORKER_CONCURRENCY', '100')
    assert review_queue._worker_count() == 8

    monkeypatch.setenv('JOB_WORKER_CONCURRENCY', 'not-a-number')
    assert review_queue._worker_count() == 4

@pytest.mark.anyio
async def test_job_workers_process_four_jobs_in_parallel(monkeypatch):
    queue=asyncio.Queue()
    workers=[]
    all_started=asyncio.Event()
    release=asyncio.Event()
    started=[]

    monkeypatch.setattr(review_queue, '_queue', queue)
    monkeypatch.setattr(review_queue, '_workers', workers)
    monkeypatch.setenv('JOB_WORKER_CONCURRENCY', '4')
    monkeypatch.setattr(review_queue, 'set_status', lambda *args, **kwargs: None)

    async def fake_process_job(job_id, media_path, media_kind, meta):
        started.append(job_id)
        if len(started) == 4:
            all_started.set()
        await release.wait()

    monkeypatch.setattr(review_queue, 'process_job', fake_process_job)

    for index in range(5):
        await queue.put(
            review_queue.QueuedReviewJob(
                f'job-{index}',
                None,
                'copy_only',
                ReviewRequestMeta(ad_copy=f'Copy {index}'),
            )
        )

    await review_queue.start_job_workers()
    try:
        await asyncio.wait_for(all_started.wait(), timeout=1)
        assert len(started) == 4
        assert queue.qsize() == 1
        release.set()
        await asyncio.wait_for(queue.join(), timeout=1)
    finally:
        await review_queue.stop_job_workers()

    assert started == [f'job-{index}' for index in range(5)]

@pytest.mark.anyio
async def test_process_queue_continues_after_start_status_failure(monkeypatch):
    queue=asyncio.Queue()
    monkeypatch.setattr(review_queue, '_queue', queue)

    status_calls=[]
    processed=[]

    def fake_set_status(job_id, status, progress, message=''):
        status_calls.append((job_id, status, progress, message))
        if job_id == 'first' and status == JobStatus.queued:
            raise RuntimeError('status backend unavailable')
        return None

    async def fake_process_job(job_id, media_path, media_kind, meta):
        processed.append(job_id)

    monkeypatch.setattr(review_queue, 'set_status', fake_set_status)
    monkeypatch.setattr(review_queue, 'process_job', fake_process_job)

    await queue.put(review_queue.QueuedReviewJob('first', None, 'copy_only', ReviewRequestMeta(ad_copy='First')))
    await queue.put(review_queue.QueuedReviewJob('second', None, 'copy_only', ReviewRequestMeta(ad_copy='Second')))

    worker=asyncio.create_task(review_queue._process_queue(0))
    try:
        await asyncio.wait_for(queue.join(), timeout=1)
    finally:
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker

    assert processed == ['second']
    assert ('first', JobStatus.failed, 100, 'Queue processing failed: RuntimeError') in status_calls

def test_review_history_prefers_explicit_source_results(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('j1', JobStatus.queued, 0, 'Queued', 'creative.mp4', has_ad_copy=True)
    set_report('j1', {
        'overall_status':'likely_violation',
        'summary':'overall mixed result',
        'source_results':{
            'creative':{'status':'pass','summary':'Creative is clear.'},
            'ad_copy':{'status':'needs_review','summary':'Caption needs substantiation.'},
        },
        'findings':[],
    })
    set_status('j1', JobStatus.complete, 100, 'Complete')
    history=list_reviews()
    assert history[0].creative_result=='pass'
    assert history[0].ad_copy_result=='needs_review'

def test_telegram_message_includes_minimal_split_results_and_report_links(monkeypatch):
    monkeypatch.setenv('APP_PUBLIC_URL', 'https://vibe-check.thatcanadian.dev')
    record=JobRecord(
        job_id='abc123',
        file_name='summer-drive-video.mp4',
        status=JobStatus.complete,
        progress=100,
        message='Complete',
        report_ready=True,
        has_ad_copy=True,
        has_creative=True,
        created_at=1783450800000,
    )
    message=build_review_message(record, {
        'overall_status':'needs_review',
        'summary':'overall mixed result',
        'source_results':{
            'creative':{
                'status':'pass',
                'summary':'Creative surfaces are clear and do not contain restricted visual claims.',
            },
            'ad_copy':{
                'status':'likely_violation',
                'summary':'Caption includes a guaranteed savings claim that needs support.',
            },
        },
        'findings':[{
            'severity':'high',
            'source':'ad_copy',
            'evidence':'Unsupported guaranteed savings claim',
            'policy_reason':'Savings claims need substantiation',
            'suggested_fix':'Soften the claim or add clear substantiation.',
            'confidence':'high',
        }],
    }, 'Save $600 this month', 'video')
    assert '<b>Type:</b> Creative Vid' in message
    assert '<b>Type:</b> Ad copy' in message
    assert '<b>Name:</b>' in message
    assert '<b>Result:</b>' in message
    assert '<b>Report Link:</b>' in message
    assert 'Open report' in message
    assert '<b>Findings</b>' not in message
    assert '<b>Summary</b>' not in message
    assert 'Ad copy: Save $600 this month' in message
    assert 'Unsupported guaranteed savings claim' not in message
    assert 'Caption includes a guaranteed' not in message
    assert message.count('/reviews/abc123/report') == 2

def test_telegram_message_omits_missing_source_sections(monkeypatch):
    monkeypatch.setenv('APP_PUBLIC_URL', 'https://vibe-check.thatcanadian.dev')
    record=JobRecord(
        job_id='copy123',
        file_name='Ad copy: Save today.',
        status=JobStatus.complete,
        progress=100,
        message='Complete',
        report_ready=True,
        has_ad_copy=True,
        has_creative=False,
        created_at=1783450800000,
    )
    message=build_review_message(record, {
        'overall_status':'pass',
        'summary':'copy is clear',
        'source_results':{
            'ad_copy':{'status':'pass','summary':'Copy is clear.'},
        },
        'findings':[],
    })
    assert 'Creative Vid' not in message
    assert 'Creative Image' not in message
    assert '<b>Type:</b> Ad copy' in message
    assert '<b>Name:</b>' in message
    assert '<b>Result:</b>' in message
    assert '<b>Report Link:</b>' in message
    assert 'Open report' in message

def test_telegram_message_labels_image_creatives(monkeypatch):
    monkeypatch.setenv('APP_PUBLIC_URL', 'https://vibe-check.thatcanadian.dev')
    record=JobRecord(
        job_id='image123',
        file_name='static-ad.png',
        status=JobStatus.complete,
        progress=100,
        message='Complete',
        report_ready=True,
        has_ad_copy=False,
        has_creative=True,
    )
    message=build_review_message(record, {
        'overall_status':'needs_review',
        'source_results':{
            'creative':{'status':'needs_review','summary':'Image needs review.'},
        },
        'findings':[],
    }, media_kind='image')
    assert '<b>Type:</b> Creative Image' in message
    assert 'static-ad.png' in message

def test_telegram_error_log_does_not_expose_bot_token(monkeypatch, caplog):
    token='secret-token-that-must-not-be-logged'
    monkeypatch.setenv('TELEGRAM_BOT_TOKEN', token)
    monkeypatch.setenv('TELEGRAM_CHAT_ID', '12345')
    record=JobRecord(job_id='telegram-failure', status=JobStatus.complete)

    class FakeClient:
        def __init__(self, timeout):
            self.timeout=timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def post(self, url, json):
            request=httpx.Request('POST', url)
            response=httpx.Response(502, request=request)
            raise httpx.HTTPStatusError(
                f'Bad gateway from {url}',
                request=request,
                response=response,
            )

    monkeypatch.setattr('app.review_pipeline.telegram.httpx.Client', FakeClient)
    caplog.set_level(logging.ERROR, logger='app.review_pipeline.telegram')

    assert not send_review_message(record, {'overall_status':'pass', 'findings':[]})
    assert 'job_id=telegram-failure' in caplog.text
    assert 'error_type=HTTPStatusError' in caplog.text
    assert 'http_status=502' in caplog.text
    assert token not in caplog.text
    assert f'https://api.telegram.org/bot{token}/sendMessage' not in caplog.text

def test_ffmpeg_command_construction():
    assert ffprobe_command(Path('ad.mp4'))[0]=='ffprobe'
    cmd=extract_frames_command(Path('ad.mp4'), Path('frame_%06d.jpg'), 1.0)
    assert cmd[0]=='ffmpeg' and 'fps=1.0' in cmd
    audio_cmd=extract_audio_command(Path('ad.mp4'), Path('audio.wav'))
    assert audio_cmd[0]=='ffmpeg' and '-vn' in audio_cmd and 'audio.wav' in audio_cmd

def test_creative_media_kind_detection():
    assert detect_media_kind('ad.mp4', 'video/mp4') == 'video'
    assert detect_media_kind('ad.png', 'image/png') == 'image'
    assert detect_media_kind('ad.webp', 'application/octet-stream') == 'image'

def test_prepare_image_frame_converts_to_jpeg(tmp_path):
    source=tmp_path/'ad.png'
    Image.new('RGBA', (20, 10), (255, 0, 0, 128)).save(source)
    frames=prepare_image_frame(source, tmp_path/'frames')
    frame_path=tmp_path/'frames'/frames[0]['filename']
    assert frames == [{'filename':'frame_still.jpg','timestamp':None,'source':'still_image'}]
    assert frame_path.exists()
    with Image.open(frame_path) as img:
        assert img.format == 'JPEG'
        assert img.size == (20, 10)

def test_manual_transcript_takes_precedence(tmp_path, monkeypatch):
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)
    audio=tmp_path/'audio.wav'
    audio.write_bytes(b'wav')
    transcript=transcribe(audio, 'Limited time offer.')
    assert transcript['source']=='manual'
    assert transcript['chunks'][0]['text']=='Limited time offer.'

def test_transcribe_reports_missing_openrouter_key(tmp_path, monkeypatch):
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)
    audio=tmp_path/'audio.wav'
    audio.write_bytes(b'wav')
    transcript=transcribe(audio)
    assert transcript['source']=='unavailable'
    assert 'OPENROUTER_API_KEY' in transcript['limitations'][0]

def test_transcribe_uses_openrouter_stt(tmp_path, monkeypatch):
    calls={}
    audio=tmp_path/'audio.wav'
    audio.write_bytes(b'test audio')
    monkeypatch.setenv('OPENROUTER_API_KEY', 'test-key')
    monkeypatch.setenv('OPENROUTER_STT_MODEL', 'openai/whisper-large-v3')
    monkeypatch.setenv('OPENROUTER_STT_LANGUAGE', 'en')

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {'text':'Test transcript.', 'usage':{'seconds':1.2}}

    class FakeClient:
        def __init__(self, timeout):
            calls['timeout']=timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def post(self, url, headers, json):
            calls['url']=url
            calls['headers']=headers
            calls['json']=json
            return FakeResponse()

    monkeypatch.setattr('app.review_pipeline.audio.httpx.Client', FakeClient)
    transcript=transcribe(audio)
    assert transcript['source']=='openrouter'
    assert transcript['model']=='openai/whisper-large-v3'
    assert transcript['chunks'][0]['text']=='Test transcript.'
    assert transcript['usage']['seconds']==1.2
    assert calls['url'].endswith('/audio/transcriptions')
    assert calls['headers']['Authorization']=='Bearer test-key'
    assert calls['json']['input_audio']['format']=='wav'
    assert calls['json']['input_audio']['data']=='dGVzdCBhdWRpbw=='
    assert calls['json']['language']=='en'

def test_transcribe_splits_audio_into_timestamped_chunks(tmp_path, monkeypatch):
    audio=tmp_path/'audio.wav'
    audio.write_bytes(b'test audio')
    monkeypatch.setenv('OPENROUTER_API_KEY', 'test-key')
    monkeypatch.setenv('OPENROUTER_STT_CHUNK_SECONDS', '5')
    monkeypatch.setenv('OPENROUTER_STT_MAX_CHUNKS', '10')
    monkeypatch.setattr('app.review_pipeline.audio._audio_duration_seconds', lambda path: 12.0)

    extracted=[]
    def fake_extract(source, target, start, duration):
        extracted.append((start, duration))
        target.write_bytes(f'chunk {start}'.encode())

    def fake_post(client, chunk_path, model, language):
        return {'text':f'transcript {chunk_path.stem}', 'usage':{'seconds':1}}

    class FakeClient:
        def __init__(self, timeout):
            self.timeout=timeout
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return None

    monkeypatch.setattr('app.review_pipeline.audio._extract_audio_segment', fake_extract)
    monkeypatch.setattr('app.review_pipeline.audio._post_transcription', fake_post)
    monkeypatch.setattr('app.review_pipeline.audio.httpx.Client', FakeClient)

    transcript=transcribe(audio)
    assert transcript['source']=='openrouter'
    assert extracted == [(0, 5), (5, 5), (10, 2.0)]
    assert [chunk['timestamp_start'] for chunk in transcript['chunks']] == [0, 5, 10]
    assert [chunk['timestamp_end'] for chunk in transcript['chunks']] == [5, 10, 12.0]
    assert transcript['usage']['seconds'] == 3

def test_select_frame_records_samples_evenly():
    frames=[{'filename':f'frame_{index}.jpg','timestamp':index} for index in range(10)]
    selected=select_frame_records(frames, 4)
    assert [frame['filename'] for frame in selected] == ['frame_0.jpg', 'frame_3.jpg', 'frame_6.jpg', 'frame_9.jpg']
