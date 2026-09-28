import { useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useI18n } from '../../../lib/i18n';
import { authErrorKey } from '../../../lib/authErrors';
import { authReturn, emailProblem, recallAuthEmail, rememberAuthEmail } from '../../../lib/authFlow';
import {
  AuthFrameV2,
  BackHeaderV2,
  FieldV2,
  IconCircleV2,
  NoteV2,
  SubmitV2,
  clock,
  useCountdown,
  useEmailError,
} from './AuthPartsV2';

const RESEND_MS = 60_000;
const SAY = ['errors.noResponse', 'errors.offline', 'errors.rateLimited'];

/**
 * Скидання пароля v2 — лист із посиланням, не код (ADR-042).
 *
 * Пошта приходить уже підставленою — з екрана входу чи з цього ж пристрою.
 * Відповідь однакова, є такий акаунт чи ні: інакше форма стала б перевіркою,
 * хто зареєстрований (T2, гілка). Кажемо лише про мережу й ліміт.
 *
 * PKCE: посилання спрацює лише в цьому браузері (DEPLOY.md), і текст про це
 * попереджає наперед.
 */
export default function ResetV2() {
  const { t } = useI18n();
  const location = useLocation();
  const [email, setEmail] = useState(
    () => (location.state as { email?: string } | null)?.email || recallAuthEmail(),
  );
  const [touched, setTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const wait = useCountdown(resendAt);
  const emailRef = useRef<HTMLInputElement>(null);

  const problem = emailProblem(email);
  const emailError = useEmailError(problem, touched, submitted);

  async function send() {
    if (busy || wait > 0) return;
    setSubmitted(true);
    if (problem) return emailRef.current?.focus();
    setBusy(true);
    setServer(null);
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
    setSentTo(email.trim());
    setResendAt(Date.now() + RESEND_MS);
  }

  if (sentTo) {
    return (
      <AuthFrameV2>
        <div className="v2-stack">
          <IconCircleV2 icon={Mail} tone="calm" />
          <h1 className="v2-title">{t('v2auth.reset.sentTitle')}</h1>
          <p className="v2-lede">{t('v2auth.reset.sentBody', { email: sentTo })}</p>
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          <button
            type="button"
            className="v2-btn v2-btn--ghost"
            aria-disabled={wait > 0 || busy || undefined}
            onClick={() => void send()}
          >
            {wait > 0 ? t('v2auth.check.resendIn', { time: clock(wait) }) : t('v2auth.check.resend')}
          </button>
          <Link to="/login" state={{ email: sentTo }} className="v2-btn v2-btn--ghost">
            {t('v2auth.toLogin')}
          </Link>
        </div>
      </AuthFrameV2>
    );
  }

  return (
    <AuthFrameV2>
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <BackHeaderV2 to="/login" state={{ email: email.trim() }} title={t('v2auth.reset.title')} />
        <p className="v2-lede">{t('v2auth.reset.body')}</p>
        {server && <NoteV2 tone="error">{server}</NoteV2>}
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
          onBlur={() => setTouched(true)}
        />
        <SubmitV2 busy={busy} label={t('v2auth.reset.submit')} busyLabel={t('v2auth.sending')} />
      </form>
    </AuthFrameV2>
  );
}
