import { formatDeadline, isTimeZone } from './format';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Часовий пояс власника для терміну посилання (ADR-037).
 *
 * Зона — з браузера власника в момент створення посилання: так само, як
 * «сьогодні» для нього рахує календар телефона. Окремого налаштування зони
 * немає — людина, що переїхала, отримає нову зону з новим пристроєм чи
 * системними налаштуваннями, а старі посилання лишаться у своїй.
 */
export function deviceTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/**
 * «за Києвом» — назва міста у відмінку, якого Intl не дає: він уміє лише
 * «за східноєвропейським часом» чи «czas wschodnioeuropejski». Для міст, де
 * живе більшість власників, — власні рядки; решта зон — назва від браузера в
 * дужках, щоб відмінок не мав значення.
 */
function cityPhrase(tz: string, t: Translate): string | null {
  switch (tz) {
    case 'Europe/Kyiv':
    case 'Europe/Kiev':
      return t('zone.kyiv');
    case 'Europe/Warsaw':
      return t('zone.warsaw');
    case 'Europe/Berlin':
      return t('zone.berlin');
    case 'Europe/Prague':
      return t('zone.prague');
    case 'Europe/London':
      return t('zone.london');
    default:
      return null;
  }
}

/**
 * Рядок для гостя: «Діє до 20 грудня, 23:59 за Києвом». Час — за годинником
 * власника, бо саме тоді посилання згасне для всіх, де б гість не був.
 */
export function validUntilText(
  expiresAt: string | null,
  tz: string | null,
  locale: string,
  t: Translate,
): string | null {
  const d = formatDeadline(expiresAt, tz, locale);
  if (!d) return null;
  if (!d.tz) return t('guest.validUntil', { date: d.day });
  const city = cityPhrase(d.tz, t);
  if (city) return t('guest.validUntilCity', { date: d.day, time: d.time, zone: city });
  if (d.zoneName) return t('guest.validUntilZone', { date: d.day, time: d.time, zone: d.zoneName });
  return t('guest.validUntil', { date: d.day });
}
