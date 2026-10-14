from io import BytesIO
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from pypdf import PdfWriter
from reportlab.pdfgen.canvas import Canvas

from app import guideline_import as imports, guideline_organizer as organizer
from test_signup import anyio_backend


def pdf(text=None):
    output = BytesIO()
    canvas = Canvas(output)
    if text:
        canvas.drawString(50, 700, text)
    canvas.showPage()
    canvas.save()
    return output.getvalue()


def docx(xml, **parts):
    output = BytesIO()
    with ZipFile(output, 'w') as archive:
        archive.writestr('word/document.xml', xml)
        for name, content in parts.items():
            archive.writestr(name, content)
    return output.getvalue()


def test_import_preserves_pdf_text_and_word_requirements_tables_notes_and_headers():
    assert 'No guaranteed savings.' in imports.extract_guidelines('rules.pdf', pdf('No guaranteed savings.'))['text']
    xml = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>Only qualified claims.</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Disclosure</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Always required</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:del><w:r><w:t>Deleted requirement</w:t></w:r></w:del>
      <w:ins><w:r><w:t>Current exception</w:t></w:r></w:ins>
      <w:drawing/><w:numPr/>
    </w:body></w:document>'''
    header = '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Advertiser name</w:t></w:r></w:p></w:hdr>'
    result = imports.extract_guidelines('rules.docx', docx(xml, **{'word/header1.xml': header}))
    for expected in ['Only qualified claims.', 'Disclosure', 'Always required', 'Current exception', 'Advertiser name']:
        assert expected in result['text']
    assert 'Deleted requirement' not in result['text']
    assert any('images' in warning for warning in result['warnings'])
    assert any('numbering' in warning for warning in result['warnings'])


def test_scanned_pdf_renders_to_ocr_without_retaining_files(monkeypatch):
    from app.review_pipeline import ocr
    seen = []
    class FakeOCR:
        def recognize(self, path):
            assert path.exists()
            assert path.read_bytes().startswith(b'\x89PNG')
            seen.append(path)
            return 'Recognized disclosure.'
    monkeypatch.setattr(ocr, 'initialize_ocr', lambda: FakeOCR())
    result = imports.extract_guidelines('scanned.pdf', pdf())
    assert result['text'] == 'Recognized disclosure.'
    assert any('recognition' in warning for warning in result['warnings'])
    assert all(not path.exists() for path in seen)


@pytest.mark.parametrize('name,data,status', [
    ('empty.txt', b'', 422), ('rules.doc', b'word', 415), ('rules.pdf', b'fake pdf', 422),
    ('rules.docx', b'broken zip', 422), ('rules.txt', b'\xfftext', 422),
    ('rules.txt', b'a' * 200001, 422), ('rules.pdf', b'a' * (10 * 1024 * 1024 + 1), 413),
    ('rules.docx', docx('<!DOCTYPE foo [<!ENTITY x "external">]><foo>&x;</foo>'), 422),
])
def test_invalid_import_never_returns_partial_success(name, data, status):
    with pytest.raises(HTTPException) as caught:
        imports.extract_guidelines(name, data)
    assert caught.value.status_code == status


def test_encrypted_pdf_and_page_bounds():
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.encrypt('password')
    output = BytesIO(); writer.write(output)
    with pytest.raises(HTTPException, match='password-protected'):
        imports.extract_guidelines('locked.pdf', output.getvalue())
    writer = PdfWriter()
    for _ in range(101):
        writer.add_blank_page(width=100, height=100)
    output = BytesIO(); writer.write(output)
    with pytest.raises(HTTPException, match='100 pages'):
        imports.extract_guidelines('long.pdf', output.getvalue())


def test_utf16_and_no_text_pdf(monkeypatch):
    assert imports.extract_guidelines('rules.txt', 'Qualified claims only.'.encode('utf-16'))['text'] == 'Qualified claims only.'
    monkeypatch.setattr(imports, 'scan_page', lambda *_: '')
    with pytest.raises(HTTPException, match='No readable text'):
        imports.extract_guidelines('blank.pdf', pdf())


def test_organization_only_renders_exact_source_wording_and_accounts_for_every_block():
    blocks = organizer.source_blocks(' Page 1\nNo guaranteed savings.\nException: only with evidence.\n')
    plan = organizer.Organization(sections=[organizer.Section(heading='General requirements', block_ids=[2, 1])], removed=[organizer.Removal(block_id=0, reason='Page number')])
    result = organizer.render_organization(blocks, plan)
    assert result['text'] == '## General requirements\n\nNo guaranteed savings.\nException: only with evidence.'
    assert result['removed'] == [{'text': 'Page 1', 'reason': 'Page number'}]
    for ids in [[1], [1, 1], [1, 3], [-1, 1]]:
        invalid = plan.model_copy(update={'sections': [organizer.Section(heading='General requirements', block_ids=ids)]})
        with pytest.raises(ValueError):
            organizer.render_organization(blocks, invalid)
    many_lines = '\n'.join(f'Rule {i}.' for i in range(1601))
    assert '\n'.join(organizer.source_blocks(many_lines)) == many_lines


@pytest.mark.anyio
async def test_invalid_ai_plan_fails_closed_and_missing_provider_leaves_original(monkeypatch):
    async def invalid(_):
        return organizer.Organization(sections=[organizer.Section(heading='General requirements', block_ids=[0])], removed=[])
    monkeypatch.setattr(organizer, 'request_organization', invalid)
    with pytest.raises(HTTPException) as caught:
        await organizer.organize_guidelines('Requirement\nException')
    assert caught.value.status_code == 502
    monkeypatch.undo()
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)
    with pytest.raises(HTTPException) as caught:
        await organizer.request_organization(['Requirement'])
    assert caught.value.status_code == 503


@pytest.mark.anyio
async def test_organizer_uses_existing_model_and_privacy_settings(monkeypatch):
    monkeypatch.setenv('OPENROUTER_API_KEY', 'dummy-test-key')
    monkeypatch.setenv('OPENROUTER_MODEL', 'configured-review-model')
    monkeypatch.setenv('OPENROUTER_ZDR', 'true')
    monkeypatch.setenv('OPENROUTER_DATA_COLLECTION', 'deny')
    seen = []
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        async def post(self, url, **kwargs):
            import httpx
            seen.append((url, kwargs))
            return httpx.Response(200, request=httpx.Request('POST', url), json={'choices': [{'message': {'content': '{"sections":[{"heading":"General requirements","block_ids":[0]}],"removed":[]}'}}]})
    monkeypatch.setattr(organizer.httpx, 'AsyncClient', Client)
    result = await organizer.organize_guidelines('Do not promise guaranteed savings.')
    assert result['text'].endswith('Do not promise guaranteed savings.')
    body = seen[0][1]['json']
    assert body['model'] == 'configured-review-model'
    assert body['provider']['zdr'] and body['provider']['data_collection'] == 'deny'
    assert body['response_format']['json_schema']['strict']
    assert 'untrusted source material' in body['messages'][0]['content']
