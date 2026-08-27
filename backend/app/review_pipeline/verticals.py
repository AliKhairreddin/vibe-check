from __future__ import annotations

import re
from typing import Literal


ReviewVertical = Literal['auto-insurance', 'home-insurance']

_HOME_TOKEN = re.compile(r'(^|[^A-Z0-9])HOME([^A-Z0-9]|$)', re.IGNORECASE)
_AUTO_TOKEN = re.compile(r'(^|[^A-Z0-9])AUTO([^A-Z0-9]|$)', re.IGNORECASE)


def classify_review_vertical(file_name: str) -> ReviewVertical:
    """Classify a creative by its explicit filename tokens.

    Home takes precedence if a filename contains both tokens. Existing files
    without either token remain in Auto Insurance because the current saved
    offer catalog is entirely auto-insurance focused.
    """
    if _HOME_TOKEN.search(file_name):
        return 'home-insurance'
    if _AUTO_TOKEN.search(file_name):
        return 'auto-insurance'
    return 'auto-insurance'
