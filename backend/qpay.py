"""QPay v2 merchant API: invoices with a QR code and bank app links, and payment checks.

QPay doesn't charge again on its own, so each paid period is one invoice. The callback QPay sends
after a payment is only a hint; `check_payment` asks QPay directly before anything is granted.
Tokens and secrets are never logged.
"""

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from . import config
from .errors import ApiError

log = logging.getLogger("pitchcoach")

TIMEOUT_S = 10
_lock = threading.Lock()
_token: Optional[str] = None
_token_expires = 0.0


@dataclass(frozen=True)
class Invoice:
    invoice_id: str
    qr_text: str
    qr_image: str  # base64 PNG
    short_url: Optional[str]
    bank_links: list[dict[str, str]]


@dataclass(frozen=True)
class PaymentCheck:
    paid: bool
    paid_amount: int
    payment_id: Optional[str]


def _unavailable() -> ApiError:
    return ApiError(502, "payment_unavailable", "The payment service is not responding. Try again in a moment.")


def _expiry(value: Any) -> float:
    """QPay sends `expires_in` as seconds from now or as a Unix time; both become a Unix time."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 0
    if number > 1_000_000_000:
        return number
    return time.time() + (number or 3600)


def _fetch_token() -> str:
    global _token, _token_expires
    try:
        res = httpx.post(
            f"{config.QPAY_BASE_URL}/v2/auth/token",
            auth=(config.QPAY_CLIENT_ID, config.QPAY_CLIENT_SECRET),
            timeout=TIMEOUT_S,
        )
    except httpx.HTTPError as exc:
        log.warning("QPay token request failed: %s", type(exc).__name__)
        raise _unavailable() from exc
    if res.status_code != 200:
        log.warning("QPay token request returned %s", res.status_code)
        raise _unavailable()
    body = res.json()
    token = body.get("access_token")
    if not token:
        raise _unavailable()
    _token = token
    # Renew a minute early so a request never goes out with a token about to expire.
    _token_expires = _expiry(body.get("expires_in")) - 60
    return token


def _bearer(force: bool = False) -> str:
    with _lock:
        if force or not _token or time.time() >= _token_expires:
            return _fetch_token()
        return _token


def reset_token() -> None:
    global _token, _token_expires
    with _lock:
        _token, _token_expires = None, 0.0


def _post(path: str, payload: dict) -> dict:
    """POST with the merchant token, getting a fresh token once if QPay says it expired."""
    for attempt in range(2):
        try:
            res = httpx.post(
                f"{config.QPAY_BASE_URL}{path}",
                json=payload,
                headers={"Authorization": f"Bearer {_bearer(force=attempt > 0)}"},
                timeout=TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            log.warning("QPay %s failed: %s", path, type(exc).__name__)
            raise _unavailable() from exc
        if res.status_code == 401 and attempt == 0:
            continue
        if res.status_code != 200:
            log.warning("QPay %s returned %s", path, res.status_code)
            raise _unavailable()
        return res.json()
    raise _unavailable()


def create_invoice(sender_invoice_no: str, amount: int, description: str, receiver: str, callback_url: str) -> Invoice:
    body = _post(
        "/v2/invoice",
        {
            "invoice_code": config.QPAY_INVOICE_CODE,
            "sender_invoice_no": sender_invoice_no,
            "invoice_receiver_code": receiver,
            "invoice_description": description,
            "amount": amount,
            "callback_url": callback_url,
        },
    )
    invoice_id = body.get("invoice_id")
    if not invoice_id:
        raise _unavailable()
    links = [
        {"name": str(url.get("description") or url.get("name") or ""), "logo": str(url.get("logo") or ""), "link": str(url.get("link") or "")}
        for url in body.get("urls") or []
        if isinstance(url, dict) and url.get("link")
    ]
    return Invoice(
        invoice_id=str(invoice_id),
        qr_text=str(body.get("qr_text") or ""),
        qr_image=str(body.get("qr_image") or ""),
        short_url=body.get("qPay_shortUrl"),
        bank_links=links,
    )


def check_payment(invoice_id: str) -> PaymentCheck:
    body = _post(
        "/v2/payment/check",
        {"object_type": "INVOICE", "object_id": invoice_id, "offset": {"page_number": 1, "page_limit": 100}},
    )
    paid_rows = [row for row in body.get("rows") or [] if str(row.get("payment_status", "")).upper() == "PAID"]
    total = 0
    for row in paid_rows:
        try:
            total += int(float(row.get("payment_amount") or 0))
        except (TypeError, ValueError):
            continue
    return PaymentCheck(
        paid=bool(paid_rows),
        paid_amount=total,
        payment_id=str(paid_rows[0].get("payment_id")) if paid_rows and paid_rows[0].get("payment_id") else None,
    )
