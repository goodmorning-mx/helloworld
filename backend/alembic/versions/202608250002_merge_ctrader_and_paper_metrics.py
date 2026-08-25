"""Merge the cTrader credentials and paper metrics migration branches."""

from alembic import op

revision = "202608250002"
down_revision = ("202608230001", "202608250001")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
