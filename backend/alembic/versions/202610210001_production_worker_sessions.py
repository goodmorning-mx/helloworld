"""Add one leased Tracker session per authenticated user."""

from alembic import op


revision = "202610210001"
down_revision = "202610180001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE production_worker_sessions (
            user_id VARCHAR(128) PRIMARY KEY,
            symbol VARCHAR(32) NOT NULL,
            owner_id VARCHAR(64),
            lease_until TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        )
    """)
    op.create_index("ix_production_worker_sessions_lease", "production_worker_sessions", ["lease_until"])


def downgrade() -> None:
    op.drop_index("ix_production_worker_sessions_lease", table_name="production_worker_sessions")
    op.drop_table("production_worker_sessions")
