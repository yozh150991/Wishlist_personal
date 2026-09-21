import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { Icon } from '../components/Icon';

/**
 * 404 живе поза каркасом застосунку: сюди потрапляють і з гостьового
 * посилання з одруківкою, тобто люди без акаунта. Показувати їм навігацію
 * застосунку нема сенсу — але «До списків» лишається для своїх.
 */
export default function NotFound() {
  const { t } = useI18n();
  return (
    <main className="empty empty--page">
      <span className="empty__icon empty__icon--accent">
        <Icon name="search" size={40} />
      </span>
      <h1>{t('common.notFound')}</h1>
      <p className="lede">{t('common.notFoundBody')}</p>
      <Link className="btn btn--primary" to="/lists">
        {t('common.backHome')}
      </Link>
    </main>
  );
}
