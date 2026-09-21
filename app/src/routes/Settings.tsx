import { useAuth } from '../lib/auth';
import { useI18n, LOCALES } from '../lib/i18n';
import { useTheme, SCHEMES, THEMES } from '../lib/theme';
import { promptInstall, useInstallState } from '../lib/install';
import { pendingCount } from '../lib/outbox';
import type { Scheme, Theme } from '../lib/theme';

const LOCALE_LABEL: Record<string, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };

/**
 * Кружечок кольору поруч із назвою схеми — єдине місце в застосунку, де колір
 * показується як колір, а не як роль. Бере акцент **тієї** схеми, а не
 * активної, тому читається з токена сусідньої палітри через data-атрибут:
 * інакше всі три кружечки були б однакові.
 */
function SchemeDot({ scheme }: { scheme: Scheme }) {
  return <span className="scheme-dot" data-scheme-dot={scheme} aria-hidden="true" />;
}

export default function Settings() {
  const { t, locale, setLocale } = useI18n();
  const { theme, scheme, setTheme, setScheme, suggestsContrast } = useTheme();
  const { session, signOut } = useAuth();
  const install = useInstallState();

  const themeLabel: Record<Theme, string> = {
    light: t('settings.themeLight'),
    dark: t('settings.themeDark'),
    system: t('settings.themeSystem'),
  };

  async function leave() {
    const waiting = session?.user.id ? await pendingCount(session.user.id) : 0;
    if (waiting > 0 && !window.confirm(t('outbox.confirmSignOut', { n: waiting }))) return;
    await signOut();
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t('settings.title')}</h1>
      </div>

      <div className="settings">
        {/* Кольори стоять першими й окремо від Теми: це дві незалежні осі,
            і зліплені в один список із шести пунктів вони б лише заплутали. */}
        <section className="settings__card">
          <h2 className="settings__label">{t('settings.colors')}</h2>
          <div className="settings__row" role="radiogroup" aria-label={t('settings.colors')}>
            {SCHEMES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scheme === s}
                className={scheme === s ? 'btn btn--primary' : 'btn btn--secondary'}
                onClick={() => setScheme(s)}
              >
                <SchemeDot scheme={s} />
                {t(`settings.scheme.${s}`)}
              </button>
            ))}
          </div>
          <p className="small muted">{t('settings.schemeHint')}</p>
          {/* Системі вже сказали, що потрібен посилений контраст. Пропонуємо
              Вугіль, але не вмикаємо за людину: це її екран. */}
          {suggestsContrast && (
            <p className="small" role="status">
              {t('settings.contrastSuggestion')}{' '}
              <button type="button" className="btn btn--ghost btn--compact" onClick={() => setScheme('vuhil')}>
                {t('settings.scheme.vuhil')}
              </button>
            </p>
          )}
        </section>

        <section className="settings__card">
          <h2 className="settings__label">{t('settings.theme')}</h2>
          <div className="settings__row" role="radiogroup" aria-label={t('settings.theme')}>
            {THEMES.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={theme === v}
                className={theme === v ? 'btn btn--primary' : 'btn btn--secondary'}
                onClick={() => setTheme(v)}
              >
                {themeLabel[v]}
              </button>
            ))}
          </div>
        </section>

        <section className="settings__card">
          <h2 className="settings__label">{t('settings.language')}</h2>
          <div className="settings__row" role="radiogroup" aria-label={t('settings.language')}>
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={locale === l}
                className={locale === l ? 'btn btn--primary' : 'btn btn--secondary'}
                onClick={() => setLocale(l)}
              >
                {LOCALE_LABEL[l]}
              </button>
            ))}
          </div>
        </section>

        <section className="settings__card" data-testid="install">
          <h2 className="settings__label">{t('pwa.installTitle')}</h2>
          {install === 'installed' && <p className="small muted">{t('pwa.installed')}</p>}
          {install === 'prompt' && (
            <>
              <p className="small muted">{t('pwa.installHint')}</p>
              <button type="button" className="btn btn--primary" onClick={() => void promptInstall()}>
                {t('pwa.installButton')}
              </button>
            </>
          )}
          {install === 'ios' && <p className="small muted">{t('pwa.installIos')}</p>}
          {install === 'manual' && <p className="small muted">{t('pwa.installManual')}</p>}
        </section>

        <section className="settings__card settings__card--wide">
          <h2 className="settings__label">{t('settings.account')}</h2>
          <p>{t('settings.signedInAs', { email: session?.user.email ?? '—' })}</p>
          <div className="settings__row">
            <button type="button" className="btn btn--secondary" onClick={() => void leave()}>
              {t('nav.signOut')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
