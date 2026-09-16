import { useI18n, LOCALES } from '../lib/i18n';
import type { Locale } from '../lib/i18n';

const SHORT: Record<Locale, string> = { uk: 'UA', pl: 'PL', en: 'EN' };
// Повна назва кожною власною мовою: зчитувач екрана вимовить її правильно
// завдяки атрибуту lang, а людина впізнає свою мову, навіть не знаючи поточної.
const FULL: Record<Locale, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };

/**
 * Компактний перемикач мови для сторінок без каркаса застосунку:
 * вхід, реєстрація, скидання пароля, гостьове посилання.
 *
 * На сторінках входу й реєстрації він потрібен не лише для зручності:
 * мова, обрана до реєстрації, їде в user_metadata і визначає мову листа
 * підтвердження (ADR-024).
 */
export function LanguagePicker({ className = '' }: { className?: string }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className={`picker ${className}`.trim()} role="group" aria-label={t('settings.language')}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-label={FULL[l]}
          aria-pressed={locale === l}
          onClick={() => setLocale(l)}
        >
          {SHORT[l]}
        </button>
      ))}
    </div>
  );
}
