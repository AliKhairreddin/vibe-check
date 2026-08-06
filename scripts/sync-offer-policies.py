#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENV_PYTHON = ROOT / '.venv' / 'bin' / 'python'
try:
    import pydantic  # noqa: F401
except ModuleNotFoundError:
    if VENV_PYTHON.exists() and Path(sys.executable).resolve() != VENV_PYTHON.resolve():
        os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv])
    raise RuntimeError('Install backend/requirements.txt or create the repository .venv first.')
sys.path.insert(0, str(ROOT / 'backend'))

from app.review_pipeline.policy_seeds import seeded_offer_inputs  # noqa: E402


DEFAULT_DEPLOYMENT = 'prod:energetic-partridge-813'


def _convex_env(deployment: str) -> dict[str, str]:
    return {**os.environ, 'CONVEX_DEPLOYMENT': deployment}


def _read_http_secret(deployment: str) -> str:
    configured = os.getenv('CONVEX_HTTP_SECRET', '').strip()
    if configured:
        return configured
    result = subprocess.run(
        ['pnpm', 'exec', 'convex', 'env', 'get', 'CONVEX_HTTP_SECRET'],
        cwd=ROOT,
        env=_convex_env(deployment),
        check=True,
        capture_output=True,
        text=True,
    )
    secret = result.stdout.strip()
    if not secret:
        raise RuntimeError('CONVEX_HTTP_SECRET is not configured for the selected deployment.')
    return secret


def _convex_json(deployment: str, function_name: str, payload: dict[str, object]):
    result = subprocess.run(
        [
            'pnpm',
            'exec',
            'convex',
            'run',
            function_name,
            json.dumps(payload, ensure_ascii=False),
        ],
        cwd=ROOT,
        env=_convex_env(deployment),
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def _matches(existing: dict[str, object], payload: dict[str, object]) -> bool:
    return (
        existing.get('display_name') == payload['displayName']
        and existing.get('official_guidelines') == payload['officialGuidelines']
        and existing.get('internal_overrides') == [
            {
                'override_id': override['overrideId'],
                'title': override['title'],
                'guidance': override['guidance'],
                'rationale': override['rationale'],
                'enabled': override['enabled'],
            }
            for override in payload['internalOverrides']  # type: ignore[union-attr]
        ]
        and existing.get('enabled') == payload['enabled']
        and existing.get('is_default') == payload['isDefault']
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Publish the source-controlled auto-insurance offer policies to Convex.'
    )
    parser.add_argument(
        '--deployment',
        default=os.getenv('CONVEX_DEPLOYMENT', DEFAULT_DEPLOYMENT),
        help='Convex deployment selector.',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Validate and summarize policy profiles without changing Convex.',
    )
    args = parser.parse_args()

    profiles = seeded_offer_inputs()
    for offer_id, profile in profiles.items():
        print(
            f'{offer_id}: {len(profile.official_guidelines):,} guideline characters, '
            f'{len(profile.internal_overrides)} current internal rules'
        )
    if args.dry_run:
        return 0

    secret = _read_http_secret(args.deployment)
    current = _convex_json(
        args.deployment,
        'offers:list',
        {'secret': secret, 'includeDisabled': True},
    )
    current_by_id = {
        profile['offer_id']: profile
        for profile in current
        if isinstance(profile, dict) and isinstance(profile.get('offer_id'), str)
    }
    for offer_id, profile in profiles.items():
        payload = {
            'secret': secret,
            'offerId': offer_id,
            'displayName': profile.display_name,
            'officialGuidelines': profile.official_guidelines,
            'internalOverrides': [
                {
                    'overrideId': override.override_id,
                    'title': override.title,
                    'guidance': override.guidance,
                    'rationale': override.rationale,
                    'enabled': override.enabled,
                }
                for override in profile.internal_overrides
            ],
            'enabled': profile.enabled,
            'isDefault': profile.is_default,
        }
        if _matches(current_by_id.get(offer_id, {}), payload):
            print(f'{offer_id} is already current.')
            continue
        subprocess.run(
            [
                'pnpm',
                'exec',
                'convex',
                'run',
                'offers:upsert',
                json.dumps(payload, ensure_ascii=False),
            ],
            cwd=ROOT,
            env=_convex_env(args.deployment),
            check=True,
            stdout=subprocess.DEVNULL,
        )
        print(f'Published {offer_id}.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
