import { useI18n } from '../lib/i18n';

export default function Lists() {
  const { t } = useI18n();
  return (
    <div className="page">
      <div className="page__head">
        <h1>{t('lists.title')}</h1>
      </div>

      <div className="empty">
        <h2>{t('lists.emptyTitle')}</h2>
        <p className="lede">{t('lists.emptyBody')}</p>
        <button className="btn" disabled title={t('lists.soon')}>
          {t('lists.create')}
        </button>
        <p className="small">{t('lists.soon')}</p>
      </div>
    </div>
  );
}
