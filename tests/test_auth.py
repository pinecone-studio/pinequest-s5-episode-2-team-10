"""Register, login, Google sign-in, logout, and project ownership."""

import os
import io
import tempfile
from pathlib import Path

_root = Path(tempfile.mkdtemp(prefix="pitchcoach-auth-"))
os.environ["PITCH_DATA_DIR"] = str(_root)
os.environ["PITCH_DB_URL"] = f"sqlite:///{_root / 'auth.db'}"

import httpx
import pytest
from PIL import Image
from sqlalchemy import create_engine as create_sqlalchemy_engine, inspect, text
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend import config, db as db_module, main as main_module, supabase_auth
from backend.db import AccessToken, AppUser, AudioAsset, engine
from backend.main import app

PASSWORD = "password1"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def clear_admin_allowlist(monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", set())


def _register(client: TestClient, email: str, username: str | None = None) -> dict:
    username = username or email.split("@")[0].replace("-", "_")
    res = client.post("/api/v1/auth/register", json={"email": email, "username": username, "password": PASSWORD})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["access_token"] and body["id"]
    assert body["email"] == email.strip().lower()
    assert body["username"] == username.strip().lower()
    assert body["role"] == "member"
    return body


def test_register_stores_a_hash_and_answers_me(client: TestClient):
    created = _register(client, "Ada@Example.com")
    me = client.get("/api/v1/auth/me", headers={"X-Access-Token": created["access_token"]})
    assert me.status_code == 200
    assert me.json() == {
        "id": created["id"],
        "email": "ada@example.com",
        "username": "ada",
        "role": "member",
        "has_password": True,
    }

    with Session(engine) as db:
        user = db.exec(select(AppUser).where(AppUser.email == "ada@example.com")).one()
    assert user.password_hash
    assert PASSWORD not in user.password_hash
    assert user.password_hash.startswith("pbkdf2_sha256$")


def test_startup_adds_role_columns_to_existing_database_without_losing_users(tmp_path, monkeypatch):
    old_engine = create_sqlalchemy_engine(f"sqlite:///{tmp_path / 'old-schema.db'}")
    with old_engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE app_user (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at DATETIME NOT NULL)"
        ))
        connection.execute(
            text("INSERT INTO app_user (id, token_hash, created_at) VALUES (:id, :token, CURRENT_TIMESTAMP)"),
            {"id": "existing-user", "token": "existing-token-hash"},
        )

    monkeypatch.setattr(db_module, "engine", old_engine)
    monkeypatch.setattr(config, "SESSIONS_DIR", tmp_path / "sessions")
    try:
        db_module.init()
        columns = {column["name"] for column in inspect(old_engine).get_columns("app_user")}
        assert {"role", "is_active", "email", "username", "password_hash"} <= columns
        unique = [
            idx["column_names"] for idx in inspect(old_engine).get_indexes("app_user") if idx.get("unique")
        ]
        assert ["username"] in unique
        with old_engine.connect() as connection:
            row = connection.execute(
                text("SELECT id, role, is_active FROM app_user WHERE id = 'existing-user'")
            ).one()
        assert row.id == "existing-user"
        assert row.role == "member"
        assert row.is_active == 1
    finally:
        old_engine.dispose()


def test_duplicate_email(client: TestClient):
    _register(client, "twice@example.com")
    res = client.post(
        "/api/v1/auth/register",
        json={"email": "Twice@Example.com", "username": "someone_else", "password": PASSWORD},
    )
    assert res.status_code == 409
    assert res.json()["code"] == "email_taken"


def test_duplicate_username_ignores_case(client: TestClient):
    _register(client, "first.saylo@example.com", "saylo.fan")
    res = client.post(
        "/api/v1/auth/register",
        json={"email": "second.saylo@example.com", "username": "Saylo.Fan", "password": PASSWORD},
    )
    assert res.status_code == 409
    assert res.json()["code"] == "username_taken"


def test_profile_update_changes_only_the_authenticated_users_username(client: TestClient):
    owner = _register(client, "profile.owner@example.com", "owner_name")
    other = _register(client, "profile.other@example.com", "other_name")

    updated = client.patch(
        "/api/v1/auth/me",
        headers={"X-Access-Token": owner["access_token"]},
        json={"username": "  Шинэ Нэр  "},
    )
    assert updated.status_code == 200
    assert updated.json() == {
        "id": owner["id"],
        "email": owner["email"],
        "username": "шинэ нэр",
        "role": "member",
        "has_password": True,
    }

    owner_me = client.get("/api/v1/auth/me", headers={"X-Access-Token": owner["access_token"]})
    other_me = client.get("/api/v1/auth/me", headers={"X-Access-Token": other["access_token"]})
    assert owner_me.json()["username"] == "шинэ нэр"
    assert other_me.json()["username"] == "other_name"


def test_profile_update_rejects_duplicate_username_and_missing_auth(client: TestClient):
    _register(client, "profile.taken@example.com", "already_used")
    owner = _register(client, "profile.changer@example.com", "changer")
    headers = {"X-Access-Token": owner["access_token"]}

    duplicate = client.patch("/api/v1/auth/me", headers=headers, json={"username": "ALREADY_USED"})
    unauthorized = client.patch("/api/v1/auth/me", json={"username": "new_name"})
    invalid = client.patch("/api/v1/auth/me", headers=headers, json={"username": "x" * 41})

    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "username_taken"
    assert unauthorized.status_code == 401
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "invalid_username"


def test_shared_demo_profile_is_read_only(client: TestClient):
    demo = client.post("/api/v1/auth/demo").json()
    response = client.patch(
        "/api/v1/auth/me",
        headers={"X-Access-Token": demo["access_token"]},
        json={"username": "someone_else"},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "shared_account_readonly"


def test_profile_avatar_upload_is_private_and_returns_webp(client: TestClient):
    owner = _register(client, "avatar.owner@example.com")
    other = _register(client, "avatar.other@example.com")
    image = Image.new("RGB", (12, 8), "purple")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    headers = {"X-Access-Token": owner["access_token"]}

    uploaded = client.put(
        "/api/v1/auth/me/avatar",
        headers=headers,
        files={"file": ("portrait.png", buffer.getvalue(), "image/png")},
    )
    assert uploaded.status_code == 204, uploaded.text

    fetched = client.get("/api/v1/auth/me/avatar", headers=headers)
    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "image/webp"
    assert fetched.content[:4] == b"RIFF" and fetched.content[8:12] == b"WEBP"

    other_avatar = client.get(
        "/api/v1/auth/me/avatar", headers={"X-Access-Token": other["access_token"]}
    )
    assert other_avatar.status_code == 204
    assert other_avatar.content == b""


def test_profile_avatar_rejects_invalid_image_and_shared_demo_upload(client: TestClient):
    owner = _register(client, "avatar.invalid@example.com")
    invalid = client.put(
        "/api/v1/auth/me/avatar",
        headers={"X-Access-Token": owner["access_token"]},
        files={"file": ("portrait.jpg", b"not an image", "image/jpeg")},
    )
    assert invalid.status_code == 415
    assert invalid.json()["code"] == "invalid_avatar"

    demo = client.post("/api/v1/auth/demo").json()
    demo_avatar = client.get(
        "/api/v1/auth/me/avatar", headers={"X-Access-Token": demo["access_token"]}
    )
    assert demo_avatar.status_code == 200
    assert demo_avatar.headers["content-type"] == "image/webp"
    assert demo_avatar.content[:4] == b"RIFF" and demo_avatar.content[8:12] == b"WEBP"

    blocked = client.put(
        "/api/v1/auth/me/avatar",
        headers={"X-Access-Token": demo["access_token"]},
        files={"file": ("portrait.png", b"anything", "image/png")},
    )
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "shared_account_readonly"


def test_login_with_username_or_email(client: TestClient):
    created = _register(client, "both@example.com", "Both_Ways")
    by_name = client.post("/api/v1/auth/login", json={"login": "  BOTH_ways ", "password": PASSWORD})
    by_email = client.post("/api/v1/auth/login", json={"login": "Both@Example.com", "password": PASSWORD})
    assert by_name.status_code == by_email.status_code == 200
    assert by_name.json()["id"] == by_email.json()["id"] == created["id"]
    assert by_email.json()["username"] == "both_ways"


def test_login_wrong_and_unknown_look_the_same(client: TestClient):
    _register(client, "known@example.com")
    wrong = client.post("/api/v1/auth/login", json={"login": "known@example.com", "password": "wrong-password"})
    missing = client.post("/api/v1/auth/login", json={"login": "missing@example.com", "password": PASSWORD})
    wrong_name = client.post("/api/v1/auth/login", json={"login": "known", "password": "wrong-password"})
    missing_name = client.post("/api/v1/auth/login", json={"login": "nobody_here", "password": PASSWORD})
    responses = [wrong, missing, wrong_name, missing_name]
    assert {r.status_code for r in responses} == {401}
    assert {r.json()["code"] for r in responses} == {"invalid_credentials"}


def test_short_password_and_bad_email_rejected(client: TestClient):
    short = client.post(
        "/api/v1/auth/register", json={"email": "short@example.com", "username": "short", "password": "short"}
    )
    bad = client.post(
        "/api/v1/auth/register", json={"email": "not-an-email", "username": "bad_email", "password": PASSWORD}
    )
    assert short.status_code == 422
    assert bad.status_code == 422
    assert bad.json()["code"] == "invalid_email"
    self_admin = client.post(
        "/api/v1/auth/register",
        json={"email": "self-admin@example.com", "username": "self_admin", "password": PASSWORD, "role": "admin"},
    )
    assert self_admin.status_code == 422


@pytest.mark.parametrize("username", ["   ", "a" * 41])
def test_bad_username_rejected(client: TestClient, username: str):
    res = client.post(
        "/api/v1/auth/register",
        json={"email": "bad.name@example.com", "username": username, "password": PASSWORD},
    )
    assert res.status_code == 422
    assert res.json()["code"] == "invalid_username"


def test_registration_accepts_mongolian_full_name_and_login(client: TestClient):
    created = _register(client, "mongolian-name@example.com", "  Мөнх-Оргил Бат  ")
    assert created["username"] == "мөнх-оргил бат"
    login = client.post(
        "/api/v1/auth/login",
        json={"login": "МӨНХ-ОРГИЛ БАТ", "password": PASSWORD},
    )
    assert login.status_code == 200
    assert login.json()["id"] == created["id"]


def test_registration_accepts_arbitrary_username_characters(client: TestClient):
    created = _register(client, "symbols@example.com", " @?# 🚀 ")
    login = client.post(
        "/api/v1/auth/login",
        json={"login": "@?# 🚀", "password": PASSWORD},
    )
    assert login.status_code == 200
    assert login.json()["id"] == created["id"]


def test_username_is_required(client: TestClient):
    res = client.post("/api/v1/auth/register", json={"email": "no.name@example.com", "password": PASSWORD})
    assert res.status_code == 422


def test_login_then_logout_kills_token(client: TestClient):
    _register(client, "bye@example.com")
    logged = client.post("/api/v1/auth/login", json={"login": "bye@example.com", "password": PASSWORD})
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
    assert first.json()["role"] == second.json()["role"] == "admin"
    assert first.json()["id"] == second.json()["id"]
    first_headers = {"X-Access-Token": first.json()["access_token"]}
    second_headers = {"X-Access-Token": second.json()["access_token"]}
    assert client.get("/api/v1/auth/me", headers=first_headers).json()["role"] == "admin"
    assert client.get("/api/v1/auth/me", headers=second_headers).status_code == 200
    assert client.get("/api/v1/admin/users", headers=first_headers).status_code == 200
    assert client.post("/api/v1/auth/logout", headers=first_headers).status_code == 204
    assert client.get("/api/v1/auth/me", headers=first_headers).status_code == 401
    assert client.get("/api/v1/auth/me", headers=second_headers).status_code == 200
    blocked = client.post(
        "/api/v1/auth/register",
        json={"email": "demo@pitchcoach.local", "username": "demo_user", "password": PASSWORD},
    )
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
    assert body["username"] is None
    no_password = client.post("/api/v1/auth/login", json={"login": "new.person@gmail.com", "password": PASSWORD})
    assert no_password.status_code == 401


def _change_password(client: TestClient, token: str | None, body: dict):
    headers = {"X-Access-Token": token} if token else {}
    return client.post("/api/v1/auth/me/password", headers=headers, json=body)


def _login(client: TestClient, login: str, password: str):
    return client.post("/api/v1/auth/login", json={"login": login, "password": password})


def test_password_change_needs_the_current_password(client: TestClient):
    owner = _register(client, "pw.change@example.com", "pw_change")
    token = owner["access_token"]

    wrong = _change_password(client, token, {"current_password": "not-the-password", "new_password": "brand-new-pass"})
    missing = _change_password(client, token, {"new_password": "brand-new-pass"})
    assert wrong.status_code == missing.status_code == 400
    assert wrong.json()["code"] == missing.json()["code"] == "wrong_password"
    still_old = _login(client, "pw_change", PASSWORD)
    assert still_old.status_code == 200
    token = still_old.json()["access_token"]  # signing in replaced the registration token

    changed = _change_password(client, token, {"current_password": PASSWORD, "new_password": "brand-new-pass"})
    assert changed.status_code == 204
    assert _login(client, "pw_change", PASSWORD).status_code == 401
    assert _login(client, "pw.change@example.com", "brand-new-pass").status_code == 200


def test_password_change_rejects_short_same_or_unauthenticated(client: TestClient):
    owner = _register(client, "pw.rules@example.com", "pw_rules")
    token = owner["access_token"]

    short = _change_password(client, token, {"current_password": PASSWORD, "new_password": "short"})
    same = _change_password(client, token, {"current_password": PASSWORD, "new_password": PASSWORD})
    anonymous = _change_password(client, None, {"current_password": PASSWORD, "new_password": "brand-new-pass"})
    extra = _change_password(client, token, {"current_password": PASSWORD, "new_password": "brand-new-pass", "role": "admin"})

    assert short.status_code == 422
    assert same.status_code == 422
    assert same.json()["code"] == "same_password"
    assert anonymous.status_code == 401
    assert extra.status_code == 422
    assert _login(client, "pw_rules", PASSWORD).status_code == 200


def test_password_change_signs_out_other_devices_but_keeps_this_one(client: TestClient):
    _register(client, "pw.devices@example.com", "pw_devices")
    current = _login(client, "pw_devices", PASSWORD).json()["access_token"]
    with Session(engine) as db:
        user = db.exec(select(AppUser).where(AppUser.email == "pw.devices@example.com")).one()
        db.add(AccessToken(token_hash=main_module._hash("other-device-token"), user_id=user.id))
        db.commit()
    assert client.get("/api/v1/auth/me", headers={"X-Access-Token": "other-device-token"}).status_code == 200

    changed = _change_password(client, current, {"current_password": PASSWORD, "new_password": "brand-new-pass"})
    assert changed.status_code == 204
    assert client.get("/api/v1/auth/me", headers={"X-Access-Token": "other-device-token"}).status_code == 401
    assert client.get("/api/v1/auth/me", headers={"X-Access-Token": current}).status_code == 200


def test_google_account_sets_a_first_password_without_the_current_one(client: TestClient, supabase):
    supabase.reply = httpx.Response(200, json=_supabase_user("first.password@gmail.com"))
    token = _google(client).json()["access_token"]
    headers = {"X-Access-Token": token}
    assert client.get("/api/v1/auth/me", headers=headers).json()["has_password"] is False

    changed = _change_password(client, token, {"new_password": "my-first-pass"})
    assert changed.status_code == 204
    assert client.get("/api/v1/auth/me", headers=headers).json()["has_password"] is True
    assert _login(client, "first.password@gmail.com", "my-first-pass").status_code == 200


def test_shared_demo_password_cannot_change(client: TestClient):
    demo = client.post("/api/v1/auth/demo").json()
    res = _change_password(client, demo["access_token"], {"new_password": "brand-new-pass"})
    assert res.status_code == 403
    assert res.json()["code"] == "shared_account_readonly"


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

    attempt = client.post(
        f"/api/v1/projects/{project['id']}/sessions",
        headers=member_headers,
        json={"copy_inputs": False},
    ).json()
    with Session(engine) as database:
        database.add(AudioAsset(
            session_id=attempt["id"],
            path=f"storage://sessions/{attempt['id']}/audio.wav",
            original_path=f"storage://sessions/{attempt['id']}/original.wav",
            duration_s=5,
            format="wav",
        ))
        database.commit()
    monkeypatch.setattr(main_module.db, "shared_storage_enabled", lambda: True)
    monkeypatch.setattr(main_module.storage, "download_bytes", lambda _: b"private-audio")
    admin_audio = client.get(f"/api/v1/sessions/{attempt['id']}/audio", headers=admin_headers)
    assert admin_audio.status_code == 200
    assert admin_audio.content == b"private-audio"

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
    disable_configured = client.patch(
        f"/api/v1/admin/users/{admin['id']}",
        headers=headers,
        json={"is_active": False},
    )
    assert disable_configured.status_code == 409

    assert client.patch(f"/api/v1/admin/users/{member['id']}", headers=headers, json={}).status_code == 422
    assert (
        client.patch(
            f"/api/v1/admin/users/{member['id']}",
            headers=headers,
            json={"role": None, "is_active": False},
        ).status_code
        == 422
    )


def test_shared_demo_login_grants_admin_access(client: TestClient, supabase, monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
    supabase.reply = httpx.Response(200, json=_supabase_user("admin@example.com"))
    admin = _google(client).json()
    demo = client.post("/api/v1/auth/demo").json()

    assert demo["role"] == "admin"
    users = client.get("/api/v1/admin/users", headers={"X-Access-Token": demo["access_token"]})
    assert users.status_code == 200
    assert any(row["id"] == demo["id"] and row["role"] == "admin" for row in users.json())

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


# ---- Admin status ------------------------------------------------------------------------------

from backend import status as status_module  # noqa: E402


def _admin_headers(client: TestClient, email: str) -> dict:
    body = _register(client, email)
    with Session(engine) as db:
        user = db.get(AppUser, body["id"])
        user.role = "admin"
        db.add(user)
        db.commit()
    return {"X-Access-Token": body["access_token"]}


class _FakeResponse:
    def __init__(self, body: dict):
        self._body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self._body


def test_admin_status_is_admin_only(client: TestClient):
    assert client.get("/api/v1/admin/status").status_code == 401
    member = _register(client, "status-member@example.com")
    assert client.get("/api/v1/admin/status", headers={"X-Access-Token": member["access_token"]}).status_code == 403


def test_admin_status_reports_down_services_without_failing(client: TestClient, monkeypatch):
    def unreachable(*_args, **_kwargs):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(status_module.httpx, "get", unreachable)
    headers = _admin_headers(client, "status-admin@example.com")
    res = client.get("/api/v1/admin/status", headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["backend"]["ok"] is True
    assert body["database"]["ok"] is True
    assert body["voice"]["ok"] is False and body["voice"]["error"] == "Not reachable."
    assert body["ollama"]["ok"] is False and body["ollama"]["error"] == "Not reachable."
    assert body["gemma_test"] is None  # only on request
    assert body["voice"]["where"] in ("local", "remote") and "url" not in body["voice"]  # no addresses or tokens


def test_admin_status_reads_voice_and_gemma(client: TestClient, monkeypatch):
    model = status_module.pipeline_config.OLLAMA_MODEL_BASE
    replies = {
        "/health": {"ok": True, "model_loaded": True, "model": "BuzzASR/mongolian", "device": "GPU", "cuda": True, "busy": False},
        "/api/version": {"version": "0.40.11"},
        "/api/tags": {"models": [{"name": model, "model": model}]},
        "/api/ps": {"models": [{"name": model, "size": 1000, "size_vram": 1000}]},
    }
    monkeypatch.setattr(status_module.httpx, "get", lambda url, **_: _FakeResponse(next(v for k, v in replies.items() if url.endswith(k))))
    monkeypatch.setattr(
        status_module.httpx, "post",
        lambda url, **_: _FakeResponse({"response": "OK", "eval_count": 2, "eval_duration": 20_000_000}),
    )
    headers = _admin_headers(client, "status-admin2@example.com")
    body = client.get("/api/v1/admin/status?test_gemma=true", headers=headers).json()
    assert body["voice"]["ok"] is True and body["voice"]["model_loaded"] is True and body["voice"]["cuda"] is True
    assert body["ollama"] == {**body["ollama"], "ok": True, "installed": True, "loaded": True, "gpu_share": 1.0}
    assert body["gemma_test"]["ok"] is True and body["gemma_test"]["tokens_per_s"] == 100.0


def test_admin_status_flags_a_missing_model_and_an_unloaded_voice_model(client: TestClient, monkeypatch):
    replies = {
        "/health": {"ok": True, "model_loaded": False},
        "/api/version": {"version": "0.40.11"},
        "/api/tags": {"models": [{"name": "something-else:latest"}]},
        "/api/ps": {"models": []},
    }
    monkeypatch.setattr(status_module.httpx, "get", lambda url, **_: _FakeResponse(next(v for k, v in replies.items() if url.endswith(k))))
    headers = _admin_headers(client, "status-admin3@example.com")
    body = client.get("/api/v1/admin/status", headers=headers).json()
    assert body["voice"]["ok"] is False and "isn't loaded" in body["voice"]["error"]
    assert body["ollama"]["ok"] is False and body["ollama"]["installed"] is False and "isn't installed" in body["ollama"]["error"]


def test_deployed_status_is_admin_only_and_reports_each_part(client: TestClient, monkeypatch):
    member = _register(client, "deployed-member@example.com")
    assert client.get("/api/v1/admin/status/deployed", headers={"X-Access-Token": member["access_token"]}).status_code == 403

    class Reply(_FakeResponse):
        def __init__(self, body, code=200):
            super().__init__(body)
            self.status_code = code

    seen_lang = []

    def fake_get(url, **kwargs):
        if url.endswith("/api/transcribe"):
            seen_lang.append(kwargs.get("headers", {}).get("x-pitch-lang"))
            return Reply({"ok": False, "error": "The voice server isn't running."})
        if url.endswith("/api/v1/health"):
            return Reply({"ok": True, "queue_length": 2, "asr": "remote", "default_backend": "gemma4-base"})
        if url.endswith("/api/v1/admin/status"):
            return Reply({}, 404)
        return Reply({}, 200)  # the site's front page

    monkeypatch.setattr(status_module.httpx, "get", fake_get)
    headers = _admin_headers(client, "deployed-admin@example.com")
    body = client.get("/api/v1/admin/status/deployed?lang=en", headers=headers).json()
    assert body["web"]["ok"] is True
    assert body["web_voice"]["ok"] is False and body["web_voice"]["error"] == "The voice server isn't running."
    assert body["web_voice"]["reachable"] is False
    assert body["backend"]["ok"] is True and body["backend"]["queue_length"] == 2
    assert body["backend"]["has_status_check"] is False  # an older deployed backend
    assert seen_lang == ["en"]


def test_deployed_status_reports_a_sleeping_or_dead_backend(client: TestClient, monkeypatch):
    def fake_get(url, **_):
        if "/api/v1/" in url:
            raise httpx.ReadTimeout("slow")
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(status_module.httpx, "get", fake_get)
    headers = _admin_headers(client, "deployed-admin2@example.com")
    body = client.get("/api/v1/admin/status/deployed", headers=headers).json()
    assert body["web"] == {**body["web"], "ok": False, "error": "Not reachable."}
    assert body["backend"] == {**body["backend"], "ok": False, "error": "Timed out."}


def test_health_reports_gemma_without_an_address_and_caches_it(client: TestClient, monkeypatch):
    model = status_module.pipeline_config.OLLAMA_MODEL_BASE
    calls = []

    def fake_get(url, **_):
        calls.append(url)
        replies = {
            "/api/version": {"version": "0.40.12"},
            "/api/tags": {"models": [{"name": model}]},
            "/api/ps": {"models": [{"name": model, "size": 100, "size_vram": 50}]},
        }
        return _FakeResponse(next(v for k, v in replies.items() if url.endswith(k)))

    monkeypatch.setattr(status_module.httpx, "get", fake_get)
    monkeypatch.setattr(status_module, "_gemma_summary", None)
    first = client.get("/api/v1/health").json()["gemma"]
    assert first == {"ok": True, "model": model, "installed": True, "loaded": True, "gpu_share": 0.5}
    assert "where" not in first and "url" not in first
    n = len(calls)
    assert client.get("/api/v1/health").json()["gemma"] == first
    assert len(calls) == n  # the second health check used the cached answer


def test_deployed_status_passes_on_the_deployed_gemma(client: TestClient, monkeypatch):
    gemma = {"ok": False, "model": "gemma4:e4b", "installed": False, "error": "gemma4:e4b isn't installed in Ollama."}

    def fake_get(url, **_):
        class Reply(_FakeResponse):
            status_code = 200
        if url.endswith("/api/v1/health"):
            return Reply({"ok": True, "queue_length": 0, "gemma": gemma})
        if url.endswith("/api/transcribe"):
            return Reply({"ok": True, "modelLoaded": True})
        return Reply({})

    monkeypatch.setattr(status_module.httpx, "get", fake_get)
    headers = _admin_headers(client, "deployed-admin3@example.com")
    body = client.get("/api/v1/admin/status/deployed", headers=headers).json()
    assert body["backend"]["gemma"] == gemma

    # An older deployed backend doesn't report it.
    monkeypatch.setattr(status_module.httpx, "get", lambda url, **_: type("R", (_FakeResponse,), {"status_code": 200})(
        {"ok": True, "queue_length": 0} if url.endswith("/api/v1/health") else {"ok": True, "modelLoaded": True}))
    assert client.get("/api/v1/admin/status/deployed", headers=headers).json()["backend"]["gemma"] is None
