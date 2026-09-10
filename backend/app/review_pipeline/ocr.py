from __future__ import annotations
from pathlib import Path
from hashlib import sha256
from PIL import Image
import pytesseract, re

def normalize_text(text:str)->str:
    return re.sub(r'\s+',' ', text).strip()

def dedupe_ocr(items:list[dict])->list[dict]:
    seen=set(); out=[]
    for item in items:
        norm=normalize_text(item.get('text','')).lower()
        if not norm or norm in seen: continue
        seen.add(norm); item['text']=normalize_text(item.get('text','')); out.append(item)
    return out

def run_ocr(frames_dir:Path, frame_records:list[dict])->list[dict]:
    rows=[]
    recognized={}
    ts_by_name={r['filename']:r.get('timestamp') for r in frame_records}
    for frame in sorted(frames_dir.glob('*.jpg')):
        try:
            with Image.open(frame) as image:
                # Reuse only pixel-identical frames within this creative. Even a
                # one-pixel change still gets OCR; no text coverage is reduced.
                key=(image.mode, image.size, sha256(image.tobytes()).digest())
                if key not in recognized:
                    recognized[key]=pytesseract.image_to_string(image)
                text=recognized[key]
        except Exception: text=''
        rows.append({'filename':frame.name,'timestamp':ts_by_name.get(frame.name),'text':normalize_text(text)})
    return dedupe_ocr(rows)
