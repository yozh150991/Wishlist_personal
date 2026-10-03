import { Link, useLocation } from 'react-router-dom';
import { useI18n } from '../../lib/i18n';
import { designSwitchHref } from '../../lib/authFlow';
import { Icon } from '../../components/Icon';

/**
 * `/add` у v1 — місток, а не екран (ADR-046).
 *
 * Маніфест спільний для обох версій, тож Android пропонує Wishlist у
 * системному «Поділитися» й тим, хто лишився на v1. Додавання з інших
 * застосунків — функція v2 (ADR-039: нова поведінка вмикається з інтерфейсу
 * v2), тож тут лише чесна розвилка: перемкнутися на новий вигляд із тим самим
 * поширеним — або лишитися й піти до своїх списків.
 */
export default function AddBridgeV1() {
  const { t } = useI18n();
  const { pathname, search } = useLocation();
  return (
    <main className="empty empty--page">
      <span className="empty__icon empty__icon--accent">
        <Icon name="plus" size={40} />
      </span>
      <h1>{t('v1add.title')}</h1>
      <p className="lede">{t('v1add.body')}</p>
      <a className="btn btn--primary" href={designSwitchHref(pathname, search, 'v2')}>
        {t('v1add.switch')}
      </a>
      <Link className="btn btn--ghost" to="/lists">
        {t('common.backHome')}
      </Link>
    </main>
  );
}
