from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from urllib.parse import quote

import httpx
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account

DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3'
DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'


class DriveLookupError(RuntimeError):
    pass


@dataclass(frozen=True)
class DriveFile:
    file_id: str
    name: str
    mime_type: str
    parents: tuple[str, ...]
    web_view_link: str
    size: int | None = None


def escape_drive_query_value(value: str) -> str:
    return value.replace('\\', '\\\\').replace("'", "\\'")


class GoogleDriveClient:
    def __init__(self, credential_info: dict[str, Any], root_folder_id: str):
        try:
            self._credentials = service_account.Credentials.from_service_account_info(
                credential_info,
                scopes=[DRIVE_READONLY_SCOPE],
            )
        except (TypeError, ValueError) as exc:
            raise DriveLookupError('Google Drive credentials are invalid.') from exc
        self.root_folder_id = root_folder_id
        self._refresh_lock = threading.Lock()

    def _authorization_header(self) -> str:
        if not self._credentials.valid:
            with self._refresh_lock:
                if not self._credentials.valid:
                    try:
                        self._credentials.refresh(GoogleAuthRequest())
                    except Exception as exc:
                        raise DriveLookupError('Google Drive authorization failed.') from exc
        if not self._credentials.token:
            raise DriveLookupError('Google Drive authorization returned no access token.')
        return f'Bearer {self._credentials.token}'

    def _get_json(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        try:
            response = httpx.get(
                f'{DRIVE_API_BASE_URL}{path}',
                params=params,
                headers={'authorization': self._authorization_header()},
                timeout=20.0,
            )
        except httpx.HTTPError as exc:
            raise DriveLookupError('Google Drive could not be reached.') from exc
        if not response.is_success:
            raise DriveLookupError(f'Google Drive returned HTTP {response.status_code}.')
        try:
            payload = response.json()
        except ValueError as exc:
            raise DriveLookupError('Google Drive returned an invalid response.') from exc
        if not isinstance(payload, dict):
            raise DriveLookupError('Google Drive returned an invalid response.')
        return payload

    def _get_file_parents(self, file_id: str) -> tuple[str, ...]:
        payload = self._get_json(
            f'/files/{quote(file_id, safe="")}',
            {
                'fields': 'id,parents',
                'supportsAllDrives': 'true',
            },
        )
        parents = payload.get('parents')
        if not isinstance(parents, list):
            return ()
        return tuple(parent for parent in parents if isinstance(parent, str))

    def _is_within_root(self, file: DriveFile) -> bool:
        pending = list(file.parents)
        visited: set[str] = set()
        parent_cache: dict[str, tuple[str, ...]] = {}
        while pending:
            parent_id = pending.pop()
            if parent_id == self.root_folder_id:
                return True
            if parent_id in visited:
                continue
            visited.add(parent_id)
            parents = parent_cache.get(parent_id)
            if parents is None:
                parents = self._get_file_parents(parent_id)
                parent_cache[parent_id] = parents
            pending.extend(parents)
        return False

    def find_files_by_exact_name(self, file_name: str) -> list[DriveFile]:
        escaped_name = escape_drive_query_value(file_name)
        params = {
            'corpora': 'user',
            'fields': 'nextPageToken,files(id,name,mimeType,parents,webViewLink,resourceKey,size)',
            'includeItemsFromAllDrives': 'true',
            'pageSize': '100',
            'q': f"name = '{escaped_name}' and trashed = false",
            'spaces': 'drive',
            'supportsAllDrives': 'true',
        }
        matches: list[DriveFile] = []
        while True:
            payload = self._get_json('/files', params)
            files = payload.get('files')
            if isinstance(files, list):
                for raw_file in files:
                    parsed = self._parse_file(raw_file)
                    if parsed and parsed.mime_type != FOLDER_MIME_TYPE and self._is_within_root(parsed):
                        matches.append(parsed)
            page_token = payload.get('nextPageToken')
            if not isinstance(page_token, str) or not page_token:
                return matches
            params['pageToken'] = page_token

    @staticmethod
    def _parse_file(raw_file: Any) -> DriveFile | None:
        if not isinstance(raw_file, dict):
            return None
        file_id = raw_file.get('id')
        name = raw_file.get('name')
        mime_type = raw_file.get('mimeType')
        if not all(isinstance(value, str) and value for value in (file_id, name, mime_type)):
            return None
        parents = raw_file.get('parents')
        parent_ids = tuple(parent for parent in parents if isinstance(parent, str)) if isinstance(parents, list) else ()
        resource_key = raw_file.get('resourceKey')
        web_view_link = raw_file.get('webViewLink')
        if not isinstance(web_view_link, str) or not web_view_link:
            web_view_link = f'https://drive.google.com/file/d/{quote(file_id, safe="")}/view'
            if isinstance(resource_key, str) and resource_key:
                web_view_link = f'{web_view_link}?resourcekey={quote(resource_key, safe="")}'
        raw_size = raw_file.get('size')
        try:
            size = int(raw_size) if raw_size is not None else None
        except (TypeError, ValueError):
            size = None
        return DriveFile(
            file_id=file_id,
            name=name,
            mime_type=mime_type,
            parents=parent_ids,
            web_view_link=web_view_link,
            size=size,
        )


@lru_cache(maxsize=1)
def get_google_drive_client() -> GoogleDriveClient:
    raw_credentials = os.getenv('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON', '')
    root_folder_id = os.getenv('GOOGLE_DRIVE_FOLDER_ID', '')
    if not raw_credentials or not root_folder_id:
        raise DriveLookupError('Google Drive is not configured.')
    try:
        credential_info = json.loads(raw_credentials)
    except json.JSONDecodeError as exc:
        raise DriveLookupError('Google Drive credentials are invalid.') from exc
    if not isinstance(credential_info, dict):
        raise DriveLookupError('Google Drive credentials are invalid.')
    return GoogleDriveClient(credential_info, root_folder_id)
