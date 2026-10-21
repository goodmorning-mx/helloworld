from app.config import Settings


def test_production_worker_live_and_resume_are_disabled_by_default():
    settings = Settings(_env_file=None)
    assert settings.production_worker_enabled is True
    assert settings.production_worker_live_enabled is False
    assert settings.production_worker_live_validated is False
    assert settings.binance_real_trading_enabled is False
    assert settings.production_worker_resume_live is False
    assert settings.telegram_commands_enabled is True
