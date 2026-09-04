"""Persist the safe foundation for backend-owned Binance execution."""

from alembic import op

revision = "202609040001"
down_revision = "202608250002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE binance_execution_intents (
            id VARCHAR(36) PRIMARY KEY,
            user_id VARCHAR(128) NOT NULL,
            symbol VARCHAR(32) NOT NULL,
            side VARCHAR(8) NOT NULL,
            quantity DOUBLE PRECISION NOT NULL,
            stop_loss DOUBLE PRECISION,
            take_profit DOUBLE PRECISION,
            status VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL',
            exchange_order_id VARCHAR(64),
            client_order_id VARCHAR(64) UNIQUE,
            last_error TEXT,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
    """)
    op.execute("CREATE INDEX binance_execution_user_status_idx ON binance_execution_intents (user_id, status, updated_at)")


def downgrade() -> None:
    op.execute("DROP TABLE binance_execution_intents")
