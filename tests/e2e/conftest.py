import os
from urllib.parse import urlsplit

import pytest

from app.review_pipeline import storage


@pytest.fixture(scope='session', autouse=True)
def local_database():
    assert os.environ.get('CONVEX_DEPLOYMENT') == 'anonymous:anonymous-agent'
    assert urlsplit(storage.CONVEX_URL).hostname == '127.0.0.1'
    assert storage.CONVEX_HTTP_SECRET == 'batch-completion-test'
