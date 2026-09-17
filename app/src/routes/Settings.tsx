import { useAuth } from '../lib/auth';
import { useI18n, LOCALES } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { promptInstall, useInstallState } from '../lib/install';
import type { Theme } from '../lib/theme';

const LOCALE_LABEL: Record<string, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };

export default function Settings() {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const { session } = useAuth();
  const install = useInstallState();

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

      <div className="settings-group" data-testid="install">
        <h2 style={{ fontSize: 'var(--t-lg)' }}>{t('pwa.installTitle')}</h2>
        {install === 'installed' && <p className="small">{t('pwa.installed')}</p>}
        {install === 'prompt' && (
          <>
            <p className="small">{t('pwa.installHint')}</p>
            <button type="button" className="btn" onClick={() => void promptInstall()}>
              {t('pwa.installButton')}
            </button>
          </>
        )}
        {install === 'ios' && <p className="small">{t('pwa.installIos')}</p>}
        {install === 'manual' && <p className="small">{t('pwa.installManual')}</p>}
      </div>

      <div className="settings-group">
        <h2 style={{ fontSize: 'var(--t-lg)' }}>{t('settings.account')}</h2>
        <p className="small">{t('settings.signedInAs', { email: session?.user.email ?? '—' })}</p>
      </div>
    </div>
  );
}
