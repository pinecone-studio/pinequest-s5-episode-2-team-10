"""Google sign-in through Supabase Auth. Supabase only proves the email; the API issues its own token."""

import httpx

from . import config
from .errors import ApiError

TIMEOUT_S = 10


def enabled() -> bool:
    return bool(config.SUPABASE_URL and config.SUPABASE_PUBLISHABLE_KEY)


def google_email(access_token: str) -> str:
    """The verified email behind a Supabase access token from a Google sign-in."""
    if not enabled():
        raise ApiError(503, "google_disabled", "Google sign-in isn't configured on the server.")
    try:
        res = httpx.get(
            f"{config.SUPABASE_URL}/auth/v1/user",
            headers={"apikey": config.SUPABASE_PUBLISHABLE_KEY, "Authorization": f"Bearer {access_token}"},
            timeout=TIMEOUT_S,
        )
    except httpx.HTTPError:
        raise ApiError(502, "google_unreachable", "Couldn't reach the sign-in service. Try again.")
    if res.status_code in (401, 403):
        raise ApiError(401, "invalid_google_token", "Google sign-in expired. Try again.")
    if res.status_code != 200:
        raise ApiError(502, "google_unreachable", "Couldn't reach the sign-in service. Try again.")
    user = res.json()
    providers = (user.get("app_metadata") or {}).get("providers") or []
    email = user.get("email")
    if "google" not in providers or not email or not user.get("email_confirmed_at"):
        raise ApiError(401, "invalid_google_token", "This isn't a verified Google account.")
    return email
