import { useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { deviceTimeZone } from '../../../lib/zones';
import {
  IMPORTANT_KINDS,
  NOTIFY_KINDS,
  allOff,
  anyOn,
  anyPushOn,
  countPushDevices,
  disablePushHere,
  enableNotifications,
  enablePushHere,
  fetchNotifySettings,
  flag,
  pushOnThisDevice,
  pushSupport,
  readNotifyAsked,
  saveNotifySettings,
  writeNotifyAsked,
} from '../../../lib/notifications';
import type {
  EnableOutcome,
  NotifyChannel,
  NotifyFlag,
  NotifyFlags,
  NotifyKind,
  NotifySettings,
  PushSupport,
} from '../../../lib/notifications';
import { NoteV2 } from './AuthPartsV2';
import { SwitchV2 } from './CommonV2';

type State = { settings: NotifySettings | null; devices: number; here: boolean; support: PushSupport };

async function loadState(): Promise<State> {
  const support = pushSupport();
  const [settings, devices, here] = await Promise.all([
    fetchNotifySettings(),
    support === 'no-key' ? Promise.resolve(0) : countPushDevices(),
    pushOnThisDevice(),
  ]);
  return { settings, devices, here, support };
}

/** Push тут неможливий і не буде можливим без дії поза застосунком. */
function pushBlocked(support: PushSupport): boolean {
  return support === 'denied' || support === 'unsupported' || support === 'ios-install';
}

function useKindText() {
  const { t } = useI18n();
  return (kind: NotifyKind): { name: string; hint: string } => {
    switch (kind) {
      case 'after_event':
        return { name: t('v2notify.kind.afterEvent'), hint: t('v2notify.kind.afterEventHint') };
      case 'yearly':
        return { name: t('v2notify.kind.yearly'), hint: t('v2notify.kind.yearlyHint') };
      case 'link':
        return { name: t('v2notify.kind.link'), hint: t('v2notify.kind.linkHint') };
      case 'price':
        return { name: t('v2notify.kind.price'), hint: t('v2notify.kind.priceHint') };
      default:
        return { name: t('v2notify.kind.share'), hint: t('v2notify.kind.shareHint') };
    }
  };
}

/** Що сталося після «Увімкнути сповіщення» — одним рядком. */
function OutcomeNoteV2({ outcome }: { outcome: EnableOutcome }) {
  const { t } = useI18n();
  const { session } = useAuth();
  if (outcome.pushWorks) return <NoteV2 tone="info">{t('v2notify.enabled')}</NoteV2>;
  return <NoteV2 tone="info">{t('v2notify.enabledEmail', { email: session?.user.email ?? '' })}</NoteV2>;
}

/**
 * «Сповіщення» в Налаштуваннях v2 (потік P2): подія × канал, push на цьому
 * пристрої й чесний стан, коли push заборонено (P, гілка). Листи про безпеку
 * не вимикаються — і це сказано прямо. Про позначки гостей — плашка з
 * поясненням, чому таких сповіщень немає (ADR-040).
 */
export function NotifyCardV2() {
  const { t } = useI18n();
  const { session } = useAuth();
  const { hash } = useLocation();
  const kindText = useKindText();
  const titleId = useId();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<EnableOutcome | null>(null);
  const [deviceNote, setDeviceNote] = useState<string | null>(null);
  const ownerId = session?.user.id ?? '';
  const email = session?.user.email ?? '';

  async function reload() {
    setError(null);
    try {
      const next = await loadState();
      setState(next);
      if (!next.settings || !ownerId) return;
      // Push тут заборонено, а інших пристроїв немає: важливе переходить із
      // push на пошту (P, гілка «push заборонено») — ми не вдаємо, що push
      // працює, і нічого не губиться. Push для цих подій вимикається, тож
      // вимкнена потім пошта вдруге сама не ввімкнеться.
      const patch: Partial<NotifyFlags> = {};
      if (anyOn(next.settings) && pushBlocked(next.support) && next.devices === 0) {
        for (const k of IMPORTANT_KINDS) {
          if (next.settings[flag(k, 'push')] && !next.settings[flag(k, 'email')]) {
            patch[flag(k, 'email')] = true;
            patch[flag(k, 'push')] = false;
          }
        }
      }
      // Тиша 22:00–9:00 — за поясом, де людина зараз: переїхала — пояс за нею.
      const tz = deviceTimeZone();
      if (Object.keys(patch).length || (tz && next.settings.time_zone !== tz)) {
        const saved = await saveNotifySettings(ownerId, patch);
        setState((s) => (s ? { ...s, settings: saved } : s));
      }
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // /settings#notifications — з листа, з push і з аркуша після посилання.
  useEffect(() => {
    if (state && hash === '#notifications') document.getElementById('notifications')?.scrollIntoView({ block: 'start' });
  }, [state, hash]);

  async function enableAll() {
    if (busy || !ownerId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await enableNotifications(ownerId);
      setOutcome(result);
      writeNotifyAsked();
      setState(await loadState());
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(f: NotifyFlag) {
    if (!state?.settings || !ownerId) return;
    const prev = state.settings;
    const next = { ...prev, [f]: !prev[f] };
    setState({ ...state, settings: next });
    setError(null);
    try {
      await saveNotifySettings(ownerId, { [f]: next[f] });
    } catch (e) {
      setState((s) => (s ? { ...s, settings: prev } : s));
      setError(errorText(e, t));
    }
  }

  async function switchHere(on: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDeviceNote(null);
    try {
      if (on) {
        const result = await enablePushHere();
        if (result === 'denied') setDeviceNote(t('v2notify.device.denied'));
        if (result === 'unsupported') setDeviceNote(t('v2notify.device.failed'));
      } else {
        await disablePushHere();
      }
      setState(await loadState());
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function turnAllOff() {
    if (busy || !ownerId) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveNotifySettings(ownerId, allOff());
      setState((s) => (s ? { ...s, settings: saved } : s));
      setOutcome(null);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const settings = state?.settings ?? null;
  const on = anyOn(settings);
  const support = state?.support ?? 'no-key';
  const showPush = support !== 'no-key';
  const pushMuted = pushBlocked(support) && (state?.devices ?? 0) === 0;

  return (
    <section className="v2-settings__card v2-settings__card--wide v2-notify" id="notifications" aria-labelledby={titleId}>
      <h2 className="v2-settings__label" id={titleId}>
        {t('v2notify.title')}
      </h2>
      {error && <NoteV2 tone="error">{error}</NoteV2>}

      {!state && !error && <p className="v2-hint v2-hint--start">{t('common.loading')}</p>}
      {!state && error && (
        <button type="button" className="v2-btn v2-btn--outline v2-btn--start" onClick={() => void reload()}>
          {t('common.retry')}
        </button>
      )}

      {state && !on && (
        <>
          <p className="v2-hint v2-hint--start">{t('v2notify.intro')}</p>
          <button
            type="button"
            className="v2-btn v2-btn--primary v2-btn--start"
            aria-disabled={busy || undefined}
            data-busy={busy || undefined}
            onClick={() => void enableAll()}
          >
            {busy && <span className="v2-spinner" aria-hidden="true" />}
            {busy ? t('v2notify.enabling') : t('v2notify.enable')}
          </button>
        </>
      )}

      {state && on && settings && (
        <>
          {outcome && <OutcomeNoteV2 outcome={outcome} />}

          {showPush && (
            <div className="v2-notify__device">
              {pushBlocked(support) ? (
                <p className="v2-hint v2-hint--start" role="status">
                  {support === 'denied'
                    ? t('v2notify.device.denied')
                    : support === 'ios-install'
                      ? t('v2notify.device.ios')
                      : t('v2notify.device.unsupported')}
                </p>
              ) : (
                <SwitchV2
                  label={t('v2notify.device.label')}
                  hint={state.here ? t('v2notify.device.on') : t('v2notify.device.off')}
                  checked={state.here}
                  disabled={busy}
                  onChange={(next) => void switchHere(next)}
                />
              )}
              {deviceNote && <p className="v2-hint v2-hint--start" role="status">{deviceNote}</p>}
              {state.devices > (state.here ? 1 : 0) && (
                <p className="v2-hint v2-hint--start">{t('v2notify.device.count', { n: state.devices })}</p>
              )}
              {anyPushOn(settings) && state.devices === 0 && !pushBlocked(support) && (
                <p className="v2-hint v2-hint--start">{t('v2notify.device.nowhere')}</p>
              )}
            </div>
          )}

          <div className="v2-notify__rows">
            {NOTIFY_KINDS.map((kind) => {
              const { name, hint } = kindText(kind);
              const channels: NotifyChannel[] = showPush ? ['push', 'email'] : ['email'];
              return (
                <div key={kind} className="v2-notify__row" role="group" aria-labelledby={`${titleId}-${kind}`}>
                  <div className="v2-notify__text">
                    <span className="v2-notify__name" id={`${titleId}-${kind}`}>
                      {name}
                    </span>
                    <span className="v2-notify__hint">{hint}</span>
                  </div>
                  <div className="v2-notify__chips">
                    {channels.map((channel) => {
                      const f = flag(kind, channel);
                      // Приглушений push можна вимкнути, але не ввімкнути.
                      const muted = channel === 'push' && pushMuted && !settings[f];
                      const label = channel === 'push' ? t('v2notify.channel.push') : t('v2notify.channel.email');
                      return (
                        <button
                          key={channel}
                          type="button"
                          role="switch"
                          aria-checked={settings[f]}
                          aria-disabled={muted || undefined}
                          aria-label={`${name}: ${label}`}
                          className="v2-chip v2-chip--toggle v2-notify__chip"
                          onClick={() => {
                            if (!muted) void toggle(f);
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div className="v2-notify__row">
              <div className="v2-notify__text">
                <span className="v2-notify__name">{t('v2notify.security')}</span>
                <span className="v2-notify__hint">{t('v2notify.securityHint')}</span>
              </div>
              <span className="v2-notify__static">{t('v2notify.securityAlways')}</span>
            </div>
          </div>

          <p className="v2-hint v2-hint--start">{t('v2notify.quiet')}</p>
          <p className="v2-hint v2-hint--start">{t('v2notify.email', { email })}</p>
          <p className="v2-hint v2-hint--start">{t('v2notify.guests')}</p>
          <button type="button" className="v2-btn v2-btn--ghost v2-btn--start" onClick={() => void turnAllOff()}>
            {t('v2notify.off')}
          </button>
        </>
      )}
    </section>
  );
}

/**
 * Запит у контексті (P1): після посилання вже є чого чекати — тоді й
 * питаємо. Спершу свій аркуш, системний запит — лише за «Увімкнути»: на iOS
 * він показується один раз. «Не зараз» системного запиту не показує й більше
 * не питає на цьому пристрої.
 */
export function NotifyAskV2() {
  const { t } = useI18n();
  const { session } = useAuth();
  const headingId = useId();
  const [phase, setPhase] = useState<'hidden' | 'ask' | 'busy'>('hidden');
  const [outcome, setOutcome] = useState<EnableOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ownerId = session?.user.id ?? '';

  useEffect(() => {
    if (readNotifyAsked()) return;
    let alive = true;
    fetchNotifySettings()
      .then((s) => {
        if (alive && !anyOn(s)) setPhase('ask');
      })
      .catch(() => {
        // Не вдалося дізнатись — не питаємо: краще промовчати, ніж спитати вдруге.
      });
    return () => {
      alive = false;
    };
  }, []);

  async function enable() {
    if (phase === 'busy' || !ownerId) return;
    setPhase('busy');
    setError(null);
    try {
      setOutcome(await enableNotifications(ownerId));
      writeNotifyAsked();
    } catch (e) {
      setError(errorText(e, t));
      setPhase('ask');
    }
  }

  if (outcome) {
    return (
      <div className="v2-notify-ask">
        <OutcomeNoteV2 outcome={outcome} />
        <Link className="v2-btn v2-btn--ghost v2-btn--start" to="/settings#notifications">
          {t('v2notify.ask.settings')}
        </Link>
      </div>
    );
  }
  if (phase === 'hidden') return null;

  return (
    <section className="v2-notify-ask" aria-labelledby={headingId}>
      <h3 className="v2-notify-ask__title" id={headingId}>
        {t('v2notify.ask.title')}
      </h3>
      <p className="v2-hint v2-hint--start">{t('v2notify.ask.body')}</p>
      {error && <NoteV2 tone="error">{error}</NoteV2>}
      <div className="v2-settings__row">
        <button
          type="button"
          className="v2-btn v2-btn--primary"
          aria-disabled={phase === 'busy' || undefined}
          data-busy={phase === 'busy' || undefined}
          onClick={() => void enable()}
        >
          {phase === 'busy' && <span className="v2-spinner" aria-hidden="true" />}
          {phase === 'busy' ? t('v2notify.enabling') : t('v2notify.enable')}
        </button>
        <button
          type="button"
          className="v2-btn v2-btn--ghost"
          onClick={() => {
            writeNotifyAsked();
            setPhase('hidden');
          }}
        >
          {t('v2notify.ask.later')}
        </button>
      </div>
    </section>
  );
}
