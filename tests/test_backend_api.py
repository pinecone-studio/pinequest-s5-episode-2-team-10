"""Contract tests for the project fields sent by the web client."""

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, create_engine, select

from backend import main
from backend.db import PitchSession


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False},
    )
    monkeypatch.setattr(main.db, "engine", engine)
    monkeypatch.setattr(main.config, "SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(main.worker, "start", lambda: None)

    with TestClient(main.app) as test_client:
        yield test_client

    engine.dispose()


def _headers(client: TestClient) -> dict[str, str]:
    response = client.post("/api/v1/auth/demo")
    assert response.status_code == 200
    return {"X-Access-Token": response.json()["access_token"]}


def _user_headers(client: TestClient, email: str) -> dict[str, str]:
    response = client.post("/api/v1/auth/register", json={"email": email, "password": "password1"})
    assert response.status_code == 201, response.text
    return {"X-Access-Token": response.json()["access_token"]}


def test_create_project_accepts_web_client_fields_and_cleans_key_points(client):
    headers = _headers(client)
    response = client.post(
        "/api/v1/projects",
        headers=headers,
        json={
            "name": "  Demo pitch  ",
            "goal": "Practice a clear pitch",
            "audience": "Classmates",
            "idea": "A tool for speaking practice",
            "key_points": ["  Problem  ", "", "  Solution  "],
            "planned_s": 240,
            "pitch_type": "academic",
        },
    )

    assert response.status_code == 201
    project = response.json()
    assert {
        key: project[key]
        for key in ("name", "goal", "audience", "idea", "key_points", "planned_s", "pitch_type")
    } == {
        "name": "Demo pitch",
        "goal": "Practice a clear pitch",
        "audience": "Classmates",
        "idea": "A tool for speaking practice",
        "key_points": ["Problem", "Solution"],
        "planned_s": 240,
        "pitch_type": "academic",
    }
    assert project["attempts"] == []
    assert project["current"] == {"slides_filename": None, "slide_count": 0, "script": ""}


def test_create_project_allows_empty_details(client):
    response = client.post("/api/v1/projects", headers=_headers(client), json={})

    assert response.status_code == 201
    project = response.json()
    assert project["name"] == "Untitled project"
    assert project["key_points"] == []
    assert project["planned_s"] == 180
    assert project["pitch_type"] == "startup"


@pytest.mark.parametrize(
    "details",
    [
        {"planned_s": 29},
        {"planned_s": 901},
        {"pitch_type": "other"},
        {"key_points": ["point"] * 7},
        {"key_points": ["x" * 201]},
    ],
)
def test_create_project_rejects_out_of_contract_fields(client, details):
    response = client.post("/api/v1/projects", headers=_headers(client), json=details)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"
    assert response.json()["message"]


def test_patch_project_updates_only_provided_fields(client):
    headers = _headers(client)
    created = client.post(
        "/api/v1/projects",
        headers=headers,
        json={
            "name": "Original",
            "goal": "Original goal",
            "audience": "Students",
            "idea": "Original idea",
            "key_points": ["First", "Second"],
            "planned_s": 120,
            "pitch_type": "startup",
        },
    )
    project_id = created.json()["id"]

    response = client.patch(
        f"/api/v1/projects/{project_id}",
        headers=headers,
        json={"name": "  Updated  ", "key_points": ["  New point  ", ""]},
    )

    assert response.status_code == 200
    project = response.json()
    assert project["name"] == "Updated"
    assert project["key_points"] == ["New point"]
    assert project["goal"] == "Original goal"
    assert project["audience"] == "Students"
    assert project["idea"] == "Original idea"
    assert project["planned_s"] == 120
    assert project["pitch_type"] == "startup"


def test_new_attempt_receives_project_fields(client):
    headers = _headers(client)
    project = client.post(
        "/api/v1/projects",
        headers=headers,
        json={
            "name": "Research pitch",
            "goal": "Explain the research",
            "audience": "Reviewers",
            "idea": "A Mongolian speech tool",
            "key_points": ["Need", "Approach"],
            "planned_s": 300,
            "pitch_type": "academic",
        },
    ).json()

    response = client.post(
        f"/api/v1/projects/{project['id']}/sessions",
        headers=headers,
        json={"copy_inputs": True},
    )

    assert response.status_code == 201
    with Session(main.db.engine) as database:
        attempt = database.get(PitchSession, response.json()["id"])
    assert attempt is not None
    assert attempt.title == "Research pitch"
    assert attempt.goal == "Explain the research"
    assert attempt.audience == "Reviewers"
    assert attempt.idea == "A Mongolian speech tool"
    assert attempt.key_points == ["Need", "Approach"]
    assert attempt.planned_s == 300
    assert attempt.pitch_type == "academic"


def test_project_fields_are_not_visible_to_another_user(client):
    owner_headers = _user_headers(client, "owner@example.com")
    project = client.post(
        "/api/v1/projects",
        headers=owner_headers,
        json={"name": "Private"},
    ).json()
    other_headers = _user_headers(client, "other@example.com")

    response = client.get(f"/api/v1/projects/{project['id']}", headers=other_headers)

    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


def test_audio_upload_and_playback_use_private_storage_in_shared_mode(client, monkeypatch):
    headers = _headers(client)
    project = client.post("/api/v1/projects", headers=headers, json={"name": "Shared"}).json()
    attempt = client.post(
        f"/api/v1/projects/{project['id']}/sessions",
        headers=headers,
        json={"copy_inputs": False},
    ).json()
    objects = {}

    def convert_to_wav(source, destination):
        destination.write_bytes(b"converted-audio")
        return 12.5

    def upload_file(key, path, content_type, *, upsert=True):
        objects[key] = path.read_bytes()

    monkeypatch.setattr(main.storage, "configured", lambda: True)
    monkeypatch.setattr(main.audio_tools, "to_wav16k", convert_to_wav)
    monkeypatch.setattr(main.storage, "upload_file", upload_file)
    monkeypatch.setattr(
        main.storage,
        "download_bytes",
        lambda key: objects[key],
    )

    response = client.post(
        f"/api/v1/sessions/{attempt['id']}/audio",
        headers=headers,
        files={"file": ("practice.wav", b"original-audio", "audio/wav")},
    )

    assert response.status_code == 200
    assert objects[f"sessions/{attempt['id']}/original.wav"] == b"original-audio"
    assert objects[f"sessions/{attempt['id']}/audio.wav"] == b"converted-audio"
    playback = client.get(f"/api/v1/sessions/{attempt['id']}/audio", headers=headers)
    assert playback.status_code == 200
    assert playback.content == b"original-audio"

    with Session(main.db.engine) as database:
        asset = database.get(main.AudioAsset, attempt["id"])
    assert asset.path == f"storage://sessions/{attempt['id']}/audio.wav"
    assert asset.original_path == f"storage://sessions/{attempt['id']}/original.wav"


def test_migrated_access_token_alias_authenticates_as_mapped_owner(client):
    from backend.db import AccessToken, AppUser

    token = "an-existing-member-token"
    headers = _headers(client)
    with Session(main.db.engine) as database:
        user = database.exec(select(AppUser)).first()
        database.add(AccessToken(token_hash=main._hash(token), user_id=user.id))
        database.commit()

    response = client.get("/api/v1/projects", headers={"X-Access-Token": token})

    assert response.status_code == 200
    assert response.json() == []


def test_slides_upload_download_and_delete_use_private_storage(client, monkeypatch):
    headers = _headers(client)
    project = client.post("/api/v1/projects", headers=headers, json={"name": "Slides"}).json()
    attempt = client.post(
        f"/api/v1/projects/{project['id']}/sessions",
        headers=headers,
        json={"copy_inputs": False},
    ).json()
    objects = {}

    def upload_file(key, path, content_type, *, upsert=True):
        objects[key] = path.read_bytes()

    def delete_objects(keys):
        for key in keys:
            objects.pop(key, None)

    monkeypatch.setattr(main.storage, "configured", lambda: True)
    monkeypatch.setattr(main.storage, "upload_file", upload_file)
    monkeypatch.setattr(main.storage, "download_bytes", lambda key: objects[key])
    monkeypatch.setattr(main.storage, "delete_objects", delete_objects)
    monkeypatch.setattr(
        main.slide_tools,
        "extract",
        lambda _path: [
            {
                "number": 1,
                "text": "Slide content",
                "notes": "",
                "image_only": False,
                "numbers": [],
                "key_terms": ["Slide"],
            }
        ],
    )

    upload = client.post(
        f"/api/v1/sessions/{attempt['id']}/slides",
        headers=headers,
        files={"file": ("deck.pdf", b"pdf-content", "application/pdf")},
    )

    assert upload.status_code == 200
    key = f"sessions/{attempt['id']}/slides.pdf"
    assert objects[key] == b"pdf-content"
    downloaded = client.get(f"/api/v1/sessions/{attempt['id']}/slides/file", headers=headers)
    assert downloaded.status_code == 200
    assert downloaded.content == b"pdf-content"

    removed = client.delete(f"/api/v1/sessions/{attempt['id']}/slides", headers=headers)
    assert removed.status_code == 204
    assert key not in objects
