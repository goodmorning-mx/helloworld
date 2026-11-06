"""Persist a bounded recent log on each production worker runtime."""

from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
import sqlalchemy as sa


revision = "202610210004"
down_revision = "202610210003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "production_worker_runtime",
        sa.Column("recent_logs", JSONB(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("production_worker_runtime", "recent_logs")
