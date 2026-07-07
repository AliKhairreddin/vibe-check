from __future__ import annotations
import shutil, anyio
from pathlib import Path
from .media import MediaKind, image_metadata, prepare_image_frame
from .models import JobStatus, ReviewRequestMeta
from .storage import job_dir, set_report, set_status, write_json
from .telegram import send_review_message
from .video import metadata, extract_frames
from .audio import extract_audio, transcribe
from .guidelines import build_policy_context
from .ocr import run_ocr
from .llm import review_with_openrouter

INTERMEDIATE_FILES=('request.json','metadata.json','frames.json','ocr.json','transcript.json')

def build_review_evidence(
    media_kind: MediaKind,
    meta: ReviewRequestMeta,
    policy_text: str,
    policy_sources: list[str],
    transcript: dict,
    ocr: list[dict],
    frames: list[dict],
    evidence_note: str,
) -> dict:
    return {
        'source_definitions': {
            'ad_copy': 'Submitted platform caption/body text from the form only.',
            'audio': 'Spoken words from the extracted or manually supplied audio transcript only.',
            'onscreen_text': 'Text detected inside creative frames by OCR only.',
            'visual': 'Non-text visual creative elements and frame references.',
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
            transcript={'source':'not_applicable','chunks':[], 'limitations':['No creative was submitted for this review.']}
            evidence_note='No creative was submitted; review is based on submitted ad copy, policy text, and notes only.'
            write_json(jd/'frames.json', frames)
            write_json(jd/'ocr.json', ocr)
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
                evidence_note='Full video frames are not sent by default; OCR, transcript chunks, and frame references are used.'
            else:
                set_status(job_id, JobStatus.processing_image, 10, 'Reading image metadata')
                write_json(jd/'metadata.json', await anyio.to_thread.run_sync(image_metadata, media_path))
                set_status(job_id, JobStatus.extracting_frames, 40, 'Preparing image for OCR')
                frames=await anyio.to_thread.run_sync(prepare_image_frame, media_path, jd/'frames')
                evidence_note='Full image pixels are not sent by default; OCR, supplied copy, notes, and image metadata are used.'
            write_json(jd/'frames.json', frames)
            set_status(job_id, JobStatus.running_ocr, 60, 'Running OCR')
            ocr=await anyio.to_thread.run_sync(run_ocr, jd/'frames', frames)
            write_json(jd/'ocr.json', ocr)
            set_status(job_id, JobStatus.preparing_transcript, 75, 'Preparing transcript')
            transcript=await anyio.to_thread.run_sync(transcribe, audio_path, meta.manual_transcript)
            write_json(jd/'transcript.json', transcript)
            set_status(job_id, JobStatus.reviewing_with_llm, 88, 'Reviewing with LLM')
        policy_text, policy_sources=build_policy_context(meta.policy_text)
        evidence=build_review_evidence(media_kind, meta, policy_text, policy_sources, transcript, ocr, frames, evidence_note)
        report=await review_with_openrouter(evidence, meta.model)
        if evidence_note not in report.limitations:
            report.limitations.append(evidence_note)
        report_json=report.model_dump(mode='json')
        set_report(job_id, report_json)
        rec=set_status(job_id, JobStatus.complete, 100, 'Complete')
        send_review_message(rec, report_json, meta.ad_copy, media_kind)
    except Exception as e:
        set_status(job_id, JobStatus.failed, 100, str(e))
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
        shutil.rmtree(jd/'frames', ignore_errors=True)
