"""Measured health for live containers; sleeping containers are not polled awake."""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from pathlib import Path

from fastapi import Request
from .review_pipeline import storage

logger = logging.getLogger(__name__)
INSTANCE_ID = uuid.uuid4().hex
STARTED_AT = int(time.time() * 1000)
_requests = 0
_errors = 0
_previous_cpu: tuple[float, int] | None = None


def record_request(status: int):
    global _requests, _errors
    _requests += 1
    if status >= 500:
        _errors += 1


def resource_usage(root: Path = Path('/sys/fs/cgroup')) -> dict:
    global _previous_cpu
    result = {}
    try:
        result['memoryBytes'] = int((root / 'memory.current').read_text().strip())
        maximum = (root / 'memory.max').read_text().strip()
        if maximum != 'max':
            result['memoryLimitBytes'] = int(maximum)
    except (OSError, ValueError):
        pass
    try:
        cpu = dict(line.split() for line in (root / 'cpu.stat').read_text().splitlines())
        usage = int(cpu['usage_usec'])
        quota, period = (root / 'cpu.max').read_text().split()
        cores = int(quota) / int(period) if quota != 'max' else (os.cpu_count() or 1)
        now = time.monotonic()
        if _previous_cpu and now > _previous_cpu[0] and usage >= _previous_cpu[1]:
            result['cpuPercent'] = min(100, max(0, (usage - _previous_cpu[1]) / 1000000 / (now - _previous_cpu[0]) / cores * 100))
        _previous_cpu = (now, usage)
    except (OSError, ValueError, KeyError, ZeroDivisionError):
        pass
    return result


def heartbeat():
    from .review_pipeline.queue import queue_state
    if not storage.convex_enabled():
        return
    state = queue_state()
    storage._convex_call('mutation', 'platform:recordHeartbeat', {
        'instanceId': INSTANCE_ID, 'startedAt': STARTED_AT, 'requests': _requests, 'errors': _errors,
        'active': state['active'], 'pending': state['pending'], 'workers': state['workers'], **resource_usage(),
    })


async def monitor_loop():
    while True:
        try:
            await asyncio.to_thread(heartbeat)
        except Exception:
            logger.warning('Platform heartbeat unavailable', exc_info=False)
        await asyncio.sleep(60)


def register(app):
    @app.get('/api/admin/platform')
    def platform_status(request: Request):
        from .main import require_settings_admin, queue_state
        require_settings_admin(request)
        started = time.perf_counter()
        try:
            if not storage.convex_enabled():
                raise RuntimeError('Not configured')
            overview = storage._convex_call('query', 'platform:overview', {})
            convex = {'status': 'reachable', 'latency_ms': round((time.perf_counter() - started) * 1000)}
        except Exception:
            overview = None
            convex = {'status': 'unavailable', 'latency_ms': None}
        return {'convex': convex, 'backend': {'status': 'reachable', 'instance_id': INSTANCE_ID, 'queue': queue_state(), **resource_usage()}, 'overview': overview, 'observed_at': int(time.time() * 1000)}
