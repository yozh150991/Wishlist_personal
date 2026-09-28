import type { ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Link2, List, SlidersHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { useMediaQuery } from '../../lib/media';
import { SignOutV2 } from './screens/CommonV2';

/**
 * Каркас екранів власника v2.
 *
 * На телефоні навігація внизу — під великим пальцем; на десктопі (від 56rem)
 * переїжджає в бічну колонку 232 px з рядком «Акаунт: …» і виходом. Пункти й
 * порядок ті самі: Списки, Посилання, Налаштування.
 *
 * Навігація в розмітці одна, а короткий чи довгий підпис вибирає рендер
 * (`useMediaQuery`), не CSS: дві копії дали б зчитувачу екрана два однакові
 * орієнтири (CLAUDE.md §4).
 */

const NAV: { to: string; icon: LucideIcon; short: 'lists' | 'shares' | 'settings'; long: 'lists' | 'sharesLong' | 'settings' }[] = [
  { to: '/lists', icon: List, short: 'lists', long: 'lists' },
  { to: '/shares', icon: Link2, short: 'shares', long: 'sharesLong' },
  { to: '/settings', icon: SlidersHorizontal, short: 'settings', long: 'settings' },
];

export const DESKTOP = '(min-width: 56rem)';

/**
 * Захищені екрани. Поки сесія перевіряється — тиха заглушка, не редірект:
 * інакше F5 викидав би на вхід (ADR-016). Немає сесії — на вхід із `next`.
 */
export function RequireAuthV2({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const { pathname, search } = useLocation();
  const { t } = useI18n();
  if (loading) {
    return (
      <div className="v2-boot" role="status" aria-live="polite">
        <span className="v2-sr">{t('common.loading')}</span>
      </div>
    );
  }
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <>{children}</>;
}

export function ShellV2() {
  const { t } = useI18n();
  const { session } = useAuth();
  const desktop = useMediaQuery(DESKTOP);

  const label = (key: 'lists' | 'shares' | 'sharesLong' | 'settings') => {
    switch (key) {
      case 'lists':
        return t('nav.lists');
      case 'shares':
        return t('nav.shares');
      case 'sharesLong':
        return t('nav.sharesLong');
      default:
        return t('nav.settings');
    }
  };

  return (
    <div className="v2-shell">
      <nav className="v2-nav" aria-label={t('v2app.nav.label')}>
        {desktop && <p className="v2-nav__brand">{t('app.name')}</p>}
        <ul className="v2-nav__list">
          {NAV.map(({ to, icon: Icon, short, long }) => (
            <li key={to}>
              <NavLink to={to} className="v2-nav__item">
                <Icon size={22} strokeWidth={2.75} aria-hidden="true" />
                <span>{label(desktop ? long : short)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        {desktop && session && (
          <div className="v2-nav__who">
            <span className="v2-nav__who-label">{t('v2app.nav.account')}</span>
            <span className="v2-nav__who-email">{session.user.email}</span>
            <SignOutV2 className="v2-btn v2-btn--ghost v2-nav__signout" />
          </div>
        )}
      </nav>
      <div className="v2-shell__main">
        <Outlet />
      </div>
    </div>
  );
}
