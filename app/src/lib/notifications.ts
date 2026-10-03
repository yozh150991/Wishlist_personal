/**
 * Сповіщення власника (потік P, ADR-049): налаштування, push на цьому
 * пристрої й правила, які не потребують React.
 *
 * Що й коли надсилати, вирішує закритий сервіс wishlist-jobs; застосунок лише
 * записує вибір людини (`notification_settings`) і підписку пристрою
 * (`save_push_subscription`). Рядка налаштувань немає — сповіщень немає, як у
 * v1: вмикає їх лише людина з інтерфейсу v2.
 *
 * Про позначки гостей подій немає й не буде (ADR-040).
 */
import { supabase } from './supabase';
import { deviceTimeZone } from './zones';
import { IMPORTANT_KINDS, NOTIFY_KINDS, allOff, anyOn, anyPushOn, enabledDefaults, flag, vapidKeyBytes } from './notifyRules';
import type { NotifyChannel, NotifyFlag, NotifyFlags, NotifyKind, NotifySettings } from './notifyRules';

export { IMPORTANT_KINDS, NOTIFY_KINDS, allOff, anyOn, anyPushOn, enabledDefaults, flag, vapidKeyBytes };
export type { NotifyChannel, NotifyFlag, NotifyFlags, NotifyKind, NotifySettings };

// ── Дані ────────────────────────────────────

export async function fetchNotifySettings(): Promise<NotifySettings | null> {
  const { data, error } = await supabase.from('notification_settings').select('*').maybeSingle();
  if (error) throw error;
  return (data as NotifySettings | null) ?? null;
}

/**
 * Зберегти вибір. Пояс — завжди поточний пристрою: тиша 22:00–9:00 рахується
 * там, де людина зараз, а не там, де вмикала сповіщення.
 */
export async function saveNotifySettings(ownerId: string, patch: Partial<NotifyFlags>): Promise<NotifySettings> {
  // Пояс невідомий — не пишемо нічого: збережений лишається, новий рядок бере UTC.
  const tz = deviceTimeZone();
  const { data, error } = await supabase
    .from('notification_settings')
    .upsert({ owner_id: ownerId, ...(tz ? { time_zone: tz } : {}), ...patch }, { onConflict: 'owner_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as NotifySettings;
}

/** Скільки пристроїв власника отримують push — лише число, адрес не читаємо. */
export async function countPushDevices(): Promise<number> {
  const { count, error } = await supabase.from('push_subscriptions').select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

// ── Push на цьому пристрої ───────────────────

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';

/**
 * - `no-key` — збірка без `VITE_VAPID_PUBLIC_KEY`: push вимкнений цілком,
 *   лишається пошта (як `VITE_PARSER_URL` для «Заповнити»);
 * - `ios-install` — iPhone чи iPad у браузері: push приходить лише у
 *   встановленому застосунку;
 * - `unsupported` — браузер не вміє push;
 * - `denied` — людина заборонила сповіщення в налаштуваннях браузера;
 * - `default` / `granted` — можна вмикати.
 */
export type PushSupport = 'no-key' | 'ios-install' | 'unsupported' | 'denied' | 'default' | 'granted';

function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (!VAPID_PUBLIC_KEY) return 'no-key';
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!capable) return isAppleMobile() && !isStandalone() ? 'ios-install' : 'unsupported';
  const permission = Notification.permission;
  return permission === 'denied' ? 'denied' : permission === 'granted' ? 'granted' : 'default';
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/**
 * Реєстрація Service Worker. У режимі розробки його немає, і `ready` не
 * настає ніколи — тож чекаємо обмежено.
 */
async function registration(ms = 4000): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  if (!reg || !('pushManager' in reg)) return null;
  return reg.pushManager.getSubscription();
}

/** Обіцянка, що здається через `ms`: системний запит може не відповісти ніколи. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/**
 * Push на цьому пристрої — і в браузері, і на сервері: сервер міг прибрати
 * рядок (понад 10 пристроїв, служба push сказала «підписки немає»).
 */
export async function pushOnThisDevice(): Promise<boolean> {
  if (pushSupport() !== 'granted') return false;
  const sub = await currentSubscription();
  if (!sub) return false;
  const { data, error } = await supabase.from('push_subscriptions').select('endpoint');
  if (error) throw error;
  return (data ?? []).some((row: { endpoint: string }) => row.endpoint === sub.endpoint);
}

/** Прибрати свій пристрій на сервері. Адреса — у тілі запиту, не в рядку адреси. */
async function forgetOnServer(endpoint: string): Promise<void> {
  const { error } = await supabase.rpc('forget_push_subscription', { p_endpoint: endpoint });
  if (error) throw error;
}

export type PushResult = 'ok' | 'denied' | 'unsupported';

/**
 * Увімкнути push тут: системний запит дозволу (лише за натиском людини),
 * підписка й збереження на сервері. Підписку зі старим ключем VAPID
 * замінюємо: служба push іншого ключа не прийме.
 */
export async function enablePushHere(): Promise<PushResult> {
  const support = pushSupport();
  if (support !== 'default' && support !== 'granted') return support === 'denied' ? 'denied' : 'unsupported';
  // Тихий запит дозволу в Chrome може не відповісти ніколи — кнопка не має
  // лишитися «Вмикаю…» назавжди (CLAUDE.md §4).
  const permission =
    support === 'granted' ? 'granted' : await within(Notification.requestPermission(), 60_000, 'default' as NotificationPermission);
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  if (!reg || !('pushManager' in reg)) return 'unsupported';
  const key = vapidKeyBytes(VAPID_PUBLIC_KEY);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    try {
      sub = await within(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), 20_000, null);
      if (!sub) return 'unsupported';
    } catch {
      // Служба push браузера відмовила (Brave без push, немає звʼязку зі
      // службою): для людини це те саме, що push тут не працює.
      return 'unsupported';
    }
  }
  const json = sub.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: json.endpoint ?? '',
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
  });
  if (error) throw error;
  return 'ok';
}

/** Вимкнути push тут: прибрати рядок на сервері й підписку браузера. */
export async function disablePushHere(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await forgetOnServer(sub.endpoint);
  await sub.unsubscribe();
}

/**
 * Перед виходом з акаунта: пристрій більше не має отримувати сповіщень цього
 * власника — наступна людина за ним побачила б назви чужих списків. Рядок на
 * сервері прибираємо, поки сесія ще жива; не вийшло (немає мережі) — підписку
 * браузера однаково знімаємо, і служба push відповість сервісу «підписки
 * немає», а той прибере рядок сам. Вихід цим не затримується надовго.
 */
export async function forgetPushOnThisDevice(withServer: boolean): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (!sub) return;
    if (withServer) await within(forgetOnServer(sub.endpoint).catch(() => undefined), 3000, undefined);
    await sub.unsubscribe();
  } catch {
    // Вихід важливіший за прибирання: помилка тут його не зупиняє.
  }
}

// ── Одна кнопка «Увімкнути сповіщення» ───────

export type EnableOutcome = { settings: NotifySettings; push: PushResult | 'no-key'; pushWorks: boolean };

/**
 * «Увімкнути сповіщення» — і з аркуша після першого посилання, і з
 * Налаштувань. Push тут — якщо можна; не вийшло, але push уже працює на
 * іншому пристрої — push однаково; інакше пошта для важливого.
 */
export async function enableNotifications(ownerId: string): Promise<EnableOutcome> {
  const support = pushSupport();
  const push: PushResult | 'no-key' =
    support === 'no-key' ? 'no-key' : support === 'default' || support === 'granted' ? await enablePushHere() : support === 'denied' ? 'denied' : 'unsupported';
  const devices = push === 'ok' ? 1 : support === 'no-key' ? 0 : await countPushDevices().catch(() => 0);
  const pushWorks = push === 'ok' || devices > 0;
  const settings = await saveNotifySettings(ownerId, enabledDefaults(pushWorks));
  return { settings, push, pushWorks };
}

// ── «Не зараз» на аркуші ─────────────────────

const ASKED_KEY = 'wl.v2.notifyAsked';

export function readNotifyAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeNotifyAsked() {
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // Приватний режим: аркуш просто спитає ще раз.
  }
}
