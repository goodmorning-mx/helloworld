"""Persist Binance entry fill time and price for exact chart alignment."""

from alembic import op

revision = "202609060002"
down_revision = "202609060001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE binance_execution_intents ADD COLUMN entry_time BIGINT")
    op.execute("ALTER TABLE binance_execution_intents ADD COLUMN entry_price DOUBLE PRECISION")


def downgrade() -> None:
    op.execute("ALTER TABLE binance_execution_intents DROP COLUMN entry_price")
    op.execute("ALTER TABLE binance_execution_intents DROP COLUMN entry_time")
