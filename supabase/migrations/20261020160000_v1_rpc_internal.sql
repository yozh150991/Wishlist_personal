-- Дизайн v2, крок 9б (ADR-065, п. 6): RPC гостьової v1 — лише внутрішні.
--
-- З кроку 9а застосунок кличе лише get_guest_list і claim_item_v2. Обидві —
-- SECURITY DEFINER від власника схеми й усередині викликають get_shared_list
-- і claim_item, тож тим потрібен виконавець postgres, а не гість. Прямий
-- виклик через PostgREST закриваємо: одна гостьова — одна дорога, і нова
-- поведінка (архів, збори, подяка) не обходиться старим входом.
--
-- Функції не видаляються: на них стоять обгортки v2. Видалення — лише разом
-- з перенесенням тіла в get_guest_list / claim_item_v2, окремим рішенням.
--
-- Порядок деплою: після фронтенду 9а. Старий фронтенд (до 9а) ще кличе ці
-- функції з екранів v1 — з ним гостьова /s/… перестала б працювати.

revoke all on function public.get_shared_list(text, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_item(text, uuid, text, integer) from public, anon, authenticated, service_role;

comment on function public.get_shared_list(text, text) is
  'Внутрішня (ADR-065): тіло гостьової відповіді для get_guest_list. Прямого доступу в клієнтів немає.';
comment on function public.claim_item(text, uuid, text, integer) is
  'Внутрішня (ADR-065): бронь для claim_item_v2. Прямого доступу в клієнтів немає.';
