"""Persist only the latest complete scanner snapshot for each user."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import JSONB, insert as pg_insert
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table


scanner_latest_snapshots_table = table(
    "scanner_latest_snapshots",
    column("user_id"), column("scan_id"), column("config", JSONB),
    column("universe", JSONB), column("symbols", JSONB),
    column("started_at"), column("updated_at"),
)


class ScannerSnapshotStore:
    """Replace one user-scoped snapshot atomically; never retain scan history."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def replace(
        self,
        user_id: str,
        *,
        scan_id: str,
        config: dict[str, Any],
        universe: list[dict[str, Any]],
        symbols: list[dict[str, Any]],
        started_at: datetime,
    ) -> dict[str, Any]:
        completed_at = datetime.now(timezone.utc)
        statement = pg_insert(scanner_latest_snapshots_table).values(
            user_id=user_id,
            scan_id=scan_id,
            config=config,
            universe=universe,
            symbols=symbols,
            started_at=started_at,
            updated_at=completed_at,
        )
        statement = statement.on_conflict_do_update(
            index_elements=[scanner_latest_snapshots_table.c.user_id],
            set_={
                "scan_id": statement.excluded.scan_id,
                "config": statement.excluded.config,
                "universe": statement.excluded.universe,
                "symbols": statement.excluded.symbols,
                "started_at": statement.excluded.started_at,
                "updated_at": statement.excluded.updated_at,
            },
            # A slower older request must not replace a scan that started later.
            where=scanner_latest_snapshots_table.c.started_at <= statement.excluded.started_at,
        )
        with self._engine.begin() as connection:
            connection.execute(statement)
        return self.get(user_id) or {
            "user_id": user_id,
            "scan_id": scan_id,
            "config": config,
            "universe": universe,
            "symbols": symbols,
            "started_at": started_at,
            "updated_at": completed_at,
        }

    def get(self, user_id: str) -> dict[str, Any] | None:
        with self._engine.connect() as connection:
            row = connection.execute(
                select(scanner_latest_snapshots_table).where(
                    scanner_latest_snapshots_table.c.user_id == user_id
                )
            ).mappings().first()
        return dict(row) if row else None


def public_snapshot(snapshot: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """Return a JSON-safe view with explicit freshness and epoch timestamps."""
    current = now or datetime.now(timezone.utc)
    updated_at = snapshot.get("updated_at")
    if isinstance(updated_at, datetime):
        completed = updated_at if updated_at.tzinfo else updated_at.replace(tzinfo=timezone.utc)
        updated_epoch = int(completed.timestamp())
        age_seconds = max(0, int((current - completed).total_seconds()))
    else:
        updated_epoch = int(updated_at or 0)
        age_seconds = max(0, int(current.timestamp()) - updated_epoch)
    return {
        "scan_id": str(snapshot.get("scan_id", "")),
        "updated_at": updated_epoch,
        "age_seconds": age_seconds,
        "freshness": "FRESH" if age_seconds <= 180 else "STALE",
        "window_seconds": 8 * 60 * 60,
        "config": snapshot.get("config") or {},
        "universe": snapshot.get("universe") or [],
        "symbols": snapshot.get("symbols") or [],
    }
