from sqlalchemy import create_engine, text

from app.paper_operations import PaperOperationStore


def test_engine_paper_rows_are_idempotent_and_isolated_from_manual_rows():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE paper_operations (
                id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(128) NOT NULL,
                symbol VARCHAR(32) NOT NULL, side VARCHAR(8) NOT NULL,
                chart VARCHAR(16) NOT NULL, entry_time BIGINT NOT NULL,
                entry_price FLOAT NOT NULL, current_at BIGINT NOT NULL,
                current_price FLOAT NOT NULL, stop_time BIGINT NOT NULL,
                stop_price FLOAT NOT NULL, target_time BIGINT NOT NULL,
                target_price FLOAT NOT NULL, status VARCHAR(24) NOT NULL,
                close_reason VARCHAR(8), risk_percent FLOAT, notional FLOAT,
                margin FLOAT, pnl FLOAT, source VARCHAR(32) NOT NULL DEFAULT 'manual',
                idempotency_key VARCHAR(160), created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
        """))
        connection.execute(text("CREATE UNIQUE INDEX paper_operation_key ON paper_operations(user_id, idempotency_key)"))
    store = PaperOperationStore(engine)
    base = {
        "symbol": "BTCUSDT", "side": "long", "chart": "entry", "entry_time": 60,
        "entry_price": 100.0, "current_time": 60, "current_price": 100.0,
        "stop_time": 60, "stop_price": 99.8, "target_time": 60,
        "target_price": 101.0, "status": "OPEN", "close_reason": None,
        "source": "realtime-engine", "idempotency_key": "tracker:BTCUSDT:1m:60:LONG:H2",
    }
    first = store.create("user", base)
    duplicate = store.create("user", base)
    assert duplicate["id"] == first["id"]
    assert store.open_for_symbol("user", "BTCUSDT")["id"] == first["id"]

    manual = {**base, "source": "manual", "idempotency_key": None}
    store.create("user", manual)
    assert store.open_for_symbol("user", "BTCUSDT")["id"] == first["id"]
