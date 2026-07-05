import json
from pathlib import Path
from app.review_pipeline.models import ComplianceReport, JobStatus
from app.review_pipeline.guidelines import build_policy_context, load_default_guidelines
from app.review_pipeline.llm import parse_report_json
from app.review_pipeline.media import detect_media_kind, prepare_image_frame
from app.review_pipeline.ocr import normalize_text, dedupe_ocr
from app.review_pipeline.storage import set_status, get_status, set_report, list_reviews
from app.review_pipeline.video import ffprobe_command, extract_frames_command
from PIL import Image

def test_report_schema_validation():
    r=ComplianceReport.model_validate({'overall_status':'pass','summary':'ok','findings':[],'safe_rewrite':{'ad_copy':'','onscreen_text':[]},'limitations':[]})
    assert r.overall_status=='pass'

def test_openrouter_json_repair_fallback():
    text='Here is JSON {"overall_status":"needs_review","summary":"x","findings":[],"safe_rewrite":{"ad_copy":"","onscreen_text":[]},"limitations":[]} done'
    assert parse_report_json(text).overall_status=='needs_review'

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

def test_ffmpeg_command_construction():
    assert ffprobe_command(Path('ad.mp4'))[0]=='ffprobe'
    cmd=extract_frames_command(Path('ad.mp4'), Path('frame_%06d.jpg'), 1.0)
    assert cmd[0]=='ffmpeg' and 'fps=1.0' in cmd

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
