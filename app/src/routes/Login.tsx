import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { authErrorKey } from '../lib/authErrors';
import { AuthLayout } from '../components/AuthLayout';
import { Field, Note } from '../components/ui';

export default function Login() {
  const { t } = useI18n();
  const { session, loading } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const next = params.get('next') ?? '/lists';
  if (!loading && session) return <Navigate to={next} replace />;

  async function onSubmit() {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) setError(t(authErrorKey(err)));
    setBusy(false);
  }

  return (
    <AuthLayout>
      <div className="auth__form">
        <h1>{t('auth.login.title')}</h1>
        {error && <Note tone="error">{error}</Note>}

        <Field
          label={t('auth.email')}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onSubmit()}
        />
        <Field
          label={t('auth.password')}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onSubmit()}
        />

        <button className="btn btn--wide" disabled={busy} onClick={() => void onSubmit()}>
          {t('auth.login.submit')}
        </button>

        <p className="auth__switch">
          {t('auth.login.toRegister')} <Link to="/register">{t('auth.login.toRegisterCta')}</Link>
          {' · '}
          <Link to="/reset">{t('auth.login.forgot')}</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
