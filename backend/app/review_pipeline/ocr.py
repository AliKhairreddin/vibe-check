from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from queue import Empty, Queue
from threading import Lock
import os
import re
import logging
import time

from PIL import Image

from .ocr_models import ENGINE_NAME, model_root, verify_models

logger = logging.getLogger(__name__)
OCR_ATTEMPTS = 3


@dataclass
class OcrResult:
    rows: list[dict] = field(default_factory=list)
    total_frames: int = 0
    successful_frames: int = 0
    failed_frames: list[dict] = field(default_factory=list)
    not_applicable: bool = False

    @classmethod
    def unavailable(cls, records: list[dict], reason: str, attempts: int = 0):
        return cls(total_frames=len(records), failed_frames=[
            {'filename': r['filename'], 'timestamp': r.get('timestamp'),
             'reason': reason, 'attempts': attempts} for r in records
        ])

    def coverage(self) -> dict:
        status = ('not_applicable' if self.not_applicable else
                  'unavailable' if not self.successful_frames else
                  'partial' if self.failed_frames else 'complete')
        limitations = []
        if status in {'partial', 'unavailable'}:
            limitations.append(
                f'On-screen text recognition was incomplete ({self.successful_frames} of '
                f'{self.total_frames} sampled frames read). The review continued with available '
                'evidence; unread text may include claims or disclosures. Missing OCR is not '
                'evidence that text or a required disclosure is absent.'
            )
        return {'engine': ENGINE_NAME, 'status': status, 'total_frames': self.total_frames,
                'successful_frames': self.successful_frames, 'failed_frames': self.failed_frames,
                'limitations': limitations}


def _retry_pause(attempt: int):
    time.sleep(0.25 * attempt)


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
            raise OcrError('OCR capacity did not become available.') from error
        try:
            results = list(engine.predict(str(frame)))
            if len(results) != 1 or not isinstance(results[0].get('rec_texts'), list):
                raise OcrError('OCR returned an invalid result.')
            return '\n'.join(results[0]['rec_texts'])
        except Exception as error:
            if isinstance(error, OcrError):
                raise
            raise OcrError(f'OCR could not read frame {frame.name}.') from error
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
            _pool = OcrPool(_setting('OCR_WORKER_CONCURRENCY', 2), _setting('OCR_CPU_THREADS', 2))
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
        'cpu_threads': _pool.threads if _pool else _setting('OCR_CPU_THREADS', 2),
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


def run_ocr(frames_dir: Path, frame_records: list[dict]) -> OcrResult:
    rows = []
    recognized = {}
    # Include expected but missing frames in coverage, too.
    ts_by_name = {r['filename']: r.get('timestamp') for r in frame_records}
    names = sorted(set(ts_by_name) | {p.name for p in frames_dir.glob('*.jpg')})
    records = [{'filename': name, 'timestamp': ts_by_name.get(name)} for name in names]
    result = OcrResult(total_frames=len(records))
    if not records:
        return result
    # Retry model initialization once per creative, not once per video frame.
    for attempt in range(1, OCR_ATTEMPTS + 1):
        try:
            pool = initialize_ocr()
            break
        except Exception:
            if attempt == OCR_ATTEMPTS:
                logger.exception('OCR unavailable after %s attempts; continuing without OCR.', attempt)
                return OcrResult.unavailable(records, 'engine_unavailable', attempt)
            _retry_pause(attempt)
    for record in records:
        frame = frames_dir / record['filename']
        for attempt in range(1, OCR_ATTEMPTS + 1):
            try:
                with Image.open(frame) as image:
                    key = (image.mode, image.size, sha256(image.tobytes()).digest())
                # Cache only successful recognition, including legitimate blank frames.
                if key not in recognized:
                    recognized[key] = normalize_text(pool.recognize(frame))
                rows.append({**record, 'text': recognized[key]})
                result.successful_frames += 1
                break
            except Exception:
                if attempt == OCR_ATTEMPTS:
                    logger.exception('OCR skipped frame %s after %s attempts.', frame.name, attempt)
                    result.failed_frames.append({**record, 'reason': 'frame_unreadable', 'attempts': attempt})
                else:
                    _retry_pause(attempt)
    result.rows = dedupe_ocr(rows)
    return result
