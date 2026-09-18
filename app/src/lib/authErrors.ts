import type { AuthError } from '@supabase/supabase-js';

/**
 * Перекладає помилку Supabase у ключ словника.
 * Тексти від сервера англійські й змінюються між версіями,
 * тому спираємось на code/status, а рядок — лише як запасний варіант.
 */
export function authErrorKey(err: AuthError | null): string {
  if (!err) return 'errors.unknown';
  const code = err.code ?? '';
  const msg = err.message.toLowerCase();

  // Спершу мережа: збій fetch клієнт загортає в AuthRetryableFetchError, і його
  // текст («failed to fetch», «timeout») інакше потрапив би під ширші перевірки
  // нижче — зокрема під msg.includes('password').
  if (err.name === 'AuthRetryableFetchError' || isNetworkFailure(msg)) {
    // Пристрій офлайн і сервер, що прийняв зʼєднання й замовк, — різні біди,
    // і порада різна: чекати на мережу чи спробувати ще раз.
    return navigator.onLine === false ? 'errors.offline' : 'errors.noResponse';
  }

  if (code === 'invalid_credentials' || msg.includes('invalid login')) return 'errors.invalidCredentials';
  if (code === 'email_not_confirmed' || msg.includes('not confirmed')) return 'errors.emailNotConfirmed';
  if (code === 'user_already_exists' || msg.includes('already registered')) return 'errors.emailTaken';
  if (code === 'weak_password' || msg.includes('password')) return 'errors.weakPassword';
  if (code === 'over_email_send_rate_limit' || err.status === 429) return 'errors.rateLimited';
  if (code === 'validation_failed') return 'errors.validation';
  return 'errors.unknown';
}

function isNetworkFailure(message: string): boolean {
  return /failed to fetch|networkerror|load failed|network request failed|timeout|aborted/i.test(message);
}
