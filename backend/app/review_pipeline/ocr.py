from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from queue import Empty, Queue
from threading import Lock
import os
import re

from PIL import Image

from .ocr_models import ENGINE_NAME, model_root, verify_models


class OcrError(RuntimeError):
    pass


def _setting(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not 1 <= value <= 4:
        raise ValueError(f'{name} must be between 1 and 4')
    return value


def _create_engine(threads: int):
    # Models ship with the image. Startup must not probe model hosts.
    os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
    from paddleocr import PaddleOCR
    import cv2

    cv2.setNumThreads(1)
    return PaddleOCR(
        text_detection_model_name='PP-OCRv6_small_det',
        text_detection_model_dir=str(model_root() / 'PP-OCRv6_small_det'),
        text_recognition_model_name='PP-OCRv6_small_rec',
        text_recognition_model_dir=str(model_root() / 'PP-OCRv6_small_rec'),
        engine='onnxruntime',
        device='cpu',
        # cpu_threads only configures Paddle's runtime, not ONNX Runtime.
        engine_config={
            'intra_op_num_threads': threads,
            'inter_op_num_threads': 1,
            'execution_mode': 'sequential',
            'providers': ['CPUExecutionProvider'],
        },
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )


class OcrPool:
    """Persistent, independent predictors; never share one concurrently."""

    def __init__(self, workers: int, threads: int):
        verify_models()
        self.workers = workers
        self.threads = threads
        self.available = Queue(maxsize=workers)
        try:
            for _ in range(workers):
                self.available.put(_create_engine(threads))
        except Exception:
            self.close()
            raise

    def recognize(self, frame: Path) -> str:
        try:
            engine = self.available.get(timeout=120)
        except Empty as error:
            raise OcrError('OCR capacity did not become available. Please retry the review.') from error
        try:
            results = list(engine.predict(str(frame)))
            if len(results) != 1 or not isinstance(results[0].get('rec_texts'), list):
                raise OcrError('OCR returned an invalid result. Please retry the review.')
            return '\n'.join(results[0]['rec_texts'])
        except Exception as error:
            if isinstance(error, OcrError):
                raise
            raise OcrError(f'OCR could not read frame {frame.name}. Please retry the review.') from error
        finally:
            self.available.put(engine)

    def close(self):
        while True:
            try:
                self.available.get_nowait().close()
            except Empty:
                break


_pool: OcrPool | None = None
_pool_lock = Lock()


def initialize_ocr() -> OcrPool:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = OcrPool(_setting('OCR_WORKER_CONCURRENCY', 2), _setting('OCR_CPU_THREADS', 1))
        return _pool


def shutdown_ocr():
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None


def ocr_state() -> dict:
    return {
        'engine': ENGINE_NAME,
        'ready': _pool is not None,
        'workers': _pool.workers if _pool else _setting('OCR_WORKER_CONCURRENCY', 2),
        'cpu_threads': _pool.threads if _pool else _setting('OCR_CPU_THREADS', 1),
    }


def normalize_text(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def dedupe_ocr(items: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for item in items:
        norm = normalize_text(item.get('text', '')).lower()
        if not norm or norm in seen:
            continue
        seen.add(norm)
        item['text'] = normalize_text(item.get('text', ''))
        out.append(item)
    return out


def run_ocr(frames_dir: Path, frame_records: list[dict]) -> list[dict]:
    rows = []
    recognized = {}
    ts_by_name = {r['filename']: r.get('timestamp') for r in frame_records}
    for frame in sorted(frames_dir.glob('*.jpg')):
        try:
            with Image.open(frame) as image:
                key = (image.mode, image.size, sha256(image.tobytes()).digest())
        except Exception as error:
            raise OcrError(f'OCR could not open frame {frame.name}. Please retry the review.') from error
        # Reuse only pixel-identical frames within this creative. A changed
        # pixel still gets OCR; timestamps and text deduplication stay intact.
        if key not in recognized:
            recognized[key] = initialize_ocr().recognize(frame)
        rows.append({'filename': frame.name, 'timestamp': ts_by_name.get(frame.name),
                     'text': normalize_text(recognized[key])})
    return dedupe_ocr(rows)
