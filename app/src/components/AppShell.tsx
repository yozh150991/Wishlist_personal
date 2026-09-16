import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

export function AppShell() {
  const { t } = useI18n();
  const { signOut } = useAuth();

  return (
    <div className="shell">
      <header className="shell__bar">
        <Link className="shell__brand" to="/lists">
          {t('app.name')}
        </Link>
        <nav className="shell__nav">
          <NavLink to="/lists">{t('nav.lists')}</NavLink>
          <NavLink to="/shares">{t('nav.shares')}</NavLink>
          <NavLink to="/settings">{t('nav.settings')}</NavLink>
        </nav>
        <button className="btn btn--bare" onClick={() => void signOut()}>
          {t('nav.signOut')}
        </button>
      </header>
      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
