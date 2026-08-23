"""Store cTrader OAuth credentials encrypted per authenticated user."""

from alembic import op

revision = "202608230001"
down_revision = "202608190003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE user_ctrader_credentials (
            user_id VARCHAR(36) PRIMARY KEY,
            encrypted_access_token TEXT NOT NULL,
            encrypted_refresh_token TEXT NOT NULL,
            account_id BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE user_ctrader_credentials")
