from __future__ import annotations
from pathlib import Path
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
    ts_by_name={r['filename']:r.get('timestamp') for r in frame_records}
    for frame in sorted(frames_dir.glob('*.jpg')):
        try: text=pytesseract.image_to_string(Image.open(frame))
        except Exception: text=''
        rows.append({'filename':frame.name,'timestamp':ts_by_name.get(frame.name),'text':normalize_text(text)})
    return dedupe_ocr(rows)
