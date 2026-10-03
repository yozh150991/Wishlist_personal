import { useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { authErrorKey } from '../../../lib/authErrors';
import {
  authReturn,
  emailProblem,
  forgetAuthEmail,
  readRedirectError,
  recallAuthEmail,
  rememberAuthEmail,
} from '../../../lib/authFlow';
import { MIN_PASSWORD, passwordChecks, passwordOk } from '../../../lib/password';
import {
  AuthFrameV2,
  BackHeaderV2,
  FieldV2,
  IconCircleV2,
  NoteV2,
  PasswordFieldV2,
  RulesV2,
  SubmitV2,
  useEmailError,
} from './AuthPartsV2';

const SAY = ['errors.noResponse', 'errors.offline', 'errors.rateLimited'];

/**
 * Новий пароль v2 (T2) — сюди веде посилання з листа скидання.
 *
 * - Одне поле з «показати» замість двох «повторіть пароль».
 * - «Зберегти й увійти»: після збереження людина вже всередині, а інші
 *   пристрої виходять з акаунта — хто скидав пароль, міг скидати його саме
 *   тому, що хтось інший має до акаунта доступ.
 * - Посилання не спрацювало (використане, протерміноване, інший браузер) —
 *   одна сторінка з полем пошти й «Надіслати нове посилання».
 */
export default function NewPasswordV2() {
  const { t } = useI18n();
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const rulesId = useId();
  const [linkError] = useState(() => readRedirectError(location.search, location.hash));

  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [same, setSame] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Гілка «посилання не діє»: своя пошта й свій стан.
  const [email, setEmail] = useState(recallAuthEmail);
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  const [sent, setSent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const account = session?.user.email ?? '';
  const checks = passwordChecks(password, account);
  const problem = emailProblem(email);
  const emailError = useEmailError(problem, emailTouched, emailSubmitted);
  const passwordError = same
    ? t('v2auth.update.same')
    : submitted && !passwordOk(checks)
      ? t('v2auth.passwordRules')
      : null;

  async function save() {
    if (busy) return;
    setSubmitted(true);
    if (!passwordOk(checks)) return passwordRef.current?.focus();
    setBusy(true);
    setServer(null);
    setSame(false);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setBusy(false);
      if (error.code === 'same_password') {
        setSame(true);
        passwordRef.current?.focus();
      } else {
        setServer(t(authErrorKey(error)));
      }
      return;
    }
    // Інші пристрої виходять; цей лишається всередині. Невдача тут не
    // скасовує вже збережений пароль — просто йдемо далі.
    await supabase.auth.signOut({ scope: 'others' }).catch(() => undefined);
    forgetAuthEmail();
    navigate('/lists', { replace: true });
  }

  async function resend() {
    if (busy) return;
    setEmailSubmitted(true);
    if (problem) return emailRef.current?.focus();
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
    setSent(true);
  }

  if (loading) {
    return (
      <AuthFrameV2>
        <p className="v2-lede" role="status">
          {t('common.loading')}…
        </p>
      </AuthFrameV2>
    );
  }

  // Сесію створює саме посилання з листа. Немає її — посилання не спрацювало.
  if (linkError || !session) {
    return (
      <AuthFrameV2>
        <form
          className="v2-stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void resend();
          }}
        >
          <IconCircleV2 icon={KeyRound} tone="warm" />
          <h1 className="v2-title">{t('v2auth.update.deadTitle')}</h1>
          <p className="v2-lede">{t('v2auth.update.deadBody')}</p>
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          {sent ? (
            <NoteV2 tone="info">{t('v2auth.reset.sentBody', { email: email.trim() })}</NoteV2>
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
              <SubmitV2 busy={busy} label={t('v2auth.update.deadSubmit')} busyLabel={t('v2auth.sending')} />
            </>
          )}
        </form>
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
          void save();
        }}
      >
        <BackHeaderV2 to="/login" title={t('v2auth.update.title')} />
        <p className="v2-lede">{t('v2auth.update.for', { email: account })}</p>
        {server && <NoteV2 tone="error">{server}</NoteV2>}
        {/* Приховане поле з поштою: без нього менеджер паролів не знає, до
            якого акаунта належить новий пароль. */}
        <input type="email" name="username" autoComplete="username" value={account} readOnly hidden />
        <PasswordFieldV2
          ref={passwordRef}
          label={t('v2auth.update.field')}
          name="password"
          autoComplete="new-password"
          value={password}
          error={passwordError}
          describedBy={rulesId}
          onChange={(e) => {
            setPassword(e.target.value);
            setSame(false);
          }}
        />
        <RulesV2
          id={rulesId}
          rules={[
            { label: t('v2auth.rules.long', { n: MIN_PASSWORD }), met: checks.long },
            { label: t('v2auth.rules.notEmail'), met: checks.notEmail },
            { label: t('v2auth.rules.notCommon'), met: checks.notCommon },
          ]}
        />
        <SubmitV2 busy={busy} label={t('v2auth.update.submit')} busyLabel={t('v2auth.update.submitting')} />
        <p className="v2-hint">{t('v2auth.update.others')}</p>
      </form>
    </AuthFrameV2>
  );
}
