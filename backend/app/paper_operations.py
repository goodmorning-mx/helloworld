"""Persistence for user-scoped paper trading operations."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table


paper_operations_table = table(
    "paper_operations",
    column("id"), column("user_id"), column("symbol"), column("side"), column("chart"),
    column("entry_time"), column("entry_price"), column("current_time"), column("current_price"),
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
        return [dict(row) for row in rows]

    def create(self, user_id: str, values: dict[str, object]) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        operation = {**values, "id": str(uuid4()), "user_id": user_id, "created_at": now, "updated_at": now}
        with self._engine.begin() as connection:
            connection.execute(insert(paper_operations_table).values(**operation))
        return operation

    def update(self, user_id: str, operation_id: str, values: dict[str, object]) -> dict[str, object] | None:
        now = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            existing = connection.execute(select(paper_operations_table).where(paper_operations_table.c.id == operation_id, paper_operations_table.c.user_id == user_id)).mappings().first()
            if existing is None:
                return None
            # A closed paper operation is an immutable historical record. This
            # also prevents an out-of-order background request from reopening it.
            if existing["status"] != "OPEN":
                return dict(existing)
            result = connection.execute(
                update(paper_operations_table)
                .where(paper_operations_table.c.id == operation_id, paper_operations_table.c.user_id == user_id)
                .values(**values, updated_at=now)
            )
            if result.rowcount == 0:
                return None
            row = connection.execute(select(paper_operations_table).where(paper_operations_table.c.id == operation_id, paper_operations_table.c.user_id == user_id)).mappings().one()
        return dict(row)
