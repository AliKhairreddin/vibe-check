from __future__ import annotations
import logging, shutil, anyio
from pathlib import Path
from .media import MediaKind, image_metadata, prepare_image_frame
from .models import JobStatus, ReviewRequestMeta
from .storage import job_dir, set_report, set_status, write_json
from .telegram import finish_batch_item_and_notify, send_review_message
from .video import metadata, extract_frames
from .audio import extract_audio, transcribe
from .guidelines import build_policy_context
from .ocr import run_ocr
from .vision import observe_frames_with_openrouter
from .llm import review_with_openrouter

INTERMEDIATE_FILES=('request.json','upload.json','metadata.json','frames.json','ocr.json','visual_observations.json','transcript.json')
logger = logging.getLogger(__name__)

def build_review_evidence(
    media_kind: MediaKind,
    meta: ReviewRequestMeta,
    policy_text: str,
    policy_sources: list[str],
    transcript: dict,
    ocr: list[dict],
    frames: list[dict],
    visual_observations: dict | None,
    evidence_note: str,
) -> dict:
    return {
        'source_definitions': {
            'ad_copy': 'Submitted platform caption/body text from the form only.',
            'audio': 'Spoken words from the extracted or manually supplied audio transcript only.',
            'onscreen_text': 'Text detected inside creative frames by OCR only.',
            'visual': 'Non-text visual creative elements observed from sampled image/video frames.',
            'policy': 'Supplied saved or pasted policy/guideline text.',
        },
        'media_type': media_kind,
        'submitted_ad_copy': {
            'present': meta.has_ad_copy,
            'text': meta.ad_copy,
        },
        'audio_transcript': transcript,
        'onscreen_text_ocr': ocr[:200],
        'visual_frame_references': frames[:200],
        'visual_observations': visual_observations or {'source':'not_run','observations':[]},
        'policy_text': policy_text,
        'policy_sources': policy_sources,
        'notes': meta.notes,
        'cost_saving_note': evidence_note,
    }

async def process_job(job_id:str, media_path:Path|None, media_kind:MediaKind, meta:ReviewRequestMeta):
    jd=job_dir(job_id)
    audio_path=jd/'audio.wav'
    try:
        if media_kind == 'copy_only':
            frames=[]
            ocr=[]
            visual_observations={'source':'not_applicable','observations':[], 'limitations':['No creative was submitted for visual review.']}
            transcript={'source':'not_applicable','chunks':[], 'limitations':['No creative was submitted for this review.']}
            evidence_note='No creative was submitted; review is based on submitted ad copy, policy text, and notes only.'
            write_json(jd/'frames.json', frames)
            write_json(jd/'ocr.json', ocr)
            write_json(jd/'visual_observations.json', visual_observations)
            write_json(jd/'transcript.json', transcript)
            set_status(job_id, JobStatus.reviewing_with_llm, 88, 'Reviewing ad copy with LLM', has_ad_copy=meta.has_ad_copy, has_creative=False)
        else:
            if media_path is None:
                raise ValueError('Creative file path is required for media review jobs.')
            if media_kind == 'video':
                set_status(job_id, JobStatus.processing_video, 10, 'Reading video metadata')
                write_json(jd/'metadata.json', await anyio.to_thread.run_sync(metadata, media_path))
                set_status(job_id, JobStatus.extracting_audio, 25, 'Extracting audio track')
                await anyio.to_thread.run_sync(extract_audio, media_path, audio_path)
                set_status(job_id, JobStatus.extracting_frames, 40, 'Sampling frames')
                frames=await anyio.to_thread.run_sync(extract_frames, media_path, jd/'frames', meta.frame_interval_seconds, meta.scene_detection)
                evidence_note='Selected sampled video frames may be sent to a vision model; the final LLM receives OCR, transcript chunks, frame references, and compact visual observations.'
            else:
                set_status(job_id, JobStatus.processing_image, 10, 'Reading image metadata')
                write_json(jd/'metadata.json', await anyio.to_thread.run_sync(image_metadata, media_path))
                set_status(job_id, JobStatus.extracting_frames, 40, 'Preparing image for OCR')
                frames=await anyio.to_thread.run_sync(prepare_image_frame, media_path, jd/'frames')
                evidence_note='The prepared still image frame may be sent to a vision model; the final LLM receives OCR, supplied copy, notes, image metadata, and compact visual observations.'
            write_json(jd/'frames.json', frames)
            set_status(job_id, JobStatus.running_ocr, 60, 'Running OCR')
            ocr=await anyio.to_thread.run_sync(run_ocr, jd/'frames', frames)
            write_json(jd/'ocr.json', ocr)
            set_status(job_id, JobStatus.analyzing_visuals, 70, 'Analyzing sampled frames with vision model')
            visual_observations=await observe_frames_with_openrouter(jd/'frames', frames, ocr)
            write_json(jd/'visual_observations.json', visual_observations)
            set_status(job_id, JobStatus.preparing_transcript, 80, 'Preparing timestamped transcript')
            transcript=await anyio.to_thread.run_sync(transcribe, audio_path, meta.manual_transcript)
            write_json(jd/'transcript.json', transcript)
            set_status(job_id, JobStatus.reviewing_with_llm, 90, 'Reviewing with LLM')
        policy_text, policy_sources=build_policy_context(meta.policy_text)
        evidence=build_review_evidence(media_kind, meta, policy_text, policy_sources, transcript, ocr, frames, visual_observations, evidence_note)
        report=await review_with_openrouter(evidence, meta.model)
        if evidence_note not in report.limitations:
            report.limitations.append(evidence_note)
        report_json=report.model_dump(mode='json')
        set_report(job_id, report_json)
        rec=set_status(job_id, JobStatus.complete, 100, 'Complete')
        if meta.has_batch:
            try:
                finish_batch_item_and_notify(
                    meta.batch_id or '',
                    meta.batch_item_id or '',
                    status='complete',
                    job_id=job_id,
                    result=report.overall_status,
                    message='Complete',
                )
            except Exception:
                logger.exception('Batch completion notification failed for job %s', job_id)
        else:
            send_review_message(rec, report_json, meta.ad_copy, media_kind)
    except Exception as e:
        set_status(job_id, JobStatus.failed, 100, str(e))
        if meta.has_batch:
            try:
                finish_batch_item_and_notify(
                    meta.batch_id or '',
                    meta.batch_item_id or '',
                    status='failed',
                    job_id=job_id,
                    message=str(e),
                )
            except Exception:
                logger.exception('Batch failure notification failed for job %s', job_id)
    finally:
        for path in (media_path, audio_path):
            if path is None:
                continue
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        for name in INTERMEDIATE_FILES:
            try:
                (jd/name).unlink(missing_ok=True)
            except OSError:
                pass
        shutil.rmtree(jd/'upload_chunks', ignore_errors=True)
        shutil.rmtree(jd/'frames', ignore_errors=True)
