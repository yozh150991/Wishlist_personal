import { supabase, publicOrigin } from './supabase';
import type { Design } from './theme';

/**
 * Кроки автентифікації, спільні для обох версій дизайну (ADR-039, ADR-042).
 *
 * Екрани входу в v1 і v2 різні, а листи, адреси повернення й Google — ті
 * самі: шаблони листів Supabase одні на проєкт, Redirect URLs теж. Тому все,
 * що не розмітка, живе тут.
 *
 * Кодів із пошти немає (ADR-042): у листах акаунта лише посилання —
 * підтвердження пошти й скидання пароля.
 */

/**
 * Адреса повернення з листа чи з Google.
 *
 * Несе `?design=` — інлайновий скрипт у `<head>` читає його до першого
 * рендера, тож лист, відкритий на іншому пристрої, потрапляє в ту версію, з
 * якої його замовили (ADR-039, п. 5). Параметр не заважає PKCE: Supabase
 * дописує свій `code` поруч, а скрипт знімає лише `design`.
 *
 * Redirect URLs проєкту Supabase мають пускати адреси з параметрами —
 * шаблон `https://<адреса>/**` це робить (DEPLOY.md, розділ 4).
 */
export function authReturn(
  path: string,
  design: Design,
  opts: { next?: string; from?: 'confirm' } = {},
): string {
  const url = new URL(path, publicOrigin);
  url.searchParams.set('design', design);
  if (opts.next && opts.next !== '/lists') url.searchParams.set('next', opts.next);
  // Звідки людина прийшла: екран входу v2 каже «пошту підтверджено», якщо
  // сесія з посилання не створилась (інший браузер, PKCE — DEPLOY.md).
  if (opts.from) url.searchParams.set('from', opts.from);
  return url.toString();
}

/**
 * Вхід через Google. Вмикається змінною `VITE_AUTH_GOOGLE=1` — лише коли
 * провайдер налаштований у Supabase (DEPLOY.md): кнопка, що веде на помилку
 * «provider is not enabled», гірша за відсутню.
 */
export const googleEnabled = import.meta.env.VITE_AUTH_GOOGLE === '1';

export async function signInWithGoogle(design: Design, next?: string) {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: authReturn('/login', design, { next }) },
  });
}

/**
 * Що Supabase дописав до адреси повернення, якщо щось пішло не так.
 *
 * `cancelled` — людина закрила вікно Google: це її рішення, а не збій, тож
 * екран повертається без червоного (потік Q). `expired` — посилання з листа
 * протерміноване, вже використане або відкрите не в тому браузері (PKCE).
 * `failed` — усе інше.
 *
 * Параметри бувають і в `?…`, і в `#…` — залежно від потоку, тож читаємо
 * обидва місця.
 */
export type RedirectError = 'cancelled' | 'expired' | 'failed';

const EXPIRED = new Set(['otp_expired', 'flow_state_expired', 'flow_state_not_found', 'bad_code_verifier']);

export function readRedirectError(search: string, hash: string): RedirectError | null {
  const q = new URLSearchParams(search);
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  const error = q.get('error') ?? h.get('error');
  const code = q.get('error_code') ?? h.get('error_code');
  if (!error && !code) return null;
  if (code && EXPIRED.has(code)) return 'expired';
  if (error === 'access_denied') return 'cancelled';
  return 'failed';
}

/** Адреса без параметрів помилки — щоб повідомлення не поверталось після F5. */
export function withoutRedirectError(pathname: string, search: string): string {
  const q = new URLSearchParams(search);
  for (const k of ['error', 'error_code', 'error_description', 'from']) q.delete(k);
  const rest = q.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

/**
 * Пошта, яку людина щойно вводила, — щоб підставити її на наступному кроці
 * (скидання пароля, повторний лист), навіть якщо посилання з листа відкрило
 * нову вкладку. Живе лише на цьому пристрої й стирається після входу.
 */
const EMAIL_KEY = 'wl.authEmail';

export function rememberAuthEmail(email: string) {
  try {
    if (email.trim()) localStorage.setItem(EMAIL_KEY, email.trim());
  } catch {
    /* приватний режим — просто не підставимо */
  }
}

export function recallAuthEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function forgetAuthEmail() {
  try {
    localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* нічого не було */
  }
}

/**
 * «Відкрити пошту» — лише для відомих поштових сервісів. Для решти кнопки
 * немає: `mailto:` відкрив би новий лист, а не вхідні.
 */
const MAILBOXES: Record<string, string> = {
  'gmail.com': 'https://mail.google.com/',
  'googlemail.com': 'https://mail.google.com/',
  'ukr.net': 'https://mail.ukr.net/',
  'i.ua': 'https://mail.i.ua/',
  'meta.ua': 'https://webmail.meta.ua/',
  'outlook.com': 'https://outlook.live.com/mail/',
  'hotmail.com': 'https://outlook.live.com/mail/',
  'live.com': 'https://outlook.live.com/mail/',
  'yahoo.com': 'https://mail.yahoo.com/',
  'icloud.com': 'https://www.icloud.com/mail/',
  'proton.me': 'https://mail.proton.me/',
  'protonmail.com': 'https://mail.proton.me/',
  'wp.pl': 'https://poczta.wp.pl/',
  'o2.pl': 'https://poczta.o2.pl/',
  'onet.pl': 'https://poczta.onet.pl/',
  'interia.pl': 'https://poczta.interia.pl/',
  'gazeta.pl': 'https://poczta.gazeta.pl/',
};

export function mailboxUrl(email: string): string | null {
  const domain = email.trim().toLowerCase().split('@')[1];
  return (domain && MAILBOXES[domain]) || null;
}

/**
 * Посилання на цей самий екран в іншій версії дизайну. Повне перезавантаження
 * через `?design=` — той самий механізм, що й аварійний вихід (ADR-032):
 * параметр читає скрипт у `<head>`, решта параметрів (`next`) лишається.
 */
export function designSwitchHref(pathname: string, search: string, target: Design): string {
  const q = new URLSearchParams(search);
  q.set('design', target);
  return `${pathname}?${q.toString()}`;
}

/** Найпростіша перевірка форми адреси — те, що можна сказати людині до запиту. */
export type EmailProblem = 'empty' | 'noAt' | 'incomplete';

export function emailProblem(email: string): EmailProblem | null {
  const e = email.trim();
  if (!e) return 'empty';
  if (!e.includes('@')) return 'noAt';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'incomplete';
  return null;
}
