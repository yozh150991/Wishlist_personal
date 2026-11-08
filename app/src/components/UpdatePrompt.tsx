import { useRegisterSW } from 'virtual:pwa-register/react';
import { useI18n } from '../lib/i18n';

const HOUR = 60 * 60 * 1000;
/** Не частіше за це перевіряти оновлення при поверненні застосунку на екран. */
const FOCUS_THROTTLE = 60 * 1000;

/**
 * Банер «Є нова версія». Service Worker нової збірки чекає, поки людина
 * натисне «Оновити», і лише тоді підміняє застосунок і перезавантажує сторінку —
 * щоб не зірвати введення посеред діалогу.
 *
 * Коли шукати нову версію:
 * - щогодини — для вкладки, яка весь час відкрита на екрані;
 * - щоразу, як застосунок повертається на екран (`visibilitychange`), але не
 *   частіше разу на хвилину. На телефоні PWA майже ніколи не висить відкритою
 *   годину: її згортають і розгортають, а таймери у фоні браузер зупиняє.
 *   Без цього банер на телефоні зʼявлявся б через години.
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
      let last = Date.now();
      const check = () => {
        last = Date.now();
        // Без мережі перевірка однаково впаде; помилку ковтаємо — це не дія людини.
        registration.update().catch(() => undefined);
      };
      // Встановлений застосунок може бути відкритий днями без перезавантаження —
      // без періодичної перевірки він так і не дізнався б про нову версію.
      setInterval(check, HOUR);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - last >= FOCUS_THROTTLE) check();
      });
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="update-banner" role="status">
      <span>{t('pwa.updateReady')}</span>
      <div className="update-banner__actions">
        <button type="button" className="v2-btn v2-btn--ghost v2-btn--small" onClick={() => setNeedRefresh(false)}>
          {t('pwa.later')}
        </button>
        <button type="button" className="v2-btn v2-btn--primary v2-btn--small" onClick={() => void updateServiceWorker(true)}>
          {t('pwa.update')}
        </button>
      </div>
    </div>
  );
}
