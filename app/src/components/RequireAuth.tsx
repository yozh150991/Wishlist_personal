import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

/**
 * Поки сесія завантажується — показуємо скелетон, а НЕ редіректимо.
 * Інакше F5 на захищеній сторінці щоразу викидав би на вхід.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const { t } = useI18n();
  const location = useLocation();

  if (loading) {
    return (
      <div className="booting" role="status" aria-live="polite">
        {t('common.loading')}…
      </div>
    );
  }

  if (!session) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <>{children}</>;
}
