"""One-time guideline extraction. Source files are never retained or published."""
from io import BytesIO
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from threading import Lock
from zipfile import ZipFile

from defusedxml import ElementTree
from fastapi import HTTPException
from pypdf import PdfReader

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TEXT_LENGTH = 200_000
MAX_PAGES = 100
MAX_SCAN_PAGES = 10
_pdfium_lock = Lock()  # PDFium calls must be serialized within a process.
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def reject(message):
    raise HTTPException(422, message)


def bounded_text(text):
    text = text.replace('\x00', '').strip()
    if len(text) > MAX_TEXT_LENGTH:
        reject('This document contains more than 200,000 characters. Split or shorten it before importing.')
    return text


def scan_page(data, index):
    import pypdfium2 as pdfium
    from .review_pipeline.ocr import initialize_ocr
    with TemporaryDirectory(prefix='guideline-import-') as directory:
        target = Path(directory) / 'page.png'
        with _pdfium_lock:
            with pdfium.PdfDocument(data) as pdf:
                page = pdf[index]
                try:
                    width, height = page.get_size()
                    if min(width, height) <= 0:
                        reject('This PDF has an invalid page size. Export it again and retry.')
                    bitmap = page.render(scale=min(2.5, 2200 / max(width, height)))
                    try:
                        image = bitmap.to_pil()
                        try:
                            image.save(target)
                        finally:
                            image.close()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        return initialize_ocr().recognize(target).strip()


def pdf_text(data):
    reader = PdfReader(BytesIO(data))
    if reader.is_encrypted:
        reject('This PDF is password-protected. Upload an unlocked copy.')
    if not 1 <= len(reader.pages) <= MAX_PAGES:
        reject('PDF imports support up to 100 pages. Split the document and append each part.')
    parts, scanned, unread = [], [], []
    for index, page in enumerate(reader.pages):
        text = (page.extract_text() or '').strip()
        if not text:
            if len(scanned) >= MAX_SCAN_PAGES:
                reject('This PDF needs text recognition on more than 10 pages. Split it into smaller PDFs and append each part.')
            scanned.append(index + 1)
            text = scan_page(data, index)
            if not text:
                unread.append(index + 1)
        parts.append(text)
        bounded_text('\n\n'.join(parts))
    warnings = ['Review extracted text, especially tables, columns, symbols, and any text embedded in images.']
    if scanned:
        warnings.append(f'Text recognition was used on {len(scanned)} page(s). Check the recognized wording before saving.')
    if unread:
        warnings.append('No text was found on page(s) ' + ', '.join(map(str, unread)) + '. These may be blank or unreadable; check the original before saving.')
    return '\n\n'.join(parts), warnings


def docx_text(data):
    with ZipFile(BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(entry.file_size for entry in entries) > 40 * 1024 * 1024:
            reject('This Word document is too large when expanded. Export a smaller document and retry.')
        names = set(archive.namelist())
        if 'word/document.xml' not in names:
            reject('This is not a valid Word .docx document. Export it as .docx and retry.')
        selected = ['word/document.xml'] + sorted(name for name in names if re.fullmatch(r'word/(?:header\d+|footer\d+|footnotes|endnotes)\.xml', name))
        parts, has_images, has_lists = [], False, False
        for name in selected:
            root = ElementTree.fromstring(archive.read(name), forbid_dtd=True)
            has_images |= any(node.tag in {W + 'drawing', W + 'pict', W + 'object'} for node in root.iter())
            has_lists |= any(node.tag == W + 'numPr' for node in root.iter())
            chunks = []
            def walk(node):
                if node.tag in {W + 'del', W + 'moveFrom'}:
                    return  # Import final text, excluding deleted tracked changes.
                if node.tag == W + 't':
                    chunks.append(node.text or '')
                elif node.tag in {W + 'tab', W + 'tc'}:
                    chunks.append('\t')
                elif node.tag in {W + 'br', W + 'cr'}:
                    chunks.append('\n')
                for child in node:
                    walk(child)
                if node.tag in {W + 'p', W + 'tr'}:
                    chunks.append('\n')
            walk(root)
            text = ''.join(chunks).strip()
            if text:
                parts.append(text)
        warnings = ['Review extracted text and table layout before saving. Word styling is converted to plain text.']
        if has_lists:
            warnings.append('Automatic list numbering may not be retained. Check numbered requirements against the original.')
        if has_images:
            warnings.append('This Word document contains images or embedded objects. Their text is not included; paste that wording or upload a PDF copy for text recognition.')
        return '\n\n'.join(parts), warnings


def extract_guidelines(filename: str, data: bytes):
    if not data:
        reject('The file is empty.')
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, 'Upload a file of 10 MB or less.')
    extension = Path(filename).suffix.lower()
    try:
        if extension == '.pdf':
            if not data.lstrip().startswith(b'%PDF-'):
                reject('This file is not a valid PDF.')
            text, warnings = pdf_text(data)
        elif extension == '.docx':
            text, warnings = docx_text(data)
        elif extension in {'.txt', '.md'}:
            encoding = 'utf-16' if data.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
            text, warnings = data.decode(encoding), []
        else:
            raise HTTPException(415, 'Choose a PDF, Word (.docx), text (.txt), or Markdown (.md) file. For older .doc files, save a .docx or PDF copy first.')
    except HTTPException:
        raise
    except UnicodeError:
        reject('Save the text file as UTF-8 or UTF-16 and try again.')
    except Exception:
        reject('This document could not be read completely. Try an unlocked PDF, export a new .docx, or paste the text. Your saved guidelines have not changed.')
    text = bounded_text(text)
    if not text:
        reject('No readable text was found. Try a clearer document or paste the guidelines.')
    return {'filename': Path(filename).name, 'text': text, 'warnings': warnings}
