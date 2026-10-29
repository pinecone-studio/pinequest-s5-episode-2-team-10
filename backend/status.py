"""Health of every part the analysis needs, for the admin Status tab.

Checks run in parallel with short timeouts, so one dead service can't hang the page. Nothing
here returns secrets: service addresses are shown only as "this machine" or "remote".
"""

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import httpx
from sqlalchemy import text
from sqlmodel import Session

from pipeline import config as pipeline_config

CHECK_TIMEOUT_S = 5.0
GEMMA_TEST_TIMEOUT_S = 120.0  # the first answer may include loading the model into memory


def _where(url: str) -> str:
    host = httpx.URL(url).host
    return "local" if host in ("localhost", "127.0.0.1", "::1") else "remote"


def _timed(check: Callable[[], dict]) -> dict:
    started = time.monotonic()
    try:
        out = check()
    except httpx.TimeoutException:
        out = {"ok": False, "error": "Timed out."}
    except httpx.HTTPError:
        out = {"ok": False, "error": "Not reachable."}
    except Exception as e:  # noqa: BLE001 - any failure is a status to show, not a crash
        out = {"ok": False, "error": type(e).__name__}
    out["ms"] = round((time.monotonic() - started) * 1000)
    return out


def _ollama_headers() -> dict | None:
    return {"Authorization": f"Bearer {pipeline_config.OLLAMA_TOKEN}"} if pipeline_config.OLLAMA_TOKEN else None


def check_database(session: Session) -> dict:
    def run():
        session.exec(text("SELECT 1"))  # type: ignore[call-overload]
        return {"ok": True}

    return _timed(run)


def check_voice() -> dict:
    url = pipeline_config.VOICE_URL

    def run():
        r = httpx.get(f"{url}/health", timeout=CHECK_TIMEOUT_S)
        r.raise_for_status()
        h = r.json()
        loaded = h.get("model_loaded") is True
        return {
            "ok": h.get("ok") is True and loaded,
            "model_loaded": loaded,
            "model": h.get("model"),
            "device": h.get("device"),
            "cuda": h.get("cuda") is True,
            "busy": h.get("busy") is True,
            **({} if loaded else {"error": "The speech model isn't loaded yet."}),
        }

    out = _timed(run)
    out["where"] = _where(url)
    out["used"] = pipeline_config.ASR_BACKEND == "remote"  # the analysis transcribes through it
    return out


def check_ollama() -> dict:
    url = pipeline_config.OLLAMA_URL
    model = pipeline_config.OLLAMA_MODEL_BASE

    def run():
        headers = _ollama_headers()
        version = httpx.get(f"{url}/api/version", headers=headers, timeout=CHECK_TIMEOUT_S).json().get("version")
        tags = httpx.get(f"{url}/api/tags", headers=headers, timeout=CHECK_TIMEOUT_S).json().get("models", [])
        ps = httpx.get(f"{url}/api/ps", headers=headers, timeout=CHECK_TIMEOUT_S).json().get("models", [])
        names = {m.get("name") for m in tags} | {m.get("model") for m in tags}
        installed = model in names or f"{model}:latest" in names
        running = next((m for m in ps if m.get("name") in (model, f"{model}:latest")), None)
        return {
            "ok": installed,
            "version": version,
            "model": model,
            "installed": installed,
            "loaded": running is not None,
            # Share of the model in graphics memory; below 1 means part of it runs on the CPU (slower).
            "gpu_share": round(running["size_vram"] / running["size"], 2) if running and running.get("size") else None,
            **({} if installed else {"error": f"{model} isn't installed in Ollama."}),
        }

    out = _timed(run)
    out["where"] = _where(url)
    return out


def test_gemma() -> dict:
    """Asks Gemma for a one-word reply: proof that it answers, not just that Ollama is up."""
    url, model = pipeline_config.OLLAMA_URL, pipeline_config.OLLAMA_MODEL_BASE

    def run():
        r = httpx.post(
            f"{url}/api/generate",
            json={"model": model, "prompt": "Reply with the single word OK.", "stream": False, "think": False,
                  "options": {"num_predict": 5, "temperature": 0}, "keep_alive": pipeline_config.OLLAMA_KEEP_ALIVE},
            headers=_ollama_headers(),
            timeout=GEMMA_TEST_TIMEOUT_S,
        )
        r.raise_for_status()
        body = r.json()
        answered = bool(str(body.get("response", "")).strip())
        tokens, ns = body.get("eval_count") or 0, body.get("eval_duration") or 0
        return {
            "ok": answered,
            "tokens_per_s": round(tokens / (ns / 1e9), 1) if ns else None,
            **({} if answered else {"error": "Gemma returned an empty answer."}),
        }

    return _timed(run)


def collect(session: Session, queue_length: int, analysing: bool, with_gemma_test: bool = False) -> dict:
    """Every check at once. The database check stays on this thread (its session isn't thread-safe)."""
    with ThreadPoolExecutor(max_workers=3) as pool:
        voice = pool.submit(check_voice)
        ollama = pool.submit(check_ollama)
        gemma = pool.submit(test_gemma) if with_gemma_test else None
        database = check_database(session)
        return {
            "backend": {"ok": True, "queue_length": queue_length, "analysing": analysing},
            "database": database,
            "voice": voice.result(),
            "ollama": ollama.result(),
            "gemma_test": gemma.result() if gemma else None,
        }


# ---- The deployed site, checked from a local build -------------------------------------------

DEPLOYED_TIMEOUT_S = 60.0  # the deployed backend's free host sleeps; waking it takes up to a minute


def check_deployed(site_url: str, api_url: str, lang: str = "mn") -> dict:
    """Public checks of the deployed site: is the web app up, does it reach its voice server, is
    its backend up. The deployed backend's database and Gemma need an admin login there."""

    def web():
        r = httpx.get(site_url, timeout=CHECK_TIMEOUT_S * 3, follow_redirects=True)
        return {"ok": r.status_code < 400, **({} if r.status_code < 400 else {"error": f"HTTP {r.status_code}"})}

    def web_voice():
        # The web app answers in the language asked for (its messages are user-facing).
        r = httpx.get(f"{site_url}/api/transcribe", headers={"x-pitch-lang": lang}, timeout=CHECK_TIMEOUT_S * 3)
        h = r.json()
        loaded = h.get("modelLoaded") is True
        return {
            "ok": h.get("ok") is True and loaded,
            "reachable": h.get("ok") is True,  # the deployed web app reaches its voice server at all
            "model_loaded": loaded,
            "device": h.get("device"),
            "busy": h.get("busy") is True,
            **({} if h.get("ok") else {"error": h.get("error") or "Not reachable."}),
            **({} if not h.get("ok") or loaded else {"error": "The speech model isn't loaded yet."}),
        }

    def backend():
        r = httpx.get(f"{api_url}/api/v1/health", timeout=DEPLOYED_TIMEOUT_S)
        r.raise_for_status()
        h = r.json()
        # Without a login, 401 means the deployed backend has the status check; 404 means it's older.
        has_status = httpx.get(f"{api_url}/api/v1/admin/status", timeout=CHECK_TIMEOUT_S * 3).status_code != 404
        return {
            "ok": h.get("ok") is True,
            "queue_length": h.get("queue_length"),
            "asr": h.get("asr"),
            "default_backend": h.get("default_backend"),
            "has_status_check": has_status,
        }

    with ThreadPoolExecutor(max_workers=3) as pool:
        w, v, b = pool.submit(_timed, web), pool.submit(_timed, web_voice), pool.submit(_timed, backend)
        return {"site_url": site_url, "web": w.result(), "web_voice": v.result(), "backend": b.result()}
