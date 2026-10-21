"""Store only the latest complete scanner snapshot per user."""

from alembic import op
revision = "202610210003"
down_revision = "202610210002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE scanner_latest_snapshots (
            user_id VARCHAR(128) PRIMARY KEY,
            scan_id VARCHAR(36) NOT NULL UNIQUE,
            config JSONB NOT NULL,
            universe JSONB NOT NULL,
            symbols JSONB NOT NULL,
            started_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        )
    """)
    op.execute("CREATE INDEX ix_scanner_latest_snapshots_updated_at ON scanner_latest_snapshots (updated_at)")


def downgrade() -> None:
    op.execute("DROP INDEX ix_scanner_latest_snapshots_updated_at")
    op.execute("DROP TABLE scanner_latest_snapshots")
