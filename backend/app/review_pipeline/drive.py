from __future__ import annotations

import json
import os
import threading
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account

DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3'
DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
MAX_DRIVE_SELECTION_FILES = 100
MAX_DRIVE_SELECTION_FOLDERS = 1000


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
    modified_time: str | None = None
    can_download: bool = True


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

    def get_file(self, file_id: str, *, require_within_root: bool = True) -> DriveFile:
        payload = self._get_json(
            f'/files/{quote(file_id, safe="")}',
            {
                'fields': 'id,name,mimeType,parents,webViewLink,resourceKey,size,modifiedTime,capabilities(canDownload)',
                'supportsAllDrives': 'true',
            },
        )
        file = self._parse_file(payload)
        if file is None:
            raise DriveLookupError('Google Drive returned invalid file metadata.')
        if require_within_root and not self._is_within_root(file):
            raise DriveLookupError('The selected file is outside the configured Drive folder.')
        return file

    def _is_within_root(self, file: DriveFile) -> bool:
        if file.file_id == self.root_folder_id:
            return True
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

    def _list_direct_children(self, folder_id: str) -> list[DriveFile]:
        params = {
            'corpora': 'user',
            'fields': 'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,webViewLink,resourceKey,size,modifiedTime,capabilities(canDownload))',
            'includeItemsFromAllDrives': 'true',
            'orderBy': 'name_natural',
            'pageSize': '1000',
            'q': f"'{escape_drive_query_value(folder_id)}' in parents and trashed = false",
            'spaces': 'drive',
            'supportsAllDrives': 'true',
        }
        children: list[DriveFile] = []
        while True:
            payload = self._get_json('/files', params)
            if payload.get('incompleteSearch') is True:
                raise DriveLookupError('Google Drive returned incomplete folder contents.')
            files = payload.get('files')
            if isinstance(files, list):
                for raw_file in files:
                    parsed = self._parse_file(raw_file)
                    if parsed is not None and folder_id in parsed.parents:
                        children.append(parsed)
            page_token = payload.get('nextPageToken')
            if not isinstance(page_token, str) or not page_token:
                break
            params['pageToken'] = page_token

        return sorted(
            children,
            key=lambda file: (
                file.mime_type != FOLDER_MIME_TYPE,
                file.name.casefold(),
                file.file_id,
            ),
        )

    def list_folder_children(self, folder_id: str | None = None) -> list[DriveFile]:
        selected_folder_id = folder_id or self.root_folder_id
        selected_folder = self.get_file(selected_folder_id)
        if selected_folder.mime_type != FOLDER_MIME_TYPE:
            raise DriveLookupError('The selected Google Drive item is not a folder.')
        return [
            child
            for child in self._list_direct_children(selected_folder_id)
            if child.mime_type == FOLDER_MIME_TYPE
            or (child.can_download and self._is_supported_creative(child))
        ]

    def resolve_selection(
        self,
        folder_ids: Sequence[str] = (),
        file_ids: Sequence[str] = (),
        max_file_size: int | None = None,
    ) -> list[DriveFile]:
        pending_folders: deque[str] = deque()
        requested_folders: set[str] = set()
        requested_files: set[str] = set()
        resolved_files: dict[str, DriveFile] = {}

        for folder_id in folder_ids:
            if folder_id in requested_folders:
                continue
            requested_folders.add(folder_id)
            folder = self.get_file(folder_id)
            if folder.mime_type != FOLDER_MIME_TYPE:
                raise DriveLookupError('The selected Google Drive item is not a folder.')
            pending_folders.append(folder.file_id)

        def add_creative(file: DriveFile) -> None:
            if (
                file.file_id in resolved_files
                or not file.can_download
                or not self._is_supported_creative(file)
                or (
                    max_file_size is not None
                    and file.size is not None
                    and file.size > max_file_size
                )
            ):
                return
            resolved_files[file.file_id] = file
            if len(resolved_files) > MAX_DRIVE_SELECTION_FILES:
                raise DriveLookupError(
                    f'A Drive selection can contain at most {MAX_DRIVE_SELECTION_FILES} creatives.'
                )

        for file_id in file_ids:
            if file_id in requested_files:
                continue
            requested_files.add(file_id)
            file = self.get_file(file_id)
            if file.mime_type == FOLDER_MIME_TYPE:
                raise DriveLookupError('The selected Google Drive file is a folder.')
            add_creative(file)

        visited_folders: set[str] = set()
        while pending_folders:
            folder_id = pending_folders.popleft()
            if folder_id in visited_folders:
                continue
            visited_folders.add(folder_id)
            if len(visited_folders) > MAX_DRIVE_SELECTION_FOLDERS:
                raise DriveLookupError('The selected Drive folders contain too many nested folders.')
            for child in self._list_direct_children(folder_id):
                if child.mime_type == FOLDER_MIME_TYPE:
                    pending_folders.append(child.file_id)
                else:
                    add_creative(child)

        return list(resolved_files.values())

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

    def list_creative_files(self, *, max_files: int = 5000, max_folders: int = 1000) -> list[DriveFile]:
        pending_folders = deque([self.root_folder_id])
        visited_folders: set[str] = set()
        creative_files: list[DriveFile] = []

        while pending_folders:
            folder_id = pending_folders.popleft()
            if folder_id in visited_folders:
                continue
            visited_folders.add(folder_id)
            if len(visited_folders) > max_folders:
                raise DriveLookupError('The configured Drive folder has too many nested folders to browse.')

            params = {
                'corpora': 'user',
                'fields': 'nextPageToken,files(id,name,mimeType,parents,webViewLink,resourceKey,size,modifiedTime,capabilities(canDownload))',
                'includeItemsFromAllDrives': 'true',
                'orderBy': 'folder,name_natural',
                'pageSize': '1000',
                'q': f"'{escape_drive_query_value(folder_id)}' in parents and trashed = false",
                'spaces': 'drive',
                'supportsAllDrives': 'true',
            }
            while True:
                payload = self._get_json('/files', params)
                files = payload.get('files')
                if isinstance(files, list):
                    for raw_file in files:
                        parsed = self._parse_file(raw_file)
                        if parsed is None:
                            continue
                        if parsed.mime_type == FOLDER_MIME_TYPE:
                            pending_folders.append(parsed.file_id)
                            continue
                        if not parsed.can_download or not self._is_supported_creative(parsed):
                            continue
                        creative_files.append(parsed)
                        if len(creative_files) > max_files:
                            raise DriveLookupError('The configured Drive folder has too many creatives to browse.')
                page_token = payload.get('nextPageToken')
                if not isinstance(page_token, str) or not page_token:
                    break
                params['pageToken'] = page_token

        return sorted(
            creative_files,
            key=lambda file: ((file.modified_time or ''), file.name.casefold()),
            reverse=True,
        )

    def download_file(
        self,
        file: DriveFile,
        destination: Path,
        *,
        max_bytes: int,
        progress_callback: Callable[[int, int | None], None] | None = None,
    ) -> int:
        if not file.can_download:
            raise DriveLookupError('This Google Drive file cannot be downloaded by the service account.')
        if file.size is not None and file.size > max_bytes:
            raise DriveLookupError(f'The Google Drive file exceeds the {max_bytes // (1024 * 1024)} MB limit.')

        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f'.{destination.name}.drive-download')
        downloaded = 0
        try:
            with httpx.stream(
                'GET',
                f'{DRIVE_API_BASE_URL}/files/{quote(file.file_id, safe="")}',
                params={'alt': 'media', 'supportsAllDrives': 'true'},
                headers={'authorization': self._authorization_header()},
                timeout=httpx.Timeout(120.0, connect=20.0),
                follow_redirects=True,
            ) as response:
                if not response.is_success:
                    raise DriveLookupError(f'Google Drive download returned HTTP {response.status_code}.')
                with temporary.open('wb') as output:
                    for chunk in response.iter_bytes(1024 * 1024):
                        downloaded += len(chunk)
                        if downloaded > max_bytes:
                            raise DriveLookupError(f'The Google Drive file exceeds the {max_bytes // (1024 * 1024)} MB limit.')
                        output.write(chunk)
                        if progress_callback:
                            progress_callback(downloaded, file.size)
            if downloaded <= 0:
                raise DriveLookupError('The selected Google Drive file is empty.')
            temporary.replace(destination)
            return downloaded
        except httpx.HTTPError as exc:
            raise DriveLookupError('Google Drive could not download the selected file.') from exc
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _is_supported_creative(file: DriveFile) -> bool:
        from .media import detect_media_kind

        try:
            detect_media_kind(file.name, file.mime_type)
        except ValueError:
            return False
        return True

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
            if mime_type == FOLDER_MIME_TYPE:
                web_view_link = f'https://drive.google.com/drive/folders/{quote(file_id, safe="")}'
            else:
                web_view_link = f'https://drive.google.com/file/d/{quote(file_id, safe="")}/view'
            if isinstance(resource_key, str) and resource_key:
                web_view_link = f'{web_view_link}?resourcekey={quote(resource_key, safe="")}'
        raw_size = raw_file.get('size')
        try:
            size = int(raw_size) if raw_size is not None else None
        except (TypeError, ValueError):
            size = None
        modified_time = raw_file.get('modifiedTime')
        if not isinstance(modified_time, str) or not modified_time:
            modified_time = None
        capabilities = raw_file.get('capabilities')
        can_download = True
        if isinstance(capabilities, dict) and capabilities.get('canDownload') is False:
            can_download = False
        return DriveFile(
            file_id=file_id,
            name=name,
            mime_type=mime_type,
            parents=parent_ids,
            web_view_link=web_view_link,
            size=size,
            modified_time=modified_time,
            can_download=can_download,
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
