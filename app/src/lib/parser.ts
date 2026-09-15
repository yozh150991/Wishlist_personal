import { supabase } from './supabase';

export type Parsed = {
  url: string;
  title: string | null;
  price: number | null;
  currency: string | null;
  image_url: string | null;
  site_name: string | null;
  confidence: Record<string, string>;
  partial: boolean;
};

/** Ключ словника для помилки парсера — щоб текст лишався перекладним. */
export class ParseError extends Error {
  constructor(public key: string) {
    super(key);
  }
}

const CODES: Record<string, string> = {
  // Помилки автентифікації й конфігурації — без них 401/503 показувались
  // як загальне «не вдалося прочитати сторінку», що нічого не пояснює.
  missing_token: 'parser.errors.notSignedIn',
  invalid_token: 'parser.errors.notSignedIn',
  auth_unavailable: 'parser.errors.authUnavailable',
  supabase_not_configured: 'parser.errors.misconfigured',
  invalid_url: 'parser.errors.invalidUrl',
  blocked_host: 'parser.errors.blockedHost',
  too_large: 'parser.errors.tooLarge',
  unsupported_content: 'parser.errors.unsupported',
  rate_limited: 'parser.errors.rateLimited',
  upstream_timeout: 'parser.errors.timeout',
  upstream_forbidden: 'parser.errors.blockedByShop',
  upstream_error: 'parser.errors.upstream',
};

export function parserConfigured(): boolean {
  return Boolean(import.meta.env.VITE_PARSER_URL);
}

export async function parseUrl(url: string, signal?: AbortSignal): Promise<Parsed> {
  const base = import.meta.env.VITE_PARSER_URL;
  if (!base) throw new ParseError('parser.errors.notConfigured');

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ParseError('parser.errors.notSignedIn');

  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
      signal,
    });
  } catch {
    throw new ParseError('parser.errors.unreachable');
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new ParseError(CODES[body?.detail ?? ''] ?? 'parser.errors.unknown');
  }

  return (await res.json()) as Parsed;
}
