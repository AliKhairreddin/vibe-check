from __future__ import annotations
import asyncio, logging, shutil, anyio
from pathlib import Path
from .media import MediaKind, image_metadata, prepare_image_frame
from .models import ComplianceReport, Finding, JobStatus, OfferComplianceResult, OfferOutcome, OfferProfile, ReviewRequestMeta
from .offer_catalog import offer_sort_key
from .automation_storage import (
    record_review_automation_job_result,
    release_review_automation_claim,
)
from .storage import get_status, job_dir, set_report, set_status, write_json
from .pdf_reports import build_and_store_review_pdf_variants
from .live_scan_storage import finish_live_review
from .telegram import (
    finish_batch_item_and_notify,
    send_live_scan_message,
    send_review_message,
)
from .video import metadata, extract_frames
from .audio import extract_audio, transcribe
from .guidelines import build_internal_override_context, build_policy_context, built_in_acp_profile
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
    offer_profile: OfferProfile | None = None,
) -> dict:
    profile=offer_profile or built_in_acp_profile()
    return {
        'offer': {
            'offer_id': profile.offer_id,
            'display_name': profile.display_name,
            'guideline_version': profile.version,
        },
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
        'internal_overrides': build_internal_override_context(profile),
        'notes': meta.notes,
        'cost_saving_note': evidence_note,
    }


def _internal_disposition(report:ComplianceReport)->str:
    if report.findings:
        return 'human_review' if report.overall_status == 'orange' else 'action_required'
    if report.applied_overrides:
        return 'accepted_with_override'
    return 'clear' if report.overall_status == 'green' else 'human_review'


def _validate_applied_overrides(report:ComplianceReport, profile:OfferProfile)->None:
    available={override.override_id:override for override in profile.internal_overrides if override.enabled}
    invalid_ids:set[str]=set()
    invalid_applications=[]
    duplicate_ids:set[str]=set()
    retained=[]
    seen:set[str]=set()
    for applied in report.applied_overrides:
        configured=available.get(applied.override_id)
        if configured is None:
            invalid_ids.add(applied.override_id)
            invalid_applications.append(applied)
            continue
        if applied.override_id in seen:
            duplicate_ids.add(applied.override_id)
            continue
        seen.add(applied.override_id)
        applied.title=configured.title
        retained.append(applied)
    report.applied_overrides=retained
    if invalid_ids:
        report.limitations.append(
            'The model referenced unknown internal override IDs; those applications were removed: '
            + ', '.join(sorted(invalid_ids))
        )
        if report.overall_status == 'green':
            first_invalid=invalid_applications[0]
            report.overall_status='orange'
            report.summary=(
                'The effective result needs human review because the model relied on an '
                'internal override that is not saved for this offer.'
            )
            report.findings.append(Finding(
                severity='medium',
                source=first_invalid.source,
                evidence=first_invalid.evidence or 'An unknown internal override was applied.',
                policy_reason='Only enabled overrides saved for this offer may change the run decision.',
                suggested_fix='Review the evidence manually or save an explicit approved rule before publishing.',
                confidence='high',
            ))
            affected=(
                report.source_results.ad_copy
                if first_invalid.source == 'ad_copy'
                else report.source_results.creative
            )
            if affected is not None:
                affected.status='orange'
                affected.summary='An unknown internal override requires human review.'
    if duplicate_ids:
        report.limitations.append(
            'The model returned duplicate internal override applications; only the first was kept: '
            + ', '.join(sorted(duplicate_ids))
        )
    report.internal_disposition=_internal_disposition(report)


async def _review_offer(
    profile:OfferProfile,
    media_kind:MediaKind,
    meta:ReviewRequestMeta,
    transcript:dict,
    ocr:list[dict],
    frames:list[dict],
    visual_observations:dict | None,
    evidence_note:str,
)->OfferComplianceResult:
    policy_text,policy_sources=build_policy_context(meta.policy_text, profile)
    evidence=build_review_evidence(
        media_kind,
        meta,
        policy_text,
        policy_sources,
        transcript,
        ocr,
        frames,
        visual_observations,
        evidence_note,
        profile,
    )
    try:
        report=await review_with_openrouter(evidence, meta.model)
    except Exception:
        logger.exception('Offer review failed for %s', profile.offer_id)
        raise
    report.offer_id=profile.offer_id
    report.offer_name=profile.display_name
    report.guideline_version=profile.version
    report.policy_sources=[*policy_sources]
    if build_internal_override_context(profile):
        report.policy_sources.append(
            f'{profile.display_name} current internal rules (version {profile.version})'
        )
    if evidence_note not in report.limitations:
        report.limitations.append(evidence_note)
    _validate_applied_overrides(report, profile)
    return OfferComplianceResult.model_validate(
        report.model_dump(exclude={'schema_version','primary_offer_id','offer_results'})
    )


def _completed_offer_outcomes(
    meta:ReviewRequestMeta,
    offer_results:list[OfferComplianceResult],
)->list[OfferOutcome]:
    results_by_offer={result.offer_id:result for result in offer_results}
    snapshots=[outcome.model_copy(deep=True) for outcome in meta.offer_outcomes]
    if not snapshots:
        snapshots=[
            OfferOutcome(
                offer_id=result.offer_id,
                offer_name=result.offer_name,
                evaluation_state='evaluated',
            )
            for result in offer_results
        ]

    outcomes=[]
    seen:set[str]=set()
    for snapshot in snapshots:
        result=results_by_offer.get(snapshot.offer_id)
        if result is None:
            outcomes.append(snapshot)
            seen.add(snapshot.offer_id)
            continue
        outcomes.append(OfferOutcome(
            offer_id=result.offer_id,
            offer_name=result.offer_name,
            evaluation_state='evaluated',
            overall_status=result.overall_status,
            creative_result=(
                result.source_results.creative.status
                if result.source_results.creative is not None
                else None
            ),
            ad_copy_result=(
                result.source_results.ad_copy.status
                if result.source_results.ad_copy is not None
                else None
            ),
            with_override=result.internal_disposition == 'accepted_with_override',
            message=(
                'Green under the saved current internal rules.'
                if result.internal_disposition == 'accepted_with_override'
                else 'Evaluated using the effective saved policy.'
            ),
        ))
        seen.add(result.offer_id)
    for result in offer_results:
        if result.offer_id in seen:
            continue
        outcomes.append(OfferOutcome(
            offer_id=result.offer_id,
            offer_name=result.offer_name,
            evaluation_state='evaluated',
            overall_status=result.overall_status,
            creative_result=(
                result.source_results.creative.status
                if result.source_results.creative is not None
                else None
            ),
            ad_copy_result=(
                result.source_results.ad_copy.status
                if result.source_results.ad_copy is not None
                else None
            ),
            with_override=result.internal_disposition == 'accepted_with_override',
            message=(
                'Green under the saved current internal rules.'
                if result.internal_disposition == 'accepted_with_override'
                else 'Evaluated using the effective saved policy.'
            ),
        ))
    return sorted(outcomes, key=offer_sort_key)

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
        profiles=meta.offer_profiles or [built_in_acp_profile()]
        offer_results=await asyncio.gather(*[
            _review_offer(
                profile,
                media_kind,
                meta,
                transcript,
                ocr,
                frames,
                visual_observations,
                evidence_note,
            )
            for profile in profiles
        ])
        primary=offer_results[0]
        offer_outcomes=_completed_offer_outcomes(meta, offer_results)
        report=ComplianceReport(
            **primary.model_dump(),
            schema_version=2,
            primary_offer_id=primary.offer_id,
            offer_results=offer_results,
            offer_outcomes=offer_outcomes,
        )
        report_json=report.model_dump(mode='json')
        set_report(job_id, report_json, meta.automation_run_id)
        try:
            await anyio.to_thread.run_sync(
                lambda: build_and_store_review_pdf_variants(
                    job_id,
                    get_status(job_id),
                    report_json,
                    frames_dir=jd/'frames',
                    frames=frames,
                    transcript=transcript,
                    ad_copy=meta.ad_copy,
                )
            )
        except Exception:
            logger.exception('Could not generate PDF report for job %s.', job_id)
        rec=set_status(job_id, JobStatus.complete, 100, 'Complete')
        try:
            record_review_automation_job_result(meta, job_id)
        except Exception:
            logger.exception('Could not finalize automation run for job %s', job_id)
        if meta.live_scan_kind and meta.live_scan_key:
            try:
                await asyncio.to_thread(
                    finish_live_review,
                    meta.live_scan_kind,
                    meta.live_scan_key,
                    job_id,
                    status='complete',
                    result=report.overall_status,
                )
            except Exception:
                logger.exception('Could not finalize live scan review %s',job_id)
            await asyncio.to_thread(
                send_live_scan_message,
                rec,
                report_json,
                meta,
                media_kind,
            )
        elif meta.has_batch:
            try:
                await asyncio.to_thread(
                    finish_batch_item_and_notify,
                    meta.batch_id or '',
                    meta.batch_item_id or '',
                    status='complete',
                    job_id=job_id,
                    result=report.overall_status,
                    offer_outcomes=offer_outcomes,
                    message='Complete',
                )
            except Exception:
                logger.exception('Batch completion notification failed for job %s', job_id)
        else:
            await asyncio.to_thread(
                send_review_message,
                rec,
                report_json,
                meta.ad_copy,
                media_kind,
            )
    except Exception as e:
        set_status(job_id, JobStatus.failed, 100, str(e))
        if meta.live_scan_kind and meta.live_scan_key:
            try:
                await asyncio.to_thread(
                    finish_live_review,
                    meta.live_scan_kind,
                    meta.live_scan_key,
                    job_id,
                    status='failed',
                )
            except Exception:
                logger.exception('Could not fail live scan review %s',job_id)
        try:
            release_review_automation_claim(meta)
        except Exception:
            logger.exception('Could not release automation claim for failed job %s', job_id)
        try:
            record_review_automation_job_result(meta, job_id)
        except Exception:
            logger.exception('Could not finalize failed automation run for job %s', job_id)
        if meta.has_batch:
            try:
                await asyncio.to_thread(
                    finish_batch_item_and_notify,
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
