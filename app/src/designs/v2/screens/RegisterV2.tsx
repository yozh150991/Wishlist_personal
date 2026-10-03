import { useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useI18n } from '../../../lib/i18n';
import { authErrorKey } from '../../../lib/authErrors';
import {
  authReturn,
  emailProblem,
  googleEnabled,
  mailboxUrl,
  rememberAuthEmail,
  signInWithGoogle,
} from '../../../lib/authFlow';
import { MIN_PASSWORD, passwordChecks, passwordOk } from '../../../lib/password';
import {
  AuthFrameV2,
  BackHeaderV2,
  FieldV2,
  IconCircleV2,
  NoteV2,
  OrDividerV2,
  PasswordFieldV2,
  RulesV2,
  SubmitV2,
  clock,
  useCountdown,
  useEmailError,
} from './AuthPartsV2';

/** Повторний лист — не раніше, ніж за хвилину (T1). */
const RESEND_MS = 60_000;

type Stage = 'form' | 'taken' | 'check';

/** Мережа й ліміт — єдине, що варто казати людині у відповідь на лист. */
const SAY = ['errors.noResponse', 'errors.offline', 'errors.rateLimited'];

/**
 * Реєстрація v2 (потоки Q і T1).
 *
 * - Google — зверху (коли ввімкнений), далі пошта й пароль.
 * - Вимоги до пароля видно наперед і відмічаються під час введення; кнопка
 *   не блокується — натиск із невиконаними переводить фокус на пароль.
 * - Зайнята пошта — не «помилка», а розвилка «Це ти?»: увійти з цією поштою
 *   або отримати лист для нового пароля (ADR-042, п. 3).
 * - Після реєстрації — «Лист уже в пошті» з повтором через хвилину. Кодів
 *   немає: у листі посилання (ADR-042).
 */
export default function RegisterV2() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const rulesId = useId();

  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? '');
  const [password, setPassword] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('form');
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wait = useCountdown(resendAt);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const problem = emailProblem(email);
  const emailError = useEmailError(problem, emailTouched, submitted);
  const checks = passwordChecks(password, email);
  const passwordError = submitted && !passwordOk(checks) ? t('v2auth.passwordRules') : null;
  const confirmUrl = authReturn('/login', 'v2', { from: 'confirm' });

  async function onSubmit() {
    if (busy) return;
    setSubmitted(true);
    if (problem) return emailRef.current?.focus();
    if (!passwordOk(checks)) return passwordRef.current?.focus();

    setBusy(true);
    setServer(null);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      // Мова листа підтвердження: шаблон читає її з user_metadata (ADR-024).
      options: { emailRedirectTo: confirmUrl, data: { locale } },
    });
    setBusy(false);

    if (error) {
      const key = authErrorKey(error);
      if (key === 'errors.emailTaken') setStage('taken');
      else setServer(t(key));
      return;
    }
    // Підтвердження вимкнене (локальна база) — людина вже всередині.
    if (data.session) {
      navigate('/lists', { replace: true });
      return;
    }
    // Із увімкненим підтвердженням Supabase на зайняту пошту не каже «зайнято»,
    // а повертає користувача без жодної ідентичності.
    if (data.user && data.user.identities?.length === 0) {
      setStage('taken');
      return;
    }
    rememberAuthEmail(email);
    setResendAt(Date.now() + RESEND_MS);
    setNotice(null);
    setStage('check');
  }

  async function resend() {
    if (busy || wait > 0) return;
    setBusy(true);
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: confirmUrl },
    });
    setBusy(false);
    const key = error ? authErrorKey(error) : null;
    if (key && SAY.includes(key)) {
      setNotice(t(key));
      return;
    }
    setResendAt(Date.now() + RESEND_MS);
    setNotice(t('v2auth.check.resent'));
  }

  async function sendReset() {
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: authReturn('/update-password', 'v2'),
    });
    setBusy(false);
    const key = error ? authErrorKey(error) : null;
    if (key && SAY.includes(key)) {
      setServer(t(key));
      return;
    }
    rememberAuthEmail(email);
    setServer(null);
    setNotice(t('v2auth.taken.resetSent'));
  }

  async function google() {
    setServer(null);
    const { error } = await signInWithGoogle('v2');
    if (error) setServer(t(authErrorKey(error)));
  }

  if (stage === 'check') {
    const mailbox = mailboxUrl(email);
    return (
      <AuthFrameV2>
        <div className="v2-stack">
          <IconCircleV2 icon={Mail} tone="calm" />
          <h1 className="v2-title">{t('v2auth.check.title')}</h1>
          <p className="v2-lede">{t('v2auth.check.body', { email: email.trim() })}</p>
          {notice && <NoteV2 tone="info">{notice}</NoteV2>}
          {mailbox && (
            <a className="v2-btn v2-btn--primary v2-btn--block" href={mailbox} target="_blank" rel="noopener noreferrer">
              {t('v2auth.check.open')}
            </a>
          )}
          <button
            type="button"
            className="v2-btn v2-btn--ghost"
            aria-disabled={wait > 0 || busy || undefined}
            onClick={() => void resend()}
          >
            {wait > 0 ? t('v2auth.check.resendIn', { time: clock(wait) }) : t('v2auth.check.resend')}
          </button>
          <button
            type="button"
            className="v2-btn v2-btn--ghost"
            onClick={() => {
              setStage('form');
              setSubmitted(false);
              requestAnimationFrame(() => emailRef.current?.focus());
            }}
          >
            {t('v2auth.check.change')}
          </button>
        </div>
      </AuthFrameV2>
    );
  }

  if (stage === 'taken') {
    return (
      <AuthFrameV2>
        <div className="v2-stack">
          <BackHeaderV2 to="/login" state={{ email: email.trim() }} title={t('v2auth.register.title')} />
          <FieldV2
            label={t('v2auth.email.label')}
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            error={t('v2auth.taken.error')}
            onChange={(e) => {
              // Інша пошта — назад до форми, пароль лишається.
              setEmail(e.target.value);
              setStage('form');
              setNotice(null);
            }}
          />
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          <section className="v2-card" aria-labelledby="taken-title">
            <h2 className="v2-card__title" id="taken-title">
              {t('v2auth.taken.title')}
            </h2>
            <Link to="/login" state={{ email: email.trim() }} className="v2-btn v2-btn--primary v2-btn--block">
              {t('v2auth.taken.login')}
            </Link>
            {notice ? (
              <NoteV2 tone="info">{notice}</NoteV2>
            ) : (
              <button
                type="button"
                className="v2-btn v2-btn--outline v2-btn--block"
                aria-disabled={busy || undefined}
                onClick={() => void sendReset()}
              >
                {busy && <span className="v2-spinner" aria-hidden="true" />}
                {busy ? t('v2auth.sending') : t('v2auth.taken.reset')}
              </button>
            )}
          </section>
          {googleEnabled && <p className="v2-hint">{t('v2auth.taken.googleHint')}</p>}
        </div>
      </AuthFrameV2>
    );
  }

  return (
    <AuthFrameV2>
      {/* <form>: менеджер паролів запропонує згенерувати й зберегти пароль. */}
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <BackHeaderV2 to="/login" state={{ email: email.trim() }} title={t('v2auth.register.title')} />
        {server && <NoteV2 tone="error">{server}</NoteV2>}

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
          autoComplete="new-password"
          value={password}
          error={passwordError}
          describedBy={rulesId}
          onChange={(e) => setPassword(e.target.value)}
        />
        <RulesV2
          id={rulesId}
          rules={[
            { label: t('v2auth.rules.long', { n: MIN_PASSWORD }), met: checks.long },
            { label: t('v2auth.rules.notEmail'), met: checks.notEmail },
            { label: t('v2auth.rules.notCommon'), met: checks.notCommon },
          ]}
        />

        <SubmitV2 busy={busy} label={t('v2auth.register.submit')} busyLabel={t('v2auth.register.submitting')} />

        <p className="v2-switch">
          {t('v2auth.register.toLogin')}{' '}
          <Link to="/login" state={{ email: email.trim() }} className="v2-link">
            {t('v2auth.register.toLoginCta')}
          </Link>
        </p>
      </form>
    </AuthFrameV2>
  );
}
