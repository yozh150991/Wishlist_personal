import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { authErrorKey } from '../lib/authErrors';
import { AuthLayout } from '../components/AuthLayout';
import { Field, Note } from '../components/ui';

export default function UpdatePassword() {
  const { t } = useI18n();
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (password.length < 8) return setError(t('errors.passwordShort'));
    if (password !== again) return setError(t('errors.passwordsDiffer'));

    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) setError(t(authErrorKey(err)));
    else navigate('/lists', { replace: true });
    setBusy(false);
  }

  return (
    <AuthLayout>
      <form
        className="auth__form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <h1>{t('auth.update.title')}</h1>

        {/* Посилання зі листа створює сесію. Немає сесії — посилання вже недійсне. */}
        {!loading && !session ? (
          <>
            <Note tone="error">{t('auth.update.expired')}</Note>
            <p className="auth__switch">
              <Link to="/reset">{t('auth.reset.submit')}</Link>
            </p>
          </>
        ) : (
          <>
            {error && <Note tone="error">{error}</Note>}
            {/*
              Приховане поле з поштою: без нього менеджер паролів не знає,
              до якого акаунта належить новий пароль, і пропонує зберегти
              його як окремий запис без логіна.
            */}
            <input
              type="email"
              name="username"
              autoComplete="username"
              value={session?.user.email ?? ''}
              readOnly
              hidden
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
            />
            <button type="submit" className="btn btn--wide" disabled={busy}>
              {t('auth.update.submit')}
            </button>
          </>
        )}
      </form>
    </AuthLayout>
  );
}
