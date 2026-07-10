from __future__ import annotations

import logging
import os

from .drive import DriveLookupError, GoogleDriveClient, get_google_drive_client
from .models import JobRecord, ReviewSource, ReviewSources
from .storage import get_status, now_ms, set_review_source

logger = logging.getLogger(__name__)


def _cached_source(record: JobRecord) -> ReviewSource | None:
    if record.source_status != 'linked' or not record.source_url or record.source_kind != 'google_drive_file':
        return None
    return ReviewSource(
        kind=record.source_kind,
        status='linked',
        url=record.source_url,
        file_id=record.source_file_id,
        label='Open creative in Google Drive',
        message=record.source_message,
        checked_at=record.source_checked_at or now_ms(),
    )


def _save(job_id: str, source: ReviewSource) -> ReviewSource:
    set_review_source(job_id, source)
    return source


def _spreadsheet_source(checked_at: int) -> ReviewSource:
    sheet_url = os.getenv('GOOGLE_AD_COPY_SHEET_URL', '').strip()
    if not sheet_url:
        return ReviewSource(
            status='unavailable',
            label='Ad copy spreadsheet',
            message='The ad copy spreadsheet is not configured.',
            checked_at=checked_at,
        )
    return ReviewSource(
        kind='google_sheet',
        status='linked',
        url=sheet_url,
        label='Open ad copy spreadsheet',
        message='This review is linked to the shared ad copy spreadsheet.',
        checked_at=checked_at,
    )


def _resolve_creative_source(
    record: JobRecord,
    drive_client: GoogleDriveClient | None,
) -> ReviewSource:
    cached = _cached_source(record)
    if cached:
        return cached

    checked_at = now_ms()
    try:
        matches = (drive_client or get_google_drive_client()).find_files_by_exact_name(record.file_name)
    except DriveLookupError as exc:
        logger.error(
            'Google Drive source lookup failed job_id=%s error_type=%s',
            record.job_id,
            type(exc).__name__,
        )
        return _save(record.job_id, ReviewSource(
            status='unavailable',
            label='Google Drive creative',
            message='Google Drive could not be checked right now. Try again later.',
            checked_at=checked_at,
        ))

    if len(matches) > 1 and record.file_size is not None:
        size_matches = [match for match in matches if match.size == record.file_size]
        if len(size_matches) == 1:
            matches = size_matches

    if not matches:
        return _save(record.job_id, ReviewSource(
            status='not_found',
            label='Google Drive creative',
            message=f'No exact match for “{record.file_name}” was found in the shared Drive folder.',
            checked_at=checked_at,
        ))
    if len(matches) > 1:
        return _save(record.job_id, ReviewSource(
            status='ambiguous',
            label='Google Drive creative',
            message=f'Multiple Drive files are named “{record.file_name}”, so no link was chosen.',
            checked_at=checked_at,
        ))

    match = matches[0]
    return _save(record.job_id, ReviewSource(
        kind='google_drive_file',
        status='linked',
        url=match.web_view_link,
        file_id=match.file_id,
        label='Open creative in Google Drive',
        message=f'Matched “{record.file_name}” in the shared Drive folder.',
        checked_at=checked_at,
    ))


def resolve_review_sources(
    job_id: str,
    drive_client: GoogleDriveClient | None = None,
) -> ReviewSources:
    record = get_status(job_id)
    checked_at = now_ms()
    sources: list[ReviewSource] = []
    if record.has_creative:
        sources.append(_resolve_creative_source(record, drive_client))
    if record.has_ad_copy:
        sources.append(_spreadsheet_source(checked_at))
    return ReviewSources(sources=sources)
