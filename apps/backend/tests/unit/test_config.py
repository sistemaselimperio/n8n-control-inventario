"""La suite no debe leer secretos reales ni el .env del disco."""

from app.config import Settings, get_settings


def test_settings_usa_entorno_de_prueba_y_no_el_env_del_disco():
    s = get_settings()
    assert s.database_url.startswith("postgresql://prueba:prueba@127.0.0.1:1/")
    assert s.openai_api_key == "sk-prueba-no-real"
    assert Settings.model_config["env_file"] is None


def test_dashboard_origins_se_separan_por_coma(monkeypatch):
    monkeypatch.setenv("DASHBOARD_ORIGIN", "https://a.example, https://b.example ,")
    get_settings.cache_clear()
    assert get_settings().dashboard_origins == ["https://a.example", "https://b.example"]
