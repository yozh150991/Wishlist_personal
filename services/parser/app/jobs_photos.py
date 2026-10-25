"""
Прибирання своїх фото позицій (ADR-073).

Раз на добу — на початку перевірки посилань, тим самим викликом Cloud
Scheduler, як і курс НБП: файл зі сховища `item-photos`, на який не
посилається жодна позиція (позицію видалили, фото прибрали чи замінили,
видалили список чи акаунт), стирається, а потім забувається й його адреса.

Хто сирота, вирішує база (`item_photo_orphans`): видані понад добу тому й
без жодного `items.image_url`, що на них показує. Добу запасу — щоб не
стерти фото з форми, що стоїть відкритою, чи зі зміни, яка ще чекає мережі
в черзі офлайн-змін.

Порядок важливий: спершу файли, потім рядки. Збій сховища лишає рядки на
місці, і наступного дня спроба повториться; навпаки — файл лишився б
публічним без жодного запису про себе.

Адреси фото в журнал не пишуться — лише лічильники: адреса й є доступом до
фото (як токен посилання, CLAUDE.md §3.5).
"""

import logging
from typing import Protocol

log = logging.getLogger("jobs.photos")

#: Скільки файлів за один щоденний запуск. Решта — завтра.
BATCH = 200


class PhotosStoreLike(Protocol):
    async def photo_orphans(self, limit: int) -> list[str]: ...
    async def remove_photos(self, paths: list[str]) -> None: ...
    async def forget_photos(self, paths: list[str]) -> None: ...


async def sweep(store: PhotosStoreLike, limit: int = BATCH) -> int:
    """Скільки фото прибрано. Помилку кидає далі — ловить її виклик задачі."""
    paths = await store.photo_orphans(limit)
    if not paths:
        return 0
    await store.remove_photos(paths)
    await store.forget_photos(paths)
    log.info("прибрано фото без посилань: %d", len(paths))
    return len(paths)
