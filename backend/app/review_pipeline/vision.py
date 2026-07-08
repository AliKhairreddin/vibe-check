from __future__ import annotations

import base64, io, json, os, re
from pathlib import Path
from typing import Any

import httpx
from PIL import Image, ImageOps

OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions'
DEFAULT_VISION_MODEL = 'minimax/minimax-m3'
DEFAULT_MAX_FRAMES = 12
DEFAULT_MAX_IMAGE_EDGE = 1024
DEFAULT_JPEG_QUALITY = 75

VISION_SYSTEM_PROMPT = """You are a visual evidence extractor for ad creative review.
Return strict JSON only. Do not make the final compliance decision.

Inspect the attached frames for non-text visual elements that may matter to ad policy review:
people, objects, products, scenes, logos, badges, government-looking documents or seals,
medical-looking settings, cash/check imagery, crashes, fire, illness, fear imagery, and layout context.

Use supplied OCR only as context. Do not duplicate text-only OCR findings as visual risks.
For every attached frame, return one observation using the supplied filename and timestamp exactly.

Return exactly this JSON shape:
{
  "observations": [
    {
      "filename": "frame filename",
      "timestamp_start": "timestamp seconds or null",
      "timestamp_end": null,
      "scene": "plain visual scene description",
      "people": ["visible people or demographic cues, only if relevant"],
      "objects": ["visible objects/products/documents"],
      "logos": ["visible logos/marks, or descriptive uncertain label"],
      "policy_relevant_visual_risks": ["specific visual risk cues"],
      "confidence": "low" | "medium" | "high"
    }
  ],
  "limitations": ["important visual uncertainty, if any"]
}"""


def _truthy_env(name:str, default:bool=True)->bool:
    value=os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {'0','false','no','off','disabled'}


def _int_env(name:str, default:int)->int:
    try:
        return int(os.getenv(name, '').strip() or default)
    except ValueError:
        return default


def _load_json(text:str)->Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match=re.search(r'\{.*\}', text, re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def _as_list(value:Any)->list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _optional_timestamp(value:Any)->str|None:
    if value in (None, ''):
        return None
    if isinstance(value, (int, float)):
        return f'{value:.3f}'.rstrip('0').rstrip('.')
    return str(value)


def select_frame_records(frame_records:list[dict], max_frames:int)->list[dict]:
    if max_frames <= 0 or len(frame_records) <= max_frames:
        return list(frame_records)
    if max_frames == 1:
        return [frame_records[0]]

    step=(len(frame_records)-1)/(max_frames-1)
    selected=[]
    seen=set()
    for index in range(max_frames):
        frame_index=round(index * step)
        if frame_index in seen:
            continue
        seen.add(frame_index)
        selected.append(frame_records[frame_index])
    return selected


def _ocr_by_filename(ocr:list[dict])->dict[str, str]:
    return {
        str(item.get('filename')): str(item.get('text') or '')
        for item in ocr
        if item.get('filename')
    }


def _frame_data_url(frame_path:Path, max_edge:int, quality:int)->str:
    with Image.open(frame_path) as image:
        frame=ImageOps.exif_transpose(image).convert('RGB')
        if max_edge > 0:
            frame.thumbnail((max_edge, max_edge))
        buffer=io.BytesIO()
        frame.save(buffer, format='JPEG', quality=max(1, min(95, quality)), optimize=True)
    encoded=base64.b64encode(buffer.getvalue()).decode('ascii')
    return f'data:image/jpeg;base64,{encoded}'


def _frame_content(
    frames_dir:Path,
    frame_records:list[dict],
    ocr:list[dict],
    max_edge:int,
    quality:int,
)->tuple[list[dict[str, Any]], list[dict], list[str]]:
    content=[]
    included=[]
    limitations=[]
    ocr_lookup=_ocr_by_filename(ocr)
    for index, record in enumerate(frame_records, start=1):
        filename=str(record.get('filename') or '')
        frame_path=frames_dir/filename
        if not filename or not frame_path.exists():
            limitations.append(f'Frame {filename or index} was unavailable for vision review.')
            continue

        timestamp=_optional_timestamp(record.get('timestamp'))
        ocr_text=ocr_lookup.get(filename, '')
        content.append({
            'type':'text',
            'text':(
                f'Frame {index} metadata:\n'
                f'filename: {filename}\n'
                f'timestamp_start: {timestamp or "null"}\n'
                f'timestamp_end: null\n'
                f'ocr_text: {ocr_text or "none"}'
            ),
        })
        content.append({
            'type':'image_url',
            'image_url': {'url': _frame_data_url(frame_path, max_edge, quality)},
        })
        included.append(record)
    return content, included, limitations


def _normalize_observation(item:Any, fallback:dict|None=None)->dict[str, Any]|None:
    if not isinstance(item, dict):
        return None
    fallback=fallback or {}
    filename=str(item.get('filename') or fallback.get('filename') or '').strip()
    timestamp=_optional_timestamp(
        item.get('timestamp_start')
        or item.get('timestampStart')
        or item.get('timestamp')
        or fallback.get('timestamp')
    )
    scene=str(item.get('scene') or item.get('description') or '').strip()
    risks=_as_list(
        item.get('policy_relevant_visual_risks')
        or item.get('policyRelevantVisualRisks')
        or item.get('visual_risks')
        or item.get('risks')
    )
    if not any((filename, scene, risks)):
        return None
    confidence=str(item.get('confidence') or 'medium').strip().lower()
    if confidence not in {'low','medium','high'}:
        confidence='medium'
    return {
        'filename': filename,
        'timestamp_start': timestamp,
        'timestamp_end': _optional_timestamp(item.get('timestamp_end') or item.get('timestampEnd')),
        'scene': scene,
        'people': _as_list(item.get('people')),
        'objects': _as_list(item.get('objects') or item.get('products')),
        'logos': _as_list(item.get('logos') or item.get('marks') or item.get('brands')),
        'policy_relevant_visual_risks': risks,
        'confidence': confidence,
    }


def _parse_visual_response(text:str, frame_records:list[dict])->tuple[list[dict], list[str]]:
    data=_load_json(text)
    observations=data.get('observations') if isinstance(data, dict) else data
    if not isinstance(observations, list):
        observations=[]
    normalized=[]
    for index, item in enumerate(observations):
        fallback=frame_records[index] if index < len(frame_records) else None
        observation=_normalize_observation(item, fallback)
        if observation:
            normalized.append(observation)
    limitations=_as_list(data.get('limitations')) if isinstance(data, dict) else []
    return normalized, limitations


async def observe_frames_with_openrouter(frames_dir:Path, frame_records:list[dict], ocr:list[dict])->dict[str, Any]:
    if not frame_records:
        return {'source':'not_applicable','observations':[], 'limitations':['No frames were available for visual review.']}
    if not _truthy_env('OPENROUTER_VISION_ENABLED', True):
        return {'source':'disabled','observations':[], 'limitations':['Vision review is disabled by OPENROUTER_VISION_ENABLED.']}

    key=os.getenv('OPENROUTER_API_KEY')
    if not key:
        return {'source':'unavailable','observations':[], 'limitations':['OPENROUTER_API_KEY is not configured; visual frame review was skipped.']}

    model=os.getenv('OPENROUTER_VISION_MODEL', DEFAULT_VISION_MODEL).strip() or DEFAULT_VISION_MODEL
    max_frames=max(1, _int_env('OPENROUTER_VISION_MAX_FRAMES', DEFAULT_MAX_FRAMES))
    max_edge=max(1, _int_env('OPENROUTER_VISION_MAX_IMAGE_EDGE', DEFAULT_MAX_IMAGE_EDGE))
    quality=max(1, _int_env('OPENROUTER_VISION_JPEG_QUALITY', DEFAULT_JPEG_QUALITY))
    selected=select_frame_records(frame_records, max_frames)
    frame_content, included, limitations=_frame_content(frames_dir, selected, ocr, max_edge, quality)

    if not included:
        return {'source':'unavailable','model':model,'observations':[], 'limitations':limitations or ['No frame files were available for visual review.']}

    content=[{
        'type':'text',
        'text':(
            'Extract compact visual observations from these ad creative frames. '
            'Use timestamps from the per-frame metadata. Return JSON only.'
        ),
    }, *frame_content]
    payload={
        'model': model,
        'messages': [
            {'role':'system','content':VISION_SYSTEM_PROMPT},
            {'role':'user','content':content},
        ],
        'response_format': {'type':'json_object'},
        'temperature': 0,
    }

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response=await client.post(
                OPENROUTER_CHAT_COMPLETIONS_URL,
                headers={'Authorization':f'Bearer {key}','Content-Type':'application/json'},
                json=payload,
            )
            response.raise_for_status()
            text=response.json()['choices'][0]['message']['content']
        observations, model_limitations=_parse_visual_response(text, included)
    except httpx.HTTPStatusError as exc:
        return {
            'source':'unavailable',
            'model':model,
            'observations':[],
            'frame_count':len(included),
            'limitations':limitations + [f'OpenRouter vision review failed with HTTP {exc.response.status_code}.'],
        }
    except (httpx.HTTPError, OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        return {
            'source':'unavailable',
            'model':model,
            'observations':[],
            'frame_count':len(included),
            'limitations':limitations + [f'OpenRouter vision review failed: {exc.__class__.__name__}.'],
        }

    return {
        'source':'openrouter_vision',
        'model':model,
        'frame_count':len(included),
        'observations':observations,
        'limitations':limitations + model_limitations,
    }
