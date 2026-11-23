import fcntl
import socket
import subprocess
import sys
from pathlib import Path


def choose_ports(locks):
    ports = []
    for port in range(3210, 65536):
        try:
            fcntl.lockf(locks, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, port)
        except BlockingIOError:
            continue
        try:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        except OSError:
            fcntl.lockf(locks, fcntl.LOCK_UN, 1, port)
            continue
        ports.append(port)
        if len(ports) == 2:
            return ports
    raise RuntimeError('No free ports for the local Convex API and site')


lock_file = Path.home() / '.cache' / 'convex' / 'test-ports.lock'
lock_file.parent.mkdir(parents=True, exist_ok=True)
with lock_file.open('a') as locks:
    cloud, site = choose_ports(locks)
    result = subprocess.run([*sys.argv[1:], '--local-cloud-port', str(cloud), '--local-site-port', str(site)])
    sys.exit(result.returncode)
