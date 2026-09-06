"""Persist native Binance take-profit algo order identifiers."""

from alembic import op

revision = "202609060001"
down_revision = "202609040001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE binance_execution_intents ADD COLUMN stop_algo_id VARCHAR(64)")
    op.execute("ALTER TABLE binance_execution_intents ADD COLUMN take_profit_algo_id VARCHAR(64)")


def downgrade() -> None:
    op.execute("ALTER TABLE binance_execution_intents DROP COLUMN take_profit_algo_id")
    op.execute("ALTER TABLE binance_execution_intents DROP COLUMN stop_algo_id")
