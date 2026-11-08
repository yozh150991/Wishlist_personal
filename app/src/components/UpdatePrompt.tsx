import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useI18n } from '../lib/i18n';

const HOUR = 60 * 60 * 1000;
/** Не частіше за це перевіряти оновлення при поверненні застосунку на екран. */
const FOCUS_THROTTLE = 60 * 1000;

/**
 * Верхнє відкрите модальне вікно (`<dialog>` через `showModal()`), або `null`.
 *
 * Модальне вікно браузер малює у верхньому шарі, над усією сторінкою: жоден
 * `z-index` не підніме банер над ним, а все поза вікном ще й неактивне. Тому,
 * поки вікно відкрите, банер рендериться всередині нього — тоді він видимий і
 * натискається. Стежимо лише тоді, коли банер справді треба показати.
 */
function useModalHost(active: boolean): HTMLDialogElement | null {
  const [host, setHost] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const pick = () => {
      const open = Array.from(document.querySelectorAll('dialog')).filter((d) => d.open && d.matches(':modal'));
      setHost(open[open.length - 1] ?? null);
    };
    pick();
    // `showModal()` і `close()` ставлять і знімають атрибут `open` — його й ловимо.
    const observer = new MutationObserver(pick);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, [active]);
  return active ? host : null;
}

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
 * Де показувати: зазвичай поверх сторінки, а поки відкрите модальне вікно
 * (форма позиції тощо) — усередині нього (`useModalHost`).
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
  const host = useModalHost(needRefresh);

  if (!needRefresh) return null;

  const banner = (
    <div className="update-banner" role="status" data-testid="update-banner">
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

  return host ? createPortal(banner, host) : banner;
}
