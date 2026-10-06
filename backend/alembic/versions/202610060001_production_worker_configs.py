"""Persist per-symbol production worker configuration."""

from alembic import op


revision = "202610060001"
down_revision = "202609060002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE production_worker_configs (
            id VARCHAR(64) PRIMARY KEY,
            user_id VARCHAR(128) NOT NULL,
            symbol VARCHAR(32) NOT NULL,
            mode VARCHAR(16) NOT NULL,
            interval VARCHAR(8) NOT NULL,
            tracker_period INTEGER NOT NULL,
            stop_percent DOUBLE PRECISION NOT NULL,
            target_percent DOUBLE PRECISION NOT NULL,
            quantity DOUBLE PRECISION NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_production_worker_user_symbol UNIQUE (user_id, symbol)
        )
    """)
    op.create_index("ix_production_worker_configs_enabled", "production_worker_configs", ["enabled"])


def downgrade() -> None:
    op.drop_index("ix_production_worker_configs_enabled", table_name="production_worker_configs")
    op.drop_table("production_worker_configs")
