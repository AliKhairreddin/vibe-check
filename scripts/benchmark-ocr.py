"""Compare CPU/thread settings with real Tesseract, without calling an LLM.

The default corpus is synthetic ad text with repeated frames. Pass --frames-dir
to benchmark extracted creative frames instead. Timings are machine-specific.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

from PIL import Image, ImageDraw, ImageFont
import pytesseract

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.review_pipeline.ocr import dedupe_ocr, run_ocr


def baseline(directory, records):
    rows = []
    for record in records:
        with Image.open(directory / record['filename']) as image:
            text = pytesseract.image_to_string(image)
        rows.append({**record, 'text': text})
    return dedupe_ocr(rows)


def synthetic_frames(directory):
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 30)
    for index in range(4):
        image = Image.new('RGB', (640, 960), 'white')
        draw = ImageDraw.Draw(image)
        lines = [f'Coverage example {index + 1}', 'Compare available options',
                 'Choose a plan for your needs', 'Request a quote today',
                 'Savings vary by location', 'Terms and eligibility apply']
        for line, text in enumerate(lines):
            draw.text((30, 100 + line * 105), text, font=font, fill='black')
        for repeat in range(2):
            image.save(directory / f'{index * 2 + repeat:03}.jpg', quality=95)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frames-dir', type=Path)
    parser.add_argument('--repeats', type=int, default=2)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error('--repeats must be positive')
    if not hasattr(os, 'sched_setaffinity'):
        parser.error('Run on Linux to compare CPU allocations with process affinity')
    original_affinity = os.sched_getaffinity(0)
    cores = sorted(original_affinity)
    original_threads = os.environ.get('OMP_THREAD_LIMIT')
    with tempfile.TemporaryDirectory(prefix='vibe-ocr-benchmark-') as temp:
        directory = args.frames_dir or Path(temp)
        if not args.frames_dir:
            synthetic_frames(directory)
        records = [{'filename': p.name, 'timestamp': float(i)} for i, p in enumerate(sorted(directory.glob('*.jpg')))]
        if not records:
            parser.error('No .jpg frames found')
        print(f'Tesseract {pytesseract.get_tesseract_version()}; {len(cores)} CPUs available.\n')
        print(f'Corpus: {"supplied creative frames" if args.frames_dir else "synthetic ad text, 8 frames / 4 identical pairs"}.')
        print('This isolates OCR; it does not measure downloads, video decoding, or LLM latency.\n')
        print('| Concurrent creatives | CPUs | OCR threads | Reuse identical frames | Median seconds |')
        print('|---|---|---|---|---|')
        expected = None
        try:
            for jobs in (1, 5):
                cases = [(min(2, len(cores)), 4, False)]
                if len(cores) >= 4:
                    cases.append((4, 4, False))
                cases += [(min(4, len(cores)), 1, False), (min(4, len(cores)), 1, True)]
                for cpu_count, threads, reuse in cases:
                    os.sched_setaffinity(0, cores[:cpu_count])
                    os.environ['OMP_THREAD_LIMIT'] = str(threads)
                    durations = []
                    for _ in range(args.repeats):
                        started = time.perf_counter()
                        with ThreadPoolExecutor(max_workers=jobs) as pool:
                            outputs = list(pool.map(lambda _: (run_ocr if reuse else baseline)(directory, records), range(jobs)))
                        durations.append(time.perf_counter() - started)
                        if expected is None:
                            expected = outputs[0]
                            if not expected:
                                raise RuntimeError('OCR produced no text; cannot validate equivalence')
                        if any(output != expected for output in outputs):
                            raise RuntimeError('OCR output changed across settings')
                    print(f'| {jobs} | {cpu_count} | {threads} | {"yes" if reuse else "no"} | {statistics.median(durations):.3f} |', flush=True)
        finally:
            os.sched_setaffinity(0, original_affinity)
            if original_threads is None:
                os.environ.pop('OMP_THREAD_LIMIT', None)
            else:
                os.environ['OMP_THREAD_LIMIT'] = original_threads
        print('\nRecognized text and first-occurrence timestamps match across all runs.')
        if len(cores) < 4:
            print('\nFour-CPU comparison unavailable on this runner.')


if __name__ == '__main__':
    main()
