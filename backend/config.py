"""Backend configuration and credit-shielded API cache.

Loads runtime settings from ``backend/.env`` (see ``.env.example`` for
placeholders) and provides :class:`CreditShield`, a SQLite-backed disk cache
plus spend ledger that caps API usage per session and cumulatively.

Ledger note: the spend totals exposed by this app are locally tracked usage
estimated from API-reported usage. They are not the live balance in either
provider account.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import HTTPException
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env"
CACHE_DIR = BASE_DIR / "cache"
DB_PATH = CACHE_DIR / "credit_shield.sqlite"

# Chat providers. ``mock`` performs zero network calls; ``baseten`` routes
# chat/dispute drafting to Baseten's hosted Meta open-weight model; ``meta``
# routes chat to the Meta Model API. Muse Voice and SAM 3.1 always use Meta.
ChatProvider = Literal["mock", "baseten", "meta"]

# Exact hackathon model served through Baseten (Meta open-weight Muse Spark).
BASETEN_CHAT_MODEL_REQUIRED = "meta-models/muse-spark-open-1026"

# Cost-conscious default chat model on the Meta Model API.
# ``muse-wonder-1.0`` is used only when explicitly configured via
# ``META_CHAT_MODEL_ID``. ``muse-wonder-1m`` is retired and never used.
META_CHAT_MODEL_DEFAULT = "muse-spark-1.3"
META_CHAT_MODEL_EXPLICIT_ONLY = "muse-wonder-1.0"
META_CHAT_MODEL_RETIRED = "muse-wonder-1m"

# Conservative pre-call budgeting rates (USD). These gate live requests
# against the app budget only: they cap the worst case before a request is
# sent and are never presented as actual provider charges. Actual cost is
# computed solely from provider-reported monetary usage. Update these from
# the providers' pricing pages when they change.
CHAT_INPUT_USD_PER_1K_TOKENS = 0.005
CHAT_OUTPUT_USD_PER_1K_TOKENS = 0.02
CHAT_MAX_OUTPUT_TOKENS = 1024
VOICE_USD_PER_MINUTE = 0.02
SAM_USD_PER_IMAGE = 0.01


class Settings(BaseSettings):
    """Runtime settings loaded from environment / ``backend/.env``."""

    # Absolute path so ``backend/.env`` loads whether Uvicorn starts from
    # the repository root or from ``backend/``.
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE), env_file_encoding="utf-8", extra="ignore"
    )

    META_API_BASE_URL: str = "https://api.meta.ai/v1"
    META_API_KEY: str = ""
    META_CHAT_MODEL_ID: str = META_CHAT_MODEL_DEFAULT

    BASETEN_BASE_URL: str = "https://inference.baseten.co/v1"
    BASETEN_API_KEY: str = ""
    BASETEN_MODEL_ID: str = BASETEN_CHAT_MODEL_REQUIRED

    CHAT_PROVIDER: ChatProvider = "mock"

    ENABLE_DISK_CACHE: bool = True
    MAX_SESSION_SPEND_USD: float = 5.00
    MAX_CUMULATIVE_SPEND_USD: float = 135.00
    DEMO_OFFLINE_LOCK: bool = False

    def resolve_chat_target(self) -> tuple[str, str, str]:
        """Return ``(provider, base_url, model)`` for chat calls.

        Raises HTTPException(503) with a clear message when the selected
        live provider has no API key configured, and HTTPException(500)
        when a configured model ID is not allowed. Never falls back to
        another provider.
        """
        provider: str = self.CHAT_PROVIDER
        if provider == "mock":
            return ("mock", "", META_CHAT_MODEL_DEFAULT)
        if provider == "baseten":
            if not self.BASETEN_API_KEY:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "CHAT_PROVIDER is 'baseten' but BASETEN_API_KEY "
                        "is not configured. Add it to backend/.env."
                    ),
                )
            if self.BASETEN_MODEL_ID != BASETEN_CHAT_MODEL_REQUIRED:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        "BASETEN_MODEL_ID must be exactly "
                        f"'{BASETEN_CHAT_MODEL_REQUIRED}'."
                    ),
                )
            return (
                "baseten",
                self.BASETEN_BASE_URL.rstrip("/"),
                BASETEN_CHAT_MODEL_REQUIRED,
            )
        if provider == "meta":
            if not self.META_API_KEY:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "CHAT_PROVIDER is 'meta' but META_API_KEY "
                        "is not configured. Add it to backend/.env."
                    ),
                )
            model = self.META_CHAT_MODEL_ID or META_CHAT_MODEL_DEFAULT
            if META_CHAT_MODEL_RETIRED in model:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"Model '{model}' is retired. Use "
                        f"'{META_CHAT_MODEL_DEFAULT}' or explicitly "
                        f"configure '{META_CHAT_MODEL_EXPLICIT_ONLY}'."
                    ),
                )
            return ("meta", self.META_API_BASE_URL.rstrip("/"), model)
        raise HTTPException(
            status_code=500,
            detail=(
                f"Unknown CHAT_PROVIDER {provider!r}. "
                "Use 'mock', 'baseten', or 'meta'."
            ),
        )

    def require_meta_key(self, feature: str) -> str:
        """Return the Meta key or raise before any request is attempted."""
        if not self.META_API_KEY:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"{feature} requires the Meta Model API but "
                    "META_API_KEY is not configured. "
                    "Add it to backend/.env."
                ),
            )
        return self.META_API_KEY


settings = Settings()


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CreditShield:
    """SQLite-backed response cache and spend guard.

    Backed by ``backend/cache/credit_shield.sqlite`` with two tables::

        api_cache (cache_key TEXT PRIMARY KEY, endpoint TEXT,
                   response_json TEXT, cost_usd REAL, created_at TIMESTAMP)
        spend_ledger (id INTEGER PRIMARY KEY, provider TEXT,
                      cost_usd REAL, timestamp TIMESTAMP)
        spend_reservations (cache_key TEXT PRIMARY KEY, endpoint TEXT,
                      provider TEXT, reserved_usd REAL, created_at TIMESTAMP)

    ``spend_ledger`` holds locally tracked usage only -- it is not the live
    balance in any provider account. Entries whose exact cost is unknown
    are stored as NULL in the ledger and carry the explicit marker
    ``"unknown"`` in the cached record, so unknown spend is never stored
    or presented as a real $0.00 charge. Mock responses and cache hits are
    genuinely free and are stored as $0.00.
    """

    def __init__(
        self,
        db_path: Path | str = DB_PATH,
        app_settings: Optional[Settings] = None,
    ) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.settings = app_settings if app_settings is not None else settings
        self._session_spend: float = 0.0
        self._session_reserved: dict[str, float] = {}
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.db_path))

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS api_cache ("
                "cache_key TEXT PRIMARY KEY, "
                "endpoint TEXT, "
                "response_json TEXT, "
                "cost_usd REAL, "
                "created_at TIMESTAMP)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS spend_ledger ("
                "id INTEGER PRIMARY KEY, "
                "provider TEXT, "
                "cost_usd REAL, "
                "timestamp TIMESTAMP)"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS spend_reservations ("
                "cache_key TEXT PRIMARY KEY, "
                "endpoint TEXT, "
                "provider TEXT, "
                "reserved_usd REAL, "
                "created_at TIMESTAMP)"
            )
            conn.commit()

    @staticmethod
    def cache_key_for(payload_bytes: bytes) -> str:
        """SHA-256 hex digest identifying a request payload."""
        return hashlib.sha256(payload_bytes).hexdigest()

    @property
    def session_spend(self) -> float:
        return self._session_spend

    def get_cumulative_spend(self) -> float:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(cost_usd), 0.0) FROM spend_ledger"
            ).fetchone()
        return float(row[0] if row else 0.0)

    def get_session_spend(self) -> float:
        return self._session_spend

    def verify_budget(self, estimated_cost: float) -> None:
        """Raise unless ``estimated_cost`` fits both spend caps.

        Both caps count recorded actuals *plus* outstanding pre-call
        reservations, so requests whose exact cost stays unknown still
        consume budget conservatively and can never disappear from the
        caps through NULL ledger rows. Raises HTTPException(402) when
        cumulative spend plus the estimate exceeds
        ``MAX_CUMULATIVE_SPEND_USD``, and HTTPException(429) when
        session spend exceeds ``MAX_SESSION_SPEND_USD``.
        """
        reserved_cumulative = self.get_reserved_cumulative()
        cumulative = self.get_cumulative_spend() + reserved_cumulative
        if cumulative + estimated_cost > self.settings.MAX_CUMULATIVE_SPEND_USD:
            raise HTTPException(
                status_code=402,
                detail=(
                    f"Cumulative spend cap exceeded: "
                    f"${cumulative:.2f} + ${estimated_cost:.2f} > "
                    f"${self.settings.MAX_CUMULATIVE_SPEND_USD:.2f}"
                ),
            )
        session = self._session_spend + sum(self._session_reserved.values())
        if (
            session > self.settings.MAX_SESSION_SPEND_USD
            or session + estimated_cost > self.settings.MAX_SESSION_SPEND_USD
        ):
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Session spend cap exceeded: "
                    f"${session:.2f} + ${estimated_cost:.2f} > "
                    f"${self.settings.MAX_SESSION_SPEND_USD:.2f}"
                ),
            )

    def reserve(
        self, key: str, endpoint: str, provider: str, amount: float
    ) -> None:
        """Hold a pre-call estimate against both caps.

        The reservation is stored separately from actual cost so an
        unknown actual never vanishes from budget accounting. When the
        provider later reports a monetary cost, the caller releases the
        reservation and records the actual; when the exact cost stays
        unknown, the reservation stands as the conservative charge.
        """
        self._session_reserved[key] = float(amount)
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO spend_reservations "
                "(cache_key, endpoint, provider, reserved_usd, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (key, endpoint, provider, float(amount), _utcnow_iso()),
            )
            conn.commit()

    def release(self, key: str) -> None:
        """Drop a pre-call reservation (failed request or actual recorded)."""
        self._session_reserved.pop(key, None)
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM spend_reservations WHERE cache_key = ?", (key,)
            )
            conn.commit()

    def get_reserved_cumulative(self) -> float:
        """Sum of outstanding pre-call reservations (all sessions)."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(reserved_usd), 0.0) FROM spend_reservations"
            ).fetchone()
        return float(row[0] if row else 0.0)

    def get_session_reserved(self) -> float:
        """Sum of this session's outstanding pre-call reservations."""
        return sum(self._session_reserved.values())

    def fetch_or_record(self, payload_bytes: bytes, endpoint: str) -> Any:
        """Return the cached JSON for ``payload_bytes`` on a cache hit.

        The lookup key is the SHA-256 hex of ``payload_bytes``. A hit costs
        $0.00 (no ledger entry is written). On a miss, returns ``None`` so
        the caller can perform the live request and persist it with
        :meth:`save_response` -- unless ``DEMO_OFFLINE_LOCK`` is True, in
        which case a miss raises HTTPException(503).
        """
        key = self.cache_key_for(payload_bytes)
        if self.settings.ENABLE_DISK_CACHE:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT response_json FROM api_cache WHERE cache_key = ?",
                    (key,),
                ).fetchone()
            if row is not None:
                return json.loads(row[0])
        if self.settings.DEMO_OFFLINE_LOCK:
            raise HTTPException(
                status_code=503,
                detail=f"Offline demo lock: no cached response for {endpoint}",
            )
        return None

    def save_response(
        self,
        key: str,
        endpoint: str,
        provider: str,
        response_data: Any,
        cost_usd: float | None,
    ) -> str:
        """Persist a live response and record its cost in the ledger.

        ``cost_usd=None`` stores NULL: unknown live spend is never stored
        as $0.00. Pass ``0.0`` only for genuinely free mock/cache-hit rows.
        """
        now = _utcnow_iso()
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO api_cache "
                "(cache_key, endpoint, response_json, cost_usd, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    key,
                    endpoint,
                    json.dumps(response_data),
                    None if cost_usd is None else float(cost_usd),
                    now,
                ),
            )
            conn.execute(
                "INSERT INTO spend_ledger (provider, cost_usd, timestamp) "
                "VALUES (?, ?, ?)",
                (
                    provider,
                    None if cost_usd is None else float(cost_usd),
                    now,
                ),
            )
            conn.commit()
        self._session_spend += float(cost_usd) if cost_usd is not None else 0.0
        return key


credit_shield = CreditShield()
