import { publicOrigin } from './supabase';

/**
 * Ключ гостя — носій права на свої позначки в одному списку (ADR-035).
 *
 * Ні імені, ні пошти: власник не бачить позначок, тож ключ не може бути
 * «людиною, яку впізнає власник». Сервер зберігає лише sha256(список:ключ),
 * тому ключ зі списку A в списку B нічого не відкриває.
 *
 * Джерел два, і жодне не єдине:
 *   * особисте посилання `/s/{токен}/g/{ключ}` — гість надсилає його собі
 *     в месенджер («Забери доступ із собою»): телефон гублять частіше, ніж чат;
 *   * localStorage цього браузера — щоб не просити посилання щоразу.
 * Третій шлях — короткий код, що видає новий ключ тієї самої ідентичності.
 *
 * Ключ генерується тут і зберігається **до** першої позначки: якщо відповідь
 * сервера загубиться, позначка не лишиться без власника.
 */

const KEY_PREFIX = 'wl.gk.';
/** До ADR-035: один ключ браузера на всі списки. Міграція перенесла броні з ним. */
const LEGACY_KEY = 'wl.guest';
const WATCH_PREFIX = 'wl.watch.';

const KEY_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;

function read(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function write(name: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    /* приватний режим: ключ живе до кінця вкладки й в особистому посиланні */
  }
}

export function isGuestKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_SHAPE.test(v);
}

/** Ключ цього посилання, якщо браузер його вже має. */
export function storedKey(token: string): string | null {
  const v = read(KEY_PREFIX + token);
  return isGuestKey(v) ? v : null;
}

/**
 * Старий ключ браузера (до ADR-035). Годиться лише для списків, де з ним уже
 * є позначки, — це вирішує сервер. Для нових позначок він не береться: інакше
 * особисте посилання одного списку відкривало б і всі інші.
 */
export function legacyKey(): string | null {
  const v = read(LEGACY_KEY);
  return isGuestKey(v) ? v : null;
}

export function rememberKey(token: string, key: string): void {
  if (isGuestKey(key)) write(KEY_PREFIX + token, key);
}

/** Ключ для першої позначки: наявний або новий, збережений до запиту. */
export function ensureKey(token: string): string {
  const existing = storedKey(token);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  rememberKey(token, key);
  return key;
}

/** Особисте посилання гостя: те саме посилання плюс його ключ. */
export function personalLink(token: string, key: string): string {
  return `${publicOrigin.replace(/\/$/, '')}/s/${token}/g/${key}`;
}

/* ── «Стежити за списком» ─────────────────── */

/**
 * «Стежити» живе на пристрої: пошту не просимо — у продукту без акаунтів це
 * перший крок до акаунта. Запамʼятовуємо, які позиції були й які були
 * вільні; наступного разу показуємо різницю.
 */
export type Watch = { at: string; items: string[]; free: string[] };

export function readWatch(token: string): Watch | null {
  try {
    const raw = read(WATCH_PREFIX + token);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Watch>;
    if (!Array.isArray(v.items) || !Array.isArray(v.free) || typeof v.at !== 'string') return null;
    return { at: v.at, items: v.items.map(String), free: v.free.map(String) };
  } catch {
    return null;
  }
}

export function saveWatch(token: string, items: string[], free: string[]): void {
  write(WATCH_PREFIX + token, JSON.stringify({ at: new Date().toISOString(), items, free }));
}

export function stopWatch(token: string): void {
  write(WATCH_PREFIX + token, null);
}
