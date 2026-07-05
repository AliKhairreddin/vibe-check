from __future__ import annotations
import base64, os, subprocess
from pathlib import Path
from typing import Any

import httpx

OPENROUTER_TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
DEFAULT_STT_MODEL = 'openai/whisper-large-v3'

def extract_audio_command(video:Path, audio:Path)->list[str]:
    return ['ffmpeg','-y','-i',str(video),'-vn','-acodec','pcm_s16le','-ar','16000','-ac','1',str(audio)]

def extract_audio(video:Path, audio:Path)->bool:
    cp=subprocess.run(extract_audio_command(video,audio), capture_output=True)
    return cp.returncode == 0 and audio.exists() and audio.stat().st_size > 0

def _transcript_chunk(text:str)->dict[str, Any]:
    return {'timestamp_start':None,'timestamp_end':None,'text':text}

def _unavailable_transcript(limitation:str)->dict[str, Any]:
    return {'source':'unavailable','chunks':[], 'limitations':[limitation]}

def _openrouter_transcription_payload(audio:Path, model:str)->dict[str, Any]:
    return {
        'model': model,
        'input_audio': {
            'data': base64.b64encode(audio.read_bytes()).decode('ascii'),
            'format': 'wav',
        },
    }

def transcribe(audio:Path, manual_transcript:str='')->dict:
    manual=manual_transcript.strip()
    if manual:
        return {'source':'manual','chunks':[_transcript_chunk(manual)]}

    if not audio.exists() or audio.stat().st_size == 0:
        return _unavailable_transcript('No extracted audio track was available for transcription.')

    key=os.getenv('OPENROUTER_API_KEY')
    if not key:
        return _unavailable_transcript('OPENROUTER_API_KEY is not configured; paste a manual transcript for transcript coverage.')

    model=os.getenv('OPENROUTER_STT_MODEL', DEFAULT_STT_MODEL).strip() or DEFAULT_STT_MODEL
    language=os.getenv('OPENROUTER_STT_LANGUAGE', '').strip()
    payload=_openrouter_transcription_payload(audio, model)
    if language:
        payload['language']=language

    try:
        with httpx.Client(timeout=120) as client:
            r=client.post(
                OPENROUTER_TRANSCRIPTIONS_URL,
                headers={'Authorization':f'Bearer {key}','Content-Type':'application/json'},
                json=payload,
            )
            r.raise_for_status()
            data=r.json()
    except httpx.HTTPStatusError as exc:
        return _unavailable_transcript(f'OpenRouter transcription failed with HTTP {exc.response.status_code}; paste a manual transcript if needed.')
    except (httpx.HTTPError, OSError, ValueError) as exc:
        return _unavailable_transcript(f'OpenRouter transcription failed: {exc.__class__.__name__}; paste a manual transcript if needed.')

    text=str(data.get('text') or '').strip()
    usage=data.get('usage') or {}
    if not text:
        return {'source':'openrouter','model':model,'chunks':[], 'usage':usage, 'limitations':['OpenRouter transcription returned no text.']}
    return {'source':'openrouter','model':model,'chunks':[_transcript_chunk(text)], 'usage':usage}
