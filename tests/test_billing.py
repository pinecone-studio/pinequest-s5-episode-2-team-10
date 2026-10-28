"""Subscription: trial and paid-period rules, read-only access after expiry, and QPay payments."""

import os
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

if "PITCH_DB_URL" not in os.environ:
    _root = Path(tempfile.mkdtemp(prefix="pitchcoach-billing-"))
    os.environ["PITCH_DATA_DIR"] = str(_root)
    os.environ["PITCH_DB_URL"] = f"sqlite:///{_root / 'billing.db'}"

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend import billing, config, db as db_module, main as main_module, qpay
from backend.db import AppUser, Payment, engine
from backend.main import app

PASSWORD = "password1"
PRICE = 9900
NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def client():
    # Another test module may already have started the analysis worker thread in this process.
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(main_module.worker, "start", lambda: None)
        with TestClient(app) as c:
            yield c


@pytest.fixture(autouse=True)
def defaults(monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", set())
    monkeypatch.setattr(config, "BILLING_ENFORCED", False)
    monkeypatch.setattr(config, "SUBSCRIPTION_PRICE_MNT", 0)


@pytest.fixture
def enforced(monkeypatch):
    monkeypatch.setattr(config, "BILLING_ENFORCED", True)


class FakeQPay:
    """Stands in for QPay's merchant API. `paid` maps an invoice id to the amount paid."""

    def __init__(self):
        self.paid: dict[str, int] = {}
        self.down = False
        self.invoices = 0
        self.checks = 0

    def post(self, url, auth=None, json=None, headers=None, timeout=None):
        if self.down:
            raise httpx.ConnectError("down")
        if url.endswith("/v2/auth/token"):
            return httpx.Response(200, json={"access_token": "test-token", "expires_in": 3600})
        if url.endswith("/v2/invoice"):
            self.invoices += 1
            return httpx.Response(
                200,
                json={
                    "invoice_id": f"inv-{self.invoices}-{json['sender_invoice_no']}",
                    "qr_text": "qr-text",
                    "qr_image": "aGVsbG8=",
                    "qPay_shortUrl": "https://s.qpay.mn/test",
                    "urls": [{"name": "Khan bank", "description": "Хаан банк", "logo": "https://logo", "link": "khanbank://q?qPay_QRcode=x"}],
                },
            )
        if url.endswith("/v2/payment/check"):
            self.checks += 1
            amount = self.paid.get(json["object_id"])
            rows = [{"payment_id": "pay-1", "payment_status": "PAID", "payment_amount": amount}] if amount else []
            return httpx.Response(200, json={"count": len(rows), "rows": rows})
        return httpx.Response(404)


@pytest.fixture
def fake_qpay(monkeypatch):
    monkeypatch.setattr(config, "SUBSCRIPTION_PRICE_MNT", PRICE)
    monkeypatch.setattr(config, "QPAY_CLIENT_ID", "client")
    monkeypatch.setattr(config, "QPAY_CLIENT_SECRET", "secret")
    monkeypatch.setattr(config, "QPAY_INVOICE_CODE", "SAYLO_INVOICE")
    qpay.reset_token()
    fake = FakeQPay()
    monkeypatch.setattr(qpay.httpx, "post", fake.post)
    yield fake
    qpay.reset_token()


def _register(client: TestClient, name: str) -> dict:
    res = client.post("/api/v1/auth/register", json={"email": f"{name}@example.com", "username": name, "password": PASSWORD})
    assert res.status_code == 201, res.text
    return res.json()


def _headers(account: dict) -> dict:
    return {"X-Access-Token": account["access_token"]}


def _set_dates(user_id: str, trial_ends_at=None, paid_until=None, role=None):
    with Session(engine) as s:
        user = s.get(AppUser, user_id)
        user.trial_ends_at = trial_ends_at
        user.paid_until = paid_until
        if role:
            user.role = role
        s.add(user)
        s.commit()


def _user(user_id: str) -> AppUser:
    with Session(engine) as s:
        return s.get(AppUser, user_id)


def _expire(user_id: str):
    _set_dates(user_id, trial_ends_at=datetime.now(timezone.utc) - timedelta(days=1))


# ---- Rules ------------------------------------------------------------------


def test_access_state_follows_trial_paid_period_and_exemptions(monkeypatch):
    user = AppUser(token_hash="x", email="rules@example.com", trial_ends_at=NOW + timedelta(days=3))
    assert billing.access_state(user, NOW).state == "trial"
    assert billing.access_state(user, NOW).days_left == 3

    user.trial_ends_at = NOW - timedelta(seconds=1)
    assert billing.access_state(user, NOW).state == "expired"

    user.paid_until = NOW + timedelta(days=10)
    access = billing.access_state(user, NOW)
    assert (access.state, access.days_left) == ("active", 10)

    user.paid_until = NOW - timedelta(days=1)
    expired = billing.access_state(user, NOW)
    monkeypatch.setattr(config, "BILLING_ENFORCED", False)
    assert expired.state == "expired" and expired.allowed
    monkeypatch.setattr(config, "BILLING_ENFORCED", True)
    assert not expired.allowed

    admin = AppUser(token_hash="a", email="boss@example.com", role="admin", trial_ends_at=NOW - timedelta(days=99))
    demo = AppUser(token_hash="d", email="demo@pitchcoach.local", trial_ends_at=NOW - timedelta(days=99))
    assert billing.access_state(admin, NOW).allowed and billing.access_state(admin, NOW).state == "admin"
    assert billing.access_state(demo, NOW).allowed


def test_new_trial_reads_as_full_days():
    user = AppUser(token_hash="t", trial_ends_at=NOW + timedelta(days=7, milliseconds=5))
    assert billing.access_state(user, NOW).days_left == 7


def test_payment_adds_a_period_after_the_latest_end():
    during_trial = AppUser(token_hash="1", trial_ends_at=NOW + timedelta(days=2))
    assert billing.extend(during_trial, NOW, 30) == NOW + timedelta(days=32)

    active = AppUser(token_hash="2", trial_ends_at=NOW - timedelta(days=20), paid_until=NOW + timedelta(days=5))
    assert billing.extend(active, NOW, 30) == NOW + timedelta(days=35)

    lapsed = AppUser(token_hash="3", trial_ends_at=NOW - timedelta(days=40), paid_until=NOW - timedelta(days=3))
    assert billing.extend(lapsed, NOW, 30) == NOW + timedelta(days=30)


# ---- Access over the API -----------------------------------------------------


def test_new_account_starts_a_seven_day_trial(client: TestClient):
    account = _register(client, "billing_new")
    status = client.get("/api/v1/billing/status", headers=_headers(account)).json()
    assert status["state"] == "trial"
    assert status["days_left"] == config.TRIAL_DAYS
    assert status["allowed"] is True
    assert status["payments_enabled"] is False


def test_expired_account_is_read_only_when_enforced(client: TestClient, enforced):
    account = _register(client, "billing_expired")
    headers = _headers(account)
    project = client.post("/api/v1/projects", headers=headers, json={"name": "Before expiry"}).json()
    attempt = project["attempts"][0] if project.get("attempts") else client.post(
        f"/api/v1/projects/{project['id']}/sessions", headers=headers
    ).json()
    _expire(account["id"])

    blocked = [
        client.post("/api/v1/projects", headers=headers, json={"name": "After expiry"}),
        client.post(f"/api/v1/projects/{project['id']}/sessions", headers=headers),
        client.put(f"/api/v1/sessions/{attempt['id']}/script", headers=headers, json={"text": "hello"}),
        client.post(f"/api/v1/sessions/{attempt['id']}/analyze", headers=headers),
        client.post(
            f"/api/v1/sessions/{attempt['id']}/audio",
            headers=headers,
            files={"file": ("take.wav", b"RIFF", "audio/wav")},
        ),
    ]
    assert [r.status_code for r in blocked] == [402] * len(blocked)
    assert {r.json()["code"] for r in blocked} == {"subscription_required"}

    assert client.get("/api/v1/projects", headers=headers).status_code == 200
    assert client.get(f"/api/v1/projects/{project['id']}", headers=headers).status_code == 200
    renamed = client.patch(f"/api/v1/projects/{project['id']}", headers=headers, json={"name": "Renamed"})
    assert renamed.status_code == 200
    assert client.delete(f"/api/v1/projects/{project['id']}", headers=headers).status_code == 204


def test_expired_account_is_not_blocked_while_billing_is_off(client: TestClient):
    account = _register(client, "billing_off")
    _expire(account["id"])
    res = client.post("/api/v1/projects", headers=_headers(account), json={"name": "Still allowed"})
    assert res.status_code == 201


def test_demo_and_admin_are_never_blocked(client: TestClient, enforced):
    demo = client.post("/api/v1/auth/demo").json()
    _expire(demo["id"])
    assert client.post("/api/v1/projects", headers=_headers(demo), json={"name": "Demo"}).status_code == 201

    admin = _register(client, "billing_admin")
    _set_dates(admin["id"], trial_ends_at=datetime.now(timezone.utc) - timedelta(days=5), role="admin")
    assert client.post("/api/v1/projects", headers=_headers(admin), json={"name": "Admin"}).status_code == 201


# ---- QPay payments ------------------------------------------------------------


def test_invoice_payment_extends_access_and_unblocks(client: TestClient, enforced, fake_qpay):
    account = _register(client, "billing_payer")
    headers = _headers(account)
    _expire(account["id"])

    invoice = client.post("/api/v1/billing/invoice", headers=headers)
    assert invoice.status_code == 201, invoice.text
    body = invoice.json()
    assert body["status"] == "pending"
    assert body["amount_mnt"] == PRICE
    assert body["qr_image"] and body["bank_links"][0]["link"].startswith("khanbank://")

    again = client.post("/api/v1/billing/invoice", headers=headers).json()
    assert again["id"] == body["id"]
    assert fake_qpay.invoices == 1

    pending = client.get(f"/api/v1/billing/payments/{body['id']}", headers=headers).json()
    assert pending["payment"]["status"] == "pending"
    assert pending["billing"]["state"] == "expired"

    with Session(engine) as s:
        fake_qpay.paid[s.get(Payment, body["id"]).invoice_id] = PRICE
    paid = client.get(f"/api/v1/billing/payments/{body['id']}", headers=headers).json()
    assert paid["payment"]["status"] == "paid"
    assert paid["billing"]["state"] == "active"
    assert paid["billing"]["days_left"] == config.SUBSCRIPTION_DAYS
    assert client.post("/api/v1/projects", headers=headers, json={"name": "Paid"}).status_code == 201

    history = client.get("/api/v1/billing/payments", headers=headers).json()
    assert [p["status"] for p in history] == ["paid"]


def test_simultaneous_invoice_requests_share_one_invoice(client: TestClient, fake_qpay):
    account = _register(client, "billing_double")
    headers = _headers(account)
    results: list[dict] = []

    def buy():
        results.append(client.post("/api/v1/billing/invoice", headers=headers).json())

    threads = [threading.Thread(target=buy) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len({r["id"] for r in results}) == 1
    assert fake_qpay.invoices == 1


def test_callback_and_poll_grant_the_period_once(client: TestClient, fake_qpay):
    account = _register(client, "billing_once")
    headers = _headers(account)
    payment_id = client.post("/api/v1/billing/invoice", headers=headers).json()["id"]
    with Session(engine) as s:
        fake_qpay.paid[s.get(Payment, payment_id).invoice_id] = PRICE
    trial_end = billing.aware(_user(account["id"]).trial_ends_at)

    assert client.get(f"/api/v1/billing/qpay/callback?payment_id={payment_id}").json() == {"ok": True}
    assert client.post(f"/api/v1/billing/qpay/callback?payment_id={payment_id}").status_code == 200
    client.get(f"/api/v1/billing/payments/{payment_id}", headers=headers)

    paid_until = billing.aware(_user(account["id"]).paid_until)
    assert paid_until - trial_end == timedelta(days=config.SUBSCRIPTION_DAYS)


def test_underpaid_invoice_is_not_granted(client: TestClient, fake_qpay):
    account = _register(client, "billing_short")
    headers = _headers(account)
    payment_id = client.post("/api/v1/billing/invoice", headers=headers).json()["id"]
    with Session(engine) as s:
        fake_qpay.paid[s.get(Payment, payment_id).invoice_id] = PRICE - 100
    result = client.get(f"/api/v1/billing/payments/{payment_id}", headers=headers).json()
    assert result["payment"]["status"] == "pending"
    assert _user(account["id"]).paid_until is None


def test_callback_ignores_unknown_or_missing_payments(client: TestClient, fake_qpay):
    assert client.get("/api/v1/billing/qpay/callback?payment_id=nope").json() == {"ok": True}
    assert client.post("/api/v1/billing/qpay/callback").json() == {"ok": True}
    assert fake_qpay.checks == 0


def test_payments_belong_to_their_owner(client: TestClient, fake_qpay):
    owner = _register(client, "billing_owner")
    other = _register(client, "billing_other")
    payment_id = client.post("/api/v1/billing/invoice", headers=_headers(owner)).json()["id"]
    res = client.get(f"/api/v1/billing/payments/{payment_id}", headers=_headers(other))
    assert res.status_code == 404
    assert client.get("/api/v1/billing/payments", headers=_headers(other)).json() == []


def test_qpay_outage_is_a_clear_error_and_polls_stay_pending(client: TestClient, fake_qpay):
    account = _register(client, "billing_outage")
    headers = _headers(account)
    payment_id = client.post("/api/v1/billing/invoice", headers=headers).json()["id"]

    fake_qpay.down = True
    qpay.reset_token()
    poll = client.get(f"/api/v1/billing/payments/{payment_id}", headers=headers)
    assert poll.status_code == 200
    assert poll.json()["payment"]["status"] == "pending"

    with Session(engine) as s:
        payment = s.get(Payment, payment_id)
        payment.created_at = datetime.now(timezone.utc) - timedelta(hours=1)
        s.add(payment)
        s.commit()
    fresh = client.post("/api/v1/billing/invoice", headers=headers)
    assert fresh.status_code == 502
    assert fresh.json()["code"] == "payment_unavailable"


def test_invoice_needs_payments_configured_and_a_paying_account(client: TestClient):
    account = _register(client, "billing_unset")
    res = client.post("/api/v1/billing/invoice", headers=_headers(account))
    assert res.status_code == 503
    assert res.json()["code"] == "payments_disabled"

    demo = client.post("/api/v1/auth/demo").json()
    assert client.post("/api/v1/billing/invoice", headers=_headers(demo)).status_code == 409


def test_admin_can_grant_days(client: TestClient):
    admin = _register(client, "billing_granter")
    _set_dates(admin["id"], trial_ends_at=datetime.now(timezone.utc) + timedelta(days=7), role="admin")
    member = _register(client, "billing_granted")
    _expire(member["id"])

    res = client.patch(f"/api/v1/admin/users/{member['id']}", headers=_headers(admin), json={"grant_days": 30})
    assert res.status_code == 200, res.text
    assert res.json()["paid_until"]
    status = client.get("/api/v1/billing/status", headers=_headers(member)).json()
    assert (status["state"], status["days_left"]) == ("active", 30)

    too_many = client.patch(f"/api/v1/admin/users/{member['id']}", headers=_headers(admin), json={"grant_days": 999})
    assert too_many.status_code == 422


def test_startup_gives_existing_accounts_a_trial(client: TestClient):
    account = _register(client, "billing_legacy")
    _set_dates(account["id"], trial_ends_at=None)
    assert _user(account["id"]).trial_ends_at is None

    db_module._start_missing_trials()
    trial_end = billing.aware(_user(account["id"]).trial_ends_at)
    assert trial_end is not None
    assert timedelta(days=config.TRIAL_DAYS - 1) < trial_end - datetime.now(timezone.utc) <= timedelta(days=config.TRIAL_DAYS)


def test_payment_rows_keep_amount_and_period(client: TestClient, fake_qpay):
    account = _register(client, "billing_rows")
    payment_id = client.post("/api/v1/billing/invoice", headers=_headers(account)).json()["id"]
    with Session(engine) as s:
        payment = s.exec(select(Payment).where(Payment.id == payment_id)).one()
    assert (payment.amount_mnt, payment.period_days, payment.provider) == (PRICE, config.SUBSCRIPTION_DAYS, "qpay")
    assert payment.sender_invoice_no.startswith("SAYLO-")
