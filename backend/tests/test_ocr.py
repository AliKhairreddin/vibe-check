from unittest.mock import patch

from PIL import Image

from app.review_pipeline.ocr import run_ocr


def save_frame(directory, name, color):
    Image.new('RGB', (24, 24), color).save(directory / name, format='PNG')


def test_identical_pixels_are_recognized_once_and_keep_first_timestamp(tmp_path):
    save_frame(tmp_path, '01.jpg', 'white')
    save_frame(tmp_path, '02.jpg', 'white')
    save_frame(tmp_path, '03.jpg', 'black')
    records = [{'filename': f'{i:02}.jpg', 'timestamp': i} for i in range(1, 4)]
    with patch('app.review_pipeline.ocr.pytesseract.image_to_string', side_effect=['Save  money\n', 'Terms apply']) as recognize:
        rows = run_ocr(tmp_path, records)
    assert recognize.call_count == 2
    assert rows == [
        {'filename': '01.jpg', 'timestamp': 1, 'text': 'Save money'},
        {'filename': '03.jpg', 'timestamp': 3, 'text': 'Terms apply'},
    ]


def test_even_one_changed_pixel_gets_ocr(tmp_path):
    save_frame(tmp_path, '01.jpg', 'white')
    with Image.open(tmp_path / '01.jpg') as image:
        image.putpixel((0, 0), (254, 255, 255))
        image.save(tmp_path / '02.jpg', format='PNG')
    with patch('app.review_pipeline.ocr.pytesseract.image_to_string', return_value='Same text') as recognize:
        rows = run_ocr(tmp_path, [])
    assert recognize.call_count == 2
    assert len(rows) == 1


def test_failed_ocr_is_retried_on_duplicate_and_bad_images_do_not_abort(tmp_path):
    (tmp_path / '00.jpg').write_bytes(b'not an image')
    save_frame(tmp_path, '01.jpg', 'white')
    save_frame(tmp_path, '02.jpg', 'white')
    with patch('app.review_pipeline.ocr.pytesseract.image_to_string', side_effect=[RuntimeError('transient'), 'Recovered text']) as recognize:
        rows = run_ocr(tmp_path, [])
    assert recognize.call_count == 2
    assert rows == [{'filename': '02.jpg', 'timestamp': None, 'text': 'Recovered text'}]
