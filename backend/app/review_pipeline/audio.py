from __future__ import annotations
import base64, math, os, subprocess, tempfile, wave
from pathlib import Path
from typing import Any

import httpx

OPENROUTER_TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
DEFAULT_STT_MODEL = 'openai/whisper-large-v3'
DEFAULT_STT_CHUNK_SECONDS = 10.0
DEFAULT_STT_MAX_CHUNKS = 30

def extract_audio_command(video:Path, audio:Path)->list[str]:
    return ['ffmpeg','-y','-i',str(video),'-vn','-acodec','pcm_s16le','-ar','16000','-ac','1',str(audio)]

def extract_audio(video:Path, audio:Path)->bool:
    cp=subprocess.run(extract_audio_command(video,audio), capture_output=True)
    return cp.returncode == 0 and audio.exists() and audio.stat().st_size > 0

def _transcript_chunk(text:str, start:float|None=None, end:float|None=None)->dict[str, Any]:
    return {'timestamp_start':start,'timestamp_end':end,'text':text}

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

def _audio_duration_seconds(audio:Path)->float|None:
    try:
        with wave.open(str(audio), 'rb') as wav:
            rate = wav.getframerate()
            if rate <= 0:
                return None
            return wav.getnframes() / rate
    except (wave.Error, OSError, EOFError):
        return None

def _float_env(name:str, default:float)->float:
    try:
        return float(os.getenv(name, '').strip() or default)
    except ValueError:
        return default

def _int_env(name:str, default:int)->int:
    try:
        return int(os.getenv(name, '').strip() or default)
    except ValueError:
        return default

def _chunk_ranges(duration:float|None, chunk_seconds:float, max_chunks:int)->tuple[list[tuple[float|None, float|None]], bool]:
    if duration is None or duration <= 0 or chunk_seconds <= 0:
        return [(None, None)], False
    if duration <= chunk_seconds:
        return [(0.0, round(duration, 3))], False

    ranges=[]
    total_chunks=math.ceil(duration / chunk_seconds)
    for index in range(min(total_chunks, max(1, max_chunks))):
        start=round(index * chunk_seconds, 3)
        end=round(min(duration, start + chunk_seconds), 3)
        if end > start:
            ranges.append((start, end))
    return ranges or [(0.0, round(duration, 3))], total_chunks > len(ranges)

def _extract_audio_segment(source:Path, target:Path, start:float, duration:float)->None:
    subprocess.run(
        [
            'ffmpeg',
            '-y',
            '-ss',
            f'{start:.3f}',
            '-t',
            f'{duration:.3f}',
            '-i',
            str(source),
            '-acodec',
            'pcm_s16le',
            '-ar',
            '16000',
            '-ac',
            '1',
            str(target),
        ],
        check=True,
        capture_output=True,
    )

def _post_transcription(client:httpx.Client, audio:Path, model:str, language:str)->dict[str, Any]:
    payload=_openrouter_transcription_payload(audio, model)
    if language:
        payload['language']=language
    r=client.post(
        OPENROUTER_TRANSCRIPTIONS_URL,
        headers={'Authorization':f'Bearer {os.environ["OPENROUTER_API_KEY"]}','Content-Type':'application/json'},
        json=payload,
    )
    r.raise_for_status()
    return r.json()

def _merge_usage(total:dict[str, Any], usage:Any)->dict[str, Any]:
    if not isinstance(usage, dict):
        return total
    for key, value in usage.items():
        if isinstance(value, (int, float)) and isinstance(total.get(key), (int, float)):
            total[key] += value
        elif isinstance(value, (int, float)) and key not in total:
            total[key] = value
        elif key not in total:
            total[key] = value
    return total

def transcribe(audio:Path, manual_transcript:str='')->dict:
    manual=manual_transcript.strip()
    if manual:
        return {
            'source':'manual',
            'chunks':[_transcript_chunk(manual)],
            'limitations':['Manual transcript override does not include audio timing metadata.'],
        }

    if not audio.exists() or audio.stat().st_size == 0:
        return _unavailable_transcript('No extracted audio track was available for transcription.')

    key=os.getenv('OPENROUTER_API_KEY')
    if not key:
        return _unavailable_transcript('OPENROUTER_API_KEY is not configured; paste a manual transcript for transcript coverage.')

    model=os.getenv('OPENROUTER_STT_MODEL', DEFAULT_STT_MODEL).strip() or DEFAULT_STT_MODEL
    language=os.getenv('OPENROUTER_STT_LANGUAGE', '').strip()
    duration=_audio_duration_seconds(audio)
    chunk_seconds=max(0.0, _float_env('OPENROUTER_STT_CHUNK_SECONDS', DEFAULT_STT_CHUNK_SECONDS))
    max_chunks=max(1, _int_env('OPENROUTER_STT_MAX_CHUNKS', DEFAULT_STT_MAX_CHUNKS))
    ranges, truncated=_chunk_ranges(duration, chunk_seconds, max_chunks)

    try:
        with httpx.Client(timeout=120) as client:
            chunks=[]
            usage:dict[str, Any]={}
            limitations=[]
            if len(ranges) == 1 and ranges[0] == (None, None):
                data=_post_transcription(client, audio, model, language)
                text=str(data.get('text') or '').strip()
                usage=_merge_usage(usage, data.get('usage') or {})
                if text:
                    chunks.append(_transcript_chunk(text))
            elif len(ranges) == 1:
                start, end = ranges[0]
                data=_post_transcription(client, audio, model, language)
                text=str(data.get('text') or '').strip()
                usage=_merge_usage(usage, data.get('usage') or {})
                if text:
                    chunks.append(_transcript_chunk(text, start, end))
            else:
                with tempfile.TemporaryDirectory(prefix='stt-chunks-', dir=str(audio.parent)) as temp_dir:
                    temp_path=Path(temp_dir)
                    for index, (start, end) in enumerate(ranges):
                        if start is None or end is None:
                            continue
                        chunk_audio=temp_path/f'chunk_{index:04d}.wav'
                        try:
                            _extract_audio_segment(audio, chunk_audio, start, end-start)
                            data=_post_transcription(client, chunk_audio, model, language)
                        except httpx.HTTPStatusError as exc:
                            limitations.append(f'Transcription chunk {index + 1} failed with HTTP {exc.response.status_code}.')
                            continue
                        except (httpx.HTTPError, OSError, subprocess.CalledProcessError, ValueError):
                            limitations.append(f'Transcription chunk {index + 1} failed.')
                            continue
                        text=str(data.get('text') or '').strip()
                        usage=_merge_usage(usage, data.get('usage') or {})
                        if text:
                            chunks.append(_transcript_chunk(text, start, end))
            if truncated:
                limitations.append(f'Audio transcription was capped at {max_chunks} chunks of {chunk_seconds:g} seconds each.')
    except httpx.HTTPStatusError as exc:
        return _unavailable_transcript(f'OpenRouter transcription failed with HTTP {exc.response.status_code}; paste a manual transcript if needed.')
    except (httpx.HTTPError, OSError, ValueError) as exc:
        return _unavailable_transcript(f'OpenRouter transcription failed: {exc.__class__.__name__}; paste a manual transcript if needed.')

    if not chunks:
        limitations.append('OpenRouter transcription returned no text.')
    result={'source':'openrouter','model':model,'chunks':chunks, 'usage':usage}
    if limitations:
        result['limitations']=limitations
    return result
