from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Налаштування сервісу. Жодного секрета тут немає і бути не може (ADR-012)."""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    supabase_url: str = ""
    supabase_publishable_key: str = ""

    parser_allowed_origins: str = "http://localhost:5173"
    parser_max_bytes: int = 5_242_880          # 5 МБ; понад це сторінка обрізається
    parser_timeout_seconds: float = 8.0
    parser_rate_limit_per_min: int = 20
    parser_cache_ttl_seconds: int = 900        # 15 хв
    parser_token_cache_seconds: int = 300      # 5 хв
    parser_max_redirects: int = 5

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.parser_allowed_origins.split(",") if o.strip()]

    @property
    def supabase_ready(self) -> bool:
        """Незаповнений шаблон із .env.example — найчастіша причина 503."""
        url = self.supabase_url
        return bool(url) and "<" not in url and url.startswith("https://")


@lru_cache
def settings() -> Settings:
    return Settings()
