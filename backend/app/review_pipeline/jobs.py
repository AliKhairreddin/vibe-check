from __future__ import annotations
import shutil, anyio
from pathlib import Path
from .models import JobStatus, ReviewRequestMeta
from .storage import job_dir, set_report, set_status, write_json
from .video import metadata, extract_frames
from .audio import extract_audio, transcribe
from .guidelines import build_policy_context
from .ocr import run_ocr
from .llm import review_with_openrouter

INTERMEDIATE_FILES=('request.json','metadata.json','frames.json','ocr.json','transcript.json')

async def process_job(job_id:str, video_path:Path, meta:ReviewRequestMeta):
    jd=job_dir(job_id)
    try:
        set_status(job_id, JobStatus.processing_video, 10, 'Reading video metadata')
        write_json(jd/'metadata.json', await anyio.to_thread.run_sync(metadata, video_path))
        set_status(job_id, JobStatus.extracting_audio, 25, 'Extracting audio track')
        audio_path=jd/'audio.wav'; audio_ok=await anyio.to_thread.run_sync(extract_audio, video_path, audio_path)
        set_status(job_id, JobStatus.extracting_frames, 40, 'Sampling frames')
        frames=await anyio.to_thread.run_sync(extract_frames, video_path, jd/'frames', meta.frame_interval_seconds, meta.scene_detection)
        write_json(jd/'frames.json', frames)
        set_status(job_id, JobStatus.running_ocr, 60, 'Running OCR')
        ocr=await anyio.to_thread.run_sync(run_ocr, jd/'frames', frames)
        write_json(jd/'ocr.json', ocr)
        set_status(job_id, JobStatus.transcribing_audio, 75, 'Preparing transcript')
        transcript=await anyio.to_thread.run_sync(transcribe, audio_path, meta.manual_transcript if audio_ok or meta.manual_transcript else meta.manual_transcript)
        write_json(jd/'transcript.json', transcript)
        set_status(job_id, JobStatus.reviewing_with_llm, 88, 'Reviewing with LLM')
        policy_text, policy_sources=build_policy_context(meta.policy_text)
        evidence={'ad_copy':meta.ad_copy,'policy_text':policy_text,'policy_sources':policy_sources,'notes':meta.notes,'transcript':transcript,'ocr':ocr[:200],'frames':frames[:200],'cost_saving_note':'Full frames are not sent by default; OCR, transcript chunks, and frame references are used.'}
        report=await review_with_openrouter(evidence, meta.model)
        set_report(job_id, report.model_dump(mode='json'))
        set_status(job_id, JobStatus.complete, 100, 'Complete')
    except Exception as e:
        set_status(job_id, JobStatus.failed, 100, str(e))
    finally:
        for path in (video_path, jd/'audio.wav'):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        for name in INTERMEDIATE_FILES:
            try:
                (jd/name).unlink(missing_ok=True)
            except OSError:
                pass
        shutil.rmtree(jd/'frames', ignore_errors=True)
