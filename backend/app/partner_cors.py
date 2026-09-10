"""Partner-specific CORS without broadening access to the admin/client APIs."""
from __future__ import annotations

import asyncio
import logging

from starlette.datastructures import Headers
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from .review_pipeline.partner_api import browser_origin_allowed

logger = logging.getLogger(__name__)


class PartnerCORSMiddleware:
    def __init__(self, app, **options):
        self.app = app
        self.options = options
        self.platform_origins = set(options['allow_origins'])
        self.default = CORSMiddleware(app, **options)

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        if scope['type'] != 'http' or not (path == '/api/v1' or path.startswith('/api/v1/')):
            await self.default(scope, receive, send)
            return
        origin = Headers(scope=scope).get('origin')
        if not origin or origin in self.platform_origins:
            await self.default(scope, receive, send)
            return
        try:
            allowed = await asyncio.to_thread(browser_origin_allowed, origin)
        except Exception:
            logger.exception('Partner browser origin lookup failed.')
            response = JSONResponse({'detail': 'Browser access settings are temporarily unavailable.'}, status_code=503)
            await response(scope, receive, send)
            return
        if not allowed and scope.get('method') != 'OPTIONS':
            response = JSONResponse({'detail': 'This website origin is not allowed for the Partner API.'}, status_code=403)
            await response(scope, receive, send)
            return
        # Preflights contain no Bearer token. This permits the browser handshake
        # for registered origins; require_api_principal then checks the exact
        # partner's origin list before any authenticated endpoint can execute.
        cors = CORSMiddleware(self.app, **{
            **self.options,
            'allow_origins': [origin] if allowed else [],
        })
        await cors(scope, receive, send)
