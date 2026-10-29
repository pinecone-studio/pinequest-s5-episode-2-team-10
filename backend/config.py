"""Server settings, read from environment variables."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DATA_DIR = Path(os.environ.get("PITCH_DATA_DIR", ROOT / "data")).resolve()
SESSIONS_DIR = DATA_DIR / "sessions"
DB_URL = os.environ.get("PITCH_DB_URL", f"sqlite:///{DATA_DIR / 'pitchcoach.db'}")

CORS_ORIGINS = [o.strip() for o in os.environ.get("PITCH_CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
DEFAULT_BACKEND = os.environ.get("PITCH_DEFAULT_BACKEND", "claude")
# The deployed site and its backend, which the admin Status tab checks from a local build.
DEPLOYED_SITE_URL = os.environ.get("PITCH_DEPLOYED_SITE_URL", "https://saylo-rose.vercel.app").strip().rstrip("/")
DEPLOYED_API_URL = os.environ.get("PITCH_DEPLOYED_API_URL", "https://saylo-backend-el5e.onrender.com").strip().rstrip("/")
# Projects untouched for this many days are deleted; 0 keeps them until the user deletes them.
RETENTION_DAYS = int(os.environ.get("PITCH_RETENTION_DAYS", "0"))

# Google sign-in through Supabase Auth. Both unset turns POST /auth/google off.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
SUPABASE_STORAGE_BUCKET = os.environ.get("SUPABASE_STORAGE_BUCKET", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_EMAILS = {
    email.strip().lower()
    for email in os.environ.get("PITCH_ADMIN_EMAILS", "").split(",")
    if email.strip()
}


def _flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name, "").strip().lower()
    return default if not value else value in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


# Subscription: a free trial, then paid periods bought through QPay. While BILLING_ENFORCED is off
# (the default) nobody is blocked, so local development and tests keep working.
BILLING_ENFORCED = _flag("PITCH_BILLING_ENFORCED")
TRIAL_DAYS = max(0, _int("PITCH_TRIAL_DAYS", 7))
SUBSCRIPTION_DAYS = max(1, _int("PITCH_SUBSCRIPTION_DAYS", 30))
# Price of one period in tögrög; 0 (unset) turns payments off.
SUBSCRIPTION_PRICE_MNT = max(0, _int("PITCH_SUBSCRIPTION_PRICE_MNT", 0))
QPAY_BASE_URL = os.environ.get("QPAY_BASE_URL", "https://merchant-sandbox.qpay.mn").strip().rstrip("/")
QPAY_CLIENT_ID = os.environ.get("QPAY_CLIENT_ID", "").strip()
QPAY_CLIENT_SECRET = os.environ.get("QPAY_CLIENT_SECRET", "").strip()
QPAY_INVOICE_CODE = os.environ.get("QPAY_INVOICE_CODE", "").strip()
# Public address of this API, for QPay's payment callback (e.g. https://api.example.com).
PUBLIC_API_URL = os.environ.get("PITCH_PUBLIC_API_URL", "").strip().rstrip("/")

# Upload limits (TDD API table)
AUDIO_MAX_BYTES = 25 * 1024 * 1024
AUDIO_MAX_S = 5 * 60
AUDIO_FORMATS = {".wav", ".mp3", ".m4a", ".webm", ".ogg"}
SLIDES_MAX_BYTES = 20 * 1024 * 1024
SLIDES_MAX_COUNT = 40
SLIDES_FORMATS = {".pdf", ".pptx"}
