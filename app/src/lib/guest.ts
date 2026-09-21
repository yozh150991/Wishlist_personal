/**
 * Ідентифікатор гостя. Випадковий, живе в localStorage браузера,
 * не повʼязаний з особою і нікуди більше не потрапляє.
 *
 * Потрібен рівно для одного: щоб гість міг зняти власну бронь.
 * Власник списку його не бачить — як і самих броней (ADR-008).
 */
const KEY = 'wl.guest';

export function guestKey(): string {
  let value = localStorage.getItem(KEY);
  if (!value) {
    value = crypto.randomUUID().replace(/-/g, '');
    localStorage.setItem(KEY, value);
  }
  return value;
}

/**
 * Що саме забронював цей браузер — і скільки штук.
 *
 * Сервер на таке питання не відповідає: `get_shared_list` віддає лише скільки
 * всього зайнято, без розбивки по гостях. Інакше з відповіді можна було б
 * вирахувати чужі броні.
 *
 * Формат — мапа `{ itemId: кількість }`. Старі записи були масивом
 * ідентифікаторів; вони читаються як «по одній штуці», щоб бронь, зроблена до
 * оновлення, не зникла в людини з екрана.
 */
function mineKey(token: string): string {
  return `wl.res.${token}`;
}

export type MyReservations = Record<string, number>;

export function myReservations(token: string): MyReservations {
  try {
    const raw = localStorage.getItem(mineKey(token));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return Object.fromEntries((parsed as string[]).map((id) => [id, 1]));
    }
    if (parsed && typeof parsed === 'object') {
      const out: MyReservations = {};
      for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof n === 'number' && n > 0) out[id] = n;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function write(token: string, value: MyReservations): void {
  try {
    localStorage.setItem(mineKey(token), JSON.stringify(value));
  } catch {
    /* приватний режим: бронь на сервері лишається, просто цей браузер її забуде */
  }
}

export function rememberReservation(token: string, itemId: string, quantity = 1): void {
  const next = myReservations(token);
  next[itemId] = quantity;
  write(token, next);
}

export function forgetReservation(token: string, itemId: string): void {
  const next = myReservations(token);
  delete next[itemId];
  write(token, next);
}
