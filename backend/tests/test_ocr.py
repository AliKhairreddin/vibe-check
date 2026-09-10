from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from unittest.mock import Mock
import sys
import time

from PIL import Image
import pytest

from app.review_pipeline import ocr, ocr_models


def save_frame(directory, name, color):
    Image.new('RGB', (24, 24), color).save(directory / name, format='PNG')


def fake_recognizer(monkeypatch, **kwargs):
    recognize = Mock(**kwargs)
    monkeypatch.setattr(ocr, 'initialize_ocr', lambda: SimpleNamespace(recognize=recognize))
    return recognize


def test_identical_pixels_are_recognized_once_and_keep_first_timestamp(tmp_path, monkeypatch):
    save_frame(tmp_path, '01.jpg', 'white')
    save_frame(tmp_path, '02.jpg', 'white')
    save_frame(tmp_path, '03.jpg', 'black')
    records = [{'filename': f'{i:02}.jpg', 'timestamp': i} for i in range(1, 4)]
    recognize = fake_recognizer(monkeypatch, side_effect=['Save  money\n', 'Terms apply'])
    rows = ocr.run_ocr(tmp_path, records)
    assert recognize.call_count == 2
    assert rows == [
        {'filename': '01.jpg', 'timestamp': 1, 'text': 'Save money'},
        {'filename': '03.jpg', 'timestamp': 3, 'text': 'Terms apply'},
    ]


def test_even_one_changed_pixel_gets_ocr(tmp_path, monkeypatch):
    save_frame(tmp_path, '01.jpg', 'white')
    with Image.open(tmp_path / '01.jpg') as image:
        image.putpixel((0, 0), (254, 255, 255))
        image.save(tmp_path / '02.jpg', format='PNG')
    recognize = fake_recognizer(monkeypatch, return_value='Same text')
    assert len(ocr.run_ocr(tmp_path, [])) == 1
    assert recognize.call_count == 2


def test_empty_recognition_is_valid_and_reused(tmp_path, monkeypatch):
    save_frame(tmp_path, '01.jpg', 'white')
    save_frame(tmp_path, '02.jpg', 'white')
    recognize = fake_recognizer(monkeypatch, return_value='')
    assert ocr.run_ocr(tmp_path, []) == []
    assert recognize.call_count == 1


def test_ocr_failure_does_not_silently_omit_evidence(tmp_path, monkeypatch):
    save_frame(tmp_path, '01.jpg', 'white')
    fake_recognizer(monkeypatch, side_effect=ocr.OcrError('Recognition failed'))
    with pytest.raises(ocr.OcrError, match='Recognition failed'):
        ocr.run_ocr(tmp_path, [])


def test_corrupt_frame_does_not_silently_omit_evidence(tmp_path):
    (tmp_path / '01.jpg').write_bytes(b'not an image')
    with pytest.raises(ocr.OcrError, match='could not open frame'):
        ocr.run_ocr(tmp_path, [])


def test_predictors_are_reused_but_never_shared_concurrently(monkeypatch):
    monkeypatch.setattr(ocr, 'verify_models', lambda: None)
    counter = {'active': 0, 'peak': 0}
    guard = Lock()
    engines = []

    class Engine:
        busy = False
        closed = False

        def predict(self, path):
            assert not self.busy
            self.busy = True
            with guard:
                counter['active'] += 1
                counter['peak'] = max(counter['peak'], counter['active'])
            try:
                time.sleep(0.01)
                yield {'rec_texts': [Path(path).name, 'Terms apply']}
            finally:
                self.busy = False
                with guard:
                    counter['active'] -= 1

        def close(self):
            self.closed = True

    def create(_threads):
        engine = Engine()
        engines.append(engine)
        return engine

    monkeypatch.setattr(ocr, '_create_engine', create)
    pool = ocr.OcrPool(2, 1)
    paths = [Path(f'creative-{i}.jpg') for i in range(10)]
    with ThreadPoolExecutor(max_workers=5) as executor:
        results = list(executor.map(pool.recognize, paths))
    assert results == [f'{p.name}\nTerms apply' for p in paths]
    assert len(engines) == counter['peak'] == 2
    pool.close()
    assert all(engine.closed for engine in engines)


def test_failed_prediction_returns_capacity_and_invalid_results_fail(monkeypatch):
    monkeypatch.setattr(ocr, 'verify_models', lambda: None)
    engine = Mock()
    engine.predict.side_effect = [RuntimeError('native error'), [{}], [{'rec_texts': []}], [{'rec_texts': ['Recovered']}]]
    monkeypatch.setattr(ocr, '_create_engine', lambda _: engine)
    pool = ocr.OcrPool(1, 1)
    for _ in range(2):
        with pytest.raises(ocr.OcrError):
            pool.recognize(Path('image.jpg'))
        assert pool.available.qsize() == 1
    assert pool.recognize(Path('blank.jpg')) == ''
    assert pool.recognize(Path('image.jpg')) == 'Recovered'


def test_models_must_pass_checksum_before_engine_initialization(tmp_path, monkeypatch):
    monkeypatch.setenv('OCR_MODEL_DIR', str(tmp_path))
    monkeypatch.setattr(ocr_models, 'model_manifest', lambda: {'models': [
        {'name': 'test-model', 'files': {'inference.onnx': sha256(b'expected').hexdigest()}}
    ]})
    with pytest.raises(RuntimeError, match='missing or damaged'):
        ocr_models.verify_models()
    (tmp_path / 'test-model').mkdir()
    artifact = tmp_path / 'test-model/inference.onnx'
    artifact.write_bytes(b'corrupt')
    with pytest.raises(RuntimeError, match='missing or damaged'):
        ocr_models.verify_models()
    artifact.write_bytes(b'expected')
    ocr_models.verify_models()


def test_startup_failure_never_marks_engine_ready(monkeypatch):
    monkeypatch.setattr(ocr, '_pool', None)
    monkeypatch.setattr(ocr, 'verify_models', Mock(side_effect=RuntimeError('Missing models')))
    with pytest.raises(RuntimeError, match='Missing models'):
        ocr.initialize_ocr()
    assert not ocr.ocr_state()['ready']


@pytest.mark.parametrize('threads', [1, 2])
def test_onnx_threads_and_cpu_provider_are_explicit(monkeypatch, threads):
    constructor = Mock()
    monkeypatch.setitem(sys.modules, 'paddleocr', SimpleNamespace(PaddleOCR=constructor))
    monkeypatch.setitem(sys.modules, 'cv2', SimpleNamespace(setNumThreads=Mock()))
    ocr._create_engine(threads)
    config = constructor.call_args.kwargs
    assert config['engine_config'] == {
        'intra_op_num_threads': threads, 'inter_op_num_threads': 1,
        'execution_mode': 'sequential', 'providers': ['CPUExecutionProvider'],
    }
    assert config['text_detection_model_name'] == 'PP-OCRv6_small_det'
    assert config['text_recognition_model_name'] == 'PP-OCRv6_small_rec'
    assert config['use_doc_orientation_classify'] is False
    assert config['use_doc_unwarping'] is False
    assert config['use_textline_orientation'] is False
