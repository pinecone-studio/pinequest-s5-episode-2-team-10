"""Subscription rules: a free trial, then paid periods. Pure functions, so the rules are easy to test.

- Admins and the shared demo account always have full access.
- Otherwise access lasts until the later of `trial_ends_at` and `paid_until`.
- A payment adds one period after whichever is later: now, the trial's end, or the paid period's end,
  so paying early never loses days.
- With billing not enforced (the default), nobody is blocked; the state is still reported.
"""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from . import config
from .db import AppUser
from .errors import ApiError

DEMO_EMAIL = "demo@pitchcoach.local"

State = Literal["admin", "trial", "active", "expired"]


def aware(value: Optional[datetime]) -> Optional[datetime]:
    """SQLite and Postgres `TIMESTAMP` columns read back without a timezone; they hold UTC."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class Access:
    state: State
    ends_at: Optional[datetime]
    days_left: int

    @property
    def allowed(self) -> bool:
        return self.state != "expired" or not config.BILLING_ENFORCED


def exempt(user: AppUser) -> bool:
    return user.role == "admin" or (user.email or "").lower() == DEMO_EMAIL


def access_state(user: AppUser, now: datetime) -> Access:
    if exempt(user):
        return Access("admin", None, 0)
    trial_end = aware(user.trial_ends_at)
    paid_end = aware(user.paid_until)
    if paid_end and paid_end > now:
        return Access("active", paid_end, _days_left(paid_end, now))
    if trial_end and trial_end > now:
        return Access("trial", trial_end, _days_left(trial_end, now))
    ends = max((d for d in (trial_end, paid_end) if d), default=None)
    return Access("expired", ends, 0)


def _days_left(ends: datetime, now: datetime) -> int:
    # Whole minutes first, so a trial created a few milliseconds after `now` still reads as 7 days.
    minutes = int((ends - now).total_seconds() // 60)
    return max(0, math.ceil(minutes / 1440))


def extend(user: AppUser, now: datetime, days: int) -> datetime:
    """Adds `days` after the latest of now, the trial's end, and the paid period's end."""
    start = max(d for d in (now, aware(user.trial_ends_at), aware(user.paid_until)) if d)
    user.paid_until = start + timedelta(days=days)
    return user.paid_until


def check_access(user: AppUser, now: datetime) -> None:
    if not access_state(user, now).allowed:
        raise ApiError(
            402,
            "subscription_required",
            "Your free trial has ended. Renew your plan to keep going.",
        )


def payments_enabled() -> bool:
    return bool(
        config.SUBSCRIPTION_PRICE_MNT
        and config.QPAY_CLIENT_ID
        and config.QPAY_CLIENT_SECRET
        and config.QPAY_INVOICE_CODE
    )


def status(user: AppUser, now: datetime) -> dict:
    access = access_state(user, now)
    return {
        "state": access.state,
        "allowed": access.allowed,
        "trial_ends_at": _iso(aware(user.trial_ends_at)),
        "paid_until": _iso(aware(user.paid_until)),
        "ends_at": _iso(access.ends_at),
        "days_left": access.days_left,
        "price_mnt": config.SUBSCRIPTION_PRICE_MNT,
        "period_days": config.SUBSCRIPTION_DAYS,
        "enforced": config.BILLING_ENFORCED,
        "payments_enabled": payments_enabled(),
    }


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None
