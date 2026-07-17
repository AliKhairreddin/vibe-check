from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from .models import OfferProfile

DEFAULT_GUIDELINES_TITLE = 'General Publisher Ad Copy & Creative Guidelines'
DEFAULT_OFFER_ID = 'acp'
DEFAULT_OFFER_NAME = 'ACP'
DEFAULT_GUIDELINES_PATH = (
    Path(__file__).with_name('guidelines')
    / 'general_publisher_ad_creative_guidelines.md'
)


@lru_cache(maxsize=1)
def load_default_guidelines() -> str:
    return DEFAULT_GUIDELINES_PATH.read_text(encoding='utf-8').strip()


def built_in_acp_profile() -> OfferProfile:
    return OfferProfile(
        offer_id=DEFAULT_OFFER_ID,
        display_name=DEFAULT_OFFER_NAME,
        official_guidelines=load_default_guidelines(),
        enabled=True,
        is_default=True,
        version=1,
    )


def build_policy_context(
    additional_policy_text: str = '',
    offer_profile: OfferProfile | None = None,
) -> tuple[str, list[str]]:
    sections: list[str] = []
    sources: list[str] = []

    profile = offer_profile or built_in_acp_profile()
    if profile.official_guidelines.strip():
        sections.append(
            f'# Official Guidelines — {profile.display_name}\n\n'
            + profile.official_guidelines.strip()
        )
        if profile.offer_id == DEFAULT_OFFER_ID and profile.version == 1:
            sources.append(f'Saved {DEFAULT_GUIDELINES_TITLE}')
        else:
            sources.append(
                f'{profile.display_name} official guidelines (version {profile.version})'
            )

    additional_policy_text = additional_policy_text.strip()
    if additional_policy_text:
        sections.append(
            '## Additional Pasted Policy/Guidelines\n\n'
            + additional_policy_text
        )
        sources.append('Additional pasted policy/guidelines')

    return '\n\n'.join(sections), sources


def build_internal_override_context(offer_profile: OfferProfile) -> list[dict[str, str]]:
    return [
        {
            'override_id': override.override_id,
            'title': override.title,
            'guidance': override.guidance,
            'rationale': override.rationale,
        }
        for override in offer_profile.internal_overrides
        if override.enabled
    ]
