import json
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app.main import app, copy_review_file_name, review_meta
from app.review_pipeline import automation_storage as review_automation_storage
from app.review_pipeline import automations as review_automations
from app.review_pipeline import jobs as review_jobs
from app.review_pipeline import live_scan_storage
from app.review_pipeline import llm as review_llm
from app.review_pipeline import queue as review_queue
from app.review_pipeline import recovery as review_recovery
from app.review_pipeline import storage as review_storage
from app.review_pipeline import telegram as review_telegram
from app.review_pipeline.models import ComplianceReport, CreateBatchItem, JobRecord, JobStatus, OfferOutcome, OfferOverride, OfferProfile, OfferProfileInput, ReviewAutomation, ReviewAutomationInput, ReviewRequestMeta
from app.review_pipeline.automations import due_schedule_key, rendered_file_pattern
from app.review_pipeline.audio import extract_audio_command, transcribe
from app.review_pipeline.drive import DriveFile, DriveLookupError, GoogleDriveClient, escape_drive_query_value
from app.review_pipeline.guidelines import build_internal_override_context, build_policy_context, load_default_guidelines
from app.review_pipeline.jobs import build_review_evidence, process_job
from app.review_pipeline.llm import ComplianceResponseError, parse_report_json, parse_strict_report_json
from app.review_pipeline.live_scan_storage import exact_creative_key, normalize_primary_text, primary_text_key
from app.review_pipeline.media import detect_media_kind, prepare_image_frame
from app.review_pipeline.policy_seeds import seeded_offer_inputs
from app.review_pipeline.ocr import normalize_text, dedupe_ocr
from app.review_pipeline.storage import create_batch, current_offer_outcomes, delete_review, disable_offer_profile, get_batch, get_offer_profile_revision, get_review_stats, list_offer_profiles, resolve_active_offer_profiles, resolve_offer_profiles, set_status, get_status, set_report, get_report, list_reviews, list_reviews_page, upsert_offer_profile
from app.review_pipeline.automation_storage import claim_automation_files, claim_automation_run, finish_automation_run, list_review_automations, upsert_review_automation
from app.review_pipeline.source_links import resolve_review_sources
from app.review_pipeline.telegram import build_batch_message, build_live_scan_message, build_review_message, finish_batch_item_and_notify, send_review_message
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
    assert evidence['internal_overrides'] == []

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

def strict_report_payload(
    *,
    overall_status='green',
    findings=None,
):
    return {
        'overall_status':overall_status,
        'summary':'No policy issues were identified.' if overall_status == 'green' else 'Policy issue identified.',
        'source_results':{
            'creative':None,
            'ad_copy':None,
        },
        'findings':findings or [],
        'applied_overrides':[],
        'safe_rewrite':{
            'ad_copy':'',
            'onscreen_text':[],
        },
        'limitations':[],
    }


def test_legacy_openrouter_json_repair_fallback():
    text='Here is JSON {"overall_status":"needs_review","summary":"x","findings":[],"safe_rewrite":{"ad_copy":"","onscreen_text":[]},"limitations":[]} done'
    assert parse_report_json(text).overall_status=='orange'


def test_legacy_openrouter_report_without_verdict_or_findings_fails_closed():
    report=parse_report_json(json.dumps({
        'summary':'The response omitted a verdict.',
        'findings':[],
        'limitations':{'unexpected':'shape'},
    }))
    assert report.overall_status=='orange'
    assert any('did not include a recognized explicit compliance verdict' in item for item in report.limitations)


def test_strict_openrouter_report_requires_complete_schema():
    with pytest.raises(ComplianceResponseError, match='invalid structured result'):
        parse_strict_report_json(json.dumps({
            'summary':'The response omitted a verdict.',
            'findings':[],
        }))


@pytest.mark.parametrize(
    ('overall_status','severity'),
    [
        ('yellow','low'),
        ('orange','medium'),
        ('red','high'),
    ],
)
def test_strict_openrouter_report_requires_findings_for_non_green_verdicts(
    overall_status,
    severity,
):
    with pytest.raises(ComplianceResponseError, match='overall_status must be'):
        parse_strict_report_json(json.dumps(strict_report_payload(
            overall_status=overall_status,
        )))

    report=parse_strict_report_json(json.dumps(strict_report_payload(
        overall_status=overall_status,
        findings=[{
            'severity':severity,
            'source':'policy',
            'timestamp_start':None,
            'timestamp_end':None,
            'evidence':'Observed policy concern.',
            'policy_reason':'The supplied guideline requires review.',
            'suggested_fix':'Revise the claim.',
            'confidence':'high',
        }],
    )))
    assert report.overall_status == overall_status
    assert len(report.findings) == 1


def test_strict_openrouter_report_accepts_green_with_no_findings():
    report=parse_strict_report_json(json.dumps(strict_report_payload()))
    assert report.overall_status == 'green'
    assert report.findings == []


def test_strict_openrouter_report_accepts_green_with_applied_override():
    payload=strict_report_payload()
    payload['applied_overrides']=[{
        'override_id':'cash-imagery',
        'title':'Cash imagery context',
        'source':'visual',
        'evidence':'Cash appears in an unrelated act of assistance.',
        'rationale':'The current rule permits money imagery when it is unrelated to the insurance offer.',
    }]
    report=parse_strict_report_json(json.dumps(payload))
    assert report.overall_status == 'green'
    assert report.applied_overrides[0].override_id == 'cash-imagery'


@pytest.mark.anyio
async def test_openrouter_uses_strict_schema_on_first_request_and_retries_semantic_mismatch(
    monkeypatch,
):
    calls=[]
    responses=[
        strict_report_payload(overall_status='orange'),
        strict_report_payload(
            overall_status='yellow',
            findings=[{
                'severity':'low',
                'source':'ad_copy',
                'timestamp_start':None,
                'timestamp_end':None,
                'evidence':'A minor wording concern.',
                'policy_reason':'The wording could be clearer.',
                'suggested_fix':'Use more precise wording.',
                'confidence':'medium',
            }],
        ),
    ]

    class FakeResponse:
        def __init__(self, payload):
            self.payload=payload

        def raise_for_status(self):
            return None

        def json(self):
            return {
                'choices':[{
                    'message':{
                        'content':json.dumps(self.payload),
                    },
                }],
            }

    class FakeAsyncClient:
        def __init__(self, timeout):
            assert timeout == 120

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers, json):
            calls.append({
                'url':url,
                'headers':headers,
                'json':json,
            })
            return FakeResponse(responses.pop(0))

    monkeypatch.setenv('OPENROUTER_API_KEY', 'test-key')
    monkeypatch.setattr(review_llm.httpx, 'AsyncClient', FakeAsyncClient)

    report=await review_llm.review_with_openrouter({'offer':{'offer_id':'acp'}})

    assert report.overall_status == 'yellow'
    assert len(calls) == 2
    initial=calls[0]['json']
    assert initial['response_format']['type'] == 'json_schema'
    assert initial['response_format']['json_schema']['strict'] is True
    assert initial['response_format']['json_schema']['schema']['additionalProperties'] is False
    assert initial['provider'] == {'require_parameters':True}
    assert initial['plugins'] == [{'id':'response-healing'}]
    assert len(initial['messages']) == 2
    assert len(calls[1]['json']['messages']) == 4
    assert 'Green must have zero findings' in calls[1]['json']['messages'][-1]['content']


@pytest.mark.anyio
async def test_openrouter_raises_after_invalid_structured_results(monkeypatch):
    calls=[]

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                'choices':[{
                    'message':{
                        'content':json.dumps(strict_report_payload(overall_status='orange')),
                    },
                }],
            }

    class FakeAsyncClient:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers, json):
            calls.append(json)
            return FakeResponse()

    monkeypatch.setenv('OPENROUTER_API_KEY', 'test-key')
    monkeypatch.setattr(review_llm.httpx, 'AsyncClient', FakeAsyncClient)

    with pytest.raises(ComplianceResponseError, match='No policy color was assigned'):
        await review_llm.review_with_openrouter({'offer':{'offer_id':'acp'}})
    assert len(calls) == 2


@pytest.mark.anyio
async def test_openrouter_requires_api_key_instead_of_returning_placeholder(monkeypatch):
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)

    with pytest.raises(RuntimeError, match='OPENROUTER_API_KEY'):
        await review_llm.review_with_openrouter({'offer':{'offer_id':'acp'}})


@pytest.mark.anyio
async def test_openrouter_request_has_hard_wall_clock_deadline(monkeypatch):
    class FakeAsyncClient:
        def __init__(self, timeout):
            assert timeout == 120

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers, json):
            await asyncio.Event().wait()

    monkeypatch.setenv('OPENROUTER_API_KEY', 'test-key')
    monkeypatch.setattr(review_llm.httpx, 'AsyncClient', FakeAsyncClient)
    monkeypatch.setattr(review_llm, '_request_deadline_seconds', lambda: 0.01)

    with pytest.raises(TimeoutError):
        await review_llm.review_with_openrouter({'offer':{'offer_id':'acp'}})


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


def test_seeded_offer_policies_cover_every_live_offer_with_current_rules():
    profiles=seeded_offer_inputs()
    assert list(profiles) == ['acp','kissterra','lead-economy','smart-financial']
    assert profiles['acp'].is_default
    assert all(profile.enabled and profile.official_guidelines for profile in profiles.values())
    assert all(profile.internal_overrides for profile in profiles.values())
    for profile in profiles.values():
        override_ids=[override.override_id for override in profile.internal_overrides]
        assert len(override_ids) == len(set(override_ids))
        assert all('supersedes the original' in override.rationale for override in profile.internal_overrides)
    assert '$19/month' in next(
        override.guidance
        for override in profiles['acp'].internal_overrides
        if override.override_id == 'savings-discounts-and-pricing'
    )
    assert '$31/month' in next(
        override.guidance
        for override in profiles['lead-economy'].internal_overrides
        if override.override_id == 'discounts-and-rate-claims'
    )
    assert 'Auto $39' in next(
        override.guidance
        for override in profiles['smart-financial'].internal_overrides
        if override.override_id == 'discounts-and-rate-claims'
    )
    kissterra_agent_rule = next(
        override.guidance
        for override in profiles['kissterra'].internal_overrides
        if override.override_id == 'urgency-and-agent-sentiment'
    )
    assert 'words “agent” and “agents” are prohibited' in kissterra_agent_rule
    assert '“skip the agent” with wording' in kissterra_agent_rule
    assert 'Convenience framing and non-commission complaints are allowed' not in kissterra_agent_rule
    assert all(
        'compliances_guidelines_2026-08-06.pdf' in override.rationale
        for profile in profiles.values()
        for override in profile.internal_overrides
    )

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


@pytest.mark.anyio
async def test_effective_policy_review_returns_green_with_valid_override(monkeypatch):
    profile=offer_with_cash_override()
    review_calls=[]

    async def fake_effective_review(evidence, model):
        review_calls.append(evidence)
        assert evidence['internal_overrides'][0]['override_id'] == 'cash-imagery'
        return ComplianceReport.model_validate({
            'overall_status':'green',
            'summary':'Ready under the current internal rule.',
            'source_results':{
                'creative':{'status':'green','summary':'The cash is incidental.'},
                'ad_copy':None,
            },
            'findings':[],
            'applied_overrides':[{
                'override_id':'cash-imagery',
                'title':'Model-provided title is ignored',
                'source':'visual',
                'evidence':'Visible cash appears in an unrelated scene.',
                'rationale':'The image is incidental and does not promise a payout.',
            }],
        })

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', fake_effective_review)
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

    assert len(review_calls) == 1
    assert result.overall_status == 'green'
    assert result.findings == []
    assert result.applied_overrides[0].override_id == 'cash-imagery'
    assert result.applied_overrides[0].title == 'Cash imagery exception'
    assert result.internal_disposition == 'accepted_with_override'
    outcomes=review_jobs._completed_offer_outcomes(
        ReviewRequestMeta(offer_outcomes=[OfferOutcome(
            offer_id='acp',
            offer_name='ACP',
            evaluation_state='evaluated',
        )]),
        [result],
    )
    assert outcomes[0].overall_status == 'green'
    assert outcomes[0].with_override


@pytest.mark.anyio
async def test_effective_policy_review_removes_unknown_override_ids(monkeypatch):
    async def fake_effective_review(evidence, model):
        return ComplianceReport.model_validate({
            'overall_status':'green',
            'summary':'Model claimed an unknown exception.',
            'findings':[],
            'applied_overrides':[{
                'override_id':'invented-exception',
                'title':'Invented exception',
                'source':'visual',
                'evidence':'Visible cash.',
                'rationale':'Not actually configured.',
            }],
        })

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', fake_effective_review)
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

    assert result.overall_status == 'orange'
    assert result.applied_overrides == []
    assert result.internal_disposition == 'human_review'
    assert result.findings[0].policy_reason.startswith('Only enabled overrides')
    assert any('invented-exception' in limitation for limitation in result.limitations)


@pytest.mark.anyio
async def test_offer_review_error_propagates_without_fake_policy_result(monkeypatch):
    async def failing_official_review(evidence, model):
        raise RuntimeError('upstream unavailable')

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', failing_official_review)
    with pytest.raises(RuntimeError, match='upstream unavailable'):
        await review_jobs._review_offer(
            offer_with_cash_override(),
            'copy_only',
            ReviewRequestMeta(ad_copy='Save today.'),
            {'source':'not_applicable','chunks':[]},
            [],
            [],
            {'source':'not_applicable','observations':[]},
            'No creative submitted.',
        )

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
    combined=get_review_stats(['acp','kissterra'])
    assert acp.total_reviews == 1 and acp.outcomes.red == 1
    assert acp.accepted_overrides == 1
    assert kissterra.total_reviews == 1 and kissterra.outcomes.green == 1
    assert kissterra.accepted_overrides == 0
    assert combined.offer_id == 'all'
    assert combined.offer_ids == ['acp','kissterra']
    assert combined.total_reviews == 1 and combined.completed_reviews == 1
    assert combined.outcomes.red == 1 and combined.outcomes.green == 1
    assert combined.accepted_overrides == 1

@pytest.mark.anyio
async def test_review_stats_api_accepts_multiple_offer_filters(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')
    set_status(
        'multi-offer-api',
        JobStatus.queued,
        0,
        'Queued',
        'creative.png',
        offer_ids=['acp','kissterra'],
        primary_offer_id='acp',
    )
    set_report('multi-offer-api', {
        'schema_version':2,
        'primary_offer_id':'acp',
        'overall_status':'orange',
        'summary':'Review needed.',
        'offer_results':[
            {'offer_id':'acp','overall_status':'orange','internal_disposition':'none'},
            {'offer_id':'kissterra','overall_status':'green','internal_disposition':'clear'},
        ],
    })
    set_status('multi-offer-api', JobStatus.complete, 100, 'Complete')

    transport=httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        response=await client.get('/api/reviews/stats?offer_ids=acp,kissterra')

    assert response.status_code == 200
    assert response.json()['offer_ids'] == ['acp','kissterra']
    assert response.json()['total_reviews'] == 1
    assert response.json()['outcomes'] == {'green':1,'yellow':0,'orange':1,'red':0}

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
    async def green_review(evidence, model):
        return ComplianceReport(
            overall_status='green',
            summary='No policy issues were identified.',
            source_results={
                'creative':None,
                'ad_copy':{
                    'status':'green',
                    'summary':'No policy issues were identified in the submitted ad copy.',
                },
            },
            findings=[],
        )

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', green_review)
    asyncio.run(process_job('j1', None, 'copy_only', ReviewRequestMeta(ad_copy='Save today.')))
    status=get_status('j1')
    report=get_report('j1')
    assert status.status == JobStatus.complete
    assert status.report_ready
    assert not status.has_creative
    assert report is not None
    assert report['overall_status'] == 'green'
    assert report['internal_disposition'] == 'clear'
    assert 'No creative was submitted' in report['limitations'][-1]


def test_process_job_fails_without_publishing_invalid_policy_result(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_URL', '')
    monkeypatch.setattr('app.review_pipeline.storage.CONVEX_HTTP_SECRET', '')

    async def invalid_review(evidence, model):
        raise ComplianceResponseError('The policy reviewer returned an invalid structured result.')

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', invalid_review)
    asyncio.run(process_job('invalid-result', None, 'copy_only', ReviewRequestMeta(ad_copy='Save today.')))

    status=get_status('invalid-result')
    assert status.status == JobStatus.failed
    assert not status.report_ready
    assert get_report('invalid-result') is None


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
async def test_health_endpoint_reports_safe_queue_diagnostics(monkeypatch):
    monkeypatch.setattr(
        'app.main.queue_state',
        lambda: {
            'active':2,
            'failure_count':1,
            'last_error_type':'RuntimeError',
            'pending':3,
            'workers':4,
        },
    )
    transport=httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        response=await client.get('/api/health')

    assert response.status_code == 200
    assert response.json() == {
        'status':'ok',
        'queue':{
            'active':2,
            'failure_count':1,
            'last_error_type':'RuntimeError',
            'pending':3,
            'workers':4,
        },
    }


@pytest.mark.anyio
async def test_enqueue_persists_manual_payload_before_marking_job_queued(monkeypatch):
    queue=asyncio.Queue()
    events=[]
    monkeypatch.setattr(review_queue, '_queue', queue)

    async def fake_persist(*args):
        events.append('persist')

    def fake_set_status(*args, **kwargs):
        events.append('status')
        return SimpleNamespace(status=JobStatus.queued)

    monkeypatch.setattr(review_queue, 'persist_job_payload', fake_persist)
    monkeypatch.setattr(review_queue, 'set_status', fake_set_status)

    await review_queue.enqueue_job(
        'durable-job',
        None,
        'copy_only',
        ReviewRequestMeta(ad_copy='Durable copy'),
        'Ad copy',
    )

    assert events == ['persist', 'status']
    assert (await queue.get()).job_id == 'durable-job'


def test_manual_payload_persists_manifest_and_media(tmp_path, monkeypatch):
    media_path=tmp_path/'creative.mp4'
    media_path.write_bytes(b'video-content')
    uploads=[]
    convex_calls=[]

    def fake_upload(value, content_type):
        uploads.append((value, content_type))
        return f'storage-{len(uploads)}'

    def fake_convex_call(kind, path, args):
        convex_calls.append((kind, path, args))
        return {'jobId':'durable-job'}

    monkeypatch.setattr(review_recovery.storage, 'convex_enabled', lambda: True)
    monkeypatch.setattr(review_recovery, '_upload_blob', fake_upload)
    monkeypatch.setattr(review_recovery.storage, '_convex_call', fake_convex_call)

    review_recovery._persist_job_payload_sync(
        'durable-job',
        media_path,
        'video',
        ReviewRequestMeta(ad_copy='Caption'),
        media_path.name,
        media_path.stat().st_size,
        None,
    )

    manifest=json.loads(uploads[0][0])
    assert manifest['job_id'] == 'durable-job'
    assert manifest['meta']['ad_copy'] == 'Caption'
    assert uploads[1] == (media_path, 'application/octet-stream')
    assert convex_calls[-1] == (
        'mutation',
        'reviewPayloads:save',
        {
            'jobId':'durable-job',
            'manifestStorageId':'storage-1',
            'mediaStorageId':'storage-2',
        },
    )


@pytest.mark.anyio
async def test_recovery_manifests_load_concurrently(monkeypatch):
    active=0
    max_active=0
    started=asyncio.Event()
    release=asyncio.Event()

    class FakeResponse:
        def __init__(self, job_id):
            self.job_id=job_id

        def raise_for_status(self):
            return None

        def json(self):
            return {
                'version':review_recovery.PAYLOAD_VERSION,
                'job_id':self.job_id,
                'file_name':f'{self.job_id}.mp4',
                'file_size':12,
                'media_kind':'video',
                'meta':{'ad_copy':'Caption'},
            }

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url):
            nonlocal active, max_active
            active += 1
            max_active=max(max_active, active)
            if active == 3:
                started.set()
            await release.wait()
            active -= 1
            return FakeResponse(url.rsplit('/', 1)[-1])

    monkeypatch.setattr(
        review_recovery,
        '_list_payload_rows_sync',
        lambda job_ids: [
            {
                'jobId':job_id,
                'manifestUrl':f'https://example.test/{job_id}',
                'mediaUrl':f'https://example.test/media/{job_id}',
            }
            for job_id in job_ids
        ],
    )
    monkeypatch.setattr(review_recovery.httpx, 'AsyncClient', FakeClient)

    load=asyncio.create_task(
        review_recovery.load_recovery_payloads(['job-1', 'job-2', 'job-3'])
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    release.set()
    recovered=await load

    assert max_active == 3
    assert set(recovered) == {'job-1', 'job-2', 'job-3'}


@pytest.mark.anyio
async def test_recovery_manifest_batch_has_one_bounded_deadline(monkeypatch):
    cancelled=0

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url):
            nonlocal cancelled
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled += 1
                raise

    monkeypatch.setattr(
        review_recovery,
        '_list_payload_rows_sync',
        lambda job_ids: [
            {'jobId':job_id, 'manifestUrl':f'https://example.test/{job_id}'}
            for job_id in job_ids
        ],
    )
    monkeypatch.setattr(review_recovery.httpx, 'AsyncClient', FakeClient)
    monkeypatch.setattr(review_recovery, 'MANIFEST_BATCH_DEADLINE_SECONDS', 0.01)

    recovered=await asyncio.wait_for(
        review_recovery.load_recovery_payloads([f'job-{index}' for index in range(12)]),
        timeout=0.5,
    )

    assert recovered == {}
    assert cancelled == review_recovery.MANIFEST_DOWNLOAD_CONCURRENCY


@pytest.mark.anyio
async def test_startup_recovery_requeues_durable_jobs_and_fails_missing_jobs(
    tmp_path,
    monkeypatch,
):
    recovered=review_recovery.RecoveredReviewPayload(
        job_id='recoverable',
        file_name='creative.mp4',
        file_size=12,
        media_kind='video',
        meta=ReviewRequestMeta(ad_copy='Caption'),
        media_url='https://example.test/creative',
    )
    enqueued=[]
    failed=[]
    monkeypatch.setattr(review_storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(
        review_queue,
        'list_interrupted_reviews',
        lambda: [
            review_recovery.InterruptedReview(
                job_id=job_id,
                file_name='creative.mp4',
                file_size=12,
                source_kind=None,
                source_file_id=None,
                source_url=None,
                batch_id=None,
                batch_item_id=None,
                offer_ids=('acp',),
                has_ad_copy=False,
            )
            for job_id in ('recoverable', 'missing')
        ],
    )

    async def fake_load(job_ids):
        assert job_ids == ['recoverable', 'missing']
        return {'recoverable':recovered}

    async def fake_enqueue(*args, **kwargs):
        enqueued.append((args, kwargs))

    def fake_fail(job_ids):
        failed.extend(job_ids)
        return job_ids

    monkeypatch.setattr(review_queue, 'load_recovery_payloads', fake_load)
    monkeypatch.setattr(review_queue, 'enqueue_job', fake_enqueue)
    monkeypatch.setattr(review_queue, 'fail_unrecoverable_jobs', fake_fail)

    result=await review_queue.recover_interrupted_jobs()

    assert result == {'failed':1, 'requeued':1}
    assert failed == ['missing']
    assert enqueued[0][0][0] == 'recoverable'
    assert enqueued[0][1] == {
        'file_size':12,
        'drive_file':None,
        'persist_payload':False,
        'recovery_payload':recovered,
    }
    assert (tmp_path/'recoverable'/'request.json').exists()


def test_startup_recovery_reconstructs_google_drive_job_without_saved_payload(
    monkeypatch,
):
    profile=OfferProfile(
        offer_id='acp',
        display_name='ACP',
        official_guidelines='Policy',
        enabled=True,
        is_default=True,
    )
    outcome=OfferOutcome(
        offer_id='acp',
        offer_name='ACP',
        evaluation_state='evaluated',
        message='Evaluated using the saved official guidelines.',
    )
    monkeypatch.setattr(
        review_recovery.storage,
        'resolve_review_offer_snapshot',
        lambda: ([profile], [outcome]),
    )
    review=review_recovery.InterruptedReview(
        job_id='drive-job',
        file_name='creative.mp4',
        file_size=42,
        source_kind='google_drive_file',
        source_file_id='drive-file',
        source_url='https://drive.google.com/file/d/drive-file/view',
        batch_id='batch',
        batch_item_id='item',
        offer_ids=('acp',),
        has_ad_copy=False,
    )

    payload=review_recovery.reconstruct_drive_payloads([review])['drive-job']

    assert payload.media_kind == 'video'
    assert payload.drive_file is not None
    assert payload.drive_file.file_id == 'drive-file'
    assert payload.meta.batch_id == 'batch'
    assert payload.meta.offer_ids == ['acp']


@pytest.mark.anyio
async def test_periodic_recovery_reconciles_an_idle_queue(monkeypatch):
    recovered=asyncio.Event()
    monkeypatch.setattr(
        review_queue,
        'queue_state',
        lambda: {'active':0, 'pending':0, 'workers':4},
    )

    async def fake_recover():
        recovered.set()
        return {'failed':0, 'requeued':1}

    monkeypatch.setattr(review_queue, 'recover_interrupted_jobs', fake_recover)
    monitor=asyncio.create_task(review_queue.monitor_interrupted_jobs(0.01))
    try:
        await asyncio.wait_for(recovered.wait(), timeout=1)
    finally:
        monitor.cancel()
        with pytest.raises(asyncio.CancelledError):
            await monitor


@pytest.mark.anyio
async def test_scheduled_recovery_requeues_and_drains_an_idle_queue(monkeypatch):
    queue=asyncio.Queue()
    monkeypatch.setattr(review_queue, '_queue', queue)
    monkeypatch.setattr(review_queue, '_drain_lock', asyncio.Lock())

    async def fake_recover():
        await queue.put('recovered-job')
        return {'failed':0, 'requeued':1}

    async def finish_recovered_job():
        assert await queue.get() == 'recovered-job'
        queue.task_done()

    monkeypatch.setattr(review_queue, 'recover_interrupted_jobs', fake_recover)
    worker=asyncio.create_task(finish_recovered_job())
    result=await review_queue.recover_and_drain_review_queue(timeout_seconds=1)
    await worker

    assert result['drained'] is True
    assert result['already_draining'] is False
    assert result['recovered'] == {'failed':0, 'requeued':1}
    assert result['queue']['pending'] == 0


@pytest.mark.anyio
async def test_internal_review_recovery_requires_secret_and_drains(monkeypatch):
    monkeypatch.setenv('CONVEX_HTTP_SECRET', 'recovery-secret')

    async def fake_drain():
        return {
            'drained':True,
            'queue':{'active':0, 'pending':0, 'workers':4},
            'recovered':{'failed':0, 'requeued':2},
        }

    monkeypatch.setattr('app.main.recover_and_drain_review_queue', fake_drain)
    transport=httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        unauthorized=await client.post('/api/internal/review-recovery')
        response=await client.post(
            '/api/internal/review-recovery',
            headers={'x-automation-secret':'recovery-secret'},
        )

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.json()['recovered']['requeued'] == 2

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
            assert max_bytes == 400 * 1024 * 1024
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'creative')
            progress_callback(8, 8)
            return 8

    monkeypatch.setattr(review_queue, 'get_google_drive_client', lambda: FakeDrive())
    monkeypatch.setattr(review_queue, 'set_status', lambda *args, **kwargs: statuses.append(args))
    monkeypatch.setenv('MAX_UPLOAD_MB', '400')
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


@pytest.mark.anyio
async def test_queue_hard_timeout_fails_job_and_releases_worker(monkeypatch):
    queue=asyncio.Queue()
    status_calls=[]
    deleted=[]
    monkeypatch.setattr(review_queue, '_queue', queue)
    monkeypatch.setattr(review_queue, '_active_jobs', set())
    monkeypatch.setattr(review_queue, '_job_timeout_seconds', lambda: 0.01)

    def fake_set_status(job_id, status, progress, message=''):
        status_calls.append((job_id, status, progress, message))

    async def blocked_process_job(*args):
        await asyncio.Event().wait()

    async def fake_delete(job_id):
        deleted.append(job_id)

    monkeypatch.setattr(review_queue, 'set_status', fake_set_status)
    monkeypatch.setattr(review_queue, 'process_job', blocked_process_job)
    monkeypatch.setattr(review_queue, 'delete_job_payload', fake_delete)

    await queue.put(review_queue.QueuedReviewJob(
        'timed-out',
        None,
        'copy_only',
        ReviewRequestMeta(ad_copy='Copy'),
    ))
    worker=asyncio.create_task(review_queue._process_queue(0))
    try:
        await asyncio.wait_for(queue.join(), timeout=1)
    finally:
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker

    assert status_calls[-1][:3] == ('timed-out', JobStatus.failed, 100)
    assert status_calls[-1][3].startswith('Queue processing timed out after ')
    assert deleted == ['timed-out']
    assert not review_queue._active_jobs

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
    ], source_label='Q3 Growth & Retargeting')

    finish_batch_item_and_notify('batch1', 'item1', status='complete', job_id='job1', result='red', message='Complete')
    finish_batch_item_and_notify('batch1', 'item2', status='upload_failed', message='Network upload failed')
    assert sent == []

    finish_batch_item_and_notify('batch1', 'item3', status='complete', job_id='job3', result='green', message='Complete')
    assert len(sent) == 1
    stored_batch=get_batch('batch1')
    assert stored_batch.notification_status == 'sent'
    assert stored_batch.source_label == 'Q3 Growth & Retargeting'

    finish_batch_item_and_notify('batch1', 'item3', status='complete', job_id='job3', result='green', message='Complete')
    assert len(sent) == 1

    message=build_batch_message(sent[0])
    assert '<b>Batch Uploaded ' in message
    assert '<b>Google Drive source:</b>' in message
    assert 'Q3 Growth &amp; Retargeting' in message
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
    individual_messages=[]
    batch_messages=[]
    async def green_review(evidence, model):
        return ComplianceReport(
            overall_status='green',
            summary='No policy issues were identified.',
            source_results={
                'creative':None,
                'ad_copy':{
                    'status':'green',
                    'summary':'No policy issues were identified in the submitted ad copy.',
                },
            },
            findings=[],
        )

    monkeypatch.setattr(review_jobs, 'review_with_openrouter', green_review)
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
            'source_label':'Summer campaign',
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
    assert created.json()['source_label'] == 'Summer campaign'
    assert [item['status'] for item in created.json()['items']] == ['pending', 'pending']
    assert failed.status_code == 200
    assert [item['status'] for item in failed.json()['items']] == ['upload_failed', 'pending']
    assert fetched.status_code == 200
    assert fetched.json()['expected_count'] == 2
    assert fetched.json()['source_label'] == 'Summer campaign'

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


def test_live_scan_keys_preserve_exact_creative_names_and_keep_copy_variants_separate():
    assert exact_creative_key(' Folder/Winning_CREATIVE-01.MP4 ') == ' Folder/Winning_CREATIVE-01.MP4 '
    assert exact_creative_key('winning creative 01.mov') == 'winning creative 01.mov'
    assert exact_creative_key('Winning Creative') != exact_creative_key('winning creative')
    first=normalize_primary_text(' Save   up to 20%. ')
    second=normalize_primary_text('Save up to 30%.')
    assert first == 'Save up to 20%.'
    assert primary_text_key(first) == primary_text_key('Save up to 20%.')
    assert primary_text_key(first) != primary_text_key(second)


def test_live_scan_claims_reuse_reviewed_name_and_do_not_duplicate_copy_job(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(live_scan_storage,'JOB_DATA_DIR',tmp_path)
    monkeypatch.setattr(live_scan_storage,'_convex_call',lambda *args,**kwargs:None)
    monkeypatch.setattr(live_scan_storage,'convex_enabled',lambda:False)
    historical=SimpleNamespace(
        file_name='Winning Creative.mov',
        has_creative=True,
        job_id='historical-job',
        overall_status='green',
        report_ready=True,
        status=JobStatus.complete,
    )
    monkeypatch.setattr(live_scan_storage,'list_reviews',lambda limit:[historical])
    def fake_status(job_id):
        if job_id == 'historical-job':
            return SimpleNamespace(message='',progress=100,status=JobStatus.complete)
        raise FileNotFoundError(job_id)
    monkeypatch.setattr(live_scan_storage,'get_status',fake_status)

    creative=live_scan_storage.claim_live_review(
        'creative',
        exact_creative_key('Winning Creative.mov'),
        'Winning Creative.mov',
        start_review=False,
    )
    assert creative['job_id'] == 'historical-job'
    assert creative['result'] == 'green'
    assert creative['should_submit'] is False

    different_name=live_scan_storage.claim_live_review(
        'creative',
        exact_creative_key('winning creative.mov'),
        'winning creative.mov',
        start_review=False,
    )
    assert different_name['status'] == 'waiting_media'
    assert different_name['job_id'] != 'historical-job'

    copy_key=primary_text_key('Save today.')
    first=live_scan_storage.claim_live_review(
        'copy',
        copy_key,
        'Save today.',
        start_review=True,
    )
    second=live_scan_storage.claim_live_review(
        'copy',
        copy_key,
        'Save today.',
        start_review=True,
    )
    assert first['should_submit'] is True
    assert second['should_submit'] is False
    assert first['job_id'] == second['job_id']


@pytest.mark.anyio
async def test_live_scan_groups_media_by_name_and_queues_unique_primary_texts(tmp_path,monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR',tmp_path)
    monkeypatch.setattr(live_scan_storage,'JOB_DATA_DIR',tmp_path)
    monkeypatch.delenv('APP_PASSWORD',raising=False)
    claims=[]
    claimed={}
    enqueued=[]
    observed={}
    released=[]

    def fake_claim(kind,key,display_name,*,start_review):
        claims.append((kind,key,display_name,start_review))
        claim_key=(kind,key)
        is_new=claim_key not in claimed
        if is_new:
            claimed[claim_key]=f'{len(claimed) + 1:032x}'
        return {
            'job_id':claimed[claim_key],
            'needs_media':kind == 'creative',
            'result':None,
            'should_submit':kind == 'copy' and is_new,
            'status':'claiming' if kind == 'copy' else 'waiting_media',
        }

    async def fake_enqueue(job_id,media_path,media_kind,meta,file_name,file_size=None):
        enqueued.append((job_id,media_kind,meta.ad_copy,file_name))
        return JobRecord(
            job_id=job_id,
            file_name=file_name,
            has_creative=media_kind != 'copy_only',
            has_ad_copy=meta.has_ad_copy,
        )

    monkeypatch.setattr('app.main.claim_live_review',fake_claim)
    monkeypatch.setattr(
        'app.main.mark_live_review_queued',
        lambda *args:(_ for _ in ()).throw(RuntimeError('Convex temporarily unavailable')),
    )
    monkeypatch.setattr(
        'app.main.set_review_source',
        lambda *args:(_ for _ in ()).throw(RuntimeError('Source linking temporarily unavailable')),
    )
    monkeypatch.setattr(
        'app.main.release_live_review',
        lambda *args:released.append(args),
    )
    monkeypatch.setattr('app.main.enqueue_job',fake_enqueue)
    monkeypatch.setattr(
        'app.main.live_scan_request_meta',
        lambda **values:ReviewRequestMeta(
            ad_copy=values.get('ad_copy',''),
            live_scan_kind=values['kind'],
            live_scan_key=values['key'],
            live_scan_creative_name=values['creative_name'],
        ),
    )
    monkeypatch.setattr(
        'app.main.observe_live_account',
        lambda **values:observed.update(values) or {},
    )

    transport=httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport,base_url='http://test') as client:
        response=await client.post('/api/live-scans/observe',json={
            'account_id':'act_123',
            'account_name':'Lead Economy',
            'observation_date':'2026-07-30',
            'observed_at':1_775_000_000_000,
            'source_url':'https://business.facebook.com/adsmanager/manage/ads?act=123',
            'ads':[
                {
                    'ad_id':'ad-1',
                    'creative_name':'Winning Creative.mp4',
                    'primary_texts':['Save up to 20%.','Call today.'],
                    'delivery_status':'ACTIVE',
                    'campaign_name':'Campaign A',
                    'media_url':'https://scontent.xx.fbcdn.net/video.mp4',
                    'media_type':'video',
                    'is_live':True,
                },
                {
                    'ad_id':'ad-2',
                    'creative_name':'winning_creative.MOV',
                    'primary_texts':['Save   up to 20%.'],
                    'delivery_status':'ACTIVE',
                    'campaign_name':'Campaign B',
                    'is_live':True,
                },
                {
                    'ad_id':'paused',
                    'creative_name':'Paused Creative',
                    'primary_texts':['Do not submit me.'],
                    'delivery_status':'PAUSED',
                    'is_live':False,
                },
            ],
        })

    assert response.status_code == 200
    body=response.json()
    assert body['live_ads'] == 2
    assert body['unique_creatives'] == 2
    assert body['unique_primary_texts'] == 2
    assert body['queued_copy_jobs'] == 2
    assert len(body['media_requests']) == 2
    assert [value[0] for value in claims].count('creative') == 2
    assert [value[0] for value in claims].count('copy') == 3
    assert sorted(value[2] for value in enqueued) == ['Call today.','Save up to 20%.']
    assert sorted(value['ad_count'] for value in observed['creatives']) == [1,1]
    assert sorted(value['campaign_names'] for value in observed['creatives']) == [
        ['Campaign A'],['Campaign B'],
    ]
    assert len(observed['copies']) == 3
    assert observed['observed_ad_ids'] == ['ad-1','ad-2','paused']
    assert released == []


def test_live_scan_current_state_preserves_partial_copy_then_removes_paused_ad(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(live_scan_storage,'JOB_DATA_DIR',tmp_path)
    monkeypatch.setattr(live_scan_storage,'_convex_call',lambda *args,**kwargs:None)
    monkeypatch.setattr(live_scan_storage,'convex_enabled',lambda:False)
    creative={
        'creative_key':'winning creative',
        'creative_name':'Winning Creative',
        'ad_ids':['ad-1'],
        'ad_count':1,
        'campaign_names':['Campaign A'],
        'ad_set_names':['Ad set A'],
        'delivery_statuses':['ACTIVE'],
    }
    copy={
        'copy_key':primary_text_key('Save today.'),
        'creative_key':'winning creative',
        'creative_name':'Winning Creative',
        'primary_text':'Save today.',
        'ad_ids':['ad-1'],
        'ad_count':1,
    }
    common={
        'account_id':'act_123',
        'account_name':'Lead Economy',
        'observation_date':'2026-07-30',
        'source_url':'https://business.facebook.com/adsmanager/manage/ads?act=123',
        'observed_ad_ids':['ad-1'],
    }

    live_scan_storage.observe_live_account(
        **common,
        observed_at=100,
        creatives=[creative],
        copies=[copy],
    )
    live_scan_storage.observe_live_account(
        **common,
        observed_at=200,
        creatives=[creative],
        copies=[],
    )
    partial=live_scan_storage.get_live_scan_day('2026-07-30')
    assert partial.totals.live_ads == 1
    assert partial.totals.copy_variants == 1
    assert partial.accounts[0].creatives[0].copies[0].primary_text == 'Save today.'

    live_scan_storage.observe_live_account(
        **common,
        observed_at=300,
        creatives=[],
        copies=[],
    )
    paused=live_scan_storage.get_live_scan_day('2026-07-30')
    assert paused.totals.accounts_observed == 1
    assert paused.totals.live_ads == 0
    assert paused.totals.unique_creatives == 0
    assert paused.totals.copy_variants == 0
    assert paused.accounts[0].creatives == []


@pytest.mark.anyio
async def test_live_scan_creative_upload_queues_one_media_review(tmp_path,monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR',tmp_path)
    monkeypatch.setattr(live_scan_storage,'JOB_DATA_DIR',tmp_path)
    monkeypatch.delenv('APP_PASSWORD',raising=False)
    enqueued={}
    released=[]
    job_id='1' * 32

    monkeypatch.setattr('app.main.claim_live_review',lambda *args,**kwargs:{
        'job_id':job_id,
        'needs_media':False,
        'result':None,
        'should_submit':True,
        'status':'claiming',
    })
    monkeypatch.setattr(
        'app.main.mark_live_review_queued',
        lambda *args:(_ for _ in ()).throw(RuntimeError('Convex temporarily unavailable')),
    )
    monkeypatch.setattr(
        'app.main.set_review_source',
        lambda *args:(_ for _ in ()).throw(RuntimeError('Source linking temporarily unavailable')),
    )
    monkeypatch.setattr(
        'app.main.release_live_review',
        lambda *args:released.append(args),
    )
    monkeypatch.setattr(
        'app.main.live_scan_request_meta',
        lambda **values:ReviewRequestMeta(
            live_scan_kind='creative',
            live_scan_key=values['key'],
            live_scan_creative_name=values['creative_name'],
        ),
    )

    async def fake_enqueue(job_id,media_path,media_kind,meta,file_name,file_size=None):
        enqueued.update({
            'job_id':job_id,
            'payload':media_path.read_bytes(),
            'media_kind':media_kind,
            'file_name':file_name,
            'file_size':file_size,
            'meta':meta,
        })
        return JobRecord(
            job_id=job_id,
            file_name=file_name,
            file_size=file_size,
            has_ad_copy=False,
        )

    monkeypatch.setattr('app.main.enqueue_job',fake_enqueue)
    transport=httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport,base_url='http://test') as client:
        response=await client.post(
            '/api/live-scans/creative',
            files={'creative':('captured.mp4',b'fake-video','video/mp4')},
            data={
                'creative_name':'Winning Creative',
                'account_id':'act_123',
                'account_name':'Lead Economy',
                'observation_date':'2026-07-30',
                'source_url':'https://business.facebook.com/adsmanager/manage/ads?act=123',
            },
        )

    assert response.status_code == 200
    assert enqueued['job_id'] == job_id
    assert enqueued['payload'] == b'fake-video'
    assert enqueued['media_kind'] == 'video'
    assert enqueued['file_name'] == 'Winning Creative'
    assert enqueued['file_size'] == len(b'fake-video')
    assert enqueued['meta'].live_scan_kind == 'creative'
    assert released == []


def test_live_scan_telegram_message_links_live_page(monkeypatch):
    monkeypatch.setenv('APP_PUBLIC_URL','https://vibe-check.example')
    meta=ReviewRequestMeta(
        live_scan_kind='copy',
        live_scan_key='copy-key',
        live_scan_creative_name='Winning Creative',
        live_scan_account_name='Lead Economy',
        live_scan_observation_date='2026-07-30',
        ad_copy='Save up to 20%.',
    )
    message=build_live_scan_message(
        JobRecord(job_id='live-job',status=JobStatus.complete,has_creative=False),
        {
            'overall_status':'orange',
            'offer_id':'acp',
            'offer_name':'ACP',
            'findings':[],
        },
        meta,
        'copy_only',
    )
    assert 'Live Primary text Result' in message
    assert 'Winning Creative' in message
    assert 'Save up to 20%.' in message
    assert '/live-scans' in message
    assert '/reviews/live-job/report' in message


def test_worker_scheduled_recovery_precedes_automation_eligibility_gate():
    worker_source = (
        Path(__file__).resolve().parents[2] / 'worker' / 'index.ts'
    ).read_text(encoding='utf-8')
    scheduled_source = worker_source[worker_source.index('  scheduled('):]

    recovery_request = scheduled_source.index(
        'new URL("/api/internal/review-recovery"',
    )
    automation_gate = scheduled_source.index(
        'if (!await hasDueAutomations(env)) return;',
    )

    assert recovery_request < automation_gate
