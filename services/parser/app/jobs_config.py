import re
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

    # Сповіщення (P, ADR-049). Ключі — із Secret Manager, адреси — звичайні
    # змінні. Без них перевірка посилань працює, а сповіщення — ні.
    brevo_api_key: str = ""
    vapid_private_key: str = ""
    mail_from: str = ""
    app_origin: str = ""

    # Гостьові листи (ADR-054): окремий відкритий сервіс wishlist-guestmail
    # приймає лише сигнал «прокинься» з цим секретом (той самий — у Vault).
    guest_mail_wake_secret: str = ""

    @field_validator(
        "supabase_url",
        "supabase_secret_key",
        "brevo_api_key",
        "vapid_private_key",
        "mail_from",
        "app_origin",
        "guest_mail_wake_secret",
    )
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

    @property
    def notify_problems(self) -> list[str]:
        """Чого бракує сповіщенням — назви змінних, без значень."""
        out: list[str] = []
        if not self.brevo_api_key.startswith("xkeysib-"):
            out.append("BREVO_API_KEY")
        # Сирий приватний ключ P-256 у base64url — 43 символи.
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}=?", self.vapid_private_key):
            out.append("VAPID_PRIVATE_KEY")
        if not re.fullmatch(r"[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+", self.mail_from):
            out.append("MAIL_FROM")
        origin = self.app_origin.rstrip("/")
        if not re.fullmatch(r"https://[A-Za-z0-9.-]+(:\d+)?", origin):
            out.append("APP_ORIGIN")
        return out

    @property
    def notify_ready(self) -> bool:
        return self.ready and not self.notify_problems

    @property
    def guest_mail_problems(self) -> list[str]:
        """Чого бракує гостьовим листам (ADR-054) — назви змінних, без значень."""
        out = [p for p in self.notify_problems if p != "VAPID_PRIVATE_KEY"]
        # Секрет сигналу — не коротший за 32 символи: він стоїть між відкритим
        # сервісом і чергою.
        if len(self.guest_mail_wake_secret) < 32:
            out.append("GUEST_MAIL_WAKE_SECRET")
        return out

    @property
    def guest_mail_ready(self) -> bool:
        return self.ready and not self.guest_mail_problems


@lru_cache
def job_settings() -> JobSettings:
    return JobSettings()
