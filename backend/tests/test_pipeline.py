import json
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from app.main import app, copy_review_file_name, review_meta
from app.review_pipeline import automation_storage as review_automation_storage
from app.review_pipeline import automations as review_automations
from app.review_pipeline import jobs as review_jobs
from app.review_pipeline import queue as review_queue
from app.review_pipeline import storage as review_storage
from app.review_pipeline import telegram as review_telegram
from app.review_pipeline.models import ComplianceReport, CreateBatchItem, JobRecord, JobStatus, OfferOutcome, OfferOverride, OfferProfile, OfferProfileInput, OverrideAnnotationSet, ReviewAutomation, ReviewAutomationInput, ReviewRequestMeta
from app.review_pipeline.automations import due_schedule_key, rendered_file_pattern
from app.review_pipeline.audio import extract_audio_command, transcribe
from app.review_pipeline.drive import DriveFile, DriveLookupError, GoogleDriveClient, escape_drive_query_value
from app.review_pipeline.guidelines import build_internal_override_context, build_policy_context, load_default_guidelines
from app.review_pipeline.jobs import build_review_evidence, process_job
from app.review_pipeline.llm import parse_report_json
from app.review_pipeline.media import detect_media_kind, prepare_image_frame
from app.review_pipeline.ocr import normalize_text, dedupe_ocr
from app.review_pipeline.storage import create_batch, current_offer_outcomes, delete_review, disable_offer_profile, get_batch, get_offer_profile_revision, get_review_stats, list_offer_profiles, resolve_active_offer_profiles, resolve_offer_profiles, set_status, get_status, set_report, get_report, list_reviews, list_reviews_page, upsert_offer_profile
from app.review_pipeline.automation_storage import claim_automation_files, claim_automation_run, finish_automation_run, list_review_automations, upsert_review_automation
from app.review_pipeline.source_links import resolve_review_sources
from app.review_pipeline.telegram import build_batch_message, build_review_message, finish_batch_item_and_notify, send_review_message
from app.review_pipeline.video import ffprobe_command, extract_frames_command
from app.review_pipeline.vision import select_frame_records
from PIL import Image


@pytest.fixture
def anyio_backend():
    return 'asyncio'

@pytest.mark.parametrize('result', ['green', 'yellow', 'orange', 'red'])
def test_report_schema_validation(result):
    r=ComplianceReport.model_validate({'overall_status':result,'summary':'ok','findings':[],'safe_rewrite':{'ad_copy':'','onscreen_text':[]},'limitations':[]})
    assert r.overall_status==result

def test_report_schema_normalizes_legacy_stored_results():
    report=ComplianceReport.model_validate({
        'overall_status':'likely_violation',
        'summary':'legacy report',
        'source_results':{
            'creative':{'status':'needs_review','summary':'Review creative.'},
            'ad_copy':{'status':'pass','summary':'Copy is clear.'},
        },
        'findings':[],
        'safe_rewrite':{'ad_copy':'','onscreen_text':[]},
        'limitations':[],
    })
    assert report.overall_status == 'red'
    assert report.source_results.creative is not None
    assert report.source_results.creative.status == 'orange'
    assert report.source_results.ad_copy is not None
    assert report.source_results.ad_copy.status == 'green'

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
    assert 'internal_overrides' not in evidence

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

    async def fake_enqueue(job_id, media_path, media_kind, meta, file_name, file_size=None):
        enqueued.update({
            'job_id': job_id,
            'payload': media_path.read_bytes(),
            'media_kind': media_kind,
            'model': meta.model,
            'file_name': file_name,
            'file_size': file_size,
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
        'file_size': len(creative),
    }

def test_drive_query_escaping_handles_apostrophes_and_backslashes():
    assert escape_drive_query_value("quinn's paper\\essay.mp4") == "quinn\\'s paper\\\\essay.mp4"

def test_drive_search_keeps_only_files_inside_configured_root(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'
    calls=[]

    def fake_get_json(path, params):
        calls.append((path, params.copy()))
        if path == '/files':
            return {'files':[
                {
                    'id':'inside',
                    'name':"quinn's ad.mp4",
                    'mimeType':'video/mp4',
                    'parents':['nested-folder'],
                    'webViewLink':'https://drive.google.com/file/d/inside/view',
                    'size':'123',
                },
                {
                    'id':'outside',
                    'name':"quinn's ad.mp4",
                    'mimeType':'video/mp4',
                    'parents':['other-folder'],
                    'webViewLink':'https://drive.google.com/file/d/outside/view',
                },
            ]}
        if path == '/files/nested-folder':
            return {'id':'nested-folder','parents':['root-folder']}
        if path == '/files/other-folder':
            return {'id':'other-folder','parents':['different-root']}
        if path == '/files/different-root':
            return {'id':'different-root','parents':[]}
        raise AssertionError(f'Unexpected Drive request: {path}')

    monkeypatch.setattr(client, '_get_json', fake_get_json)
    matches=client.find_files_by_exact_name("quinn's ad.mp4")

    assert [match.file_id for match in matches] == ['inside']
    assert matches[0].size == 123
    assert calls[0][1]['q'] == "name = 'quinn\\'s ad.mp4' and trashed = false"

def test_drive_browser_lists_supported_creatives_recursively(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'

    def fake_get_json(path, params):
        assert path == '/files'
        if "'root-folder' in parents" in params['q']:
            return {'files':[
                {'id':'nested','name':'Nested','mimeType':'application/vnd.google-apps.folder','parents':['root-folder']},
                {'id':'video','name':'latest.mp4','mimeType':'video/mp4','parents':['root-folder'],'size':'200','modifiedTime':'2026-07-10T12:00:00Z'},
                {'id':'sheet','name':'Copy','mimeType':'application/vnd.google-apps.spreadsheet','parents':['root-folder']},
            ]}
        if "'nested' in parents" in params['q']:
            return {'files':[
                {'id':'image','name':'still.png','mimeType':'image/png','parents':['nested'],'size':'100','modifiedTime':'2026-07-09T12:00:00Z'},
                {'id':'blocked','name':'blocked.jpg','mimeType':'image/jpeg','parents':['nested'],'capabilities':{'canDownload':False}},
            ]}
        raise AssertionError(params['q'])

    monkeypatch.setattr(client, '_get_json', fake_get_json)
    files=client.list_creative_files()

    assert [file.file_id for file in files] == ['video', 'image']
    assert files[0].size == 200
    assert files[0].modified_time == '2026-07-10T12:00:00Z'

def test_drive_folder_browser_lists_only_direct_selectable_children_across_pages(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'
    list_calls=[]

    def fake_get_json(path, params):
        if path == '/files/root-folder':
            return {
                'id':'root-folder',
                'name':'Creative root',
                'mimeType':'application/vnd.google-apps.folder',
                'parents':[],
            }
        if path != '/files':
            raise AssertionError(path)
        list_calls.append(params.copy())
        assert params['q'] == "'root-folder' in parents and trashed = false"
        if params.get('pageToken') == 'next-page':
            return {'files':[
                {'id':'video','name':'A video.mp4','mimeType':'video/mp4','parents':['root-folder']},
            ]}
        return {
            'nextPageToken':'next-page',
            'files':[
                {'id':'image','name':'Z image.png','mimeType':'image/png','parents':['root-folder']},
                {'id':'nested','name':'Nested','mimeType':'application/vnd.google-apps.folder','parents':['root-folder']},
                {'id':'sheet','name':'Copy','mimeType':'application/vnd.google-apps.spreadsheet','parents':['root-folder']},
                {'id':'blocked','name':'Blocked.jpg','mimeType':'image/jpeg','parents':['root-folder'],'capabilities':{'canDownload':False}},
                {'id':'wrong-parent','name':'Elsewhere.mp4','mimeType':'video/mp4','parents':['other-folder']},
            ],
        }

    monkeypatch.setattr(client, '_get_json', fake_get_json)
    children=client.list_folder_children()

    assert [child.file_id for child in children] == ['nested', 'video', 'image']
    assert len(list_calls) == 2
    assert list_calls[1]['pageToken'] == 'next-page'

def test_drive_folder_browser_rejects_nonfolder_and_outside_root(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'

    def fake_get_json(path, params):
        if path == '/files/not-folder':
            return {'id':'not-folder','name':'creative.mp4','mimeType':'video/mp4','parents':['root-folder']}
        if path == '/files/outside-folder':
            return {'id':'outside-folder','name':'Outside','mimeType':'application/vnd.google-apps.folder','parents':['other-root']}
        if path == '/files/other-root':
            return {'id':'other-root','parents':[]}
        raise AssertionError(path)

    monkeypatch.setattr(client, '_get_json', fake_get_json)
    with pytest.raises(DriveLookupError, match='not a folder'):
        client.list_folder_children('not-folder')
    with pytest.raises(DriveLookupError, match='outside the configured Drive folder'):
        client.list_folder_children('outside-folder')

def test_drive_selection_expands_folders_and_deduplicates_exact_files(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'
    root=DriveFile('root-folder','Root','application/vnd.google-apps.folder',(), 'https://drive.google.com/root')
    nested=DriveFile('nested','Nested','application/vnd.google-apps.folder',('root-folder',), 'https://drive.google.com/nested')
    first=DriveFile('first','first.mp4','video/mp4',('root-folder','nested'), 'https://drive.google.com/first')
    second=DriveFile('second','second.png','image/png',('nested',), 'https://drive.google.com/second')
    blocked=DriveFile('blocked','blocked.jpg','image/jpeg',('root-folder',), 'https://drive.google.com/blocked', can_download=False)
    unsupported=DriveFile('copy','Copy','application/vnd.google-apps.spreadsheet',('root-folder',), 'https://drive.google.com/copy')
    files={file.file_id:file for file in (root,nested,first,second)}
    get_calls=[]
    list_calls=[]

    def fake_get_file(file_id, *, require_within_root=True):
        get_calls.append(file_id)
        return files[file_id]

    def fake_list_children(folder_id):
        list_calls.append(folder_id)
        if folder_id == 'root-folder':
            return [nested, first, blocked, unsupported]
        if folder_id == 'nested':
            return [first, second]
        raise AssertionError(folder_id)

    monkeypatch.setattr(client, 'get_file', fake_get_file)
    monkeypatch.setattr(client, '_list_direct_children', fake_list_children)
    resolved=client.resolve_selection(
        folder_ids=['root-folder','nested','root-folder'],
        file_ids=['first','first'],
    )

    assert [file.file_id for file in resolved] == ['first', 'second']
    assert get_calls == ['root-folder', 'nested', 'first']
    assert list_calls == ['root-folder', 'nested']

def test_drive_selection_rejects_wrong_item_kinds(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'
    folder=DriveFile('folder','Folder','application/vnd.google-apps.folder',('root-folder',), 'https://drive.google.com/folder')
    creative=DriveFile('creative','creative.mp4','video/mp4',('root-folder',), 'https://drive.google.com/creative')
    monkeypatch.setattr(client, 'get_file', lambda file_id: {'folder':folder,'creative':creative}[file_id])

    with pytest.raises(DriveLookupError, match='not a folder'):
        client.resolve_selection(folder_ids=['creative'])
    with pytest.raises(DriveLookupError, match='file is a folder'):
        client.resolve_selection(file_ids=['folder'])

def test_drive_selection_rejects_outside_root_folder(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'

    def fake_get_json(path, params):
        if path == '/files/outside-folder':
            return {'id':'outside-folder','name':'Outside','mimeType':'application/vnd.google-apps.folder','parents':['other-root']}
        if path == '/files/other-root':
            return {'id':'other-root','parents':[]}
        raise AssertionError(path)

    monkeypatch.setattr(client, '_get_json', fake_get_json)
    with pytest.raises(DriveLookupError, match='outside the configured Drive folder'):
        client.resolve_selection(folder_ids=['outside-folder'])

def test_drive_selection_enforces_one_hundred_creative_limit(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'
    root=DriveFile('root-folder','Root','application/vnd.google-apps.folder',(), 'https://drive.google.com/root')
    creatives=[
        DriveFile(
            f'creative-{index}',
            f'creative-{index}.mp4',
            'video/mp4',
            ('root-folder',),
            f'https://drive.google.com/creative-{index}',
        )
        for index in range(101)
    ]
    monkeypatch.setattr(client, 'get_file', lambda file_id: root)
    monkeypatch.setattr(client, '_list_direct_children', lambda folder_id: creatives)

    with pytest.raises(DriveLookupError, match='at most 100 creatives'):
        client.resolve_selection(folder_ids=['root-folder'])

def test_drive_selection_counts_only_creatives_within_upload_limit(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'
    root=DriveFile('root-folder','Root','application/vnd.google-apps.folder',(), 'https://drive.google.com/root')
    oversized=[
        DriveFile(
            f'oversized-{index}',
            f'oversized-{index}.mp4',
            'video/mp4',
            ('root-folder',),
            f'https://drive.google.com/oversized-{index}',
            size=101,
        )
        for index in range(101)
    ]
    eligible=DriveFile(
        'eligible',
        'eligible.mp4',
        'video/mp4',
        ('root-folder',),
        'https://drive.google.com/eligible',
        size=100,
    )
    monkeypatch.setattr(client, 'get_file', lambda file_id: root)
    monkeypatch.setattr(client, '_list_direct_children', lambda folder_id: [*oversized, eligible])

    resolved=client.resolve_selection(folder_ids=['root-folder'], max_file_size=100)

    assert [file.file_id for file in resolved] == ['eligible']

def test_drive_get_file_rejects_files_outside_root(monkeypatch):
    client=object.__new__(GoogleDriveClient)
    client.root_folder_id='root-folder'

    def fake_get_json(path, params):
        if path == '/files/outside':
            return {'id':'outside','name':'outside.mp4','mimeType':'video/mp4','parents':['other-root']}
        if path == '/files/other-root':
            return {'id':'other-root','parents':[]}
        raise AssertionError(path)

    monkeypatch.setattr(client, '_get_json', fake_get_json)
    with pytest.raises(DriveLookupError, match='outside the configured Drive folder'):
        client.get_file('outside')

@pytest.mark.anyio
async def test_drive_review_endpoint_enqueues_exact_selected_file(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    selected=DriveFile(
        'drive-file-id',
        'selected creative.mp4',
        'video/mp4',
        ('root-folder',),
        'https://drive.google.com/file/d/drive-file-id/view',
        123,
    )
    enqueued={}

    class FakeDrive:
        def get_file(self, file_id):
            assert file_id == 'drive-file-id'
            return selected

    async def fake_enqueue(job_id, media_path, media_kind, meta, file_name, file_size=None, drive_file=None):
        enqueued.update({
            'job_id':job_id,
            'media_path':media_path,
            'media_kind':media_kind,
            'ad_copy':meta.ad_copy,
            'file_name':file_name,
            'file_size':file_size,
            'drive_file':drive_file,
        })
        return set_status(job_id, JobStatus.queued, 0, 'Queued', file_name, file_size, has_ad_copy=meta.has_ad_copy)

    monkeypatch.setattr('app.main.get_google_drive_client', lambda: FakeDrive())
    monkeypatch.setattr('app.main.enqueue_job', fake_enqueue)
    transport=httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        response=await client.post('/api/drive/reviews', json={
            'file_id':'drive-file-id',
            'ad_copy':'Caption text',
            'model':'example/model',
            'frame_interval_seconds':1,
        })

    assert response.status_code == 200
    body=response.json()
    assert enqueued['drive_file'] == selected
    assert enqueued['media_kind'] == 'video'
    assert enqueued['ad_copy'] == 'Caption text'
    assert enqueued['media_path'].name == 'selected creative.mp4'
    assert body['source_file_id'] == 'drive-file-id'
    assert body['source_url'] == selected.web_view_link

class FakeDriveClient:
    def __init__(self, matches):
        self.matches=matches
        self.queries=[]

    def find_files_by_exact_name(self, file_name):
        self.queries.append(file_name)
        return self.matches

def test_copy_only_source_links_to_shared_spreadsheet(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.setenv('GOOGLE_AD_COPY_SHEET_URL', 'https://docs.google.com/spreadsheets/d/sheet-id/edit')
    set_status('copy1', JobStatus.complete, 100, 'Complete', 'Ad copy: Save today.', has_creative=False)

    source=resolve_review_sources('copy1').sources[0]

    assert source.status == 'linked'
    assert source.kind == 'google_sheet'
    assert source.url == 'https://docs.google.com/spreadsheets/d/sheet-id/edit'

def test_creative_source_uses_size_to_disambiguate_same_name(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('creative1', JobStatus.complete, 100, 'Complete', 'creative.mp4', file_size=200, has_ad_copy=False)
    drive=FakeDriveClient([
        DriveFile('first','creative.mp4','video/mp4',('root',),'https://drive.google.com/first',100),
        DriveFile('second','creative.mp4','video/mp4',('root',),'https://drive.google.com/second',200),
    ])

    source=resolve_review_sources('creative1', drive).sources[0]

    assert source.status == 'linked'
    assert source.file_id == 'second'
    assert source.url == 'https://drive.google.com/second'
    assert drive.queries == ['creative.mp4']

def test_creative_source_reports_missing_and_ambiguous_matches(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('missing', JobStatus.complete, 100, 'Complete', 'missing.mp4', has_ad_copy=False)
    set_status('ambiguous', JobStatus.complete, 100, 'Complete', 'duplicate.mp4', has_ad_copy=False)

    missing=resolve_review_sources('missing', FakeDriveClient([])).sources[0]
    ambiguous=resolve_review_sources('ambiguous', FakeDriveClient([
        DriveFile('one','duplicate.mp4','video/mp4',('root',),'https://drive.google.com/one'),
        DriveFile('two','duplicate.mp4','video/mp4',('root',),'https://drive.google.com/two'),
    ])).sources[0]

    assert missing.status == 'not_found'
    assert missing.url is None
    assert ambiguous.status == 'ambiguous'
    assert ambiguous.url is None

def test_creative_with_ad_copy_returns_drive_and_spreadsheet_links(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.setenv('GOOGLE_AD_COPY_SHEET_URL', 'https://docs.google.com/spreadsheets/d/sheet-id/edit')
    set_status('mixed', JobStatus.complete, 100, 'Complete', 'mixed.mp4', has_ad_copy=True)

    resolved=resolve_review_sources('mixed', FakeDriveClient([
        DriveFile('creative','mixed.mp4','video/mp4',('root',),'https://drive.google.com/creative'),
    ])).sources

    assert [source.kind for source in resolved] == ['google_drive_file', 'google_sheet']
    assert [source.status for source in resolved] == ['linked', 'linked']

def test_openrouter_json_repair_fallback():
    text='Here is JSON {"overall_status":"needs_review","summary":"x","findings":[],"safe_rewrite":{"ad_copy":"","onscreen_text":[]},"limitations":[]} done'
    assert parse_report_json(text).overall_status=='orange'

def test_openrouter_report_without_verdict_or_findings_fails_closed():
    report=parse_report_json(json.dumps({
        'summary':'The response omitted a verdict.',
        'findings':[],
        'limitations':{'unexpected':'shape'},
    }))
    assert report.overall_status=='orange'
    assert any('did not include a recognized explicit compliance verdict' in item for item in report.limitations)

def test_openrouter_report_maps_legacy_pass_to_green_without_findings():
    report=parse_report_json(json.dumps({
        'overall_status':'pass',
        'summary':'No policy issues were identified.',
        'findings':[],
    }))
    assert report.overall_status=='green'
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
    assert report.overall_status=='red'
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
    assert report.source_results.creative.status == 'green'
    assert report.source_results.ad_copy is not None
    assert report.source_results.ad_copy.status == 'orange'
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
    assert report.overall_status=='red'
    assert report.summary=='The ad includes a call prompt without consent language.'
    assert report.findings[0].policy_reason=='TCPA'

def test_default_guidelines_are_loaded_and_combined():
    guidelines=load_default_guidelines()
    assert 'General Publisher Ad Copy & Creative Guidelines' in guidelines
    assert 'No imagery of car wrecks' in guidelines
    policy_text, sources=build_policy_context('Extra rule.')
    assert 'Extra rule.' in policy_text
    assert sources == ['Saved General Publisher Ad Copy & Creative Guidelines', 'Additional pasted policy/guidelines']

def test_offer_profiles_persist_guidelines_and_offer_scoped_overrides(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')

    initial=list_offer_profiles()
    assert [profile.offer_id for profile in initial] == [
        'acp',
        'kissterra',
        'lead-economy',
        'smart-financial',
    ]
    assert initial[0].enabled and initial[0].configured
    assert all(not profile.enabled and not profile.configured for profile in initial[1:])
    saved=upsert_offer_profile('kissterra', OfferProfileInput(
        display_name='Kissterra',
        official_guidelines='Kissterra official policy.',
        internal_overrides=[OfferOverride(
            override_id='cash-imagery',
            title='Cash imagery exception',
            guidance='Cash may appear when it is incidental and not a guaranteed payout claim.',
            rationale='Approved internally for this offer.',
        )],
    ))

    assert saved.version == 1
    resolved=resolve_offer_profiles(['acp','kissterra'])
    assert [profile.offer_id for profile in resolved] == ['acp','kissterra']
    assert resolved[1].internal_overrides[0].override_id == 'cash-imagery'
    policy_text,_=build_policy_context('', resolved[1])
    assert 'Kissterra official policy.' in policy_text
    assert 'Cash may appear' not in policy_text
    assert build_internal_override_context(resolved[1])[0]['guidance'].startswith('Cash may appear')

    acp=upsert_offer_profile('acp', OfferProfileInput(
        display_name='ACP',
        official_guidelines='Updated ACP official policy.',
        internal_overrides=[],
        is_default=True,
    ))
    assert acp.version == 2
    assert get_offer_profile_revision('acp', 1).official_guidelines == load_default_guidelines()
    assert get_offer_profile_revision('acp', 2).official_guidelines == 'Updated ACP official policy.'


def test_review_eligibility_is_server_owned_and_snapshots_na_states(tmp_path, monkeypatch):
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    upsert_offer_profile('kissterra', OfferProfileInput(
        display_name='Kissterra',
        official_guidelines='Kissterra official policy.',
        enabled=True,
    ))

    meta=review_meta('', '', '', '', '', 1.0, False, '', '', ['acp'])
    assert [profile.offer_id for profile in meta.offer_profiles] == ['acp', 'kissterra']
    assert [outcome.evaluation_state for outcome in meta.offer_outcomes] == [
        'evaluated',
        'evaluated',
        'missing_guidelines',
        'missing_guidelines',
    ]

    disable_offer_profile('acp')
    assert [profile.offer_id for profile in resolve_active_offer_profiles()] == ['kissterra']
    acp_outcome=next(outcome for outcome in current_offer_outcomes() if outcome.offer_id == 'acp')
    assert acp_outcome.evaluation_state == 'disabled'


def test_disabled_offer_can_be_blank_but_enabled_offer_requires_guidelines():
    draft=OfferProfileInput(
        display_name='Lead Economy',
        official_guidelines='',
        enabled=False,
    )
    assert not draft.enabled
    with pytest.raises(ValueError, match='official guidelines'):
        OfferProfileInput(
            display_name='Lead Economy',
            official_guidelines='',
            enabled=True,
        )


def test_review_creation_is_blocked_when_every_offer_is_ineligible(tmp_path, monkeypatch):
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    disable_offer_profile('acp')
    with pytest.raises(HTTPException) as error:
        review_meta('', '', '', '', '', 1.0, False, '', '', ['acp'])
    assert getattr(error.value, 'status_code', None) == 409
    assert 'No offers are available' in str(getattr(error.value, 'detail', ''))


def test_review_automation_schedule_and_claims_are_durable_and_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(review_automation_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    payload=ReviewAutomationInput(
        name='Daily creative folder',
        enabled=False,
        folder_id='drive-folder-123',
        file_name_pattern='creative-{date}-*.png',
        time_of_day='16:30',
        timezone='America/Toronto',
        days_of_week=[3],
        include_subfolders=True,
    )
    automation=upsert_review_automation('daily-creatives', payload)
    assert not automation.enabled
    assert len(list_review_automations()) == 1

    current=datetime(2026, 7, 16, 21, 0, tzinfo=timezone.utc)
    assert due_schedule_key(automation, current) == '2026-07-16@16:30'
    assert rendered_file_pattern(automation, current.astimezone()) == 'creative-2026-07-16-*.png'

    run_id=claim_automation_run(automation, 'manual:test', allow_disabled=True)
    assert run_id
    assert claim_automation_run(automation, 'manual:test', allow_disabled=True) is None
    files=[{
        'file_id':'file-1',
        'file_name':'creative-2026-07-16-a.png',
        'modified_time':'2026-07-16T20:00:00Z',
    }]
    assert claim_automation_files(automation.automation_id, run_id, files) == files
    assert claim_automation_files(automation.automation_id, run_id, files) == []
    updated=finish_automation_run(
        run_id,
        automation.automation_id,
        status='queued',
        message='Queued one creative.',
        matched_count=1,
        queued_count=1,
        job_ids=['job-1'],
    )
    assert updated.last_run_status == 'queued'
    assert updated.last_run_message == 'Queued one creative.'


def test_failed_automation_schedule_retries_three_times(tmp_path, monkeypatch):
    monkeypatch.setattr(review_automation_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    automation=upsert_review_automation('retry-daily', ReviewAutomationInput(
        name='Retry daily',
        enabled=False,
        folder_id='folder',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=[0],
    ))

    run_ids=[]
    for _attempt in range(3):
        run_id=claim_automation_run(automation, '2026-07-20@09:00', allow_disabled=True)
        assert run_id
        run_ids.append(run_id)
        finish_automation_run(
            run_id,
            automation.automation_id,
            status='failed',
            message='Drive temporarily unavailable.',
            matched_count=0,
            queued_count=0,
        )

    assert len(set(run_ids)) == 3
    assert claim_automation_run(
        automation,
        '2026-07-20@09:00',
        allow_disabled=True,
    ) is None
    assert list_review_automations()[0].last_run_status == 'failed_exhausted'


def test_failed_automated_job_releases_its_file_claim(tmp_path, monkeypatch):
    monkeypatch.setattr(review_automation_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    automation=upsert_review_automation('release-failure', ReviewAutomationInput(
        name='Release failure',
        enabled=False,
        folder_id='folder',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=[0],
    ))
    first_run=claim_automation_run(automation, 'manual:first', allow_disabled=True)
    assert first_run
    file_claim={
        'file_id':'file-1',
        'file_name':'creative.png',
        'job_id':'job-1',
        'modified_time':'2026-07-16T20:00:00Z',
    }
    assert claim_automation_files(automation.automation_id, first_run, [file_claim])

    review_automation_storage.release_review_automation_claim(ReviewRequestMeta(
        automation_id=automation.automation_id,
        automation_run_id=first_run,
        automation_file_id='file-1',
        automation_file_modified_time='2026-07-16T20:00:00Z',
    ))
    finish_automation_run(
        first_run,
        automation.automation_id,
        status='failed',
        message='The first review failed.',
        matched_count=1,
        queued_count=0,
    )
    second_run=claim_automation_run(automation, 'manual:first', allow_disabled=True)
    assert second_run
    assert claim_automation_files(automation.automation_id, second_run, [file_claim])


def test_automation_file_claims_are_fenced_by_the_active_lease(tmp_path, monkeypatch):
    monkeypatch.setattr(review_automation_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    clock={'now':1_000}
    monkeypatch.setattr(review_automation_storage, 'now_ms', lambda: clock['now'])
    automation=upsert_review_automation('lease-fence', ReviewAutomationInput(
        name='Lease fence',
        enabled=False,
        folder_id='folder',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=[0],
    ))
    run_id=claim_automation_run(automation, '2026-07-20@09:00', allow_disabled=True)
    assert run_id
    clock['now'] += review_automation_storage.AUTOMATION_RUN_LEASE_MS + 1

    with pytest.raises(RuntimeError, match='lease is no longer active'):
        review_automation_storage.heartbeat_automation_run(automation.automation_id, run_id)
    with pytest.raises(RuntimeError, match='lease is no longer active'):
        claim_automation_files(automation.automation_id, run_id, [{
            'file_id':'file-1',
            'file_name':'creative.png',
            'modified_time':'v1',
        }])


def test_fast_automation_completion_closes_local_parent_run(tmp_path, monkeypatch):
    monkeypatch.setattr(review_automation_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    automation=upsert_review_automation('fast-job', ReviewAutomationInput(
        name='Fast job',
        enabled=False,
        folder_id='folder',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=[0],
    ))
    run_id=claim_automation_run(automation, 'manual:fast', allow_disabled=True)
    assert run_id
    claim_automation_files(automation.automation_id, run_id, [{
        'file_id':'file-1',
        'file_name':'creative.png',
        'job_id':'job-1',
        'modified_time':'v1',
    }])
    set_status('job-1', JobStatus.complete, 100, 'Complete', 'creative.png')
    meta=ReviewRequestMeta(
        automation_id=automation.automation_id,
        automation_run_id=run_id,
    )

    # A very fast worker can finish before the scan has attached job IDs to its parent.
    review_automation_storage.record_review_automation_job_result(meta, 'job-1')
    updated=finish_automation_run(
        run_id,
        automation.automation_id,
        status='queued',
        message='Queued one creative.',
        matched_count=1,
        queued_count=1,
        job_ids=['job-1'],
    )

    runs=review_storage.read_json(tmp_path/'settings'/'review_automation_runs.json')
    assert runs[0]['status'] == 'complete'
    assert runs[0]['message'] == 'All automated reviews completed.'
    assert updated.last_run_status == 'complete'


def test_partial_automation_waits_for_queued_jobs_before_retry(tmp_path, monkeypatch):
    monkeypatch.setattr(review_automation_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    automation=upsert_review_automation('partial-parent', ReviewAutomationInput(
        name='Partial parent',
        enabled=False,
        folder_id='folder',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=[0],
    ))
    schedule_key='2026-07-20@09:00'
    run_id=claim_automation_run(automation, schedule_key, allow_disabled=True)
    assert run_id
    claims=[
        {'file_id':'file-1', 'file_name':'one.png', 'job_id':'job-1', 'modified_time':'v1'},
        {'file_id':'file-2', 'file_name':'two.png', 'job_id':'job-2', 'modified_time':'v1'},
    ]
    assert len(claim_automation_files(automation.automation_id, run_id, claims)) == 2
    review_automation_storage.mark_automation_run_retry_required(
        automation.automation_id,
        run_id,
    )
    review_automation_storage.release_automation_files(
        automation.automation_id,
        run_id,
        [claims[1]],
    )
    finish_automation_run(
        run_id,
        automation.automation_id,
        status='queued',
        message='One queued; one will retry.',
        matched_count=2,
        queued_count=1,
        job_ids=['job-1'],
        retry_required=True,
    )

    assert claim_automation_run(automation, schedule_key, allow_disabled=True) is None
    set_status('job-1', JobStatus.complete, 100, 'Complete', 'one.png')
    review_automation_storage.record_review_automation_job_result(
        ReviewRequestMeta(
            automation_id=automation.automation_id,
            automation_run_id=run_id,
        ),
        'job-1',
    )
    assert list_review_automations()[0].last_run_status == 'failed'
    assert claim_automation_run(automation, schedule_key, allow_disabled=True)


@pytest.mark.anyio
async def test_partial_automation_enqueue_failure_stays_retryable(monkeypatch):
    automation=ReviewAutomation(
        automation_id='partial-enqueue',
        name='Partial enqueue',
        enabled=True,
        folder_id='folder',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=list(range(7)),
        created_at=0,
        updated_at=0,
    )
    files=[
        DriveFile('file-1', 'one.png', 'image/png', ('folder',), 'https://drive/one', 100),
        DriveFile('file-2', 'two.png', 'image/png', ('folder',), 'https://drive/two', 100),
    ]
    profile=OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Official rules',
        enabled=True,
        is_default=True,
        version=1,
        created_at=0,
        updated_at=0,
    )
    captured={}
    monkeypatch.setattr(review_automations, 'claim_automation_run', lambda *args, **kwargs: 'run-1')
    monkeypatch.setattr(review_automations, 'resolve_review_offer_snapshot', lambda: (
        [profile],
        [OfferOutcome(
            offer_id='acp',
            offer_name='ACP',
            evaluation_state='evaluated',
        )],
    ))
    monkeypatch.setattr(review_automations, '_matching_drive_files', lambda value, scheduled_for=None: files)
    monkeypatch.setattr(review_automations, 'heartbeat_automation_run', lambda *args: None)
    monkeypatch.setattr(review_automations, 'claim_automation_files', lambda _automation_id, _run_id, values: values)
    monkeypatch.setattr(review_automations, 'attach_automation_batch_items', lambda *args: None)
    monkeypatch.setattr(review_automations, 'create_batch', lambda *args: None)
    monkeypatch.setattr(review_automations, 'release_automation_files', lambda *args: None)
    retry_markers=[]
    monkeypatch.setattr(
        review_automations,
        'mark_automation_run_retry_required',
        lambda automation_id, run_id: retry_markers.append((automation_id, run_id)),
    )
    monkeypatch.setattr(review_automations, 'finish_batch_item_and_notify', lambda *args, **kwargs: None)

    async def fake_enqueue(_automation, drive_file, **kwargs):
        if drive_file.file_id == 'file-2':
            raise RuntimeError('queue unavailable')
        return kwargs['job_id']

    def fake_finish(_run_id, _automation_id, **kwargs):
        captured.update(kwargs)
        return automation

    monkeypatch.setattr(review_automations, '_enqueue_automation_file', fake_enqueue)
    monkeypatch.setattr(review_automations, 'finish_automation_run', fake_finish)

    result=await review_automations.run_review_automation(automation, manual=True)

    assert result.status == 'queued'
    assert result.queued_count == 1
    assert captured['status'] == 'queued'
    assert captured['retry_required'] is True
    assert retry_markers == [('partial-enqueue', 'run-1')]
    assert captured['job_ids'] and len(captured['job_ids']) == 1
    assert 'will be retried' in captured['message']


@pytest.mark.anyio
async def test_partial_automation_cleanup_failure_stays_recoverable(monkeypatch):
    automation=ReviewAutomation(
        automation_id='cleanup-failure',
        name='Cleanup failure',
        enabled=True,
        folder_id='folder',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=list(range(7)),
        created_at=0,
        updated_at=0,
    )
    files=[
        DriveFile('file-1', 'one.png', 'image/png', ('folder',), 'https://drive/one', 100),
        DriveFile('file-2', 'two.png', 'image/png', ('folder',), 'https://drive/two', 100),
    ]
    profile=OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Official rules',
        enabled=True,
        is_default=True,
        version=1,
        created_at=0,
        updated_at=0,
    )
    outcomes=[OfferOutcome(
        offer_id='acp',
        offer_name='ACP',
        evaluation_state='evaluated',
    )]
    captured={}
    released=[]
    created=[]
    monkeypatch.setattr(review_automations, 'claim_automation_run', lambda *args, **kwargs: 'run-1')
    monkeypatch.setattr(review_automations, 'resolve_review_offer_snapshot', lambda: ([profile], outcomes))
    monkeypatch.setattr(review_automations, '_matching_drive_files', lambda value, scheduled_for=None: files)
    monkeypatch.setattr(review_automations, 'heartbeat_automation_run', lambda *args: None)
    monkeypatch.setattr(review_automations, 'claim_automation_files', lambda _automation_id, _run_id, values: values)
    monkeypatch.setattr(review_automations, 'attach_automation_batch_items', lambda *args: None)
    monkeypatch.setattr(review_automations, 'create_batch', lambda *args: created.append(args))
    monkeypatch.setattr(review_automations, 'release_automation_files', lambda *args: released.append(args))
    monkeypatch.setattr(review_automations, 'mark_automation_run_retry_required', lambda *args: None)

    def fail_batch_cleanup(*args, **kwargs):
        raise RuntimeError('batch storage unavailable')

    async def fake_enqueue(_automation, drive_file, **kwargs):
        if drive_file.file_id == 'file-2':
            raise RuntimeError('queue unavailable')
        return kwargs['job_id']

    def fake_finish(_run_id, _automation_id, **kwargs):
        captured.update(kwargs)
        return automation

    monkeypatch.setattr(review_automations, 'finish_batch_item_and_notify', fail_batch_cleanup)
    monkeypatch.setattr(review_automations, '_enqueue_automation_file', fake_enqueue)
    monkeypatch.setattr(review_automations, 'finish_automation_run', fake_finish)

    result=await review_automations.run_review_automation(automation, manual=True)

    assert result.status == 'queued'
    assert result.queued_count == 1
    assert released == []
    assert captured['status'] == 'queued'
    assert captured['retry_required'] is True
    assert len(captured['job_ids']) == 2
    assert created[0][2] == outcomes


@pytest.mark.anyio
async def test_automation_batch_setup_ambiguity_retains_recovery_state(monkeypatch):
    automation=ReviewAutomation(
        automation_id='setup-ambiguity',
        name='Setup ambiguity',
        enabled=True,
        folder_id='folder',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=list(range(7)),
        created_at=0,
        updated_at=0,
    )
    drive_file=DriveFile(
        'file-1',
        'creative.png',
        'image/png',
        ('folder',),
        'https://drive/creative',
        100,
    )
    profile=OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Official rules',
        enabled=True,
        is_default=True,
        version=1,
        created_at=0,
        updated_at=0,
    )
    outcome=OfferOutcome(
        offer_id='acp',
        offer_name='ACP',
        evaluation_state='evaluated',
    )
    captured={}
    released=[]
    close_attempts=[]
    monkeypatch.setattr(review_automations, 'claim_automation_run', lambda *args, **kwargs: 'run-1')
    monkeypatch.setattr(review_automations, 'resolve_review_offer_snapshot', lambda: ([profile], [outcome]))
    monkeypatch.setattr(review_automations, '_matching_drive_files', lambda value, scheduled_for=None: [drive_file])
    monkeypatch.setattr(review_automations, 'heartbeat_automation_run', lambda *args: None)
    monkeypatch.setattr(review_automations, 'claim_automation_files', lambda _automation_id, _run_id, values: values)
    monkeypatch.setattr(review_automations, 'attach_automation_batch_items', lambda *args: None)
    monkeypatch.setattr(
        review_automations,
        'create_batch',
        lambda *args: (_ for _ in ()).throw(RuntimeError('response lost after commit')),
    )
    monkeypatch.setattr(review_automations, 'mark_automation_run_retry_required', lambda *args: None)
    monkeypatch.setattr(review_automations, 'release_automation_files', lambda *args: released.append(args))

    def fail_batch_cleanup(*args, **kwargs):
        close_attempts.append((args, kwargs))
        raise RuntimeError('batch write unavailable')

    def fake_finish(_run_id, _automation_id, **kwargs):
        captured.update(kwargs)
        return automation

    monkeypatch.setattr(review_automations, 'finish_batch_item_and_notify', fail_batch_cleanup)
    monkeypatch.setattr(review_automations, 'finish_automation_run', fake_finish)
    monkeypatch.setattr(
        review_automations,
        '_enqueue_automation_file',
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('enqueue must not run')),
    )

    result=await review_automations.run_review_automation(automation, manual=True)

    assert result.status == 'queued'
    assert result.queued_count == 0
    assert released == []
    assert len(close_attempts) == 1
    assert captured['retry_required'] is True
    assert len(captured['job_ids']) == 1


@pytest.mark.anyio
async def test_failed_automation_retries_its_original_schedule_and_pattern_date(monkeypatch):
    automation=ReviewAutomation(
        automation_id='original-schedule',
        name='Original schedule',
        enabled=True,
        folder_id='folder',
        file_name_pattern='creative-{date}.png',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=[0],
        last_run_status='failed',
        last_scheduled_for='2026-07-13@09:00',
        created_at=0,
        updated_at=0,
    )
    captured=[]

    async def fake_run(value, *, scheduled_for=None, **kwargs):
        captured.append((value.automation_id, scheduled_for))
        return scheduled_for

    monkeypatch.setattr(review_automations, 'list_review_automations', lambda **kwargs: [automation])
    monkeypatch.setattr(review_automations, 'run_review_automation', fake_run)

    results=await review_automations.run_due_review_automations()

    assert captured == [('original-schedule', '2026-07-13@09:00')]
    assert results == ['2026-07-13@09:00']
    scheduled_time=review_automations._scheduled_local_time(
        automation,
        automation.last_scheduled_for,
    )
    assert scheduled_time.strftime('%Y-%m-%d %H:%M %Z') == '2026-07-13 09:00 EDT'
    assert rendered_file_pattern(automation, scheduled_time) == 'creative-2026-07-13.png'


def test_notification_delivery_drains_claimed_batch_outbox(monkeypatch):
    monkeypatch.setattr(review_storage, 'CONVEX_URL', 'https://convex.example')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', 'secret')
    batch={
        'batch_id':'recovered-batch',
        'created_at':1,
        'updated_at':2,
        'expected_count':1,
        'notification_status':'claimed',
        'items':[{
            'file_name':'creative.png',
            'item_id':'item-1',
            'media_kind':'image',
            'message':'Interrupted',
            'offer_outcomes':[],
            'status':'failed',
        }],
    }
    claimed=[batch, None]

    def fake_convex_call(kind, path, args):
        if path == 'automations:recoverInterrupted':
            return {'processed':0}
        if path == 'batches:claimNotification':
            return claimed.pop(0)
        raise AssertionError(path)

    sent=[]
    marked=[]
    monkeypatch.setattr(review_automation_storage, '_convex_call', fake_convex_call)
    monkeypatch.setattr(review_telegram, 'send_batch_message', lambda value: sent.append(value) or True)
    monkeypatch.setattr(review_storage, 'mark_batch_notification', lambda batch_id, success: marked.append((batch_id, success)))

    assert review_automation_storage.recover_interrupted_automation_jobs() == 0
    assert review_automation_storage.deliver_pending_batch_notifications(limit=1) == 1
    assert [value.batch_id for value in sent] == ['recovered-batch']
    assert marked == [('recovered-batch', True)]


def test_automation_filters_large_folder_before_match_limit(monkeypatch):
    folder=DriveFile(
        file_id='folder',
        name='Creative archive',
        mime_type='application/vnd.google-apps.folder',
        parents=('root',),
        web_view_link='https://drive.example/folder',
    )
    children=[
        DriveFile(
            file_id=f'archive-{index}',
            name=f'archive-{index}.png',
            mime_type='image/png',
            parents=('folder',),
            web_view_link=f'https://drive.example/archive-{index}',
            size=100,
        )
        for index in range(150)
    ]
    children.append(DriveFile(
        file_id='target',
        name='today.png',
        mime_type='image/png',
        parents=('folder',),
        web_view_link='https://drive.example/target',
        size=100,
    ))

    class LargeFolderDrive:
        def get_file(self, file_id):
            assert file_id == 'folder'
            return folder

        def list_folder_children(self, file_id):
            assert file_id == 'folder'
            return children

    monkeypatch.setattr(review_automations, 'get_google_drive_client', lambda: LargeFolderDrive())
    automation=ReviewAutomation(
        automation_id='large-folder',
        name='Large folder',
        enabled=True,
        folder_id='folder',
        file_name_pattern='today.png',
        time_of_day='09:00',
        timezone='America/Toronto',
        days_of_week=list(range(7)),
        include_subfolders=True,
        created_at=0,
        updated_at=0,
    )

    matches=review_automations._matching_drive_files(automation)

    assert [match.file_id for match in matches] == ['target']

def test_offer_profile_and_report_size_guards_run_before_persistence(tmp_path, monkeypatch):
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    monkeypatch.setattr(review_storage, 'MAX_OFFER_PROFILE_BYTES', 100)

    with pytest.raises(ValueError, match='too large to save'):
        upsert_offer_profile('large-offer', OfferProfileInput(
            display_name='Large offer',
            official_guidelines='x' * 90,
        ))

    monkeypatch.setattr(review_storage, 'MAX_REPORT_RESULT_BYTES', 100)
    with pytest.raises(ValueError, match='too large to save'):
        set_report('large-report', {
            'overall_status':'red',
            'summary':'x' * 120,
            'findings':[],
        })
    assert not (tmp_path/'large-report'/'report.json').exists()

def test_openrouter_report_preserves_internal_override_annotation():
    report=parse_report_json(json.dumps({
        'overall_status':'red',
        'summary':'Official policy issue with an internal exception.',
        'findings':[{
            'severity':'high',
            'source':'visual',
            'evidence':'Visible cash.',
            'policy_reason':'Official guidance restricts money imagery.',
            'suggested_fix':'Remove the cash.',
            'confidence':'high',
            'internal_override':{
                'override_id':'cash-imagery',
                'title':'Cash imagery exception',
                'disposition':'accepted',
                'rationale':'Incidental only.',
            },
        }],
    }))

    assert report.overall_status == 'red'
    assert report.findings[0].policy_reason.startswith('Official guidance')
    assert report.findings[0].internal_override is not None
    assert report.findings[0].internal_override.override_id == 'cash-imagery'


def offer_with_cash_override()->OfferProfile:
    return OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Official ACP policy prohibits money imagery.',
        internal_overrides=[OfferOverride(
            override_id='cash-imagery',
            title='Cash imagery exception',
            guidance='Cash may appear when incidental and not tied to a guaranteed payout.',
            rationale='Approved operationally for ACP.',
        )],
    )


def red_cash_report()->ComplianceReport:
    return ComplianceReport.model_validate({
        'overall_status':'red',
        'summary':'Money imagery violates official policy.',
        'findings':[{
            'severity':'high',
            'source':'visual',
            'evidence':'Visible cash beside the offer.',
            'policy_reason':'Official ACP policy prohibits money imagery.',
            'suggested_fix':'Remove the cash.',
            'confidence':'high',
        }],
    })


@pytest.mark.anyio
async def test_two_pass_override_annotation_cannot_change_official_red_finding(monkeypatch):
    profile=offer_with_cash_override()
    official_calls=[]
    override_calls=[]

    async def fake_official_review(evidence, model):
        official_calls.append(evidence)
        assert 'internal_overrides' not in evidence
        return red_cash_report()

    async def fake_override_review(context, model):
        override_calls.append(context)
        return OverrideAnnotationSet.model_validate({
            'annotations':[{
                'finding_index':0,
                'internal_override':{
                    'override_id':'cash-imagery',
                    'title':'Model-provided title is ignored',
                    'disposition':'accepted',
                    'rationale':'The image is incidental and does not promise a payout.',
                },
            }],
        })

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', fake_official_review)
    monkeypatch.setattr(review_jobs, 'review_internal_overrides_with_openrouter', fake_override_review)
    result=await review_jobs._review_offer(
        profile,
        'image',
        ReviewRequestMeta(),
        {'source':'not_applicable','chunks':[]},
        [],
        [],
        {'source':'openrouter_vision','observations':[]},
        'Evidence note.',
    )

    assert len(official_calls) == 1 and len(override_calls) == 1
    assert override_calls[0]['internal_overrides'][0]['override_id'] == 'cash-imagery'
    assert result.overall_status == 'red'
    assert len(result.findings) == 1
    assert result.findings[0].severity == 'high'
    assert result.findings[0].evidence == 'Visible cash beside the offer.'
    assert result.findings[0].policy_reason == 'Official ACP policy prohibits money imagery.'
    assert result.findings[0].internal_override is not None
    assert result.findings[0].internal_override.override_id == 'cash-imagery'
    assert result.findings[0].internal_override.title == 'Cash imagery exception'
    assert result.internal_disposition == 'accepted_with_override'


@pytest.mark.anyio
async def test_two_pass_override_annotation_removes_unknown_override_ids(monkeypatch):
    async def fake_official_review(evidence, model):
        return red_cash_report()

    async def fake_override_review(context, model):
        return OverrideAnnotationSet.model_validate({
            'annotations':[{
                'finding_index':0,
                'internal_override':{
                    'override_id':'invented-exception',
                    'disposition':'accepted',
                    'rationale':'Not actually configured.',
                },
            }],
        })

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', fake_official_review)
    monkeypatch.setattr(review_jobs, 'review_internal_overrides_with_openrouter', fake_override_review)
    result=await review_jobs._review_offer(
        offer_with_cash_override(),
        'image',
        ReviewRequestMeta(),
        {'source':'not_applicable','chunks':[]},
        [],
        [],
        {'source':'openrouter_vision','observations':[]},
        'Evidence note.',
    )

    assert result.overall_status == 'red'
    assert result.findings[0].internal_override is None
    assert result.internal_disposition == 'action_required'
    assert any('invented-exception' in limitation for limitation in result.limitations)


@pytest.mark.anyio
async def test_offer_review_error_is_orange_and_requires_human_review(monkeypatch):
    async def failing_official_review(evidence, model):
        raise RuntimeError('upstream unavailable')

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', failing_official_review)
    result=await review_jobs._review_offer(
        offer_with_cash_override(),
        'copy_only',
        ReviewRequestMeta(ad_copy='Save today.'),
        {'source':'not_applicable','chunks':[]},
        [],
        [],
        {'source':'not_applicable','observations':[]},
        'No creative submitted.',
    )

    assert result.overall_status == 'orange'
    assert result.findings == []
    assert result.internal_disposition == 'human_review'

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
    assert history[0].overall_status=='green'
    assert [outcome.offer_id for outcome in history[0].offer_outcomes] == [
        'acp',
        'kissterra',
        'lead-economy',
        'smart-financial',
    ]
    assert history[0].offer_outcomes[0].overall_status == 'green'
    assert all(
        outcome.overall_status is None
        for outcome in history[0].offer_outcomes[1:]
    )
    assert history[0].created_at is not None

def test_in_progress_history_has_no_false_na_offer_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status(
        'active-review',
        JobStatus.reviewing_with_llm,
        90,
        'Reviewing with LLM',
        'creative.mp4',
        offer_ids=['acp', 'kissterra'],
        primary_offer_id='acp',
    )

    history=list_reviews()

    assert history[0].offer_ids == ['acp', 'kissterra']
    assert history[0].offer_outcomes == []

def test_review_stats_are_offer_aware_and_keep_override_counts_separate(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status(
        'multi-offer',
        JobStatus.queued,
        0,
        'Queued',
        'creative.png',
        offer_ids=['acp','kissterra'],
        primary_offer_id='acp',
    )
    set_report('multi-offer', {
        'schema_version':2,
        'primary_offer_id':'acp',
        'overall_status':'red',
        'summary':'ACP issue.',
        'offer_results':[
            {
                'offer_id':'acp',
                'offer_name':'ACP',
                'overall_status':'red',
                'summary':'ACP issue.',
                'internal_disposition':'accepted_with_override',
                'findings':[],
                'safe_rewrite':{},
                'limitations':[],
            },
            {
                'offer_id':'kissterra',
                'offer_name':'Kissterra',
                'overall_status':'green',
                'summary':'Clear.',
                'internal_disposition':'clear',
                'findings':[],
                'safe_rewrite':{},
                'limitations':[],
            },
        ],
    })
    set_status('multi-offer', JobStatus.complete, 100, 'Complete')

    acp=get_review_stats('acp')
    kissterra=get_review_stats('kissterra')
    assert acp.total_reviews == 1 and acp.outcomes.red == 1
    assert acp.accepted_overrides == 1
    assert kissterra.total_reviews == 1 and kissterra.outcomes.green == 1
    assert kissterra.accepted_overrides == 0

def test_delete_review_tombstones_history_report_and_stats(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('delete-me', JobStatus.queued, 0, 'Queued', 'test.png')
    set_report('delete-me', {'overall_status':'green','summary':'Clear.','findings':[]})
    set_status('delete-me', JobStatus.complete, 100, 'Complete')

    deleted=delete_review('delete-me')
    assert deleted.job_id == 'delete-me'
    assert (tmp_path/'delete-me'/'deleted.json').exists()
    assert list_reviews() == []
    assert get_report('delete-me') is None
    assert get_review_stats('acp').total_reviews == 0
    with pytest.raises(FileNotFoundError):
        get_status('delete-me')

def test_review_history_pages_through_all_local_jobs(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    for index in range(5):
        set_status(f'j{index}', JobStatus.queued, 0, 'Queued', f'creative-{index}.mp4')

    first=list_reviews_page(limit=2)
    second=list_reviews_page(limit=2, cursor=first.next_cursor)
    third=list_reviews_page(limit=2, cursor=second.next_cursor)

    assert len(first.reviews)==2 and first.has_more
    assert len(second.reviews)==2 and second.has_more
    assert len(third.reviews)==1 and not third.has_more
    assert len({item.job_id for page in (first, second, third) for item in page.reviews})==5

@pytest.mark.anyio
async def test_full_history_api_returns_cursor_page(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    for index in range(3):
        set_status(f'j{index}', JobStatus.queued, 0, 'Queued', f'creative-{index}.mp4')

    transport=httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        response=await client.get('/api/reviews/history?limit=2')

    assert response.status_code == 200
    assert len(response.json()['reviews']) == 2
    assert response.json()['has_more']
    assert response.json()['next_cursor'] == '2'

@pytest.mark.anyio
async def test_review_delete_api_rejects_active_then_removes_terminal_job(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.setenv('ADMIN_PASSWORD', 'test-admin-password')
    job_id='a' * 32
    set_status(job_id, JobStatus.queued, 0, 'Queued', 'test.png')
    transport=httpx.ASGITransport(app=app)
    headers={'x-admin-password':'test-admin-password'}
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        active=await client.delete(f'/api/reviews/{job_id}', headers=headers)
        set_report(job_id, {'overall_status':'green','summary':'Clear.','findings':[]})
        set_status(job_id, JobStatus.complete, 100, 'Complete')
        removed=await client.delete(f'/api/reviews/{job_id}', headers=headers)
        status=await client.get(f'/api/reviews/{job_id}')
        stats=await client.get('/api/reviews/stats?offer_id=acp')

    assert active.status_code == 409
    assert removed.status_code == 200
    assert removed.json()['job_id'] == job_id
    assert status.status_code == 404
    assert stats.json()['total_reviews'] == 0

@pytest.mark.anyio
async def test_offer_admin_routes_require_password_and_catalog_is_sanitized(tmp_path, monkeypatch):
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    monkeypatch.delenv('ADMIN_PASSWORD', raising=False)
    transport=httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        unavailable=await client.get('/api/offers')
        catalog=await client.get('/api/offers/catalog')
        monkeypatch.setenv('ADMIN_PASSWORD', 'test-admin-password')
        unauthorized=await client.get('/api/offers')
        authorized=await client.get(
            '/api/offers',
            headers={'x-admin-password':'test-admin-password'},
        )

    assert unavailable.status_code == 503
    assert catalog.status_code == 200
    assert [offer['offer_id'] for offer in catalog.json()['offers']] == [
        'acp',
        'kissterra',
        'lead-economy',
        'smart-financial',
    ]
    assert catalog.json()['offers'][0]['configured'] is True
    assert catalog.json()['offers'][1]['configured'] is False
    assert 'official_guidelines' not in catalog.json()['offers'][0]
    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert authorized.json()['offers'][0]['official_guidelines']

def test_review_history_splits_creative_and_ad_copy_results(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('j1', JobStatus.queued, 0, 'Queued', 'creative.mp4', has_ad_copy=True)
    set_report('j1', {
        'overall_status':'red',
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
    assert history[0].creative_result=='red'
    assert history[0].ad_copy_result=='orange'

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
    assert history[0].creative_result=='orange'
    assert history[0].ad_copy_result is None

def test_review_history_maps_low_severity_findings_to_yellow(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status('j1', JobStatus.queued, 0, 'Queued', 'creative.png', has_ad_copy=False)
    set_report('j1', {
        'overall_status':'yellow',
        'summary':'minor edit recommended',
        'findings':[{
            'severity':'low',
            'source':'onscreen_text',
            'evidence':'Small readability issue',
            'policy_reason':'Disclosure should be easier to read',
            'suggested_fix':'Increase the disclosure size.',
            'confidence':'high',
        }],
    })
    set_status('j1', JobStatus.complete, 100, 'Complete')
    history=list_reviews()
    assert history[0].creative_result=='yellow'

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
    assert report['overall_status'] == 'orange'
    assert report['internal_disposition'] == 'human_review'
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
async def test_queue_downloads_drive_file_before_processing(tmp_path, monkeypatch):
    destination=tmp_path/'job'/'creative.mp4'
    drive_file=DriveFile(
        'drive-id',
        'creative.mp4',
        'video/mp4',
        ('root',),
        'https://drive.google.com/file/d/drive-id/view',
        8,
    )
    statuses=[]

    class FakeDrive:
        def download_file(self, file, path, *, max_bytes, progress_callback):
            assert file == drive_file
            assert max_bytes == 200 * 1024 * 1024
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'creative')
            progress_callback(8, 8)
            return 8

    monkeypatch.setattr(review_queue, 'get_google_drive_client', lambda: FakeDrive())
    monkeypatch.setattr(review_queue, 'set_status', lambda *args, **kwargs: statuses.append(args))
    monkeypatch.setenv('MAX_UPLOAD_MB', '200')
    job=review_queue.QueuedReviewJob(
        'job-id',
        destination,
        'video',
        ReviewRequestMeta(),
        drive_file,
    )

    await review_queue._download_drive_file(job)

    assert destination.read_bytes() == b'creative'
    assert statuses[0][1] == JobStatus.downloading_from_drive
    assert statuses[-1][2] == 9


@pytest.mark.anyio
async def test_automated_job_heartbeat_starts_while_waiting_in_queue(monkeypatch):
    queue=asyncio.Queue()
    started=asyncio.Event()
    hold=asyncio.Event()
    monkeypatch.setattr(review_queue, '_queue', queue)
    monkeypatch.setattr(review_queue, '_automation_heartbeat_jobs', {})
    monkeypatch.setattr(review_queue, '_automation_heartbeat_ref_counts', {})
    monkeypatch.setattr(review_queue, '_automation_heartbeat_tasks', {})
    monkeypatch.setattr(review_queue, 'set_status', lambda *args, **kwargs: None)

    async def fake_heartbeat(meta):
        started.set()
        await hold.wait()

    monkeypatch.setattr(review_queue, '_keep_automation_lease_alive', fake_heartbeat)
    meta=ReviewRequestMeta(
        ad_copy='Queued creative',
        automation_id='daily',
        automation_run_id='run-1',
    )

    await review_queue.enqueue_job(
        'job-1',
        None,
        'copy_only',
        meta,
        'Ad copy',
    )
    await asyncio.wait_for(started.wait(), timeout=1)

    assert queue.qsize() == 1
    assert review_queue._automation_heartbeat_ref_counts[('daily', 'run-1')] == 1
    await review_queue._release_automation_heartbeat('job-1')

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
        'overall_status':'red',
        'summary':'overall mixed result',
        'source_results':{
            'creative':{'status':'green','summary':'Creative is clear.'},
            'ad_copy':{'status':'orange','summary':'Caption needs substantiation.'},
        },
        'findings':[],
    })
    set_status('j1', JobStatus.complete, 100, 'Complete')
    history=list_reviews()
    assert history[0].creative_result=='green'
    assert history[0].ad_copy_result=='orange'

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
        'overall_status':'red',
        'summary':'overall mixed result',
        'source_results':{
            'creative':{
                'status':'green',
                'summary':'Creative surfaces are clear and do not contain restricted visual claims.',
            },
            'ad_copy':{
                'status':'red',
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
    assert '🟢 Green — Ready to run' in message
    assert '🔴 Red — Do not publish' in message
    assert '<b>Report Link:</b>' in message
    assert 'Open report' in message
    assert '<b>Findings</b>' not in message
    assert '<b>Summary</b>' not in message
    assert 'Ad copy: Save $600 this month' in message
    assert 'Unsupported guaranteed savings claim' not in message
    assert 'Caption includes a guaranteed' not in message
    assert message.count('/reviews/abc123/report') == 1
    assert message.index('<b>ACP:</b>') < message.index('<b>Kissterra:</b>')
    assert message.index('<b>Kissterra:</b>') < message.index('<b>Lead Economy:</b>')
    assert message.index('<b>Lead Economy:</b>') < message.index('<b>Smart Financial:</b>')
    assert message.count('N/A — Not reviewed') == 3

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
    assert '🟢 Green — Ready to run' in message
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
        'overall_status':'orange',
        'source_results':{
            'creative':{'status':'orange','summary':'Image needs review.'},
        },
        'findings':[],
    }, media_kind='image')
    assert '<b>Type:</b> Creative Image' in message
    assert 'static-ad.png' in message
    assert '🟠 Orange — Review required' in message

def test_batch_notification_waits_for_all_items_and_sends_once(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.setenv('APP_PUBLIC_URL', 'https://vibe-check.thatcanadian.dev')
    sent=[]
    monkeypatch.setattr(review_telegram, 'send_batch_message', lambda batch: sent.append(batch) or True)

    create_batch('batch1', [
        CreateBatchItem(item_id='item1', file_name='creative-one.mp4', media_kind='video'),
        CreateBatchItem(item_id='item2', file_name='creative-two.png', media_kind='image'),
        CreateBatchItem(item_id='item3', file_name='Ad copy 1: Save today.', media_kind='copy_only'),
    ])

    finish_batch_item_and_notify('batch1', 'item1', status='complete', job_id='job1', result='red', message='Complete')
    finish_batch_item_and_notify('batch1', 'item2', status='upload_failed', message='Network upload failed')
    assert sent == []

    finish_batch_item_and_notify('batch1', 'item3', status='complete', job_id='job3', result='green', message='Complete')
    assert len(sent) == 1
    assert get_batch('batch1').notification_status == 'sent'

    finish_batch_item_and_notify('batch1', 'item3', status='complete', job_id='job3', result='green', message='Complete')
    assert len(sent) == 1

    message=build_batch_message(sent[0])
    assert '<b>Batch Uploaded ' in message
    assert '<b>Type:</b> Creative Vid' in message
    assert '<b>Type:</b> Creative Image' in message
    assert '<b>Type:</b> Ad copy' in message
    assert 'creative-one.mp4' in message
    assert '🔴 Red — Do not publish' in message
    assert '⚫ Failed — Review did not complete' in message
    assert 'Network upload failed' in message
    assert '🟢 Green — Ready to run' in message
    assert message.count('/batches/batch1') == 1
    assert message.count('<b>Report Link:</b>') == 1


def test_batch_persists_and_formats_per_offer_outcomes(tmp_path, monkeypatch):
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    monkeypatch.setenv('APP_PUBLIC_URL', 'https://vibe-check.thatcanadian.dev')
    create_batch('multi-results', [
        CreateBatchItem(item_id='item1', file_name='creative.png', media_kind='image'),
        CreateBatchItem(item_id='item2', file_name='failed.png', media_kind='image'),
    ])
    outcomes=[
        OfferOutcome(
            offer_id='acp',
            offer_name='ACP',
            evaluation_state='evaluated',
            overall_status='green',
        ),
        OfferOutcome(
            offer_id='kissterra',
            offer_name='Kissterra',
            evaluation_state='disabled',
        ),
        OfferOutcome(
            offer_id='lead-economy',
            offer_name='Lead Economy',
            evaluation_state='missing_guidelines',
        ),
        OfferOutcome(
            offer_id='smart-financial',
            offer_name='Smart Financial',
            evaluation_state='missing_guidelines',
        ),
    ]
    finish_batch_item_and_notify(
        'multi-results',
        'item1',
        status='complete',
        job_id='missing-report',
        result='green',
        offer_outcomes=outcomes,
        message='Complete',
    )
    batch=finish_batch_item_and_notify(
        'multi-results',
        'item2',
        status='upload_failed',
        message='Import failed',
    )
    assert [outcome.offer_id for outcome in batch.items[0].offer_outcomes] == [
        'acp',
        'kissterra',
        'lead-economy',
        'smart-financial',
    ]
    message=build_batch_message(batch)
    assert '🟢 Green — Ready to run' in message
    assert 'N/A — Turned off' in message
    assert message.count('N/A — Guidelines not saved') == 2
    assert 'Import failed' in message


def test_batch_telegram_loads_report_when_ready_snapshot_has_no_verdict(tmp_path, monkeypatch):
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    create_batch('outbox-result', [
        CreateBatchItem(item_id='item1', file_name='creative.png', media_kind='image'),
    ])
    batch=get_batch('outbox-result')
    batch.items[0].status='complete'
    batch.items[0].job_id='job-1'
    batch.items[0].offer_outcomes=[OfferOutcome(
        offer_id='acp',
        offer_name='ACP',
        evaluation_state='disabled',
    )]
    monkeypatch.setattr(review_telegram, '_load_batch_item_report', lambda job_id: {
        'schema_version':2,
        'primary_offer_id':'acp',
        'offer_results':[
            {'offer_id':'acp', 'offer_name':'ACP', 'overall_status':'green'},
        ],
    })

    message=build_batch_message(batch)

    assert '<b>ACP:</b> 🟢 Green — Ready to run' in message


def test_batch_telegram_bulk_hydrates_offer_summaries_once(tmp_path, monkeypatch):
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(review_storage, 'CONVEX_URL', '')
    monkeypatch.setattr(review_storage, 'CONVEX_HTTP_SECRET', '')
    create_batch('bulk-summary', [
        CreateBatchItem(item_id='item1', file_name='creative.png', media_kind='image'),
    ])
    batch=get_batch('bulk-summary')
    batch.items[0].status='complete'
    batch.items[0].job_id='job-1'
    batch.items[0].offer_outcomes=[OfferOutcome(
        offer_id='acp',
        offer_name='ACP',
        evaluation_state='disabled',
        message='Offer was turned off when this review started.',
    )]
    lookups=[]
    sent=[]

    def fake_summaries(job_ids):
        lookups.append(job_ids)
        return {
            'job-1':{
                'offer_results':[
                    {'offer_id':'acp', 'overall_status':'green'},
                ],
            },
        }

    monkeypatch.setattr(review_storage, 'get_batch_offer_summaries', fake_summaries)
    monkeypatch.setattr(
        review_telegram,
        '_load_batch_item_report',
        lambda *args: (_ for _ in ()).throw(AssertionError('per-item report lookup must not run')),
    )
    monkeypatch.setattr(
        review_telegram,
        '_send_telegram_message',
        lambda message, context: sent.append((message, context)) or True,
    )

    assert review_telegram.send_batch_message(batch)
    assert lookups == [['job-1']]
    assert len(sent) == 1
    assert '<b>ACP:</b> 🟢 Green — Ready to run' in sent[0][0]


def test_telegram_429_uses_response_retry_after():
    request=httpx.Request('POST', 'https://api.telegram.org/bot-token/sendMessage')
    response=httpx.Response(
        429,
        request=request,
        json={'ok':False, 'parameters':{'retry_after':30}},
    )
    error=httpx.HTTPStatusError('Too many requests', request=request, response=response)

    assert review_telegram._telegram_retry_delay(error, 1) == 30

def test_batched_jobs_suppress_individual_messages_until_last_job(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)
    individual_messages=[]
    batch_messages=[]
    monkeypatch.setattr('app.review_pipeline.jobs.send_review_message', lambda *args: individual_messages.append(args))
    monkeypatch.setattr(review_telegram, 'send_batch_message', lambda batch: batch_messages.append(batch) or True)
    create_batch('batch2', [
        CreateBatchItem(item_id='item1', file_name='Ad copy 1', media_kind='copy_only'),
        CreateBatchItem(item_id='item2', file_name='Ad copy 2', media_kind='copy_only'),
    ])
    metas=[
        ReviewRequestMeta(ad_copy='First copy', batch_id='batch2', batch_item_id='item1'),
        ReviewRequestMeta(ad_copy='Second copy', batch_id='batch2', batch_item_id='item2'),
    ]
    for index, meta in enumerate(metas, start=1):
        set_status(
            f'job{index}',
            JobStatus.queued,
            0,
            'Queued',
            f'Ad copy {index}',
            has_ad_copy=True,
            has_creative=False,
            batch_id=meta.batch_id,
            batch_item_id=meta.batch_item_id,
        )

    asyncio.run(process_job('job1', None, 'copy_only', metas[0]))
    assert individual_messages == []
    assert batch_messages == []

    asyncio.run(process_job('job2', None, 'copy_only', metas[1]))
    assert individual_messages == []
    assert len(batch_messages) == 1
    assert [item.status for item in batch_messages[0].items] == ['complete', 'complete']

@pytest.mark.anyio
async def test_batch_api_registers_pending_uploads_before_reviews_start(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    batch_id='a' * 32
    item_ids=['b' * 32, 'c' * 32]
    transport=httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        created=await client.post('/api/batches', json={
            'batch_id':batch_id,
            'items':[
                {'item_id':item_ids[0], 'file_name':'one.mp4', 'media_kind':'video'},
                {'item_id':item_ids[1], 'file_name':'two.mp4', 'media_kind':'video'},
            ],
        })
        failed=await client.post(
            f'/api/batches/{batch_id}/items/{item_ids[0]}/failed',
            json={'message':'Upload connection lost'},
        )
        fetched=await client.get(f'/api/batches/{batch_id}')

    assert created.status_code == 200
    assert [item['status'] for item in created.json()['items']] == ['pending', 'pending']
    assert failed.status_code == 200
    assert [item['status'] for item in failed.json()['items']] == ['upload_failed', 'pending']
    assert fetched.status_code == 200
    assert fetched.json()['expected_count'] == 2

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
