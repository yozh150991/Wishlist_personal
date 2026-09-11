import { useAuth } from '../lib/auth';
import { useI18n, LOCALES } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import type { Theme } from '../lib/theme';

const LOCALE_LABEL: Record<string, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };

export default function Settings() {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const { session } = useAuth();

  const themes: { value: Theme; label: string }[] = [
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'system', label: t('settings.themeSystem') },
  ];

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t('settings.title')}</h1>
      </div>

      <div className="settings-group">
        <h2 style={{ fontSize: 'var(--t-lg)' }}>{t('settings.theme')}</h2>
        <div className="picker">
          {themes.map((o) => (
            <button
              key={o.value}
              aria-pressed={theme === o.value}
              onClick={() => setTheme(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <h2 style={{ fontSize: 'var(--t-lg)' }}>{t('settings.language')}</h2>
        <div className="picker">
          {LOCALES.map((l) => (
            <button key={l} aria-pressed={locale === l} onClick={() => setLocale(l)}>
              {LOCALE_LABEL[l]}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <h2 style={{ fontSize: 'var(--t-lg)' }}>{t('settings.account')}</h2>
        <p className="small">{t('settings.signedInAs', { email: session?.user.email ?? '—' })}</p>
      </div>
    </div>
  );
}
