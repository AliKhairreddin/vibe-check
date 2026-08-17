from __future__ import annotations

import os
from typing import Any


def _enabled(name:str, default:bool)->bool:
    value=os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {'0','false','no','off','disabled'}


def provider_preferences(*, require_parameters:bool)->dict[str, Any]:
    """Keep the selected model fixed while choosing a compliant fast endpoint."""
    preferences:dict[str, Any]={
        'require_parameters':require_parameters,
        'zdr':_enabled('OPENROUTER_ZDR', True),
    }
    data_collection=os.getenv('OPENROUTER_DATA_COLLECTION', 'deny').strip().lower()
    if data_collection in {'allow','deny'}:
        preferences['data_collection']=data_collection
    provider_sort=os.getenv('OPENROUTER_PROVIDER_SORT', 'throughput').strip().lower()
    if provider_sort in {'price','throughput','latency'}:
        preferences['sort']=provider_sort
    return preferences
