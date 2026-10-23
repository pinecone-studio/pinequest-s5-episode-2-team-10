"""Register, login, Google sign-in, logout, and project ownership."""

import os
import tempfile
from pathlib import Path

_root = Path(tempfile.mkdtemp(prefix="pitchcoach-auth-"))
os.environ["PITCH_DATA_DIR"] = str(_root)
os.environ["PITCH_DB_URL"] = f"sqlite:///{_root / 'auth.db'}"

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend import config, supabase_auth
from backend.db import AppUser, engine
from backend.main import app

PASSWORD = "password1"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def clear_admin_allowlist(monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", set())


def _register(client: TestClient, email: str) -> dict:
    res = client.post("/api/v1/auth/register", json={"email": email, "password": PASSWORD})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["access_token"] and body["id"]
    assert body["email"] == email.strip().lower()
    assert body["role"] == "member"
    return body


def test_register_stores_a_hash_and_answers_me(client: TestClient):
    created = _register(client, "Ada@Example.com")
    me = client.get("/api/v1/auth/me", headers={"X-Access-Token": created["access_token"]})
    assert me.status_code == 200
    assert me.json() == {"id": created["id"], "email": "ada@example.com", "role": "member"}

    with Session(engine) as db:
        user = db.exec(select(AppUser).where(AppUser.email == "ada@example.com")).one()
    assert user.password_hash
    assert PASSWORD not in user.password_hash
    assert user.password_hash.startswith("pbkdf2_sha256$")


def test_duplicate_email(client: TestClient):
    _register(client, "twice@example.com")
    res = client.post("/api/v1/auth/register", json={"email": "Twice@Example.com", "password": PASSWORD})
    assert res.status_code == 409
    assert res.json()["code"] == "email_taken"


def test_login_wrong_and_unknown_look_the_same(client: TestClient):
    _register(client, "known@example.com")
    wrong = client.post("/api/v1/auth/login", json={"email": "known@example.com", "password": "wrong-password"})
    missing = client.post("/api/v1/auth/login", json={"email": "missing@example.com", "password": PASSWORD})
    assert wrong.status_code == missing.status_code == 401
    assert wrong.json()["code"] == missing.json()["code"] == "invalid_credentials"


def test_short_password_and_bad_email_rejected(client: TestClient):
    short = client.post("/api/v1/auth/register", json={"email": "short@example.com", "password": "short"})
    bad = client.post("/api/v1/auth/register", json={"email": "not-an-email", "password": PASSWORD})
    assert short.status_code == 422
    assert bad.status_code == 422
    assert bad.json()["code"] == "invalid_email"
    self_admin = client.post(
        "/api/v1/auth/register",
        json={"email": "self-admin@example.com", "password": PASSWORD, "role": "admin"},
    )
    assert self_admin.status_code == 422


def test_login_then_logout_kills_token(client: TestClient):
    _register(client, "bye@example.com")
    logged = client.post("/api/v1/auth/login", json={"email": "bye@example.com", "password": PASSWORD})
    assert logged.status_code == 200, logged.text
    token = logged.json()["access_token"]
    headers = {"X-Access-Token": token}
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 200
    assert client.post("/api/v1/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401


def test_demo_login_opens_the_same_account(client: TestClient):
    first = client.post("/api/v1/auth/demo", headers={"Origin": "http://192.168.1.20:3000"})
    second = client.post("/api/v1/auth/demo", headers={"Origin": "http://10.0.0.8:3000"})
    assert first.headers["access-control-allow-origin"] == "http://192.168.1.20:3000"
    assert second.headers["access-control-allow-origin"] == "http://10.0.0.8:3000"
    assert first.status_code == second.status_code == 200
    assert first.json()["email"] == second.json()["email"] == "demo@pitchcoach.local"
    assert first.json()["id"] == second.json()["id"]
    first_headers = {"X-Access-Token": first.json()["access_token"]}
    second_headers = {"X-Access-Token": second.json()["access_token"]}
    assert client.get("/api/v1/auth/me", headers=first_headers).status_code == 200
    assert client.get("/api/v1/auth/me", headers=second_headers).status_code == 200
    assert client.post("/api/v1/auth/logout", headers=first_headers).status_code == 204
    assert client.get("/api/v1/auth/me", headers=first_headers).status_code == 401
    assert client.get("/api/v1/auth/me", headers=second_headers).status_code == 200
    blocked = client.post("/api/v1/auth/register", json={"email": "demo@pitchcoach.local", "password": PASSWORD})
    assert blocked.status_code == 409


def _supabase_user(email: str, providers=("google",), confirmed=True) -> dict:
    return {
        "email": email,
        "email_confirmed_at": "2026-01-01T00:00:00Z" if confirmed else None,
        "app_metadata": {"providers": list(providers)},
    }


@pytest.fixture
def supabase(monkeypatch):
    """Points the server at a fake Supabase. Set `.reply` to the response /auth/v1/user should give."""
    monkeypatch.setattr(config, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    fake = type("FakeSupabase", (), {"reply": httpx.Response(401), "calls": []})()

    def get(url, headers, timeout):
        fake.calls.append((url, headers))
        if isinstance(fake.reply, Exception):
            raise fake.reply
        return fake.reply

    monkeypatch.setattr(supabase_auth.httpx, "get", get)
    return fake


def _google(client: TestClient, token: str = "supabase-token"):
    return client.post("/api/v1/auth/google", json={"access_token": token})


def test_google_creates_an_account_without_a_password(client: TestClient, supabase):
    supabase.reply = httpx.Response(200, json=_supabase_user("New.Person@Gmail.com"))
    res = _google(client)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["email"] == "new.person@gmail.com"
    assert body["role"] == "member"
    url, headers = supabase.calls[-1]
    assert url == "https://example.supabase.co/auth/v1/user"
    assert headers["Authorization"] == "Bearer supabase-token"
    assert client.get("/api/v1/auth/me", headers={"X-Access-Token": body["access_token"]}).status_code == 200

    with Session(engine) as db:
        user = db.exec(select(AppUser).where(AppUser.email == "new.person@gmail.com")).one()
    assert user.password_hash is None
    no_password = client.post("/api/v1/auth/login", json={"email": "new.person@gmail.com", "password": PASSWORD})
    assert no_password.status_code == 401


def test_google_reuses_the_account_with_that_email(client: TestClient, supabase):
    created = _register(client, "linked@example.com")
    supabase.reply = httpx.Response(200, json=_supabase_user("linked@example.com"))
    res = _google(client)
    assert res.status_code == 200, res.text
    assert res.json()["id"] == created["id"]
    assert res.json()["role"] == "member"


def test_allowlisted_google_account_is_admin_but_password_registration_is_not(client: TestClient, supabase, monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
    registered = _register(client, "admin@example.com")
    assert registered["role"] == "member"

    supabase.reply = httpx.Response(200, json=_supabase_user("ADMIN@example.com"))
    response = _google(client)

    assert response.status_code == 200
    assert response.json()["role"] == "admin"
    with Session(engine) as db:
        user = db.exec(select(AppUser).where(AppUser.email == "admin@example.com")).one()
    assert user.role == "admin"


def test_admin_can_manage_roles_disable_accounts_and_access_other_projects(client: TestClient, supabase, monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
    supabase.reply = httpx.Response(200, json=_supabase_user("admin@example.com"))
    admin = _google(client).json()
    admin_headers = {"X-Access-Token": admin["access_token"]}

    member = _register(client, "member@example.com")
    member_headers = {"X-Access-Token": member["access_token"]}
    project = client.post("/api/v1/projects", headers=member_headers, json={"name": "Private"}).json()
    assert client.get(f"/api/v1/projects/{project['id']}", headers=admin_headers).status_code == 200
    assert client.get(f"/api/v1/projects/{project['id']}", headers=member_headers).status_code == 200
    assert client.get("/api/v1/admin/users", headers=member_headers).status_code == 403

    projects = client.get("/api/v1/projects", headers=admin_headers)
    assert projects.status_code == 200
    assert any(row["id"] == project["id"] and row["owner_email"] == "member@example.com" for row in projects.json())

    users = client.get("/api/v1/admin/users", headers=admin_headers)
    assert users.status_code == 200
    assert any(row["id"] == member["id"] and row["role"] == "member" for row in users.json())

    promoted = client.patch(
        f"/api/v1/admin/users/{member['id']}",
        headers=admin_headers,
        json={"role": "admin"},
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "admin"

    disabled = client.patch(
        f"/api/v1/admin/users/{member['id']}",
        headers=admin_headers,
        json={"is_active": False},
    )
    assert disabled.status_code == 200
    assert client.get("/api/v1/auth/me", headers=member_headers).status_code == 401

    enabled = client.patch(
        f"/api/v1/admin/users/{member['id']}",
        headers=admin_headers,
        json={"is_active": True},
    )
    assert enabled.status_code == 200
    assert client.get("/api/v1/auth/me", headers=member_headers).status_code == 401


def test_admin_cannot_change_self_or_remove_configured_admin(client: TestClient, supabase, monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
    supabase.reply = httpx.Response(200, json=_supabase_user("admin@example.com"))
    admin = _google(client).json()
    headers = {"X-Access-Token": admin["access_token"]}

    own_change = client.patch(
        f"/api/v1/admin/users/{admin['id']}",
        headers=headers,
        json={"is_active": False},
    )
    assert own_change.status_code == 409

    member = _register(client, "another-member@example.com")
    remove_configured = client.patch(
        f"/api/v1/admin/users/{admin['id']}",
        headers=headers,
        json={"role": "member"},
    )
    assert remove_configured.status_code == 409

    assert client.patch(f"/api/v1/admin/users/{member['id']}", headers=headers, json={}).status_code == 422
    assert (
        client.patch(
            f"/api/v1/admin/users/{member['id']}",
            headers=headers,
            json={"role": None, "is_active": False},
        ).status_code
        == 422
    )


def test_shared_demo_account_cannot_be_promoted_to_admin(client: TestClient, supabase, monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
    supabase.reply = httpx.Response(200, json=_supabase_user("admin@example.com"))
    admin = _google(client).json()
    demo = client.post("/api/v1/auth/demo").json()

    response = client.patch(
        f"/api/v1/admin/users/{demo['id']}",
        headers={"X-Access-Token": admin["access_token"]},
        json={"role": "admin"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "demo_cannot_be_admin"
    assert client.post("/api/v1/auth/demo").status_code == 200


def test_google_rejects_bad_or_unverified_tokens(client: TestClient, supabase):
    supabase.reply = httpx.Response(401, json={"msg": "invalid JWT"})
    assert _google(client).json()["code"] == "invalid_google_token"
    supabase.reply = httpx.Response(200, json=_supabase_user("pw@example.com", providers=("email",)))
    assert _google(client).status_code == 401
    supabase.reply = httpx.Response(200, json=_supabase_user("late@example.com", confirmed=False))
    assert _google(client).status_code == 401
    supabase.reply = httpx.Response(200, json=_supabase_user("demo@pitchcoach.local"))
    assert _google(client).status_code == 401


def test_google_reports_an_unreachable_supabase(client: TestClient, supabase):
    supabase.reply = httpx.ConnectError("down")
    res = _google(client)
    assert res.status_code == 502
    assert res.json()["code"] == "google_unreachable"


def test_google_is_off_without_supabase_settings(client: TestClient, monkeypatch):
    monkeypatch.setattr(config, "SUPABASE_URL", "")
    res = _google(client)
    assert res.status_code == 503
    assert res.json()["code"] == "google_disabled"


def test_other_users_project_is_hidden(client: TestClient):
    owner = _register(client, "owner@example.com")
    other = _register(client, "other@example.com")
    project = client.post("/api/v1/projects", headers={"X-Access-Token": owner["access_token"]}, json={"name": "Secret"})
    assert project.status_code == 201, project.text
    hidden = client.get(f"/api/v1/projects/{project.json()['id']}", headers={"X-Access-Token": other["access_token"]})
    assert hidden.status_code == 404
    assert client.get("/api/v1/projects").status_code == 401
    assert client.post("/api/v1/users").status_code == 404
