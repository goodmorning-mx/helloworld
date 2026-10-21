"""Deduplicate worker Binance intents by Tracker signal."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


revision = "202610210002"
down_revision = "202610210001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("binance_execution_intents", sa.Column("signal_id", sa.String(length=160), nullable=True))
    op.create_index(
        "uq_binance_execution_user_signal",
        "binance_execution_intents",
        ["user_id", "signal_id"],
        unique=True,
        postgresql_where=text("signal_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_binance_execution_user_signal", table_name="binance_execution_intents")
    op.drop_column("binance_execution_intents", "signal_id")
