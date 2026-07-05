from __future__ import annotations

from functools import lru_cache
from pathlib import Path

DEFAULT_GUIDELINES_TITLE = 'General Publisher Ad Copy & Creative Guidelines'
DEFAULT_GUIDELINES_PATH = (
    Path(__file__).with_name('guidelines')
    / 'general_publisher_ad_creative_guidelines.md'
)


@lru_cache(maxsize=1)
def load_default_guidelines() -> str:
    return DEFAULT_GUIDELINES_PATH.read_text(encoding='utf-8').strip()


def build_policy_context(additional_policy_text: str = '') -> tuple[str, list[str]]:
    sections: list[str] = []
    sources: list[str] = []

    default_guidelines = load_default_guidelines()
    if default_guidelines:
        sections.append(default_guidelines)
        sources.append(f'Saved {DEFAULT_GUIDELINES_TITLE}')

    additional_policy_text = additional_policy_text.strip()
    if additional_policy_text:
        sections.append(
            '## Additional Pasted Policy/Guidelines\n\n'
            + additional_policy_text
        )
        sources.append('Additional pasted policy/guidelines')

    return '\n\n'.join(sections), sources
