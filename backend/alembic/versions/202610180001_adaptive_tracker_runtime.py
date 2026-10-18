"""Persist the authoritative Tracker operation and adaptive parameter snapshot."""

from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
import sqlalchemy as sa


revision = "202610180001"
down_revision = "202610150002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("production_worker_configs", sa.Column("risk_percent", sa.Float(), nullable=False, server_default="1"))
    op.add_column("production_worker_configs", sa.Column("leverage", sa.Float(), nullable=False, server_default="1"))
    op.add_column("production_worker_configs", sa.Column("initial_balance", sa.Float(), nullable=False, server_default="100"))
    op.add_column("production_worker_runtime", sa.Column("tracker_operation", JSONB(), nullable=True))
    op.add_column("production_worker_runtime", sa.Column("adaptive_parameters", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("production_worker_runtime", "adaptive_parameters")
    op.drop_column("production_worker_runtime", "tracker_operation")
    op.drop_column("production_worker_configs", "initial_balance")
    op.drop_column("production_worker_configs", "leverage")
    op.drop_column("production_worker_configs", "risk_percent")
