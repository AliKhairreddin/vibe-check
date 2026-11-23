"""Explicit, scoped downloads using the existing authorized media transport."""
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore
from zipfile import ZipFile, ZIP_STORED

import anyio
from fastapi import HTTPException, Request
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.responses import FileResponse

MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
_archive_slots = BoundedSemaphore(2)


def _creative_text_document(filename: str, detail: dict) -> bytes:
    """Export only the authorized, saved creative text projection."""
    text = detail.get('creativeText') or {}
    sections = [
        f'Creative: {filename}',
        'Text extracted during review. Transcription and text recognition may contain errors.',
        'Spoken text / transcript\n' + (text.get('transcript') or 'No saved transcript is available.'),
        'On-screen text\n' + (text.get('onscreen_text') or 'No saved on-screen text is available.'),
    ]
    if text.get('onscreen_text_partial'):
        sections[-1] += '\n\nOnly part of the sampled on-screen text could be read.'
    if text.get('ad_copy'):
        sections.append('Submitted ad copy\n' + text['ad_copy'])
    return ('\n\n'.join(sections) + '\n').encode('utf-8')


async def creative_archive(items: list[tuple[str, dict]], request: Request, media_response, revalidate):
    """Fail atomically if any selected creative is missing; never return a partial ZIP."""
    if not _archive_slots.acquire(blocking=False):
        raise HTTPException(429, 'Other downloads are being prepared. Please try again shortly.', headers={'retry-after': '30'})
    directory = TemporaryDirectory(prefix='adchecked-creatives-')
    path = Path(directory.name) / 'creatives.zip'
    total = 0
    # A ZIP needs entire files, regardless of Range headers on the download.
    scope = {**request.scope, 'method': 'GET', 'headers': [
        (key, value) for key, value in request.scope.get('headers', []) if key.lower() != b'range'
    ]}
    media_request = Request(scope)
    try:
        with ZipFile(path, 'w', compression=ZIP_STORED, allowZip64=True) as archive:
            for index, (job_id, detail) in enumerate(items, 1):
                review = detail['review']
                filename = re.sub(r'[\\/\x00-\x1f]', '_', str(review.get('fileName') or job_id))
                filename = f'{index:03d}-{filename[:180]}'
                if review.get('mediaKind') == 'copy_only':
                    text = (detail.get('creativeText') or {}).get('ad_copy')
                    if not text:
                        raise HTTPException(409, 'A selected creative has no saved ad copy. No ZIP was downloaded.')
                    body = text.encode('utf-8')
                    total += len(body)
                    if total > MAX_ARCHIVE_BYTES:
                        raise HTTPException(413, 'This download exceeds 1 GB. Download smaller selections or individual originals.')
                    archive.writestr(filename + '.txt', body)
                    continue
                response = await run_in_threadpool(media_response, job_id, media_request)
                try:
                    if response.status_code != 200:
                        raise HTTPException(502, 'A selected original is unavailable. No ZIP was downloaded; try again.')
                    async def chunks():
                        if isinstance(response, FileResponse):
                            async with await anyio.open_file(response.path, 'rb') as source:
                                while chunk := await source.read(1024 * 1024):
                                    yield chunk
                        elif hasattr(response, 'body_iterator'):
                            async for chunk in response.body_iterator:
                                yield chunk
                        else:
                            yield response.body
                    with archive.open(filename, 'w', force_zip64=True) as target:
                        size = 0
                        async for chunk in chunks():
                            total += len(chunk)
                            size += len(chunk)
                            if total > MAX_ARCHIVE_BYTES:
                                raise HTTPException(413, 'This download exceeds 1 GB. Download smaller selections or individual originals.')
                            await run_in_threadpool(target.write, chunk)
                        expected = response.headers.get('content-length')
                        if not size or (expected and size != int(expected)):
                            raise HTTPException(502, 'An original download was incomplete. No ZIP was downloaded; try again.')
                finally:
                    if response.background:
                        await response.background()
                body = _creative_text_document(filename, detail)
                total += len(body)
                if total > MAX_ARCHIVE_BYTES:
                    raise HTTPException(413, 'This download exceeds 1 GB. Download smaller selections or individual originals.')
                text_filename = str(Path(filename).with_suffix('.txt'))
                if text_filename == filename:
                    text_filename = filename + '.txt'
                archive.writestr(text_filename, body)
        await run_in_threadpool(revalidate)
        return FileResponse(path, media_type='application/zip', filename='creatives.zip',
                            headers={'cache-control': 'no-store'}, background=BackgroundTask(directory.cleanup))
    except BaseException:
        directory.cleanup()
        raise
    finally:
        _archive_slots.release()
