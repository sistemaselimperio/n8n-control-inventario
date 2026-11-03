from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Conexion directa (no pooler transaccional) — el backend mantiene su
    # propio pool de asyncpg de larga duracion, asi que no necesita PgBouncer
    # en modo transaction. Ver POSTGRES_URL_NON_POOLING en Supabase.
    database_url: str = "postgresql://postgres:postgres@localhost:5432/postgres"

    openai_api_key: str = ""
    # GPT-5.6 Luna: mas barato/rapido de la familia 5.6, alcanza de sobra para
    # extraer campos estructurados de una guia legible. GPT-4o esta en retiro
    # por parte de OpenAI, dejo de ser el default seguro.
    vision_model: str = "gpt-5.6-luna"

    # Supabase Storage — la usan scripts/setup_storage.py (provisioning) y
    # app/services/storage_evidencia.py (reporte Syscafe, subido desde el
    # backend). La app movil sube con la
    # publishable key (ver apps/mobile/supabase.ts).
    # Secret key nueva (sb_secret_...) — reemplaza a la service_role key (JWT),
    # que Supabase da de baja a fines de 2026. Ambas funcionan igual, esta es
    # la vigente.
    supabase_url: str = ""
    supabase_secret_key: str = ""

    # Lista separada por comas — permite el dashboard en prod (Vercel) y el
    # dashboard local (localhost:3000) al mismo tiempo mientras se sigue
    # desarrollando contra el backend ya desplegado.
    dashboard_origin: str = "http://localhost:3000"

    @property
    def dashboard_origins(self) -> list[str]:
        return [o.strip() for o in self.dashboard_origin.split(",") if o.strip()]

    # Confianza minima por campo obligatorio antes de auto-aprobar una entrega.
    min_confidence: float = 0.75

    # Piso mas estricto que min_confidence: por debajo de esto la foto se
    # considera ilegible y se rechaza sin crear ningun registro (ver
    # ExtraccionIlegible en app/services/duplicates.py) -- valor de arranque,
    # ajustable despues de ver casos reales en produccion.
    min_confidence_rechazo: float = 0.35

    # Protege los endpoints de borrado definitivo del dashboard (ver
    # app/services/admin_auth.py, verificar_token_admin) y la administracion
    # (/creador del dashboard). None = deshabilitado (falla cerrado) hasta que se configure explicitamente.
    admin_delete_token: str | None = None

    # Clave con la que se firman los tokens de sesion del dashboard (ver
    # app/services/sesion_dashboard.py). Opcional: si falta, se deriva de
    # admin_delete_token.
    dashboard_session_secret: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
