import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { useI18n } from '../../../lib/i18n';

/** Адреси, якої немає (ADR-065): один екран із дорогою на «Мої списки». */
export default function NotFoundV2() {
  const { t } = useI18n();
  return (
    <main className="v2-page">
      <div className="v2-empty">
        <span className="v2-circle v2-circle--calm" aria-hidden="true">
          <Compass size={32} strokeWidth={2.75} />
        </span>
        <h1 className="v2-empty__title">{t('v2app.notFound.title')}</h1>
        <p className="v2-lede">{t('v2app.notFound.body')}</p>
        <Link to="/lists" className="v2-btn v2-btn--primary">
          {t('v2app.notFound.home')}
        </Link>
      </div>
    </main>
  );
}
