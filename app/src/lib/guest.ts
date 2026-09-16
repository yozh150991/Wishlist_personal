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

/** Що саме забронював цей браузер — сервер такого питання не відповідає. */
function mineKey(token: string): string {
  return `wl.res.${token}`;
}

export function myReservations(token: string): string[] {
  try {
    const raw = localStorage.getItem(mineKey(token));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function rememberReservation(token: string, itemId: string): void {
  const next = new Set(myReservations(token));
  next.add(itemId);
  localStorage.setItem(mineKey(token), JSON.stringify([...next]));
}

export function forgetReservation(token: string, itemId: string): void {
  const next = myReservations(token).filter((id) => id !== itemId);
  localStorage.setItem(mineKey(token), JSON.stringify(next));
}
