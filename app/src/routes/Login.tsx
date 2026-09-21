import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { authErrorKey } from '../lib/authErrors';
import { safeNext } from '../lib/safeNext';
import { AuthLayout } from '../components/AuthLayout';
import { Field, Note, SubmitButton } from '../components/ui';

export default function Login() {
  const { t } = useI18n();
  const { session, loading } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only same-origin paths; anything else falls back to /lists.
  const next = safeNext(params.get('next'));
  if (!loading && session) return <Navigate to={next} replace />;

  async function onSubmit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) setError(t(authErrorKey(err)));
    setBusy(false);
  }

  return (
    <AuthLayout>
      {/*
        Справжня <form> потрібна менеджерам паролів: вони пропонують зберегти
        й підставити пароль саме для форми з полями username / current-password
        і кнопкою submit. Enter відправляє форму сам, без обробників на полях.
        noValidate — повідомлення про помилки наші й перекладені, а не браузерні.
      */}
      <form
        className="auth__form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <h1>{t('auth.login.title')}</h1>

        {/* Помилка стоїть над полями, а не під кнопкою: саме до полів людина
            повертається очима, і саме вони підсвічені як хибні. */}
        {error && <Note tone="error">{error}</Note>}

        <Field
          label={t('auth.email')}
          name="email"
          type="email"
          autoComplete="username"
          invalid={Boolean(error)}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label={t('auth.password')}
          name="password"
          type="password"
          autoComplete="current-password"
          invalid={Boolean(error)}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <SubmitButton
          busy={busy}
          label={t('auth.login.submit')}
          busyLabel={t('auth.login.submitting')}
        />

        <p className="auth__switch">
          {t('auth.login.toRegister')} <Link to="/register">{t('auth.login.toRegisterCta')}</Link>
          {' · '}
          <Link to="/reset">{t('auth.login.forgot')}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
