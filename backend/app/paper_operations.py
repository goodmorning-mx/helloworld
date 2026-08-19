"""Persistence for user-scoped paper trading operations."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table


paper_operations_table = table(
    "paper_operations",
    column("id"), column("user_id"), column("symbol"), column("side"), column("chart"),
    column("entry_time"), column("entry_price"), column("current_at"), column("current_price"),
    column("stop_time"), column("stop_price"), column("target_time"), column("target_price"),
    column("status"), column("close_reason"), column("created_at"), column("updated_at"),
)


class PaperOperationStore:
    def __init__(self, engine: Engine):
        self._engine = engine

    def list(self, user_id: str) -> list[dict[str, object]]:
        query = select(paper_operations_table).where(paper_operations_table.c.user_id == user_id).order_by(paper_operations_table.c.created_at)
        with self._engine.connect() as connection:
            rows = connection.execute(query).mappings().all()
        return [self._public(dict(row)) for row in rows]

    def create(self, user_id: str, values: dict[str, object]) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        operation = {**self._database_values(values), "id": str(uuid4()), "user_id": user_id, "created_at": now, "updated_at": now}
        with self._engine.begin() as connection:
            connection.execute(insert(paper_operations_table).values(**operation))
        return self._public(operation)

    def update(self, user_id: str, operation_id: str, values: dict[str, object]) -> dict[str, object] | None:
        now = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            existing = connection.execute(select(paper_operations_table).where(paper_operations_table.c.id == operation_id, paper_operations_table.c.user_id == user_id)).mappings().first()
            if existing is None:
                return None
            # A closed paper operation is an immutable historical record. This
            # also prevents an out-of-order background request from reopening it.
            if existing["status"] != "OPEN":
                return self._public(dict(existing))
            database_values = self._database_values(values)
            result = connection.execute(
                update(paper_operations_table)
                .where(paper_operations_table.c.id == operation_id, paper_operations_table.c.user_id == user_id)
                .values(**database_values, updated_at=now)
            )
            if result.rowcount == 0:
                return None
            row = connection.execute(select(paper_operations_table).where(paper_operations_table.c.id == operation_id, paper_operations_table.c.user_id == user_id)).mappings().one()
        return self._public(dict(row))

    @staticmethod
    def _database_values(values: dict[str, object]) -> dict[str, object]:
        values = dict(values)
        values["current_at"] = values.pop("current_time")
        return values

    @staticmethod
    def _public(values: dict[str, object]) -> dict[str, object]:
        if "current_at" in values:
            values["current_time"] = values.pop("current_at")
        return values
