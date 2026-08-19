"""Store Binance credentials encrypted per authenticated user."""

from alembic import op

revision = "202608190002"
down_revision = "202607150001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE user_binance_credentials (
            user_id VARCHAR(36) PRIMARY KEY,
            encrypted_api_key TEXT NOT NULL,
            encrypted_api_secret TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE user_binance_credentials")
