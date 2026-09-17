type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Помилка → текст для людини.
 *
 * Supabase повертає помилки звичайними обʼєктами з полем message, а не
 * екземплярами Error, тож `String(e)` давав на екрані «[object Object]».
 * Без мережі — окреме зрозуміле повідомлення: у встановленому застосунку
 * оболонка відкривається й офлайн, а дані — ні.
 */
export function errorText(e: unknown, t: Translate): string {
  const message = messageOf(e);
  if (isNetworkFailure(message)) return t('errors.offline');
  return message || t('errors.unknown');
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return typeof e === 'string' ? e : '';
}

function isNetworkFailure(message: string): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  // Chrome, Firefox і Safari формулюють збій мережі у fetch по-різному.
  return /failed to fetch|networkerror|load failed|network request failed/i.test(message);
}
