"""Store paper-operation sizing and realized PNL at operation time."""

from alembic import op

revision = "202608250001"
down_revision = "202608190003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE paper_operations ADD COLUMN risk_percent DOUBLE PRECISION")
    op.execute("ALTER TABLE paper_operations ADD COLUMN notional DOUBLE PRECISION")
    op.execute("ALTER TABLE paper_operations ADD COLUMN margin DOUBLE PRECISION")
    op.execute("ALTER TABLE paper_operations ADD COLUMN pnl DOUBLE PRECISION")


def downgrade() -> None:
    op.execute("ALTER TABLE paper_operations DROP COLUMN pnl")
    op.execute("ALTER TABLE paper_operations DROP COLUMN margin")
    op.execute("ALTER TABLE paper_operations DROP COLUMN notional")
    op.execute("ALTER TABLE paper_operations DROP COLUMN risk_percent")
