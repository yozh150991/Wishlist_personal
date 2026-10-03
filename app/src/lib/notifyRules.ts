/**
 * Правила сповіщень власника (ADR-049) без мережі, React і DOM — тож
 * перевіряються тестами без браузера (`tests/e2e/notify-rules.spec.ts`).
 * Дані й push на пристрої — у `notifications.ts`.
 */

export const NOTIFY_KINDS = ['after_event', 'yearly', 'link', 'price', 'share'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
export type NotifyChannel = 'push' | 'email';
export type NotifyFlag = `${NotifyKind}_${NotifyChannel}`;
export type NotifyFlags = Record<NotifyFlag, boolean>;

export type NotifySettings = NotifyFlags & {
  owner_id: string;
  time_zone: string;
  last_sent_at: string | null;
};

/**
 * Події, заради яких пошта вмикається сама, коли push на пристрої неможливий
 * (P, гілка «push заборонено»): щоб важливе не загубилось. Ціна — ні: вона
 * цікава не всім і легко стає шумом, тож усталено вимкнена й для push.
 */
export const IMPORTANT_KINDS: readonly NotifyKind[] = ['after_event', 'yearly', 'link', 'share'];

export function flag(kind: NotifyKind, channel: NotifyChannel): NotifyFlag {
  return `${kind}_${channel}`;
}

/** Усі канали вимкнені — те саме, що рядка немає. */
export function allOff(): NotifyFlags {
  const out = {} as NotifyFlags;
  for (const k of NOTIFY_KINDS) {
    out[flag(k, 'push')] = false;
    out[flag(k, 'email')] = false;
  }
  return out;
}

/**
 * Вибір за замовчуванням у момент «Увімкнути сповіщення»: push для всього,
 * крім ціни; якщо push тут неможливий — пошта для важливого.
 */
export function enabledDefaults(pushWorks: boolean): NotifyFlags {
  const out = allOff();
  for (const k of NOTIFY_KINDS) {
    if (pushWorks) out[flag(k, 'push')] = k !== 'price';
    else out[flag(k, 'email')] = IMPORTANT_KINDS.includes(k);
  }
  return out;
}

export function anyOn(s: Partial<NotifyFlags> | null | undefined): boolean {
  if (!s) return false;
  return NOTIFY_KINDS.some((k) => Boolean(s[flag(k, 'push')]) || Boolean(s[flag(k, 'email')]));
}

export function anyPushOn(s: Partial<NotifyFlags> | null | undefined): boolean {
  return Boolean(s) && NOTIFY_KINDS.some((k) => Boolean(s![flag(k, 'push')]));
}

/** Ключ VAPID із base64url у байти для `applicationServerKey`. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
