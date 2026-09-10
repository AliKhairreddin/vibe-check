"""Verify bundled PaddleOCR offline, including concurrent jobs and frame reuse.

Run inside the production Linux image. No creative data or model API is used.
"""
from concurrent.futures import ThreadPoolExecutor
import multiprocessing
import os
from pathlib import Path
import queue
import resource
import signal
import statistics
import sys
import tempfile
import time

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.review_pipeline.ocr import initialize_ocr, run_ocr, shutdown_ocr


def create_creatives(root):
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 30)
    paths = []
    for creative in range(5):
        directory = root / f'creative-{creative}'
        directory.mkdir()
        paths.append(directory)
        for frame in range(4):
            image = Image.new('RGB', (640, 960), 'white')
            draw = ImageDraw.Draw(image)
            lines = [f'Creative number {creative + 1}', f'Coverage example {frame + 1}',
                     'Insurance from $19.99', 'Compare available options',
                     'Savings vary by location', 'Terms and eligibility apply']
            for line, text in enumerate(lines):
                draw.text((30, 90 + line * 110), text, font=font, fill='black')
            for repeat in range(2):
                image.save(directory / f'{frame * 2 + repeat:03}.jpg', quality=95)
    return paths


def measure(result_queue, root, workers, threads):
    os.setsid()
    if hasattr(os, 'sched_getaffinity'):
        os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:4])
    os.environ['OCR_WORKER_CONCURRENCY'] = str(workers)
    os.environ['OCR_CPU_THREADS'] = str(threads)
    try:
        paths = sorted(Path(root).glob('creative-*'))
        records = [{'filename': f'{i:03}.jpg', 'timestamp': float(i)} for i in range(8)]
        start = time.perf_counter()
        initialize_ocr()
        initialization = time.perf_counter() - start
        baseline = [run_ocr(path, records) for path in paths]
        for index, result in enumerate(baseline):
            assert result.coverage()['status'] == 'complete', 'OCR coverage was incomplete'
            assert result.successful_frames == 8
            rows = result.rows
            assert len(rows) == 4, 'Identical frames were not deduplicated'
            assert [row['timestamp'] for row in rows] == [0., 2., 4., 6.]
            for row in rows:
                assert f'Creative number {index + 1}' in row['text'], 'Creative identity was lost'
                assert '19.99' in row['text'], 'The sample price was not recognized'
        measurements = {}
        for jobs in (1, 5):
            times = []
            for _ in range(2):
                start = time.perf_counter()
                with ThreadPoolExecutor(max_workers=jobs) as executor:
                    outputs = list(executor.map(lambda p: run_ocr(p, records), paths[:jobs]))
                times.append(time.perf_counter() - start)
                assert outputs == baseline[:jobs], 'Concurrent OCR changed text or timestamps'
            measurements[jobs] = statistics.median(times)
        result_queue.put({'initialization': initialization, 'seconds': measurements,
                          'peak_rss_mib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024})
        shutdown_ocr()
    except Exception as error:
        result_queue.put({'error': str(error)})


def run_case(root, workers, threads):
    context = multiprocessing.get_context('spawn')
    results = context.Queue()
    process = context.Process(target=measure, args=(results, root, workers, threads))
    process.start()
    try:
        result = results.get(timeout=90)
        if 'error' in result:
            raise RuntimeError(result['error'])
        return result
    except queue.Empty as error:
        raise RuntimeError('OCR verification exceeded its 90-second deadline') from error
    finally:
        process.join(timeout=2)
        if process.is_alive():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                process.kill()
            process.join(timeout=5)
        results.close()


def main():
    if not sys.platform.startswith('linux'):
        raise SystemExit('Run this verification in the production Linux container.')
    with tempfile.TemporaryDirectory(prefix='paddle-ocr-verify-') as root:
        create_creatives(Path(root))
        print('PP-OCRv6 small / ONNX Runtime; synthetic ad text, four unique frames per creative.', flush=True)
        print('| OCR predictors | Threads/predictor | Model startup (s) | One creative (s) | Five creatives (s) | Peak RSS (MiB) |', flush=True)
        print('|---|---|---|---|---|---|', flush=True)
        for workers, threads in [(1, 1), (2, 1), (2, 2)]:
            result = run_case(root, workers, threads)
            print(f"| {workers} | {threads} | {result['initialization']:.2f} | {result['seconds'][1]:.2f} | {result['seconds'][5]:.2f} | {result['peak_rss_mib']:.0f} |", flush=True)
        print('All cases preserved creative identity, prices, text and timestamps. No network access was needed.', flush=True)


if __name__ == '__main__':
    main()
