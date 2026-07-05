from __future__ import annotations

from pathlib import Path
from typing import Literal

from PIL import Image, ImageOps

MediaKind = Literal['video', 'image']

IMAGE_CONTENT_TYPES = {'image/jpeg', 'image/png', 'image/webp'}
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}
VIDEO_CONTENT_TYPES = {'video/mp4'}
VIDEO_EXTENSIONS = {'.mp4'}


def normalize_content_type(content_type: str | None) -> str:
    return (content_type or '').split(';', 1)[0].strip().lower()


def detect_media_kind(file_name: str, content_type: str | None = None) -> MediaKind:
    content_type = normalize_content_type(content_type)
    extension = Path(file_name).suffix.lower()

    if content_type in IMAGE_CONTENT_TYPES:
        return 'image'
    if content_type in VIDEO_CONTENT_TYPES:
        return 'video'
    if extension in IMAGE_EXTENSIONS:
        return 'image'
    if extension in VIDEO_EXTENSIONS:
        return 'video'

    raise ValueError('Unsupported creative type. Upload an MP4, JPG, PNG, or WebP file.')


def image_metadata(image: Path) -> dict:
    with Image.open(image) as img:
        return {
            'format': img.format,
            'width': img.width,
            'height': img.height,
            'mode': img.mode,
        }


def _as_rgb(img: Image.Image) -> Image.Image:
    if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
        rgba = img.convert('RGBA')
        background = Image.new('RGB', rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel('A'))
        return background
    return img.convert('RGB')


def prepare_image_frame(image: Path, frames_dir: Path) -> list[dict]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    frame_path = frames_dir / 'frame_still.jpg'
    with Image.open(image) as img:
        frame = _as_rgb(ImageOps.exif_transpose(img))
        frame.save(frame_path, format='JPEG', quality=95)
    return [{'filename': frame_path.name, 'timestamp': None, 'source': 'still_image'}]
