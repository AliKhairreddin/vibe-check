"""Check the activated backend without logging credentials or request headers."""
import os
import time

import httpx

from convex_secret import read_backend_secret


def check_backend_health():
    secret = read_backend_secret()
    expected_shards = int(os.environ['CONFIGURED_BACKEND_SHARDS'])
    failure = 'Backend health check failed'
    for attempt in range(7):
        try:
            response = httpx.get('https://admin.adchecked.com/api/internal/queue-state',
                                 headers={'x-automation-secret': secret}, timeout=120)
            response.raise_for_status()
            state = response.json()
            assert state['workers'] > 0, 'No live job workers'
            assert state['configured_shards'] == expected_shards, 'Wrong shard configuration'
            assert state['ocr'] == {'engine': 'PP-OCRv6_small', 'ready': True, 'workers': 2, 'cpu_threads': 2}, 'Wrong OCR engine or readiness'
            print('Activated backend is healthy; shard and OCR configuration verified.')
            return
        except AssertionError as exc:
            failure = str(exc)
        except Exception as exc:
            # HTTP libraries can include raw header values in their exceptions.
            failure = f'Backend health check failed ({type(exc).__name__}); request details withheld.'
        if attempt < 6:
            time.sleep(10)
    raise RuntimeError(failure) from None


if __name__ == '__main__':
    check_backend_health()
