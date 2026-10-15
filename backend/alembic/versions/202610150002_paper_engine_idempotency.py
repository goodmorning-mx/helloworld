"""Tag engine Paper operations and prevent duplicate candle entries."""

from alembic import op
from sqlalchemy import text


revision = "202610150002"
down_revision = "202610150001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE paper_operations ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'manual'")
    op.execute("ALTER TABLE paper_operations ADD COLUMN idempotency_key VARCHAR(160)")
    op.create_index(
        "uq_paper_operations_user_idempotency",
        "paper_operations",
        ["user_id", "idempotency_key"],
        unique=True,
        postgresql_where=text("idempotency_key IS NOT NULL"),
    )
    op.create_index("ix_paper_operations_engine_open", "paper_operations", ["user_id", "symbol", "status", "source"])


def downgrade() -> None:
    op.drop_index("ix_paper_operations_engine_open", table_name="paper_operations")
    op.drop_index("uq_paper_operations_user_idempotency", table_name="paper_operations")
    op.execute("ALTER TABLE paper_operations DROP COLUMN idempotency_key")
    op.execute("ALTER TABLE paper_operations DROP COLUMN source")
