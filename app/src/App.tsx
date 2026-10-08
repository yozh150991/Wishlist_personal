import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { I18nProvider } from './lib/i18n';
import { designOfPath, ThemeProvider, useRouteDesign } from './lib/theme';
import { LocaleSync } from './components/LocaleSync';
import { AppearanceSync } from './components/AppearanceSync';
import { UpdatePrompt } from './components/UpdatePrompt';
import SharedList from './routes/SharedList';
import { DesignRoutes, GuestV2Screen } from './designs/DesignRoutes';

/**
 * Верхня таблиця маршрутів: гостьові адреси — і все інше.
 *
 * Гостьову версію визначає адреса, а не вибір власника: `/s/…` — гостьова v1,
 * `/l/…` — гостьова v2 (ADR-039). У гостя немає сховища власника, а власник,
 * який щось перемкнув у себе, не має змінити того, що бачать рідні за вже
 * розданим посиланням. Тому ці маршрути стоять тут, **вище** за вибір версії;
 * решту адрес розводить `DesignRoutes` за `wl.design`.
 *
 * Тут же адреса каже провайдеру, яку версію ставити на `<html>`
 * (`useRouteDesign`) — при кожному переході, а не лише на старті.
 */
function Screens() {
  const { pathname } = useLocation();
  useRouteDesign(designOfPath(pathname));

  return (
    <Routes>
      {/* Гостьова v1. Особисте посилання: ключ ляже в браузер і зникне з адреси (ADR-035). */}
      <Route path="/s/:token" element={<SharedList />} />
      <Route path="/s/:token/g/:key" element={<SharedList />} />
      {/* Гостьова v2 (ADR-041): той самий токен і той самий ключ, інший префікс. */}
      <Route path="/l/:token" element={<GuestV2Screen />} />
      <Route path="/l/:token/g/:key" element={<GuestV2Screen />} />
      {/* Відписка з гостьового листа (ADR-054): секрет зникає з адреси одразу. */}
      <Route path="/l/:token/u/:mailToken" element={<GuestV2Screen />} />

      <Route path="*" element={<DesignRoutes />} />
    </Routes>
  );
}

/**
 * Каркас застосунку: провайдери, сесія, мова — усе, що спільне для обох
 * версій дизайну. Самі екрани живуть у таблицях маршрутів версій
 * (`designs/v1`, `designs/v2`), бо v2 переробляє й екрани, й порядок кроків
 * (ADR-032).
 */
export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <UpdatePrompt />
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AuthProvider>
            <LocaleSync />
            {/* Тема й схема власника їдуть у профіль, щоб переїжджали
                між пристроями. Гостьова сторінка цього не має. Версія
                дизайну не їде: поки v2 наповнюється, вона не має вмикатися
                сама на іншому пристрої. */}
            <AppearanceSync />
            <Screens />
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </ThemeProvider>
  );
}
