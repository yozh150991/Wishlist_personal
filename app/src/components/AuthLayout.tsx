import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { LanguagePicker } from './LanguagePicker';

/**
 * Ліва панель показує суть продукту без слів-обіцянок:
 * список, у якому відкрита рівно одна позиція, решта розмиті.
 */
function PrivacyDemo() {
  const rows = [true, true, false, true, true];
  return (
    <div className="privacy-demo" aria-hidden="true">
      {rows.map((hidden, i) => (
        <div className="privacy-demo__row" data-hidden={hidden} key={i}>
          <span className="privacy-demo__thumb" />
          <span className="privacy-demo__bar" style={{ width: `${58 + ((i * 13) % 34)}%` }} />
          <span className="privacy-demo__price" />
        </div>
      ))}
    </div>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="auth">
      <aside className="auth__aside">
        <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
          <h2 className="display" style={{ fontSize: 'var(--t-3xl)' }}>
            {t('auth.aside.headline')}
          </h2>
          <p className="lede">{t('auth.aside.body')}</p>
        </div>
        <PrivacyDemo />
      </aside>
      <div className="auth__form-wrap">
        <LanguagePicker className="auth__lang" />
        {children}
      </div>
    </div>
  );
}
