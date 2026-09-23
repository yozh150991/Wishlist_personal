import { Suspense, lazy } from 'react';
import { useI18n } from '../lib/i18n';
import { useDesign } from '../lib/theme';
import DesignV1Routes from './v1/RoutesV1';

/**
 * Перемикач версій дизайну на рівні маршрутів.
 *
 * v2 — не тема й не набір стилів: це інші екрани та інший порядок кроків.
 * Тому розділення проходить тут, по таблиці маршрутів, а не всередині
 * компонентів. Гілка `design === 'v2'` у кожному екрані дала б застосунок,
 * який неможливо ні читати, ні викинути (ADR-032).
 *
 * **v1 завантажується одразу, v2 — ліниво.** v1 сьогодні бачать усі, і зайвий
 * запит перед першим екраном коштував би їм відчутніше, ніж економія на коді
 * v2, якого вони ніколи не відкриють. Коли v2 стане усталеною, порядок
 * міняється на протилежний — це один рядок.
 *
 * Спільне для обох версій лишається вище за це місце: провайдери, сесія,
 * мова, синхронізація вигляду — усе в `App.tsx`. Версія міняє екрани, а не
 * те, звідки застосунок бере дані.
 */
const DesignV2Routes = lazy(() => import('./v2/RoutesV2'));

export function DesignRoutes() {
  const design = useDesign();
  const { t } = useI18n();

  if (design === 'v1') return <DesignV1Routes />;

  return (
    <Suspense
      fallback={
        <div className="booting" role="status" aria-live="polite">
          {t('common.loading')}…
        </div>
      }
    >
      <DesignV2Routes />
    </Suspense>
  );
}
