import { useAuth } from '../lib/auth';
import { useI18n, LOCALES } from '../lib/i18n';
import { useTheme, DESIGNS, SCHEMES, THEMES } from '../lib/theme';
import { promptInstall, useInstallState } from '../lib/install';
import { InstallQr } from '../components/InstallQr';
import { pendingCount } from '../lib/outbox';
import type { Design, Scheme, Theme } from '../lib/theme';
import { Switch } from '../components/Switch';

const LOCALE_LABEL: Record<string, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };

/**
 * Зразок схеми — пара «полотно + акцент» — єдине місце в застосунку, де колір
 * показується як колір, а не як роль. Бере кольори **тієї** схеми, а не
 * активної, тому читає окремі токени зразків через data-атрибут: інакше всі
 * пʼять кружечків були б однакові.
 */
function SchemeSwatch({ scheme }: { scheme: Scheme }) {
  return <span className="scheme-swatch" data-scheme-dot={scheme} aria-hidden="true" />;
}

export default function Settings() {
  const { t, locale, setLocale } = useI18n();
  const {
    theme,
    scheme,
    design,
    highContrast,
    systemContrast,
    setTheme,
    chooseScheme,
    setHighContrast,
    setDesign,
  } = useTheme();
  const contrastOn = highContrast || systemContrast;
  const { session, signOut } = useAuth();
  const install = useInstallState();

  const themeLabel: Record<Theme, string> = {
    light: t('settings.themeLight'),
    dark: t('settings.themeDark'),
    system: t('settings.themeSystem'),
  };

  const designLabel: Record<Design, string> = {
    v1: t('settings.design.v1'),
    v2: t('settings.design.v2'),
  };

  /**
   * Версії мають власні таблиці маршрутів, і адреси в них не зобовʼязані
   * збігатися: у v2 інший флоу, а не перефарбовані ті самі екрани. Тому
   * перемикання — це перехід на корінь із повним перезавантаженням, а не
   * підміна дерева під ногами на сторінці, якої в іншій версії може не бути.
   * Заразом інлайновий скрипт у `<head>` ставить атрибути заново (ADR-032).
   */
  function switchDesign(next: Design) {
    if (next === design) return;
    setDesign(next);
    window.location.assign('/');
  }

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
        {/* Дизайн стоїть перед кольорами й темою, бо він над ними: версія
            задає форму інтерфейсу, а вже всередині неї працюють усі три
            схеми й обидві теми (ADR-032). */}
        <section className="settings__card" data-testid="design">
          <h2 className="settings__label" id="set-design">
            {t('settings.design.title')}
          </h2>
          <div className="settings__row" role="radiogroup" aria-labelledby="set-design">
            {DESIGNS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={design === d}
                className={design === d ? 'btn btn--primary' : 'btn btn--secondary'}
                onClick={() => switchDesign(d)}
              >
                {designLabel[d]}
              </button>
            ))}
          </div>
          <p className="small muted">{t('settings.designHint')}</p>
        </section>

        {/* Доступність стоїть над кольорами, бо важливіша за смак: тумблер
            вмикає Вугіль і забороняє будь-якому оформленню його змінювати.
            Вугля в переліку схем немає — у нього один вхід, цей (ADR-033). */}
        <section className="settings__card settings__card--a11y" data-testid="a11y">
          <h2 className="settings__label" id="set-a11y">
            {t('settings.a11y')}
          </h2>
          <Switch
            checked={contrastOn}
            disabled={systemContrast}
            onChange={(on) => setHighContrast(on)}
            label={t('settings.highContrast')}
            hint={systemContrast ? t('settings.highContrastSystem') : t('settings.highContrastHint')}
          />
        </section>

        {/* Кольори окремо від Теми: це дві незалежні осі, і зліплені в один
            список вони б лише заплутали. */}
        <section className="settings__card">
          <h2 className="settings__label" id="set-colors">
            {t('settings.colors')}
          </h2>
          {/* aria-labelledby, а не aria-label: інакше зчитувач екрана читає
              «Кольори» двічі — як заголовок і як назву групи. */}
          <div className="scheme-grid" role="radiogroup" aria-labelledby="set-colors">
            {SCHEMES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scheme === s}
                className="scheme-tile"
                onClick={() => chooseScheme(s)}
              >
                <SchemeSwatch scheme={s} />
                <span className="scheme-tile__name">{t(`settings.scheme.${s}`)}</span>
              </button>
            ))}
          </div>
          {/* Смак не зникає, поки діє контраст: тумблер не перезаписує схему,
              і людина має знати, що її вибір просто чекає. */}
          {contrastOn && (
            <p className="small muted" role="status">
              {t('settings.schemeLocked')}
            </p>
          )}
          {!contrastOn && scheme === 'nich' && <p className="small muted">{t('settings.nichHint')}</p>}
        </section>

        <section className="settings__card">
          <h2 className="settings__label" id="set-theme">
            {t('settings.theme')}
          </h2>
          <div className="settings__row" role="radiogroup" aria-labelledby="set-theme">
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
          <h2 className="settings__label" id="set-language">
            {t('settings.language')}
          </h2>
          <div className="settings__row" role="radiogroup" aria-labelledby="set-language">
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
          {/* На десктопі ставити застосунок зазвичай хочуть не сюди, а на
              телефон — тож поряд лежить QR з адресою. */}
          {install !== 'installed' && <InstallQr />}
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
