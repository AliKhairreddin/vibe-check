"""Pinned model artifacts shared by the image build and the OCR runtime."""
from hashlib import sha256
import json
import os
from pathlib import Path

ENGINE_NAME = 'PP-OCRv6_small'
MANIFEST = Path(__file__).with_name('ocr-models.json')


def model_root() -> Path:
    return Path(os.getenv('OCR_MODEL_DIR', str(Path(__file__).resolve().parents[3] / 'data' / 'ocr-models')))


def model_manifest() -> dict:
    return json.loads(MANIFEST.read_text())


def verify_models() -> None:
    for model in model_manifest()['models']:
        for filename, expected in model['files'].items():
            path = model_root() / model['name'] / filename
            if not path.is_file() or sha256(path.read_bytes()).hexdigest() != expected:
                raise RuntimeError(f'OCR model missing or damaged: {model["name"]}/{filename}. '
                                   'Run python scripts/prepare-ocr-models.py before starting the backend.')
