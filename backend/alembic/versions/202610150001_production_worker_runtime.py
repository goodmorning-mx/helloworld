"""Persist worker cursors and health state."""

from alembic import op


revision = "202610150001"
down_revision = "202610060001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE production_worker_runtime (
            user_id VARCHAR(128) NOT NULL,
            symbol VARCHAR(32) NOT NULL,
            owner_id VARCHAR(64),
            lease_until TIMESTAMP WITH TIME ZONE,
            last_bar_time BIGINT,
            heartbeat_at TIMESTAMP WITH TIME ZONE NOT NULL,
            status VARCHAR(24) NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT pk_production_worker_runtime PRIMARY KEY (user_id, symbol)
        )
    """)
    op.create_index("ix_production_worker_runtime_heartbeat", "production_worker_runtime", ["heartbeat_at"])


def downgrade() -> None:
    op.drop_index("ix_production_worker_runtime_heartbeat", table_name="production_worker_runtime")
    op.drop_table("production_worker_runtime")
