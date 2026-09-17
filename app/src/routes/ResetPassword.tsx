import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, publicOrigin } from '../lib/supabase';
import { useI18n } from '../lib/i18n';
import { AuthLayout } from '../components/AuthLayout';
import { Field, Note } from '../components/ui';

export default function ResetPassword() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (!email) return setError(t('errors.emailRequired'));
    setBusy(true);
    setError(null);
    // Відповідь однакова незалежно від того, чи існує акаунт:
    // інакше форма перетворюється на перевірку, чи зареєстрована адреса.
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${publicOrigin}/update-password`,
    });
    setSent(true);
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
        <h1>{t('auth.reset.title')}</h1>
        {sent ? (
          <Note tone="success">{t('auth.reset.sent', { email })}</Note>
        ) : (
          <>
            <p className="lede">{t('auth.reset.body')}</p>
            {error && <Note tone="error">{error}</Note>}
            <Field
              label={t('auth.email')}
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" className="btn btn--wide" disabled={busy}>
              {t('auth.reset.submit')}
            </button>
          </>
        )}
        <p className="auth__switch">
          <Link to="/login">{t('auth.reset.back')}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
