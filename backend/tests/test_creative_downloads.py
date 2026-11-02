from pathlib import Path
from zipfile import ZipFile

import pytest
from fastapi import HTTPException, Request
from starlette.background import BackgroundTask
from starlette.responses import Response, StreamingResponse

from app import creative_downloads


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def request():
    return Request({'type': 'http', 'method': 'GET', 'headers': [(b'range', b'bytes=0-3')], 'path': '/'})


def items():
    return [(job, {'review': {'fileName': '../same.mp4', 'mediaKind': 'video'}}) for job in ['first', 'second']]


@pytest.mark.anyio
async def test_zip_contains_selected_originals_and_matching_text_with_safe_unique_names():
    visited = []
    def media(job, req):
        assert 'range' not in req.headers
        visited.append(job)
        return Response(job.encode())
    validated = []
    selected = items()
    selected[0][1]['creativeText'] = {
        'transcript': 'Café prices start at $25.\nTerms apply.',
        'onscreen_text': 'Compare today\nSave more',
        'onscreen_text_partial': True,
        'ad_copy': 'Request a quote.',
        'private_notes': 'Not for export',
    }
    selected[0][1]['report'] = {'summary': 'Not a transcript'}
    response = await creative_downloads.creative_archive(selected, request(), media, lambda: validated.append(True))
    path = Path(response.path)
    try:
        with ZipFile(path) as archive:
            assert archive.namelist() == ['001-.._same.mp4', '001-.._same.txt', '002-.._same.mp4', '002-.._same.txt']
            assert all('/' not in name for name in archive.namelist())
            assert [archive.read(name) for name in archive.namelist() if name.endswith('.mp4')] == [b'first', b'second']
            text = archive.read('001-.._same.txt').decode('utf-8')
            assert 'Creative: 001-.._same.mp4' in text
            assert 'Spoken text / transcript\nCafé prices start at $25.\nTerms apply.' in text
            assert 'On-screen text\nCompare today\nSave more' in text
            assert 'Only part of the sampled on-screen text could be read.' in text
            assert 'Submitted ad copy\nRequest a quote.' in text
            assert 'Not for export' not in text and 'Not a transcript' not in text
            missing = archive.read('002-.._same.txt').decode('utf-8')
            assert 'No saved transcript is available.' in missing
            assert 'No saved on-screen text is available.' in missing
            assert 'Only part' not in missing and 'Submitted ad copy' not in missing
        assert visited == ['first', 'second'] and validated == [True]
        assert response.headers['cache-control'] == 'no-store'
    finally:
        await response.background()
    assert not path.exists()


@pytest.mark.anyio
@pytest.mark.parametrize('failure', ['partial', 'size', 'text_size', 'revoked', 'missing'])
async def test_failed_archive_is_never_returned_and_always_closes_sources(failure, monkeypatch):
    cleaned = []
    closed = []
    original = creative_downloads.TemporaryDirectory
    def directory(**kwargs):
        result = original(**kwargs)
        cleaned.append(Path(result.name))
        return result
    monkeypatch.setattr(creative_downloads, 'TemporaryDirectory', directory)
    if failure == 'size':
        monkeypatch.setattr(creative_downloads, 'MAX_ARCHIVE_BYTES', 1)
    if failure == 'text_size':
        # Both originals fit; the new companion files must count toward the cap.
        monkeypatch.setattr(creative_downloads, 'MAX_ARCHIVE_BYTES', 14)
    def media(job, req):
        return StreamingResponse(iter([b'content']), status_code=404 if failure == 'missing' else 200,
            headers={'content-length': '100' if failure == 'partial' else '7'},
            background=BackgroundTask(lambda: closed.append(job)))
    def validate():
        if failure == 'revoked':
            raise HTTPException(404, 'Share expired or revoked')
    with pytest.raises(HTTPException) as caught:
        await creative_downloads.creative_archive(items(), request(), media, validate)
    if failure in {'size', 'text_size'}:
        assert caught.value.status_code == 413
    assert closed
    assert all(not path.exists() for path in cleaned)


@pytest.mark.anyio
async def test_image_text_and_copy_only_creatives_keep_their_content_and_names():
    selected = [
        ('image', {'review': {'fileName': 'Banner.v2.PNG', 'mediaKind': 'image'},
                   'creativeText': {'onscreen_text': 'Compare quotes', 'transcript': None}}),
        ('copy', {'review': {'fileName': 'Ad copy', 'mediaKind': 'copy_only'},
                  'creativeText': {'ad_copy': 'Original ad copy'}}),
    ]
    visited = []
    def media(job, req):
        visited.append(job)
        return Response(b'image bytes')
    response = await creative_downloads.creative_archive(selected, request(), media, lambda: None)
    try:
        with ZipFile(response.path) as archive:
            assert archive.namelist() == ['001-Banner.v2.PNG', '001-Banner.v2.txt', '002-Ad copy.txt']
            assert archive.read('001-Banner.v2.PNG') == b'image bytes'
            text = archive.read('001-Banner.v2.txt').decode('utf-8')
            assert 'On-screen text\nCompare quotes' in text
            assert 'No saved transcript is available.' in text
            assert 'Only part' not in text
            assert archive.read('002-Ad copy.txt') == b'Original ad copy'
        assert visited == ['image']
    finally:
        await response.background()
