import { useI18n } from '../../../lib/i18n';
import { useTheme } from '../../../lib/theme';

/**
 * Єдиний екран v2 до того, як приїде пакет передачі.
 *
 * Він існує не «щоб було»: без нього вибір v2 давав би порожній застосунок
 * без жодного способу повернутися — таблиця маршрутів v2 своїх Налаштувань
 * ще не має. Тому тут завжди є дорога назад, і вона не залежить від того,
 * чи встиг щось відрендерити решта застосунку.
 *
 * Другий, надійніший вихід — адреса `?design=v1`: його ставить інлайновий
 * скрипт у `<head>` ще до React, тож він працює навіть тоді, коли v2 падає
 * на першому ж рендері (ADR-032).
 *
 * Цей файл видаляється разом із першим справжнім екраном v2.
 */
export default function Placeholder() {
  const { t } = useI18n();
  const { setDesign } = useTheme();

  return (
    <div className="booting" role="status" aria-live="polite">
      <h1>{t('design.emptyTitle')}</h1>
      <p>{t('design.emptyBody')}</p>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => {
          setDesign('v1');
          // Повне перезавантаження, а не navigate: адреси v1 і v2 не зобовʼязані
          // збігатися, і найнадійніший спосіб опинитися на робочому екрані —
          // зайти в v1 з кореня.
          window.location.assign('/');
        }}
      >
        {t('design.backToV1')}
      </button>
    </div>
  );
}
