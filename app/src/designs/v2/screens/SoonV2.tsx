import { useLocation } from 'react-router-dom';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { designSwitchHref } from '../../../lib/authFlow';
import { SignOutV2 } from './CommonV2';

/**
 * Екран власника, якого у v2 ще немає, — усередині каркаса, тож навігація
 * лишається під рукою. Посилання веде на той самий екран у v1 (`?design=v1`
 * читає скрипт у `<head>`), а на місці Налаштувань — ще й акаунт і вихід:
 * на телефоні вийти більше ніде (крок 3в, ROADMAP).
 *
 * Зникає разом з останнім екраном власника, якого бракує.
 */
export default function SoonV2({ settings = false }: { settings?: boolean }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const { pathname, search } = useLocation();
  const v1 = designSwitchHref(pathname, search, 'v1');
  return (
    <main className="v2-page v2-soon">
      <h1 className="v2-page__title">{t('v2app.soon.title')}</h1>
      <p className="v2-lede">{t('v2app.soon.body')}</p>
      <a className="v2-btn v2-btn--primary" href={v1}>
        {t('v2app.soon.openV1')}
      </a>
      {settings && session && (
        <section className="v2-card" aria-labelledby="soon-account">
          <h2 className="v2-card__title" id="soon-account">
            {t('v2app.nav.account')}
          </h2>
          <p>{session.user.email}</p>
          <SignOutV2 className="v2-btn v2-btn--outline v2-btn--block" />
        </section>
      )}
    </main>
  );
}
