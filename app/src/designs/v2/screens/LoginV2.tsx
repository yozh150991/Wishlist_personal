import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { MailWarning, MailX } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { authErrorKey } from '../../../lib/authErrors';
import { safeNext } from '../../../lib/safeNext';
import {
  authReturn,
  emailProblem,
  forgetAuthEmail,
  googleEnabled,
  readRedirectError,
  recallAuthEmail,
  rememberAuthEmail,
  signInWithGoogle,
  withoutRedirectError,
} from '../../../lib/authFlow';
import {
  AuthFrameV2,
  FieldV2,
  IconCircleV2,
  NoteV2,
  OrDividerV2,
  PasswordFieldV2,
  SubmitV2,
  clock,
  useCountdown,
  useEmailError,
} from './AuthPartsV2';

/** Після стількох невдалих спроб поспіль — пауза (ADR-042, п. 5). */
const MAX_FAILS = 3;
const PAUSE_MS = 30_000;
/** Понад стільки очікування під кнопкою з'являється «Скасувати» (A3). */
const SLOW_MS = 8_000;

/**
 * `expired` — посилання з листа не спрацювало; `unconfirmed` — пароль правильний,
 * але пошту ще не підтверджено. В обох — повторний лист підтвердження: увійти
 * може лише акаунт із підтвердженою поштою (ADR-043).
 */
type Stage = 'form' | 'expired' | 'unconfirmed';

/**
 * Вхід v2 (потік A).
 *
 * - Валідація — на виході з поля, не на кожній літері; помилка під своїм полем
 *   і зникає, щойно рядок стає коректним. Поля ніколи не очищаються.
 * - Кнопка активна завжди: порожні поля перевіряє натиск і переводить фокус
 *   до першого поля з помилкою, а не блокування.
 * - Очікування — «Входжу…» зі спінером; понад 8 с під кнопкою «Скасувати».
 * - «Не пам'ятаєш пароль?» веде на скидання пароля з уже підставленою поштою:
 *   окремого листа для входу без пароля немає (ADR-042, п. 3).
 * - Три невдалі спроби поспіль — пауза на 30 с із лічильником на кнопці й
 *   порадою скинути пароль. Це не захист (його дає rate limit Supabase), а
 *   підказка людині, яка вгадує.
 *
 * Сюди ж повертаються посилання з листа підтвердження й вхід через Google:
 * помилки з адреси (скасовано, протерміновано) читає `readRedirectError`.
 */
export default function LoginV2() {
  const { t } = useI18n();
  const { session, loading } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));

  // Що принесла адреса — читається один раз, до того як її очистимо.
  const [arrival] = useState(() => ({
    error: readRedirectError(location.search, location.hash),
    confirmed: params.get('from') === 'confirm',
  }));

  const presetEmail = (location.state as { email?: string } | null)?.email;
  const [email, setEmail] = useState(() => presetEmail ?? recallAuthEmail());
  const [password, setPassword] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<string | null>(
    arrival.error === 'failed' ? t('v2auth.login.linkFailed') : null,
  );
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [fails, setFails] = useState(0);
  const [pausedUntil, setPausedUntil] = useState<number | null>(null);
  const [stage, setStage] = useState<Stage>(arrival.error === 'expired' ? 'expired' : 'form');
  const [resent, setResent] = useState(false);
  const pause = useCountdown(pausedUntil);
  const attempt = useRef(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Параметри помилки й «from» прибираються з адреси одразу: інакше F5
  // показав би те саме повідомлення ще раз.
  useEffect(() => {
    if (arrival.error || arrival.confirmed) {
      navigate(withoutRedirectError(location.pathname, location.search), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const problem = emailProblem(email);
  const emailError = useEmailError(problem, emailTouched, submitted);

  if (!loading && session) return <Navigate to={next} replace />;

  const passwordError = submitted && !password ? t('v2auth.passwordEmpty') : null;

  async function onSubmit() {
    if (busy || pause > 0) return;
    setSubmitted(true);
    if (problem) return emailRef.current?.focus();
    if (!password) return passwordRef.current?.focus();

    const mine = ++attempt.current;
    setBusy(true);
    setSlow(false);
    setServer(null);
    const timer = window.setTimeout(() => {
      if (attempt.current === mine) setSlow(true);
    }, SLOW_MS);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    window.clearTimeout(timer);
    // «Скасувати» вже відпустив людину — відповідь, що запізнилась, ігноруємо.
    // Якщо вона була успішною, сесія все одно прийде через AuthProvider.
    if (attempt.current !== mine) return;
    setBusy(false);
    setSlow(false);

    if (!error) {
      forgetAuthEmail();
      return;
    }
    const key = authErrorKey(error);
    // Непідтверджена пошта — не помилка входу, а крок, який лишився: одразу
    // пропонуємо лист ще раз. І не рахуємо цю спробу в паузу.
    if (key === 'errors.emailNotConfirmed') {
      rememberAuthEmail(email);
      setResent(false);
      setStage('unconfirmed');
      return;
    }
    if (key === 'errors.invalidCredentials') {
      const n = fails + 1;
      if (n >= MAX_FAILS) {
        setFails(0);
        setPausedUntil(Date.now() + PAUSE_MS);
      } else {
        setFails(n);
      }
    }
    setServer(t(key));
  }

  function cancel() {
    attempt.current++;
    setBusy(false);
    setSlow(false);
  }

  async function google() {
    setServer(null);
    const { error } = await signInWithGoogle('v2', next);
    if (error) setServer(t(authErrorKey(error)));
  }

  async function resendConfirmation() {
    if (emailProblem(email)) {
      setSubmitted(true);
      return emailRef.current?.focus();
    }
    setBusy(true);
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: authReturn('/login', 'v2', { from: 'confirm' }) },
    });
    setBusy(false);
    // Відповідь однакова, є така адреса чи ні; кажемо лише про мережу й ліміт.
    const key = error ? authErrorKey(error) : null;
    if (key && ['errors.noResponse', 'errors.offline', 'errors.rateLimited'].includes(key)) {
      setServer(t(key));
      return;
    }
    rememberAuthEmail(email);
    setServer(null);
    setResent(true);
  }

  if (stage === 'expired' || stage === 'unconfirmed') {
    const expired = stage === 'expired';
    return (
      <AuthFrameV2>
        <form
          className="v2-stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void resendConfirmation();
          }}
        >
          <IconCircleV2 icon={expired ? MailX : MailWarning} tone="warm" />
          <h1 className="v2-title">{expired ? t('v2auth.expired.title') : t('v2auth.unconfirmed.title')}</h1>
          <p className="v2-lede">
            {expired ? t('v2auth.expired.body') : t('v2auth.unconfirmed.body', { email: email.trim() })}
          </p>
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          {resent ? (
            <NoteV2 tone="info">{t('v2auth.expired.sent', { email: email.trim() })}</NoteV2>
          ) : (
            <>
              <FieldV2
                ref={emailRef}
                label={t('v2auth.email.label')}
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                value={email}
                error={emailError}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailTouched(true)}
              />
              <SubmitV2
                busy={busy}
                label={expired ? t('v2auth.expired.submit') : t('v2auth.unconfirmed.submit')}
                busyLabel={t('v2auth.sending')}
              />
            </>
          )}
          <button type="button" className="v2-btn v2-btn--ghost" onClick={() => setStage('form')}>
            {t('v2auth.toLogin')}
          </button>
        </form>
      </AuthFrameV2>
    );
  }

  return (
    <AuthFrameV2>
      {/* Справжня <form>: менеджер паролів пропонує зберегти й підставити
          пароль саме для форми з username / current-password і кнопкою submit. */}
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <div className="v2-head">
          <h1 className="v2-title">{t('v2auth.login.title')}</h1>
          <p className="v2-lede">{t('v2auth.login.lede')}</p>
        </div>

        {arrival.confirmed && !server && <NoteV2 tone="info">{t('v2auth.login.confirmed')}</NoteV2>}
        {server && <NoteV2 tone="error">{server}</NoteV2>}
        {pause > 0 && (
          <NoteV2 tone="error">
            {t('v2auth.login.paused', { time: clock(pause) })}{' '}
            <Link to="/reset" state={{ email: email.trim() }}>
              {t('v2auth.login.resetCta')}
            </Link>
          </NoteV2>
        )}

        {googleEnabled && (
          <>
            <button type="button" className="v2-btn v2-btn--outline v2-btn--block" onClick={() => void google()}>
              {t('v2auth.google')}
            </button>
            <OrDividerV2 />
          </>
        )}

        <FieldV2
          ref={emailRef}
          label={t('v2auth.email.label')}
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          placeholder={t('v2auth.email.placeholder')}
          value={email}
          error={emailError}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setEmailTouched(true)}
        />
        <PasswordFieldV2
          ref={passwordRef}
          label={t('v2auth.password')}
          name="password"
          autoComplete="current-password"
          value={password}
          error={passwordError}
          onChange={(e) => setPassword(e.target.value)}
          after={
            <p className="v2-field__after">
              <Link to="/reset" state={{ email: email.trim() }} className="v2-link">
                {t('v2auth.login.forgot')}
              </Link>
            </p>
          }
        />

        <SubmitV2
          busy={busy}
          label={t('v2auth.login.submit')}
          busyLabel={t('v2auth.login.submitting')}
          paused={pause > 0 ? t('v2auth.login.pausedButton', { time: clock(pause) }) : null}
        />
        {slow && (
          <button type="button" className="v2-btn v2-btn--ghost" onClick={cancel}>
            {t('v2auth.cancel')}
          </button>
        )}

        <p className="v2-switch">
          {t('v2auth.login.toRegister')}{' '}
          <Link to="/register" state={{ email: email.trim() }} className="v2-link">
            {t('v2auth.login.toRegisterCta')}
          </Link>
        </p>
      </form>
    </AuthFrameV2>
  );
}
