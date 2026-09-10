#!/usr/bin/env python3
"""Idempotently initialize Digital Nudge and migrate internal review ownership.

Run after Convex deployment. Secrets remain in memory, never in command arguments
or logs. The optional setup link lets the owner choose a publisher password.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deployment', default='prod:energetic-partridge-813')
    parser.add_argument('--url', default='https://energetic-partridge-813.convex.cloud')
    parser.add_argument('--create-invite', action='store_true', help='Create/reset the Digital Nudge password setup link (7 days).')
    args = parser.parse_args()
    secret = os.environ.get('CONVEX_HTTP_SECRET', '').strip()
    if not secret:
        result = subprocess.run(['pnpm', 'exec', 'convex', 'env', 'get', 'CONVEX_HTTP_SECRET'], cwd=ROOT,
                                env={**os.environ, 'CONVEX_DEPLOYMENT': args.deployment}, capture_output=True, text=True)
        if result.returncode:
            raise SystemExit('Could not read CONVEX_HTTP_SECRET. Authenticate the Convex CLI or set the deployment key.')
        secret = result.stdout.strip()
    if not secret:
        raise SystemExit('CONVEX_HTTP_SECRET is not configured.')

    def mutation(name, payload):
        request = urllib.request.Request(args.url.rstrip('/') + '/api/mutation',
            data=json.dumps({'path': name, 'args': {**payload, 'secret': secret}, 'format': 'json'}).encode(),
            headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.load(response)
        if body.get('status') != 'success':
            raise SystemExit(f'{name} failed. Inspect the Convex function logs; setup can be retried safely.')
        return body.get('value')

    token = secrets.token_urlsafe(32) if args.create_invite else None
    mutation('workspaces:setupDigitalNudge', {'inviteHash': hashlib.sha256(token.encode()).hexdigest()} if token else {})
    count = 0
    for _ in range(10000):
        result = mutation('platform:backfillDigitalNudge', {})
        count += result['processed']
        if result['done']:
            break
    else:
        raise SystemExit('Backfill paused after one million rows. Run again to continue from the saved cursor.')
    print(f'Digital Nudge workspaces ready. Scanned {count} offer results; existing publisher and API ownership preserved.')
    projected_count = 0
    for _ in range(10000):
        result = mutation('platform:backfillPublisherStats', {})
        projected_count += result['processed']
        if result['done']:
            break
    else:
        raise SystemExit('Publisher statistics backfill paused. Run setup again to resume.')
    print(f'Publisher statistics ready. Projected ownership for {projected_count} offer results.')
    source_count = 0
    for _ in range(20000):
        result = mutation('reviewSources:backfill', {})
        source_count += result['processed']
        if result['done']:
            break
    else:
        raise SystemExit('History source backfill paused. Run setup again to resume.')
    print(f'Review history sources ready. Classified {source_count} reviews by submitter.')
    if token:
        print('Publisher username: digital-nudge')
        print(f'Choose a password within 7 days: https://app.adchecked.com/invite/{token}')


if __name__ == '__main__':
    main()
