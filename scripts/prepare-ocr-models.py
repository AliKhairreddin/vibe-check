"""Download the evaluated model revisions at build time, never during a review."""
from hashlib import sha256
from pathlib import Path
import sys
import time
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.review_pipeline.ocr_models import model_manifest, model_root, verify_models


def prepare_models():
    for model in model_manifest()['models']:
        directory = model_root() / model['name']
        directory.mkdir(parents=True, exist_ok=True)
        for filename, expected in model['files'].items():
            destination = directory / filename
            if destination.is_file() and sha256(destination.read_bytes()).hexdigest() == expected:
                continue
            url = f'https://huggingface.co/{model["repository"]}/resolve/{model["revision"]}/{filename}'
            for attempt in range(3):
                try:
                    with urlopen(url, timeout=120) as response:
                        content = response.read()
                    if sha256(content).hexdigest() != expected:
                        raise RuntimeError(f'Checksum mismatch for {model["name"]}/{filename}')
                    temporary = destination.with_suffix(destination.suffix + '.tmp')
                    temporary.write_bytes(content)
                    temporary.replace(destination)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(2 * (attempt + 1))
    verify_models()
    print('Pinned PP-OCRv6 small detection and recognition models verified.')


if __name__ == '__main__':
    prepare_models()
