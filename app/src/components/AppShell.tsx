import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { OutboxNotice } from './OutboxNotice';
import { pendingCount } from '../lib/outbox';

export function AppShell() {
  const { t } = useI18n();
  const { session, signOut } = useAuth();

  /**
   * Вихід стирає чергу разом із кешем (там ті самі особисті дані), тож
   * незакінчену чергу не викидаємо мовчки — спершу питаємо.
   */
  async function leave() {
    const waiting = session?.user.id ? await pendingCount(session.user.id) : 0;
    if (waiting > 0 && !window.confirm(t('outbox.confirmSignOut', { n: waiting }))) return;
    await signOut();
  }

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
        <button className="btn btn--bare" onClick={() => void leave()}>
          {t('nav.signOut')}
        </button>
      </header>
      <main className="shell__main">
        <OutboxNotice />
        <Outlet />
      </main>
    </div>
  );
}
