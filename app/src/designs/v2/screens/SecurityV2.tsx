import { useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { pendingCount } from '../../../lib/outbox';
import {
  countPushDevices,
  fetchNotifySettings,
  pushSupport,
  saveNotifySettings,
  signInFlags,
} from '../../../lib/notifications';
import type { SignInFlags } from '../../../lib/notifications';
import { NoteV2 } from './AuthPartsV2';
import { SheetV2 } from './CommonV2';

/**
 * «Безпека» в Налаштуваннях (ADR-074). Видно завжди, навіть коли сповіщення
 * вимкнено: лист про вхід із нового пристрою діє типово для всіх.
 *
 * - **Вхід із нового пристрою** — пошта й push. Без рядка налаштувань діє
 *   типове (лист так, push ні); перший натиск створює рядок.
 * - **Зміна пароля** — лист Supabase, не вимикається.
 * - **Змінити пароль** — те саме скидання паролем через пошту, що й на вході.
 * - **Вийти на всіх пристроях** — відкликає всі сесії й прибирає всі push.
 */
export function SecurityCardV2() {
  const { t } = useI18n();
  const { session, signOutEverywhere } = useAuth();
  const { hash } = useLocation();
  const titleId = useId();
  const confirmId = useId();
  const ownerId = session?.user.id ?? '';
  const email = session?.user.email ?? '';
  const [flags, setFlags] = useState<SignInFlags | null>(null);
  const [devices, setDevices] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [busy, setBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const showPush = pushSupport() !== 'no-key';

  useEffect(() => {
    let alive = true;
    Promise.all([fetchNotifySettings(), showPush ? countPushDevices() : Promise.resolve(0)])
      .then(([settings, n]) => {
        if (!alive) return;
        setFlags(signInFlags(settings));
        setDevices(n);
      })
      .catch((e: unknown) => {
        if (alive) setError(errorText(e, t));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // /settings#security — з листа й push «вхід із нового пристрою».
  useEffect(() => {
    if (flags && hash === '#security') document.getElementById('security')?.scrollIntoView({ block: 'start' });
  }, [flags, hash]);

  async function toggle(key: keyof SignInFlags) {
    if (!flags || !ownerId) return;
    const prev = flags;
    const next = { ...prev, [key]: !prev[key] };
    setFlags(next);
    setError(null);
    try {
      setFlags(signInFlags(await saveNotifySettings(ownerId, { [key]: next[key] })));
    } catch (e) {
      setFlags(prev);
      setError(errorText(e, t));
    }
  }

  async function ask() {
    setLeaveError(null);
    setWaiting(ownerId ? await pendingCount(ownerId) : 0);
    setAsking(true);
  }

  async function leaveEverywhere() {
    if (busy) return;
    setBusy(true);
    setLeaveError(null);
    try {
      await signOutEverywhere();
      // Сесії вже немає — екран сам піде на вхід.
    } catch (e) {
      setLeaveError(errorText(e, t));
      setBusy(false);
    }
  }

  // Push без жодного пристрою не прийде нікуди: ввімкнути не даємо, вимкнути — так.
  const pushMuted = devices === 0 && !flags?.signin_push;

  return (
    <section className="v2-settings__card v2-settings__card--wide v2-notify" id="security" aria-labelledby={titleId}>
      <h2 className="v2-settings__label" id={titleId}>
        {t('v2security.title')}
      </h2>
      {error && <NoteV2 tone="error">{error}</NoteV2>}

      <div className="v2-notify__rows">
        <div className="v2-notify__row" role="group" aria-labelledby={`${titleId}-signin`}>
          <div className="v2-notify__text">
            <span className="v2-notify__name" id={`${titleId}-signin`}>
              {t('v2security.signin')}
            </span>
            <span className="v2-notify__hint">{t('v2security.signinHint')}</span>
          </div>
          {flags ? (
            <div className="v2-notify__chips">
              {showPush && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={flags.signin_push}
                  aria-disabled={pushMuted || undefined}
                  aria-label={`${t('v2security.signin')}: ${t('v2notify.channel.push')}`}
                  className="v2-chip v2-chip--toggle v2-notify__chip"
                  onClick={() => {
                    if (!pushMuted) void toggle('signin_push');
                  }}
                >
                  {t('v2notify.channel.push')}
                </button>
              )}
              <button
                type="button"
                role="switch"
                aria-checked={flags.signin_email}
                aria-label={`${t('v2security.signin')}: ${t('v2notify.channel.email')}`}
                className="v2-chip v2-chip--toggle v2-notify__chip"
                data-testid="signin-email"
                onClick={() => void toggle('signin_email')}
              >
                {t('v2notify.channel.email')}
              </button>
            </div>
          ) : (
            !error && <span className="v2-notify__static">{t('common.loading')}</span>
          )}
        </div>
        <div className="v2-notify__row">
          <div className="v2-notify__text">
            <span className="v2-notify__name">{t('v2notify.securityHint')}</span>
            <span className="v2-notify__hint">{t('v2security.passwordHint')}</span>
          </div>
          <span className="v2-notify__static">{t('v2notify.securityAlways')}</span>
        </div>
      </div>

      {showPush && pushMuted && <p className="v2-hint v2-hint--start">{t('v2security.pushHint')}</p>}
      {flags && !flags.signin_email && !flags.signin_push && (
        <p className="v2-hint v2-hint--start" role="status">
          {t('v2security.offHint')}
        </p>
      )}
      <p className="v2-hint v2-hint--start">{t('v2security.email', { email })}</p>

      <div className="v2-settings__row">
        <Link to="/reset" state={{ email }} className="v2-btn v2-btn--outline">
          {t('v2security.changePassword')}
        </Link>
        <button type="button" className="v2-btn v2-btn--danger" onClick={() => void ask()}>
          {t('v2security.everywhere')}
        </button>
      </div>
      <p className="v2-hint v2-hint--start">{t('v2security.everywhereHint')}</p>

      <SheetV2 open={asking} onClose={() => !busy && setAsking(false)} labelledBy={confirmId}>
        <h2 className="v2-sheet__title" id={confirmId}>
          {t('v2security.everywhereTitle')}
        </h2>
        <p className="v2-lede">{t('v2security.everywhereBody')}</p>
        {waiting > 0 && <p className="v2-lede">{t('outbox.confirmSignOut', { n: waiting })}</p>}
        {leaveError && <NoteV2 tone="error">{leaveError}</NoteV2>}
        <div className="v2-sheet__actions">
          <button
            type="button"
            className="v2-btn v2-btn--danger-fill v2-btn--block"
            aria-disabled={busy || undefined}
            data-busy={busy || undefined}
            onClick={() => void leaveEverywhere()}
          >
            {busy && <span className="v2-spinner" aria-hidden="true" />}
            {busy ? t('v2security.everywhereBusy') : t('v2security.everywhereConfirm')}
          </button>
          <button type="button" className="v2-btn v2-btn--ghost" onClick={() => setAsking(false)} disabled={busy}>
            {t('v2app.signOut.stay')}
          </button>
        </div>
      </SheetV2>
    </section>
  );
}
