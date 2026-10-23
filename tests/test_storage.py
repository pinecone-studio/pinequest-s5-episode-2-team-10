import httpx
import pytest
from sqlmodel import Session, SQLModel, create_engine

from backend import config, storage
from backend.db import AppUser, AudioAsset, PitchSession, Project


class FakeClient:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.response


def _configure_storage(monkeypatch):
    monkeypatch.setattr(config, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_STORAGE_BUCKET", "saylo-session-files")
    monkeypatch.setattr(config, "SUPABASE_SERVICE_ROLE_KEY", "server-secret")


def test_auth_url_alone_does_not_enable_storage(monkeypatch):
    monkeypatch.setattr(config, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_STORAGE_BUCKET", "")
    monkeypatch.setattr(config, "SUPABASE_SERVICE_ROLE_KEY", "")

    assert storage.configured() is False


def test_partial_storage_configuration_is_an_explicit_error(monkeypatch):
    monkeypatch.setattr(config, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_STORAGE_BUCKET", "saylo-session-files")
    monkeypatch.setattr(config, "SUPABASE_SERVICE_ROLE_KEY", "")

    with pytest.raises(storage.StorageError, match="configuration is incomplete"):
        storage.configured()


def test_upload_uses_private_server_key_and_escapes_object_key(monkeypatch):
    _configure_storage(monkeypatch)
    client = FakeClient(httpx.Response(200, content=b"ok"))
    monkeypatch.setattr(storage.httpx, "Client", lambda **_: client)

    storage.upload_bytes("sessions/attempt id/audio.wav", b"audio", "audio/wav")

    method, url, kwargs = client.calls[0]
    assert method == "POST"
    assert url == "https://example.supabase.co/storage/v1/object/saylo-session-files/sessions/attempt%20id/audio.wav"
    assert kwargs["headers"]["Authorization"] == "Bearer server-secret"
    assert kwargs["headers"]["apikey"] == "server-secret"
    assert kwargs["headers"]["x-upsert"] == "true"
    assert kwargs["content"] == b"audio"


def test_delete_objects_uses_bucket_object_api(monkeypatch):
    _configure_storage(monkeypatch)
    client = FakeClient(httpx.Response(200, content=b"{}"))
    monkeypatch.setattr(storage.httpx, "Client", lambda **_: client)

    storage.delete_objects(["sessions/one/a.wav", "sessions/one/a.wav", "sessions/one/slides.pdf"])

    method, url, kwargs = client.calls[0]
    assert method == "DELETE"
    assert url == "https://example.supabase.co/storage/v1/object/saylo-session-files"
    assert kwargs["json"] == {"prefixes": ["sessions/one/a.wav", "sessions/one/slides.pdf"]}


def test_storage_failure_does_not_expose_response_body_or_secret(monkeypatch):
    _configure_storage(monkeypatch)
    client = FakeClient(httpx.Response(403, content=b"server-secret"))
    monkeypatch.setattr(storage.httpx, "Client", lambda **_: client)

    with pytest.raises(storage.StorageError, match="HTTP 403") as error:
        storage.download_bytes("sessions/attempt/audio.wav")

    assert "server-secret" not in str(error.value)


def test_worker_downloads_remote_audio_to_temporary_file(monkeypatch):
    from backend import worker as worker_module

    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as database:
        user = AppUser(token_hash="user-token")
        database.add(user)
        database.flush()
        project = Project(user_id=user.id, name="Shared")
        database.add(project)
        database.flush()
        attempt = PitchSession(
            project_id=project.id,
            title="Attempt",
            planned_s=120,
            feedback_backend="rules",
            status="processing",
        )
        database.add(attempt)
        database.flush()
        database.add(
            AudioAsset(
                session_id=attempt.id,
                path=storage.uri_for(f"sessions/{attempt.id}/audio.wav"),
                original_path=storage.uri_for(f"sessions/{attempt.id}/original.wav"),
                duration_s=12,
                format="wav",
            )
        )
        database.commit()
        session_id = attempt.id

    monkeypatch.setattr(worker_module, "engine", engine)
    monkeypatch.setattr(storage, "download_bytes", lambda _key: b"shared-audio")
    received = {}
    runner = worker_module.Worker()

    def analyze(path, duration, session_info, slides, backend, on_stage):
        received["path"] = path
        received["bytes"] = path.read_bytes()
        return {"result": True}

    monkeypatch.setattr(worker_module.run, "analyze", analyze)
    monkeypatch.setattr(runner, "_save", lambda *_args: None)

    runner._process(session_id)

    assert received["bytes"] == b"shared-audio"
    assert not received["path"].exists()
    engine.dispose()
