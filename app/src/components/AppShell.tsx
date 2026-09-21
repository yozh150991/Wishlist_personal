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
 * Навігація в розмітці одна; медіазапит у CSS міняє її композицію й вибирає
 * короткий підпис чи довгий. Дві навігації з прихованою давали зчитувачу
 * екрана два однакових орієнтири й по два посилання на розділ.
 *
 * Обидва підписи лежать у розмітці й ховаються через CSS, тож правила
 * `.mainnav__short` / `.mainnav__long` у `styles.css` — не оформлення, а
 * умова правильності: без них у доступну назву потрапляють обидва, і
 * посилання зветься «ПосиланняМої посилання».
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
        {/*
          Навігація одна на обидві розкладки, а не дві з прихованою.
          Дві давали зчитувачу екрана два однакових орієнтири «Розділи» й по
          два посилання на кожен розділ — а Playwright чесно знаходив обидва.
          Підпис короткий чи довгий вибирає CSS: текст, схований `display:none`,
          у доступну назву не потрапляє, тож вона завжди рівно одна.
        */}
        <nav className="mainnav" aria-label={t('nav.label')}>
          <Link className="mainnav__brand" to="/lists">
            {t('app.name')}
          </Link>

          {NAV.map((item) => (
            <NavLink key={item.to} className="mainnav__item" to={item.to}>
              <Icon name={item.icon} size={19} />
              <span className="mainnav__short">{t(item.key)}</span>
              <span className="mainnav__long">{t(item.longKey)}</span>
            </NavLink>
          ))}

          <div className="mainnav__who">
            {/* Окремий ключ без підстановки: `settings.signedInAs` — це
                «Ти увійшов як {email}», і без другого аргументу дужки з
                назвою змінної їхали просто в інтерфейс. Тут пошта стоїть
                нижче окремим рядком, тож підпис потрібен без неї. */}
            <span className="meta muted">{t('nav.signedInAs')}</span>
            <span className="mainnav__mail">{session?.user.email}</span>
            <button type="button" className="btn btn--ghost btn--compact" onClick={() => void leave()}>
              {t('nav.signOut')}
            </button>
          </div>
        </nav>

        <div className="shell__main">
          <Banners />
          <Outlet />
        </div>
      </div>
    </StaleProvider>
  );
}
