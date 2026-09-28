import { useRef, useState } from 'react';
import { useAuth } from '../../../lib/auth';
import { useI18n, LOCALES } from '../../../lib/i18n';
import type { Locale } from '../../../lib/i18n';
import { SCHEMES, THEMES, useTheme } from '../../../lib/theme';
import type { Design, Scheme, Theme } from '../../../lib/theme';
import { promptInstall, useInstallState } from '../../../lib/install';
import { useMediaQuery } from '../../../lib/media';
import { errorText } from '../../../lib/errors';
import { fetchAllItems, fetchLists } from '../../../lib/db';
import { fetchSharesOverview } from '../../../lib/shares';
import { toAccountJson } from '../../../lib/transfer';
import { downloadText } from '../../../lib/download';
import { DESKTOP } from '../ShellV2';
import { NoteV2 } from './AuthPartsV2';
import { SignOutV2, SwitchV2 } from './CommonV2';

const LANGUAGE: Record<Locale, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };

/** Радіо-пігулки — справжні `<input type="radio">`: клавіатура й зчитувач без коду. */
function Choice<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  testId,
}: {
  name: string;
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testId?: string;
}) {
  return (
    <fieldset className="v2-seg" data-testid={testId}>
      <legend className="v2-settings__label">{legend}</legend>
      <div className="v2-seg__row">
        {options.map((o) => (
          <label key={o.value} className="v2-seg__opt">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Налаштування v2 (потік I; README, розділ 6).
 *
 * Кожен вибір застосовується одразу — кнопки «Зберегти» немає. Порядок:
 * акаунт → доступність (висока контрастність над кольорами, бо важливіша за
 * смак) → кольори → тема → мова → застосунок на телефоні → мої дані → вигляд
 * застосунку → вихід. Тема, схема й контраст їдуть у профіль (`AppearanceSync`)
 * — для обох версій однаково; вигляд події — властивість окремого списку,
 * тут його немає (ADR-034).
 *
 * На десктопі — дві колонки карток, не на всю ширину.
 */
export default function SettingsV2() {
  const { t, locale, setLocale } = useI18n();
  const { session } = useAuth();
  const { theme, scheme, highContrast, systemContrast, design, setTheme, chooseScheme, setHighContrast, setDesign } =
    useTheme();
  const install = useInstallState();
  const desktop = useMediaQuery(DESKTOP);
  const email = session?.user.email ?? '';
  const contrastOn = highContrast || systemContrast;

  const schemeLabel = (s: Scheme) => {
    switch (s) {
      case 'slyva':
        return t('settings.scheme.slyva');
      case 'polotno':
        return t('settings.scheme.polotno');
      case 'cytrus':
        return t('settings.scheme.cytrus');
      case 'nich':
        return t('settings.scheme.nich');
      default:
        return t('settings.scheme.sage');
    }
  };
  const themeLabel = (v: Theme) =>
    v === 'light' ? t('settings.themeLight') : v === 'dark' ? t('settings.themeDark') : t('settings.themeSystem');

  /**
   * Інша версія — інша таблиця маршрутів, і адреси в них не зобовʼязані
   * збігатися. Тож перемикання — на корінь із перезавантаженням (ADR-032).
   */
  function switchDesign(next: Design) {
    if (next === design) return;
    setDesign(next);
    window.location.assign('/');
  }

  return (
    <main className="v2-page">
      <h1 className="v2-page__title">{t('settings.title')}</h1>

      <div className="v2-settings">
        <section className="v2-settings__card v2-settings__card--wide" aria-labelledby="v2-set-account">
          <h2 className="v2-sr" id="v2-set-account">
            {t('settings.account')}
          </h2>
          <div className="v2-profile">
            <span className="v2-profile__avatar" aria-hidden="true">
              {email.slice(0, 1).toUpperCase()}
            </span>
            <span className="v2-profile__email">{email}</span>
          </div>
        </section>

        <section className="v2-settings__card v2-settings__card--a11y" aria-labelledby="v2-set-a11y">
          <h2 className="v2-settings__label" id="v2-set-a11y">
            {t('settings.a11y')}
          </h2>
          <SwitchV2
            label={t('settings.highContrast')}
            hint={systemContrast ? t('settings.highContrastSystem') : t('settings.highContrastHint')}
            checked={contrastOn}
            disabled={systemContrast}
            onChange={setHighContrast}
          />
        </section>

        <section className="v2-settings__card" aria-labelledby="v2-set-colors">
          <fieldset className="v2-seg">
            <legend className="v2-settings__label" id="v2-set-colors">
              {t('settings.colors')}
            </legend>
            <div className="v2-schemes">
              {SCHEMES.map((s) => (
                <label key={s} className="v2-scheme" data-on={scheme === s || undefined}>
                  <input type="radio" name="v2-scheme" value={s} checked={scheme === s} onChange={() => chooseScheme(s)} />
                  <span className="v2-scheme__dot" data-dot={s} aria-hidden="true" />
                  <span className="v2-scheme__name">{schemeLabel(s)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {/* Смак не зникає, поки діє контраст: вибір просто чекає. */}
          {contrastOn && (
            <p className="v2-hint v2-hint--start" role="status">
              {t('settings.schemeLocked')}
            </p>
          )}
          {!contrastOn && scheme === 'nich' && <p className="v2-hint v2-hint--start">{t('settings.nichHint')}</p>}
          <p className="v2-hint v2-hint--start">{t('v2settings.looksHint')}</p>
        </section>

        <section className="v2-settings__card">
          <Choice
            name="v2-theme"
            legend={t('settings.theme')}
            options={THEMES.map((v) => ({ value: v, label: themeLabel(v) }))}
            value={theme}
            onChange={setTheme}
          />
        </section>

        <section className="v2-settings__card">
          <Choice
            name="v2-language"
            legend={t('settings.language')}
            options={LOCALES.map((l) => ({ value: l, label: LANGUAGE[l] }))}
            value={locale}
            onChange={setLocale}
          />
        </section>

        <section className="v2-settings__card" aria-labelledby="v2-set-install" data-testid="install">
          <h2 className="v2-settings__label" id="v2-set-install">
            {t('pwa.installTitle')}
          </h2>
          {install === 'installed' && <p className="v2-hint v2-hint--start">{t('pwa.installed')}</p>}
          {install === 'prompt' && !desktop && (
            <>
              <p className="v2-hint v2-hint--start">{t('pwa.installHint')}</p>
              <button type="button" className="v2-btn v2-btn--primary v2-btn--start" onClick={() => void promptInstall()}>
                {t('pwa.installButton')}
              </button>
            </>
          )}
          {install === 'ios' && <p className="v2-hint v2-hint--start">{t('pwa.installIos')}</p>}
          {install === 'manual' && !desktop && <p className="v2-hint v2-hint--start">{t('pwa.installManual')}</p>}
          {/* На десктопі ставити нікуди — туди ж переносить QR (README, розділ 6). */}
          {install !== 'installed' && desktop && <QrV2 />}
        </section>

        <MyDataV2 />

        <section className="v2-settings__card" aria-labelledby="v2-set-design">
          <h2 className="v2-sr" id="v2-set-design">
            {t('settings.design.title')}
          </h2>
          <Choice
            name="v2-design"
            legend={t('settings.design.title')}
            options={[
              { value: 'v1' as Design, label: t('settings.design.v1') },
              { value: 'v2' as Design, label: t('settings.design.v2') },
            ]}
            value={design}
            onChange={switchDesign}
            testId="design"
          />
          <p className="v2-hint v2-hint--start">{t('settings.designHint')}</p>
        </section>

        <section className="v2-settings__card v2-settings__card--wide" aria-labelledby="v2-set-out">
          <h2 className="v2-settings__label" id="v2-set-out">
            {t('settings.account')}
          </h2>
          {/* Пошта вже у верхній картці профілю — тут лише дії з акаунтом. */}
          <SignOutV2 className="v2-btn v2-btn--outline v2-btn--start" />
          <p className="v2-hint v2-hint--start">{t('v2settings.deleteLater')}</p>
        </section>
      </div>
    </main>
  );
}

/**
 * QR з адресою застосунку — для десктопа: ставити застосунок хочуть на
 * телефон, а він в іншій руці. Бібліотека тягнеться ліниво й не входить у
 * кеш офлайн-оболонки (`globIgnores` у `vite.config.ts`).
 */
function QrV2() {
  const { t } = useI18n();
  const [svg, setSvg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function show() {
    if (busy || svg) return;
    setBusy(true);
    try {
      const { default: qrcode } = await import('qrcode-generator');
      const qr = qrcode(0, 'M');
      qr.addData(window.location.origin);
      qr.make();
      setSvg(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v2-qr">
      <p className="v2-hint v2-hint--start">{t('pwa.qrHint')}</p>
      {svg ? (
        <>
          {/* SVG бібліотека будує з нашої ж адреси, не з даних людини. Картинка
              декоративна: адреса нижче текстом, її й читає зчитувач екрана. */}
          <div className="v2-qr__code" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
          <code className="v2-qr__url">{window.location.origin}</code>
        </>
      ) : (
        <button type="button" className="v2-btn v2-btn--outline v2-btn--start" onClick={() => void show()}>
          {busy && <span className="v2-spinner" aria-hidden="true" />}
          {t('pwa.qrShow')}
        </button>
      )}
    </div>
  );
}

/**
 * «Мої дані» (потік I3): усі списки з позиціями й опис посилань одним файлом
 * (`toAccountJson`). Кнопка не гасне мовчки — «Експортую… 3 з 12», і
 * скасувати можна з першої секунди. Адрес посилань і позначок у файлі немає.
 */
function MyDataV2() {
  const { t } = useI18n();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** Номер запуску: «Скасувати» його міняє, і старий запуск тихо згасає. */
  const runId = useRef(0);

  async function run() {
    if (progress) return;
    const mine = ++runId.current;
    const cancelled = { get current() { return runId.current !== mine; } };
    setError(null);
    setSaved(false);
    setProgress({ done: 0, total: 0 });
    try {
      const lists = await fetchLists();
      setProgress({ done: 0, total: lists.length });
      const out: { list: (typeof lists)[number]; items: Awaited<ReturnType<typeof fetchAllItems>> }[] = [];
      for (const list of lists) {
        if (cancelled.current) return;
        const items = await fetchAllItems(list.id);
        out.push({ list, items });
        setProgress({ done: out.length, total: lists.length });
      }
      if (cancelled.current) return;
      const titles = new Map(lists.map((l) => [l.id, l.title]));
      const shares = (await fetchSharesOverview()).map((s) => ({
        title: s.title,
        list_title: s.list_title ?? titles.get(s.source_list_id) ?? null,
        created_at: s.created_at,
        expires_at: s.expires_at,
        revoked_at: s.revoked_at,
        view_count: s.view_count ?? 0,
        items_count: s.share_items[0]?.count ?? 0,
      }));
      if (cancelled.current) return;
      const day = new Date().toISOString().slice(0, 10);
      downloadText(`wishlist-${day}.json`, toAccountJson(out, shares), 'application/json');
      setSaved(true);
    } catch (e) {
      if (!cancelled.current) setError(errorText(e, t));
    } finally {
      if (!cancelled.current) setProgress(null);
    }
  }

  return (
    <section className="v2-settings__card" aria-labelledby="v2-set-data">
      <h2 className="v2-settings__label" id="v2-set-data">
        {t('v2settings.data.title')}
      </h2>
      <p className="v2-hint v2-hint--start">{t('v2settings.data.body')}</p>
      {error && <NoteV2 tone="error">{error}</NoteV2>}
      {saved && <NoteV2 tone="info">{t('v2settings.data.saved')}</NoteV2>}
      <div className="v2-settings__row">
        <button
          type="button"
          className="v2-btn v2-btn--outline"
          aria-disabled={Boolean(progress) || undefined}
          data-busy={Boolean(progress) || undefined}
          onClick={() => void run()}
        >
          {progress && <span className="v2-spinner" aria-hidden="true" />}
          {progress
            ? progress.total
              ? t('v2settings.data.progress', { n: progress.done, m: progress.total })
              : t('v2settings.data.starting')
            : t('v2settings.data.cta')}
        </button>
        {progress && (
          <button
            type="button"
            className="v2-btn v2-btn--ghost"
            onClick={() => {
              runId.current++;
              setProgress(null);
            }}
          >
            {t('v2settings.data.cancel')}
          </button>
        )}
      </div>
    </section>
  );
}
