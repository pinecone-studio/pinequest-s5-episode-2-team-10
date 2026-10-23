"""Private Supabase Storage access for server-side session files."""

from pathlib import Path
from urllib.parse import quote

import httpx

from . import config

STORAGE_URI_PREFIX = "storage://"


class StorageError(RuntimeError):
    """A safe, user-readable storage failure."""


class StorageNotFound(StorageError):
    """The requested private object does not exist."""


def configured() -> bool:
    storage_values = (config.SUPABASE_STORAGE_BUCKET, config.SUPABASE_SERVICE_ROLE_KEY)
    if any(storage_values) and not (config.SUPABASE_URL and all(storage_values)):
        raise StorageError("Supabase Storage configuration is incomplete.")
    return bool(config.SUPABASE_URL and all(storage_values))


def validate_configuration(required: bool = False) -> None:
    if required and not configured():
        raise StorageError("Supabase Storage must be configured for a shared database.")
    configured()


def uri_for(key: str) -> str:
    return f"{STORAGE_URI_PREFIX}{key}"


def key_from_uri(value: str) -> str | None:
    if value.startswith(STORAGE_URI_PREFIX):
        return value[len(STORAGE_URI_PREFIX):]
    return None


def _url(key: str) -> str:
    if not configured():
        raise StorageError("Supabase Storage is not configured.")
    bucket = quote(config.SUPABASE_STORAGE_BUCKET, safe="")
    object_key = quote(key.lstrip("/"), safe="/")
    return f"{config.SUPABASE_URL}/storage/v1/object/{bucket}/{object_key}"


def _bucket_url() -> str:
    if not configured():
        raise StorageError("Supabase Storage is not configured.")
    bucket = quote(config.SUPABASE_STORAGE_BUCKET, safe="")
    return f"{config.SUPABASE_URL}/storage/v1/object/{bucket}"


def _headers(content_type: str | None = None, upsert: bool = False) -> dict[str, str]:
    headers = {
        "apikey": config.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_ROLE_KEY}",
    }
    if content_type:
        headers["Content-Type"] = content_type
    if upsert:
        headers["x-upsert"] = "true"
    return headers


def _request(method: str, url: str, **kwargs) -> httpx.Response:
    try:
        with httpx.Client(timeout=45.0) as client:
            response = client.request(method, url, **kwargs)
    except httpx.RequestError as exc:
        raise StorageError("Supabase Storage could not be reached.") from exc
    if response.status_code == 404:
        raise StorageNotFound("Stored file was not found.")
    if response.is_error:
        raise StorageError(f"Supabase Storage returned HTTP {response.status_code}.")
    return response


def upload_bytes(
    key: str,
    content: bytes,
    content_type: str = "application/octet-stream",
    *,
    upsert: bool = True,
) -> None:
    _request(
        "POST",
        _url(key),
        headers=_headers(content_type, upsert),
        content=content,
    )


def upload_file(
    key: str,
    path: Path,
    content_type: str = "application/octet-stream",
    *,
    upsert: bool = True,
) -> None:
    upload_bytes(key, path.read_bytes(), content_type, upsert=upsert)


def download_bytes(key: str) -> bytes:
    response = _request("GET", _url(key), headers=_headers())
    return response.content


def delete_objects(keys: list[str]) -> None:
    if not keys:
        return
    _request(
        "DELETE",
        _bucket_url(),
        headers=_headers("application/json"),
        json={"prefixes": sorted(set(key.lstrip("/") for key in keys))},
    )
