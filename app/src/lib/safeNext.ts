/**
 * Returns a same-origin path to go to after sign-in, or the fallback.
 *
 * `next` comes from the address bar, so anyone can craft it. React Router
 * cannot leave the site, but a bad value still produced a 404 page, and a
 * future switch to `window.location` would turn it into an open redirect.
 *
 * The check resolves the value against a fixed dummy origin with the WHATWG
 * URL parser — the same one the browser uses. That covers every trick that
 * turns a "path" into another host: `//evil.com`, `/\evil.com`, tabs and
 * newlines that browsers strip, `https:` and `javascript:` schemes.
 * Hand-written prefix checks tend to miss at least one of them.
 */
const BASE = 'https://app.invalid';

export function safeNext(raw: string | null, fallback = '/lists'): string {
  if (!raw || !raw.startsWith('/')) return fallback;

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }

  if (url.origin !== BASE) return fallback;
  return url.pathname + url.search + url.hash;
}
