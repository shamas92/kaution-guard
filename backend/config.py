"""Backend configuration and credit-shielded API cache.

Loads runtime settings from `.env` (see `.env.example` for placeholders)
and provides :class:`CreditShield`, a SQLite-backed disk cache plus spend
ledger that caps API usage per session and cumulatively.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "cache"
DB_PATH = CACHE_DIR / "credit_shield.sqlite"


class Settings(BaseSettings):
    """Runtime settings loaded from environment / `.env`."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    META_API_BASE_URL: str = "https://api.meta.ai/v1"
    META_API_KEY: str = ""
    SAM_PROVIDER: str = "baseten"
    BASETEN_API_KEY: str = ""
    BASETEN_SAM31_MODEL_ID: str = ""
    MODAL_TOKEN_ID: str = ""
    MODAL_TOKEN_SECRET: str = ""
    MODAL_SAM31_WEBHOOK_URL: str = ""
    ENABLE_DISK_CACHE: bool = True
    MAX_SESSION_SPEND_USD: float = 5.00
    MAX_CUMULATIVE_SPEND_USD: float = 135.00
    DEMO_OFFLINE_LOCK: bool = False


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

        Raises HTTPException(402) when cumulative spend plus the estimate
        exceeds ``MAX_CUMULATIVE_SPEND_USD``, and HTTPException(429) when
        session spend exceeds ``MAX_SESSION_SPEND_USD``.
        """
        cumulative = self.get_cumulative_spend()
        if cumulative + estimated_cost > self.settings.MAX_CUMULATIVE_SPEND_USD:
            raise HTTPException(
                status_code=402,
                detail=(
                    f"Cumulative spend cap exceeded: "
                    f"${cumulative:.2f} + ${estimated_cost:.2f} > "
                    f"${self.settings.MAX_CUMULATIVE_SPEND_USD:.2f}"
                ),
            )
        if (
            self._session_spend > self.settings.MAX_SESSION_SPEND_USD
            or self._session_spend + estimated_cost
            > self.settings.MAX_SESSION_SPEND_USD
        ):
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Session spend cap exceeded: "
                    f"${self._session_spend:.2f} + ${estimated_cost:.2f} > "
                    f"${self.settings.MAX_SESSION_SPEND_USD:.2f}"
                ),
            )

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
        cost_usd: float,
    ) -> str:
        """Persist a live response and record its cost in the ledger."""
        now = _utcnow_iso()
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO api_cache "
                "(cache_key, endpoint, response_json, cost_usd, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (key, endpoint, json.dumps(response_data), float(cost_usd), now),
            )
            conn.execute(
                "INSERT INTO spend_ledger (provider, cost_usd, timestamp) "
                "VALUES (?, ?, ?)",
                (provider, float(cost_usd), now),
            )
            conn.commit()
        self._session_spend += float(cost_usd)
        return key


credit_shield = CreditShield()
