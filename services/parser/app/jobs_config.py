from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class JobSettings(BaseSettings):
    """
    Налаштування закритого сервісу wishlist-jobs (ADR-048).

    На відміну від `app.config.Settings` парсера тут є секрет: secret-ключ
    Supabase (`sb_secret_…`). Він приходить із Secret Manager у змінну
    оточення лише сервісу wishlist-jobs; відкритий парсер цього модуля не
    імпортує й ключа не має (ADR-012).
    """

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    supabase_url: str = ""
    supabase_secret_key: str = ""

    # Перевірка посилань (R). Не бомбардуємо магазини: одночасно — кілька
    # різних сайтів, у межах одного сайту — по черзі й із паузою.
    jobs_batch_size: int = 50
    jobs_time_budget_seconds: int = 300
    jobs_recheck_hours: int = 20
    jobs_host_delay_seconds: float = 2.0
    jobs_concurrency: int = 4

    @field_validator("supabase_url", "supabase_secret_key")
    @classmethod
    def _strip(cls, value: str) -> str:
        # Секрет, покладений у Secret Manager через `echo`, несе перенос рядка
        # в кінці, а записаний через `Set-Content -Encoding UTF8` у Windows
        # PowerShell — ще й BOM на початку. Такий ключ Supabase уже не впізнає.
        return value.strip().lstrip("\ufeff").strip()

    @property
    def problems(self) -> list[str]:
        """Що саме не налаштовано — назви змінних, без значень."""
        out: list[str] = []
        url = self.supabase_url
        if not url.startswith("https://") or "<" in url:
            out.append("SUPABASE_URL")
        if not self.supabase_secret_key.startswith("sb_secret_"):
            out.append("SUPABASE_SECRET_KEY")
        return out

    @property
    def ready(self) -> bool:
        return not self.problems


@lru_cache
def job_settings() -> JobSettings:
    return JobSettings()
