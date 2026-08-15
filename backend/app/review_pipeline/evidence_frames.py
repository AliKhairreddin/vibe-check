from __future__ import annotations

import contextlib
import io
import mimetypes
import shutil
from pathlib import Path
from typing import Any, Sequence

import httpx
from PIL import Image
from pypdf import PdfReader

from . import storage
from .pdf_reports import _all_findings, nearest_frame

MAX_EVIDENCE_FRAMES = 30
UPLOAD_TIMEOUT = httpx.Timeout(125.0, connect=20.0)
DOWNLOAD_TIMEOUT = httpx.Timeout(60.0, connect=15.0)
EVIDENCE_MANIFEST = 'evidence_frames.json'
EVIDENCE_DIRECTORY = 'evidence_frames'


def _evidence_candidates(
    report: dict[str, Any],
    frames: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    if frames:
        candidates.append(frames[0])
    for _offer, finding in _all_findings(report):
        if finding.get('source') not in {'audio', 'onscreen_text', 'visual'}:
            continue
        frame = nearest_frame(frames, finding.get('timestamp_start'))
        if frame is not None:
            candidates.append(frame)
    unique: list[dict[str, Any]] = []
    filenames: set[str] = set()
    for frame in candidates:
        filename = Path(str(frame.get('filename') or '')).name
        if not filename or filename in filenames:
            continue
        filenames.add(filename)
        unique.append({
            'filename': filename,
            'timestamp': (
                float(frame['timestamp'])
                if isinstance(frame.get('timestamp'), (int, float))
                else None
            ),
        })
    return unique[:MAX_EVIDENCE_FRAMES]


def _upload_frame(path: Path) -> str:
    upload_url = storage._convex_call(
        'mutation',
        'reviewEvidenceFrames:generateUploadUrl',
        {},
    )
    if not isinstance(upload_url, str) or not upload_url.startswith('https://'):
        raise RuntimeError('Convex returned an invalid evidence-frame upload URL.')
    content_type = mimetypes.guess_type(path.name)[0] or 'image/jpeg'
    with path.open('rb') as body, httpx.Client(
        timeout=UPLOAD_TIMEOUT,
        follow_redirects=True,
    ) as client:
        response = client.post(
            upload_url,
            headers={
                'content-length': str(path.stat().st_size),
                'content-type': content_type,
            },
            content=body,
        )
    response.raise_for_status()
    payload = response.json()
    storage_id = payload.get('storageId') if isinstance(payload, dict) else None
    if not isinstance(storage_id, str) or not storage_id:
        raise RuntimeError('Convex did not return an evidence-frame storage ID.')
    return storage_id


def persist_review_evidence_frames(
    job_id: str,
    report: dict[str, Any],
    frames_dir: Path,
    frames: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    candidates = _evidence_candidates(report, frames)
    evidence_dir = storage.job_dir(job_id) / EVIDENCE_DIRECTORY
    evidence_dir.mkdir(parents=True, exist_ok=True)
    saved: list[dict[str, Any]] = []
    for candidate in candidates:
        source = frames_dir / candidate['filename']
        if not source.exists():
            continue
        destination = evidence_dir / candidate['filename']
        shutil.copy2(source, destination)
        saved.append(candidate)
    storage.write_json(storage.job_dir(job_id) / EVIDENCE_MANIFEST, saved)
    if not storage.convex_enabled() or not saved:
        return saved

    storage_ids: list[str] = []
    try:
        remote_frames = []
        for frame in saved:
            storage_id = _upload_frame(evidence_dir / frame['filename'])
            storage_ids.append(storage_id)
            value: dict[str, Any] = {
                'filename': frame['filename'],
                'storageId': storage_id,
            }
            if frame['timestamp'] is not None:
                value['timestamp'] = frame['timestamp']
            remote_frames.append(value)
        storage._convex_call(
            'mutation',
            'reviewEvidenceFrames:save',
            {'jobId': job_id, 'frames': remote_frames},
        )
    except Exception:
        if storage_ids:
            with contextlib.suppress(Exception):
                storage._convex_call(
                    'mutation',
                    'reviewEvidenceFrames:removeFiles',
                    {'storageIds': storage_ids},
                )
        raise
    return saved


def list_review_evidence_frames(job_id: str) -> list[dict[str, Any]]:
    remote = storage._convex_call(
        'query',
        'reviewEvidenceFrames:list',
        {'jobId': job_id},
    )
    if isinstance(remote, list) and remote:
        return [frame for frame in remote if isinstance(frame, dict)]
    manifest = storage.job_dir(job_id) / EVIDENCE_MANIFEST
    if not manifest.exists():
        extracted = _extract_report_thumbnail(job_id)
        return [extracted] if extracted else []
    try:
        values = storage.read_json(manifest)
    except (OSError, ValueError):
        return []
    return [value for value in values if isinstance(value, dict)] if isinstance(values, list) else []


def _report_artifact_bytes(job_id: str) -> bytes | None:
    local = storage.job_dir(job_id) / 'report.pdf'
    if local.exists() and local.stat().st_size:
        return local.read_bytes()
    for owner_id in (f'{job_id}:layout:2', job_id):
        remote = storage._convex_call(
            'query',
            'reportArtifacts:get',
            {'ownerType': 'review', 'ownerId': owner_id},
        )
        url = remote.get('url') if isinstance(remote, dict) else None
        if not isinstance(url, str):
            continue
        try:
            with httpx.Client(timeout=DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
                response = client.get(url)
                response.raise_for_status()
            return response.content
        except httpx.HTTPError:
            continue
    return None


def _extract_report_thumbnail(job_id: str) -> dict[str, Any] | None:
    report_bytes = _report_artifact_bytes(job_id)
    if not report_bytes:
        return None
    try:
        reader = PdfReader(io.BytesIO(report_bytes))
        images = list(reader.pages[0].images) if reader.pages else []
        candidates = []
        for embedded in images:
            with Image.open(io.BytesIO(embedded.data)) as image:
                candidates.append((image.width * image.height, image.copy().convert('RGB')))
        if not candidates:
            return None
        thumbnail = max(candidates, key=lambda value: value[0])[1]
        thumbnail.thumbnail((480, 360))
        evidence_dir = storage.job_dir(job_id) / EVIDENCE_DIRECTORY
        evidence_dir.mkdir(parents=True, exist_ok=True)
        path = evidence_dir / 'thumbnail.jpg'
        thumbnail.save(path, format='JPEG', quality=88)
        value = {'filename': path.name, 'timestamp': None}
        storage.write_json(storage.job_dir(job_id) / EVIDENCE_MANIFEST, [value])
        if storage.convex_enabled():
            storage_id = _upload_frame(path)
            try:
                storage._convex_call(
                    'mutation',
                    'reviewEvidenceFrames:save',
                    {
                        'jobId': job_id,
                        'frames': [{'filename': path.name, 'storageId': storage_id}],
                    },
                )
            except Exception:
                with contextlib.suppress(Exception):
                    storage._convex_call(
                        'mutation',
                        'reviewEvidenceFrames:removeFiles',
                        {'storageIds': [storage_id]},
                    )
                raise
        return value
    except Exception:
        return None


def resolve_review_evidence_frame(job_id: str, filename: str) -> Path | str | None:
    safe_filename = Path(filename).name
    if not safe_filename or safe_filename != filename:
        return None
    local = storage.job_dir(job_id) / EVIDENCE_DIRECTORY / safe_filename
    if local.exists():
        return local
    for frame in list_review_evidence_frames(job_id):
        if frame.get('filename') == safe_filename and isinstance(frame.get('url'), str):
            return frame['url']
    return None


def read_remote_evidence_frame(url: str) -> tuple[bytes, str]:
    with httpx.Client(timeout=DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
        response = client.get(url)
        response.raise_for_status()
    return response.content, response.headers.get('content-type') or 'image/jpeg'
