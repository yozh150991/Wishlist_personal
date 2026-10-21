import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useI18n } from '../../lib/i18n';
import NotFoundV2 from './screens/NotFoundV2';
import LoginV2 from './screens/LoginV2';
import RegisterV2 from './screens/RegisterV2';
import ResetV2 from './screens/ResetV2';
import NewPasswordV2 from './screens/NewPasswordV2';
import ListsV2 from './screens/ListsV2';
import NewListV2 from './screens/NewListV2';
import ListV2 from './screens/ListV2';
import SharesV2 from './screens/SharesV2';
import GiftsV2 from './screens/GiftsV2';
import SettingsV2 from './screens/SettingsV2';
import AddV2 from './screens/AddV2';
import { RequireAuthV2, ShellV2 } from './ShellV2';
// Стилі v2 — у головному пакеті: інших екранів у застосунку немає (ADR-065).
import './v2.css';

/** Гостьова — лінива: свій чанк, який власнику, що відкрив застосунок, не потрібен. */
const GuestV2 = lazy(() => import('./screens/GuestV2'));

/**
 * Таблиця маршрутів застосунку.
 *
 * З ADR-065 версія дизайну одна: v1 прибрано (ROADMAP, «Дизайн v2», крок 9),
 * разом із перемикачем у Налаштуваннях, `?design=` і атрибутом `data-design`.
 * Усе з `src/lib/` — дані, вигляд, офлайн-кеш, черга змін — як і раніше.
 *
 * Гостьові адреси: `/l/…` — гостьова сторінка (ADR-041); старі `/s/…` (їх
 * роздавала v1 до кроку 5г) ведуть на ту саму `/l/…` — токен, ключ гостя й
 * броні ті самі (ADR-057, п. 2).
 *
 * `/add` — «Додати в Wishlist» із системного «Поділитися» (крок 4б): без
 * каркаса, бо це аркуш поверх магазину. Невідома адреса — «Сторінки немає».
 */
/**
 * `/lists/:id/preview` — окрема сторінка превʼю з v1. У v2 превʼю — аркуш на
 * сторінці списку, тож стара адреса (закладка, історія) веде туди ж.
 */
function PreviewRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={`/lists/${id}`} replace />;
}

/**
 * `/s/{токен}…` → `/l/{токен}…` з тим самим хвостом (`/g/{ключ}`) і
 * параметрами. Особисте посилання з ключем далі обробляє гостьова: ключ ляже
 * в браузер і зникне з адреси (ADR-035, п. 4).
 */
function LegacyGuestRedirect() {
  const { token = '', '*': rest = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/l/${token}${rest ? `/${rest}` : ''}${search}`} replace />;
}

function Loading() {
  const { t } = useI18n();
  return (
    <div className="v2-boot" role="status" aria-live="polite">
      <span className="v2-sr">{t('common.loading')}</span>
    </div>
  );
}

function Guest() {
  return (
    <Suspense fallback={<Loading />}>
      <GuestV2 />
    </Suspense>
  );
}

export default function AppRoutes() {
  return (
    <Routes>
      {/* Гостьова. Особисте посилання: ключ ляже в браузер і зникне з адреси (ADR-035). */}
      <Route path="/l/:token" element={<Guest />} />
      <Route path="/l/:token/g/:key" element={<Guest />} />
      {/* Відписка з гостьового листа (ADR-054): секрет зникає з адреси одразу. */}
      <Route path="/l/:token/u/:mailToken" element={<Guest />} />
      <Route path="/s/:token/*" element={<LegacyGuestRedirect />} />

      <Route path="/login" element={<LoginV2 />} />
      <Route path="/register" element={<RegisterV2 />} />
      <Route path="/reset" element={<ResetV2 />} />
      <Route path="/update-password" element={<NewPasswordV2 />} />

      <Route
        path="/add"
        element={
          <RequireAuthV2>
            <AddV2 />
          </RequireAuthV2>
        }
      />

      <Route
        element={
          <RequireAuthV2>
            <ShellV2 />
          </RequireAuthV2>
        }
      >
        <Route path="/lists" element={<ListsV2 />} />
        <Route path="/lists/new" element={<NewListV2 />} />
        <Route path="/lists/:id" element={<ListV2 />} />
        <Route path="/lists/:id/preview" element={<PreviewRedirect />} />
        <Route path="/shares" element={<SharesV2 />} />
        <Route path="/gifts" element={<GiftsV2 />} />
        <Route path="/settings" element={<SettingsV2 />} />
      </Route>

      <Route path="/" element={<Navigate to="/lists" replace />} />
      <Route path="*" element={<NotFoundV2 />} />
    </Routes>
  );
}
