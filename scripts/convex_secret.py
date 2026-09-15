"""Read the backend credential without treating Convex CLI diagnostics as data."""
import os
import subprocess
import time


def read_backend_secret(deployment=None):
    env = {**os.environ, **({'CONVEX_DEPLOYMENT': deployment} if deployment else {})}
    for attempt in range(3):
        try:
            result = subprocess.run(
                ['pnpm', 'exec', 'convex', 'env', 'get', 'CONVEX_HTTP_SECRET'],
                capture_output=True, text=True, timeout=60, env=env,
            )
            value = result.stdout.strip()
            # Transient WebSocket diagnostics can appear on stdout before the
            # actual value. Retry the read instead of sending those diagnostics
            # as an HTTP header (whose exception can print the entire secret).
            if result.returncode == 0 and value and all(33 <= ord(c) <= 126 for c in value):
                if os.environ.get('GITHUB_ACTIONS') == 'true':
                    print(f'::add-mask::{value}', flush=True)
                return value
        except (subprocess.SubprocessError, OSError):
            pass
        if attempt < 2:
            time.sleep(1)
    raise RuntimeError('Could not read a clean backend credential from Convex; CLI output withheld.')
