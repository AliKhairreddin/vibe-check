from __future__ import annotations

import re
import json
from pathlib import Path
from typing import Annotated
from pydantic import Field


VERTICAL_CATALOG = json.loads((Path(__file__).parents[1] / 'vertical_catalog.json').read_text())
VERTICAL_ID_PATTERN = r'^(?:' + '|'.join(re.escape(row[0]) for row in VERTICAL_CATALOG) + r'|custom-[a-z0-9][a-z0-9-]{0,72})$'
ReviewVertical = Annotated[str, Field(pattern=VERTICAL_ID_PATTERN)]

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
