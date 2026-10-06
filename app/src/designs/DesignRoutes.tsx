import { Suspense, lazy } from 'react';
import { useI18n } from '../lib/i18n';
import { useDesign } from '../lib/theme';
import DesignV2Routes from './v2/RoutesV2';

/**
 * Перемикач версій дизайну на рівні маршрутів.
 *
 * v2 — не тема й не набір стилів: це інші екрани та інший порядок кроків.
 * Тому розділення проходить тут, по таблиці маршрутів, а не всередині
 * компонентів. Гілка `design === 'v2'` у кожному екрані дала б застосунок,
 * який неможливо ні читати, ні викинути (ADR-032).
 *
 * **v2 завантажується одразу, v1 — ліниво** (ADR-052). v2 — усталена версія,
 * її бачать усі, тож зайвий запит перед першим екраном коштував би їм, а не
 * тим поодиноким, хто сам повернувся на v1. До ADR-052 було навпаки.
 *
 * Спільне для обох версій лишається вище за це місце: провайдери, сесія,
 * мова, синхронізація вигляду й гостьові адреси — усе в `App.tsx`. Версія
 * міняє екрани, а не те, звідки застосунок бере дані.
 */
const DesignV1Routes = lazy(() => import('./v1/RoutesV1'));
const GuestV2 = lazy(() => import('./v2/screens/GuestV2'));

/** Поки лінивий модуль вантажиться. */
function Loading() {
  const { t } = useI18n();
  return (
    <div className="booting" role="status" aria-live="polite">
      {t('common.loading')}…
    </div>
  );
}

export function DesignRoutes() {
  const design = useDesign();

  if (design === 'v2') return <DesignV2Routes />;

  return (
    <Suspense fallback={<Loading />}>
      <DesignV1Routes />
    </Suspense>
  );
}

/**
 * Гостьова v2 (`/l/…`) — поза вибором версії: її показує адреса, а не
 * `wl.design` (ADR-039). Маршрут стоїть в `App.tsx`. Лінива: свій чанк, який
 * власнику, що відкрив застосунок, не потрібен.
 */
export function GuestV2Screen() {
  return (
    <Suspense fallback={<Loading />}>
      <GuestV2 />
    </Suspense>
  );
}
