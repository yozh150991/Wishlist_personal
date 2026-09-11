import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="page">
      <div className="empty">
        <h2>{t('common.notFound')}</h2>
        <Link className="btn" to="/lists">
          {t('common.backHome')}
        </Link>
      </div>
    </div>
  );
}
