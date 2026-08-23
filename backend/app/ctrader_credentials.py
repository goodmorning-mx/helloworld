"""Encrypted per-user cTrader OAuth credentials."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table

from app.binance_credentials import CredentialCipher
from app.config import Settings


credentials_table = table(
    "user_ctrader_credentials",
    column("user_id"), column("encrypted_access_token"), column("encrypted_refresh_token"),
    column("account_id"), column("created_at"), column("updated_at"),
)


class CTraderCredentialStore:
    def __init__(self, engine: Engine, settings: Settings):
        self._engine = engine
        self._cipher = CredentialCipher(settings.binance_credentials_encryption_key, settings.jwt_secret)

    def get(self, user_id: str) -> dict[str, object] | None:
        query = select(
            credentials_table.c.encrypted_access_token,
            credentials_table.c.encrypted_refresh_token,
            credentials_table.c.account_id,
        ).where(credentials_table.c.user_id == user_id)
        with self._engine.connect() as connection:
            row = connection.execute(query).first()
        if row is None:
            return None
        return {
            "access_token": self._cipher.decrypt(row.encrypted_access_token),
            "refresh_token": self._cipher.decrypt(row.encrypted_refresh_token),
            "account_id": row.account_id,
        }

    def user_ids(self) -> list[str]:
        with self._engine.connect() as connection:
            rows = connection.execute(select(credentials_table.c.user_id)).all()
        return [str(row.user_id) for row in rows]

    def status(self, user_id: str) -> dict[str, object]:
        query = select(credentials_table.c.account_id, credentials_table.c.updated_at).where(credentials_table.c.user_id == user_id)
        with self._engine.connect() as connection:
            row = connection.execute(query).first()
        if row is None:
            return {"configured": False, "account_id": None, "updated_at": None}
        return {
            "configured": True,
            "account_id": str(row.account_id),
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }

    def save(self, user_id: str, access_token: str, refresh_token: str, account_id: int) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        values = {
            "user_id": user_id,
            "encrypted_access_token": self._cipher.encrypt(access_token.strip()),
            "encrypted_refresh_token": self._cipher.encrypt(refresh_token.strip()),
            "account_id": int(account_id),
            "created_at": now,
            "updated_at": now,
        }
        with self._engine.begin() as connection:
            exists = connection.execute(select(credentials_table.c.user_id).where(credentials_table.c.user_id == user_id)).first()
            if exists:
                connection.execute(update(credentials_table).where(credentials_table.c.user_id == user_id).values(
                    encrypted_access_token=values["encrypted_access_token"],
                    encrypted_refresh_token=values["encrypted_refresh_token"],
                    account_id=values["account_id"], updated_at=now,
                ))
            else:
                connection.execute(insert(credentials_table).values(**values))
        return self.status(user_id)

    def update_tokens(self, user_id: str, access_token: str, refresh_token: str) -> None:
        """Persist rotated OAuth tokens without exposing them to the client."""
        now = datetime.now(timezone.utc)
        values = {
            "encrypted_access_token": self._cipher.encrypt(access_token.strip()),
            "encrypted_refresh_token": self._cipher.encrypt(refresh_token.strip()),
            "updated_at": now,
        }
        with self._engine.begin() as connection:
            connection.execute(update(credentials_table).where(credentials_table.c.user_id == user_id).values(**values))

    def delete(self, user_id: str) -> None:
        with self._engine.begin() as connection:
            connection.execute(delete(credentials_table).where(credentials_table.c.user_id == user_id))
