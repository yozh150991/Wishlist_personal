import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, publicOrigin } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { authErrorKey } from '../lib/authErrors';
import { AuthLayout } from '../components/AuthLayout';
import { Field, Note } from '../components/ui';

export default function Register() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (password.length < 8) return setError(t('errors.passwordShort'));
    if (password !== again) return setError(t('errors.passwordsDiffer'));

    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${publicOrigin}/lists` },
    });
    if (err) setError(t(authErrorKey(err)));
    else setSent(true);
    setBusy(false);
  }

  if (sent) {
    return (
      <AuthLayout>
        <div className="auth__form">
          <h1>{t('auth.register.title')}</h1>
          <Note tone="success">{t('auth.register.checkEmail', { email })}</Note>
          <p className="auth__switch">
            <Link to="/login">{t('auth.reset.back')}</Link>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="auth__form">
        <h1>{t('auth.register.title')}</h1>
        {error && <Note tone="error">{error}</Note>}

        <Field
          label={t('auth.email')}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label={t('auth.password')}
          name="password"
          type="password"
          autoComplete="new-password"
          hint={t('auth.passwordHint')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label={t('auth.passwordAgain')}
          name="password2"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onSubmit()}
        />

        <button className="btn btn--wide" disabled={busy} onClick={() => void onSubmit()}>
          {t('auth.register.submit')}
        </button>

        <p className="auth__switch">
          {t('auth.register.toLogin')} <Link to="/login">{t('auth.register.toLoginCta')}</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
