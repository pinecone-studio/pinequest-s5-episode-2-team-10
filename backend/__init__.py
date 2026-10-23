from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent

# Explicit process environment variables win; backend/.env.local is the machine-specific
# override, followed by backend/.env and the repository-root .env as fallbacks.
load_dotenv(_ROOT / "backend" / ".env.local")
load_dotenv(_ROOT / "backend" / ".env")
load_dotenv(_ROOT / ".env")