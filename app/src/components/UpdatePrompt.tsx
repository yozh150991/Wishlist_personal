import { useRegisterSW } from 'virtual:pwa-register/react';
import { useI18n } from '../lib/i18n';

const HOUR = 60 * 60 * 1000;

/**
 * Банер «Є нова версія». Service Worker нової збірки чекає, поки людина
 * натисне «Оновити», і лише тоді підміняє застосунок і перезавантажує сторінку —
 * щоб не зірвати введення посеред діалогу.
 *
 * У режимі розробки Service Worker не реєструється (devOptions у vite.config),
 * і банер ніколи не зʼявляється.
 */
export function UpdatePrompt() {
  const { t } = useI18n();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // Встановлений застосунок може бути відкритий днями без перезавантаження —
      // без періодичної перевірки він так і не дізнався б про нову версію.
      setInterval(() => void registration.update(), HOUR);
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="update-banner" role="status">
      <span>{t('pwa.updateReady')}</span>
      <div className="update-banner__actions">
        <button type="button" className="btn btn--secondary" onClick={() => setNeedRefresh(false)}>
          {t('pwa.later')}
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void updateServiceWorker(true)}>
          {t('pwa.update')}
        </button>
      </div>
    </div>
  );
}
