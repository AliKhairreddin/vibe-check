from __future__ import annotations
import json, subprocess
from pathlib import Path

def ffprobe_command(video:Path)->list[str]:
    return ['ffprobe','-v','error','-print_format','json','-show_format','-show_streams',str(video)]

def extract_frames_command(video:Path, out_pattern:Path, interval:float)->list[str]:
    fps = 1 / max(interval, 0.1)
    return ['ffmpeg','-y','-i',str(video),'-vf',f'fps={fps}', '-q:v','3', str(out_pattern)]

def scene_frames_command(video:Path, out_pattern:Path)->list[str]:
    return ['ffmpeg','-y','-i',str(video),'-vf',"select='gt(scene,0.35)',showinfo",'-vsync','vfr','-q:v','3',str(out_pattern)]

def metadata(video:Path)->dict:
    cp=subprocess.run(ffprobe_command(video), check=True, capture_output=True, text=True)
    return json.loads(cp.stdout or '{}')

def extract_frames(video:Path, frames_dir:Path, interval:float, scene_detection:bool=False)->list[dict]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    pattern=frames_dir/'frame_%06d.jpg'
    subprocess.run(extract_frames_command(video, pattern, interval), check=True, capture_output=True)
    if scene_detection:
        subprocess.run(scene_frames_command(video, frames_dir/'scene_%06d.jpg'), check=False, capture_output=True)
    frames=[]
    for i,p in enumerate(sorted(frames_dir.glob('*.jpg'))):
        ts = i * interval if p.name.startswith('frame_') else None
        if ts is not None:
            new=frames_dir/f'frame_{ts:010.3f}.jpg'; p.rename(new); p=new
        frames.append({'filename':p.name,'timestamp':ts})
    return frames
