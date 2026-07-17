from __future__ import annotations

from typing import Any


KNOWN_OFFERS: tuple[dict[str, str], ...] = (
    {'offer_id': 'acp', 'display_name': 'ACP'},
    {'offer_id': 'kissterra', 'display_name': 'Kissterra'},
    {'offer_id': 'lead-economy', 'display_name': 'Lead Economy'},
    {'offer_id': 'smart-financial', 'display_name': 'Smart Financial'},
)

KNOWN_OFFER_IDS = tuple(offer['offer_id'] for offer in KNOWN_OFFERS)
KNOWN_OFFER_NAMES = {
    offer['offer_id']: offer['display_name']
    for offer in KNOWN_OFFERS
}


def offer_sort_key(value: Any) -> tuple[int, str]:
    offer_id = getattr(value, 'offer_id', None)
    if offer_id is None and isinstance(value, dict):
        offer_id = value.get('offer_id')
    normalized = str(offer_id or '')
    try:
        return KNOWN_OFFER_IDS.index(normalized), normalized
    except ValueError:
        return len(KNOWN_OFFER_IDS), normalized
