"""Deleting a take works without Supabase Storage (local SQLite setup, slides kept on disk)."""

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import create_engine

from backend import main

DECK = Path(__file__).resolve().parents[1] / "web" / "public" / "defaults" / "demo" / "agaar.pdf"


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}", connect_args={"check_same_thread": False})
    monkeypatch.setattr(main.db, "engine", engine)
    monkeypatch.setattr(main.config, "SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(main.db.config, "SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(main.worker, "start", lambda: None)
    # The local setup: a Supabase address may be set, but no Storage bucket or key.
    monkeypatch.setattr(main.storage.config, "SUPABASE_STORAGE_BUCKET", "")
    monkeypatch.setattr(main.storage.config, "SUPABASE_SERVICE_ROLE_KEY", "")
    with TestClient(main.app) as test_client:
        yield test_client
    engine.dispose()


def test_delete_a_take_with_slides_without_storage(client, tmp_path):
    reg = client.post("/api/v1/auth/register", json={
        "email": f"t-{uuid.uuid4().hex}@example.com", "username": f"t_{uuid.uuid4().hex[:16]}", "password": "test-password",
    })
    headers = {"X-Access-Token": reg.json()["access_token"]}
    project = client.post("/api/v1/projects", headers=headers, json={"name": "p"}).json()
    session = client.post(f"/api/v1/projects/{project['id']}/sessions", headers=headers, json={"copy_inputs": False}).json()
    with DECK.open("rb") as f:
        up = client.post(f"/api/v1/sessions/{session['id']}/slides", headers=headers, files={"file": ("deck.pdf", f, "application/pdf")})
    assert up.status_code == 200, up.text

    response = client.delete(f"/api/v1/sessions/{session['id']}", headers=headers)

    assert response.status_code == 204, response.text  # was 503 "File storage is temporarily unavailable."
    assert client.get(f"/api/v1/sessions/{session['id']}/status", headers=headers).status_code == 404
    assert not (tmp_path / "sessions" / session["id"]).exists()  # the local slide file is gone too
