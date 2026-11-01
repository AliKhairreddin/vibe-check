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
async def test_zip_contains_only_selected_complete_originals_with_safe_unique_names():
    visited = []
    def media(job, req):
        assert 'range' not in req.headers
        visited.append(job)
        return Response(job.encode())
    validated = []
    response = await creative_downloads.creative_archive(items(), request(), media, lambda: validated.append(True))
    path = Path(response.path)
    try:
        with ZipFile(path) as archive:
            assert len(set(archive.namelist())) == 2
            assert all('/' not in name for name in archive.namelist())
            assert [archive.read(name) for name in archive.namelist()] == [b'first', b'second']
        assert visited == ['first', 'second'] and validated == [True]
        assert response.headers['cache-control'] == 'no-store'
    finally:
        await response.background()
    assert not path.exists()


@pytest.mark.anyio
@pytest.mark.parametrize('failure', ['partial', 'size', 'revoked', 'missing'])
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
    def media(job, req):
        return StreamingResponse(iter([b'content']), status_code=404 if failure == 'missing' else 200,
            headers={'content-length': '100' if failure == 'partial' else '7'},
            background=BackgroundTask(lambda: closed.append(job)))
    def validate():
        if failure == 'revoked':
            raise HTTPException(404, 'Share expired or revoked')
    with pytest.raises(HTTPException):
        await creative_downloads.creative_archive(items(), request(), media, validate)
    assert closed
    assert all(not path.exists() for path in cleaned)
