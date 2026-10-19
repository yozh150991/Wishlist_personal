/**
 * Картка гостьового посилання для ботів месенджерів (потік W2, ADR-060).
 *
 * vercel.json переписує сюди `/l/{токен}…` і `/s/{токен}…` лише для
 * user-agent ботів, що будують картки (`CARD_BOTS` у `src/lib/shareCard.ts`);
 * людям ці адреси й далі віддають застосунок. Токен приходить параметром `t`,
 * префікс — `p`. Ключ гостя сюди не передається.
 *
 * Дані — `get_share_card` (лише назва посилання, дата, мова власника)
 * публічним ключем, як у браузера гостя. Будь-який збій — загальна картка:
 * людина однаково відкриє посилання, а бот не має бачити, чому.
 *
 * Нічого не пишемо в лог: у запиті — токен посилання (CLAUDE.md §3.5).
 */
import { renderCard, tokenFromPath } from '../src/lib/shareCard';
import type { CardData } from '../src/lib/shareCard';

export const config = { runtime: 'edge' };

/** Скільки чекати базу: картка, що не прийшла вчасно, гірша за загальну. */
const DB_TIMEOUT_MS = 2500;

export async function fetchCard(
  token: string,
  env: { url?: string; key?: string },
  fetcher: typeof fetch = fetch,
): Promise<CardData | null> {
  if (!env.url || !env.key) return null;
  try {
    const res = await fetcher(`${env.url.replace(/\/+$/, '')}/rest/v1/rpc/get_share_card`, {
      method: 'POST',
      headers: { apikey: env.key, 'content-type': 'application/json' },
      body: JSON.stringify({ p_token: token }),
      signal: AbortSignal.timeout(DB_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CardData | null;
    return data && typeof data.title === 'string' ? data : null;
  } catch {
    return null;
  }
}

export async function handleCard(
  req: Request,
  env: { url?: string; key?: string },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get('t');
  const prefix = url.searchParams.get('p') === 's' ? 's' : 'l';
  const parsed = fromQuery
    ? tokenFromPath(`/${prefix}/${fromQuery}`)
    : tokenFromPath(url.pathname);

  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    // Хвилина в кеші Vercel: відкликане посилання недовго лишається з назвою.
    'cache-control': 'public, max-age=0, s-maxage=60',
  };
  if (!parsed) {
    return new Response(renderCard(null, { origin: url.origin, prefix, token: '' }), { status: 200, headers });
  }
  const data = await fetchCard(parsed.token, env, fetcher);
  const html = renderCard(data, { origin: url.origin, prefix: parsed.prefix, token: parsed.token });
  return new Response(html, { status: 200, headers });
}

export default function handler(req: Request): Promise<Response> {
  return handleCard(req, {
    url: process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL,
    key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY,
  });
}
