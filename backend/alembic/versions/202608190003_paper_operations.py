"""Persist paper operations per authenticated user."""

from alembic import op

revision = "202608190003"
down_revision = "202608190002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE paper_operations (
            id VARCHAR(36) PRIMARY KEY,
            user_id VARCHAR(128) NOT NULL,
            symbol VARCHAR(32) NOT NULL,
            side VARCHAR(8) NOT NULL,
            chart VARCHAR(16) NOT NULL,
            entry_time BIGINT NOT NULL,
            entry_price DOUBLE PRECISION NOT NULL,
            current_at BIGINT NOT NULL,
            current_price DOUBLE PRECISION NOT NULL,
            stop_time BIGINT NOT NULL,
            stop_price DOUBLE PRECISION NOT NULL,
            target_time BIGINT NOT NULL,
            target_price DOUBLE PRECISION NOT NULL,
            status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
            close_reason VARCHAR(8),
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
    """)
    op.execute("CREATE INDEX paper_operations_user_updated_idx ON paper_operations (user_id, updated_at)")


def downgrade() -> None:
    op.execute("DROP TABLE paper_operations")
