"""Persist the completion time of the latest scanner run."""

from alembic import op

revision = "202611190001"
down_revision = "202610210004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE scanner_latest_snapshots ADD COLUMN last_scanned_at TIMESTAMP WITH TIME ZONE")
    # Existing updated_at values may have been refreshed by worker publications;
    # started_at is the reliable timestamp available for old scanner snapshots.
    op.execute("UPDATE scanner_latest_snapshots SET last_scanned_at = started_at WHERE last_scanned_at IS NULL")
    op.execute("ALTER TABLE scanner_latest_snapshots ALTER COLUMN last_scanned_at SET NOT NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE scanner_latest_snapshots DROP COLUMN last_scanned_at")
