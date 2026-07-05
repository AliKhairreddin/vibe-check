import json
from pathlib import Path
from app.review_pipeline.models import ComplianceReport, JobStatus
from app.review_pipeline.llm import parse_report_json
from app.review_pipeline.ocr import normalize_text, dedupe_ocr
from app.review_pipeline.storage import set_status, get_status
from app.review_pipeline.video import ffprobe_command, extract_frames_command

def test_report_schema_validation():
    r=ComplianceReport.model_validate({'overall_status':'pass','summary':'ok','findings':[],'safe_rewrite':{'ad_copy':'','onscreen_text':[]},'limitations':[]})
    assert r.overall_status=='pass'

def test_openrouter_json_repair_fallback():
    text='Here is JSON {"overall_status":"needs_review","summary":"x","findings":[],"safe_rewrite":{"ad_copy":"","onscreen_text":[]},"limitations":[]} done'
    assert parse_report_json(text).overall_status=='needs_review'

def test_ocr_normalization_deduping():
    items=dedupe_ocr([{'text':' Big   Sale ','timestamp':0},{'text':'big sale','timestamp':1},{'text':'','timestamp':2}])
    assert len(items)==1 and items[0]['text']=='Big Sale'

def test_job_status_transitions(tmp_path, monkeypatch):
    monkeypatch.setattr('app.review_pipeline.storage.JOB_DATA_DIR', tmp_path)
    set_status('j1', JobStatus.queued, 0)
    set_status('j1', JobStatus.running_ocr, 60)
    assert get_status('j1').status == JobStatus.running_ocr

def test_ffmpeg_command_construction():
    assert ffprobe_command(Path('ad.mp4'))[0]=='ffprobe'
    cmd=extract_frames_command(Path('ad.mp4'), Path('frame_%06d.jpg'), 1.0)
    assert cmd[0]=='ffmpeg' and 'fps=1.0' in cmd
