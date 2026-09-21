import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { pendingCount } from '../lib/outbox';
import { Banners, StaleProvider } from './Banners';
import { Icon } from './Icon';
import type { IconName } from './Icon';

/**
 * Каркас застосунку.
 *
 * На телефоні навігація внизу — великим пальцем дотягуєшся, не перехоплюючи
 * телефон. На десктопі вона переїжджає в бічну колонку 232 px, бо смуга на всю
 * ширину екрана під трьома пунктами виглядає порожньою, а внизу 27-дюймового
 * монітора її ніхто не шукає. Пункти й порядок ті самі — змінюється тільки
 * композиція, тож звичка переноситься між пристроями.
 *
 * Перемикає їх один медіазапит у CSS: обидві навігації в розмітці завжди, але
 * видима рівно одна. Дублювання посилань для зчитувача екрана прикрите
 * `aria-hidden` на тій, що схована.
 */

const NAV: { to: string; icon: IconName; key: string; longKey: string }[] = [
  { to: '/lists', icon: 'list', key: 'nav.lists', longKey: 'nav.lists' },
  { to: '/shares', icon: 'link', key: 'nav.shares', longKey: 'nav.sharesLong' },
  { to: '/settings', icon: 'sliders', key: 'nav.settings', longKey: 'nav.settings' },
];

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
    <StaleProvider>
      <div className="shell">
        <nav className="sidenav" aria-label={t('nav.label')}>
          <Link className="sidenav__brand" to="/lists">
            {t('app.name')}
          </Link>
          {NAV.map((item) => (
            <NavLink key={item.to} className="sidenav__item" to={item.to}>
              <Icon name={item.icon} size={19} />
              {t(item.longKey)}
            </NavLink>
          ))}
          <div className="sidenav__who">
            <span className="meta muted">{t('settings.signedInAs')}</span>
            <span className="sidenav__mail">{session?.user.email}</span>
            <button type="button" className="btn btn--ghost btn--compact" onClick={() => void leave()}>
              {t('nav.signOut')}
            </button>
          </div>
        </nav>

        <div className="shell__main">
          <Banners />
          <Outlet />
        </div>

        <nav className="tabbar" aria-label={t('nav.label')}>
          {NAV.map((item) => (
            <NavLink key={item.to} className="tabbar__item" to={item.to}>
              <Icon name={item.icon} size={20} />
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
      </div>
    </StaleProvider>
  );
}
