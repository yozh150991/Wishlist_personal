"""
`pytest -m live` збирає лише живий прогін магазинів (ROADMAP 8.3).

Інакше pytest імпортує всі модулі тестів, щоб прочитати їхні мітки, і
модулі `wishlist-jobs` падають на збиранні, якщо локально не стоять усі
залежності сервісу (`http_ece` тощо). Живому прогону вони не потрібні.
Звичайний `pytest` і CI це не зачіпає: там мітка — `not live`.
"""

from pathlib import Path

LIVE_MODULE = "test_live_shops.py"


def pytest_ignore_collect(collection_path: Path, config) -> bool | None:
    if (config.getoption("markexpr") or "").strip() != "live":
        return None
    if collection_path.is_file() and collection_path.suffix == ".py" and collection_path.name.startswith("test_"):
        return collection_path.name != LIVE_MODULE
    return None
