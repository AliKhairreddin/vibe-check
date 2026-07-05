from __future__ import annotations
import subprocess
from pathlib import Path

def extract_audio_command(video:Path, audio:Path)->list[str]:
    return ['ffmpeg','-y','-i',str(video),'-vn','-acodec','pcm_s16le','-ar','16000','-ac','1',str(audio)]

def extract_audio(video:Path, audio:Path)->bool:
    cp=subprocess.run(extract_audio_command(video,audio), capture_output=True)
    return cp.returncode == 0 and audio.exists() and audio.stat().st_size > 0

def transcribe(audio:Path, manual_transcript:str='')->dict:
    if manual_transcript.strip():
        return {'source':'manual','chunks':[{'timestamp_start':None,'timestamp_end':None,'text':manual_transcript.strip()}]}
    return {'source':'unavailable','chunks':[], 'limitations':['No ASR configured; paste a manual transcript for MVP transcription.']}
