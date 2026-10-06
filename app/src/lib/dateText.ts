/**
 * Дата, вписана з клавіатури, — «ДД.ММ.РРРР» (DateFieldV2). Назовні
 * застосунку — завжди `YYYY-MM-DD`, як у рідного `<input type="date">`.
 */

/** «20.12.2026» → «2026-12-20»; неповна чи неіснуюча дата (31.02) — `null`. */
export function dateTextToIso(text: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** «2026-12-20» → «20.12.2026». */
export function isoToDateText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/**
 * Маска під час набору: крапки ставляться самі, «5.3.» стає «05.03.»,
 * вставлене «2026-12-20» перетворюється на «20.12.2026».
 */
export function maskDateText(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return isoToDateText(raw.trim());
  const parts = raw.split(/[^\d]+/);
  const typedSep = parts.length > 1;
  const digits = (
    typedSep
      ? parts.map((p, i) => (i < 2 && i < parts.length - 1 && p.length === 1 ? `0${p}` : p)).join('')
      : raw
  )
    .replace(/\D/g, '')
    .slice(0, 8);
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += `.${digits.slice(2, 4)}`;
  if (digits.length > 4) out += `.${digits.slice(4)}`;
  // Крапку, яку людина поставила сама, не ковтаємо — інакше її не видно до наступної цифри.
  if (typedSep && /[^\d]$/.test(raw) && (digits.length === 2 || digits.length === 4)) out += '.';
  return out;
}
