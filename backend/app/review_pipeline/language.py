from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any


HAN_SCRIPT_PATTERN = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')


def contains_han_script(value: Any) -> bool:
    return isinstance(value, str) and bool(HAN_SCRIPT_PATTERN.search(value))


def first_han_script_field(fields: Iterable[tuple[str, Any]]) -> str | None:
    for name, value in fields:
        if contains_han_script(value):
            return name
        if isinstance(value, (list, tuple)):
            for item in value:
                if contains_han_script(item):
                    return name
    return None
