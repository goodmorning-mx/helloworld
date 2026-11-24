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
    column("started_at"), column("last_scanned_at"), column("updated_at"),
)

SCANNER_ANALYSIS_FIELDS = (
    "tp_optimal_percent", "average_duration_minutes", "operations", "wins", "losses",
    "win_rate", "equity_final", "final_result_usdt", "max_balance", "min_balance",
    "loss_limit_percent", "last_bar_time", "bars", "snapshot", "forward",
    "snapshot_final_result_usdt", "forward_final_result_usdt", "snapshot_operations",
    "snapshot_wins", "snapshot_losses", "forward_operations", "forward_wins",
    "forward_losses", "snapshot_hours", "evaluation_hours", "split_time", "parameters",
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
        with self._engine.begin() as connection:
            # Serialize a scanner refresh against worker parameter publication
            # so an active worker's newest controls cannot be lost in the race.
            previous = connection.execute(
                select(scanner_latest_snapshots_table).where(
                    scanner_latest_snapshots_table.c.user_id == user_id
                ).with_for_update()
            ).mappings().first()
            previous = dict(previous) if previous else None
            previous_rows = {
                str(row.get("symbol", "")).upper(): row
                for row in (previous or {}).get("symbols", [])
                if isinstance(row, dict)
            }
            retained_symbols = []
            analysis_fields = SCANNER_ANALYSIS_FIELDS
            for row in symbols:
                symbol = str(row.get("symbol", "")).upper()
                previous_row = previous_rows.get(symbol, {})
                worker_parameters = previous_row.get("worker_parameters")
                if isinstance(worker_parameters, dict) and worker_parameters.get("running"):
                    row = {**row, "worker_parameters": worker_parameters}
                    expected_version = worker_parameters.get("parameter_version")
                    if row.get("analysis_parameter_version") != expected_version:
                        if previous_row.get("analysis_parameter_version") == expected_version:
                            row.update({key: previous_row[key] for key in analysis_fields if key in previous_row})
                            row["analysis_parameter_version"] = expected_version
                        else:
                            # Never pair a worker's current controls with a result
                            # calculated for a different parameter version.
                            row.update({key: None for key in analysis_fields})
                            row["status"] = "ANALYZING"
                            row["error"] = "Recalculando resultado con los parámetros actuales del worker."
                retained_symbols.append(row)
            symbols = retained_symbols
            incoming_symbols = {str(row.get("symbol", "")).upper() for row in symbols if isinstance(row, dict)}
            for old_row in (previous or {}).get("symbols", []):
                if not isinstance(old_row, dict) or str(old_row.get("symbol", "")).upper() in incoming_symbols:
                    continue
                worker_parameters = old_row.get("worker_parameters")
                if isinstance(worker_parameters, dict) and worker_parameters.get("running"):
                    symbols.append(old_row)
                    incoming_symbols.add(str(old_row.get("symbol", "")).upper())
                    old_universe = next((item for item in (previous or {}).get("universe", []) if isinstance(item, dict) and str(item.get("symbol", "")).upper() == str(old_row.get("symbol", "")).upper()), None)
                    if old_universe and not any(str(item.get("symbol", "")).upper() == str(old_universe.get("symbol", "")).upper() for item in universe if isinstance(item, dict)):
                        universe.append(old_universe)
            statement = pg_insert(scanner_latest_snapshots_table).values(
                user_id=user_id,
                scan_id=scan_id,
                config=config,
                universe=universe,
                symbols=symbols,
                started_at=started_at,
                last_scanned_at=completed_at,
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
                    "last_scanned_at": statement.excluded.last_scanned_at,
                    "updated_at": statement.excluded.updated_at,
                },
                # A slower older request must not replace a scan that started later.
                where=scanner_latest_snapshots_table.c.started_at <= statement.excluded.started_at,
            )
            connection.execute(statement)
        return self.get(user_id) or {
            "user_id": user_id,
            "scan_id": scan_id,
            "config": config,
            "universe": universe,
            "symbols": symbols,
            "started_at": started_at,
            "last_scanned_at": completed_at,
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

    def publish_worker_parameters(self, user_id: str, symbol: str, parameters: dict[str, Any]) -> bool:
        """Publish the worker's latest effective controls into the shared scan row."""
        normalized = symbol.upper()
        with self._engine.begin() as connection:
            row = connection.execute(
                select(scanner_latest_snapshots_table).where(
                    scanner_latest_snapshots_table.c.user_id == user_id
                ).with_for_update()
            ).mappings().first()
            if not row:
                return False
            symbols = row.get("symbols") or []
            updated = False
            next_symbols = []
            for item in symbols:
                if isinstance(item, dict) and str(item.get("symbol", "")).upper() == normalized:
                    updated_item = {
                        **item,
                        "worker_parameters": {**dict(parameters), "running": bool(parameters.get("running", True))},
                    }
                    parameter_version = parameters.get("parameter_version")
                    if parameters.get("running", True) and item.get("analysis_parameter_version") != parameter_version:
                        for key in SCANNER_ANALYSIS_FIELDS:
                            updated_item[key] = None
                        updated_item["status"] = "ANALYZING"
                        updated_item["error"] = "Recalculando resultado con los parámetros actuales del worker."
                    next_symbols.append(updated_item)
                    updated = True
                else:
                    next_symbols.append(item)
            if updated:
                connection.execute(
                    scanner_latest_snapshots_table.update()
                    .where(scanner_latest_snapshots_table.c.user_id == user_id)
                    .values(symbols=next_symbols)
                )
            return updated

    def publish_worker_analysis(
        self,
        user_id: str,
        symbol: str,
        analysis: dict[str, Any],
        *,
        parameter_version: int,
    ) -> bool:
        """Publish metrics calculated for the still-current active worker version."""
        normalized = symbol.upper()
        analysis_fields = SCANNER_ANALYSIS_FIELDS
        with self._engine.begin() as connection:
            row = connection.execute(
                select(scanner_latest_snapshots_table).where(
                    scanner_latest_snapshots_table.c.user_id == user_id
                ).with_for_update()
            ).mappings().first()
            if not row:
                return False
            symbols = row.get("symbols") or []
            updated = False
            next_symbols = []
            for item in symbols:
                if isinstance(item, dict) and str(item.get("symbol", "")).upper() == normalized:
                    worker_parameters = item.get("worker_parameters")
                    if not isinstance(worker_parameters, dict) or not worker_parameters.get("running"):
                        return False
                    if int(worker_parameters.get("parameter_version", -1)) != parameter_version:
                        return False
                    updated_row = dict(item)
                    for key in analysis_fields:
                        if key in analysis:
                            updated_row[key] = analysis[key]
                    updated_row["analysis_parameter_version"] = parameter_version
                    updated_row["status"] = analysis.get("status", "VALID")
                    updated_row.pop("error", None)
                    next_symbols.append(updated_row)
                    updated = True
                else:
                    next_symbols.append(item)
            if updated:
                connection.execute(
                    scanner_latest_snapshots_table.update()
                    .where(scanner_latest_snapshots_table.c.user_id == user_id)
                    .values(symbols=next_symbols, updated_at=datetime.now(timezone.utc))
                )
            return updated


def worker_parameters_from_snapshot(snapshot: dict[str, Any], symbol: str) -> dict[str, Any] | None:
    """Build the worker's exact startup controls from the canonical scan row."""
    normalized = symbol.upper()
    row = next((
        item for item in snapshot.get("symbols", [])
        if isinstance(item, dict) and str(item.get("symbol", "")).upper() == normalized
    ), None)
    if row is None or row.get("status") not in {"VALID", "STALE"}:
        return None
    active = row.get("worker_parameters")
    if isinstance(active, dict) and not active.get("running"):
        active = None
    if not isinstance(active, dict):
        active = {
            "tracker_period": row.get("tracker_period", (snapshot.get("config") or {}).get("tracker_period", 5)),
            "stop_percent": row.get("stop_percent", (snapshot.get("config") or {}).get("stop_percent", 0.2)),
            "target_percent": row.get("tp_optimal_percent"),
            "minroe_limit_percent": row.get("loss_limit_percent"),
            "risk_percent": row.get("risk_percent", (snapshot.get("config") or {}).get("risk_percent", 1.0)),
            "leverage": row.get("leverage", 1.0),
            "initial_balance": row.get("initial_balance", (snapshot.get("config") or {}).get("initial_balance", 100.0)),
            "bars": row.get("bars", 0),
            "last_bar_time": row.get("last_bar_time"),
            "status": "SCANNER_SNAPSHOT",
        }
    result = dict(active)
    if result.get("target_percent") is None:
        result["target_percent"] = row.get("tp_optimal_percent")
    return result if result.get("target_percent") is not None else None


def public_snapshot(snapshot: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """Return a JSON-safe view with explicit freshness and epoch timestamps."""
    current = now or datetime.now(timezone.utc)
    def epoch(value: Any) -> int:
        if isinstance(value, datetime):
            normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            return int(normalized.timestamp())
        return int(value or 0)

    scanned_value = snapshot.get("last_scanned_at") or snapshot.get("updated_at")
    scanned_epoch = epoch(scanned_value)
    scanned_at = datetime.fromtimestamp(scanned_epoch, timezone.utc)
    age_seconds = max(0, int((current - scanned_at).total_seconds()))
    updated_epoch = epoch(snapshot.get("updated_at") or scanned_epoch)
    symbols = []
    for item in snapshot.get("symbols") or []:
        if not isinstance(item, dict):
            continue
        active = item.get("worker_parameters")
        if isinstance(active, dict) and not active.get("running"):
            active = None
        if not isinstance(active, dict):
            active = {
                "tracker_period": item.get("tracker_period", (snapshot.get("config") or {}).get("tracker_period")),
                "stop_percent": item.get("stop_percent", (snapshot.get("config") or {}).get("stop_percent")),
                "target_percent": item.get("tp_optimal_percent"),
                "minroe_limit_percent": item.get("loss_limit_percent"),
                "risk_percent": item.get("risk_percent", (snapshot.get("config") or {}).get("risk_percent")),
                "leverage": item.get("leverage"),
                "initial_balance": item.get("initial_balance", (snapshot.get("config") or {}).get("initial_balance")),
                "status": "SCANNER_SNAPSHOT",
            }
        symbols.append({**item, "active_parameters": active})
    return {
        "scan_id": str(snapshot.get("scan_id", "")),
        "last_scanned_at": scanned_epoch,
        "updated_at": updated_epoch,
        "age_seconds": age_seconds,
        "freshness": "FRESH" if age_seconds <= 180 else "STALE",
        "window_seconds": int((snapshot.get("config") or {}).get("window_seconds", 16 * 60 * 60)),
        "config": snapshot.get("config") or {},
        "universe": snapshot.get("universe") or [],
        "symbols": symbols,
    }
