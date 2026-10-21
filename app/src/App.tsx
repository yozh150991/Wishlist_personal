import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { I18nProvider } from './lib/i18n';
import { ThemeProvider } from './lib/theme';
import { LocaleSync } from './components/LocaleSync';
import { AppearanceSync } from './components/AppearanceSync';
import { UpdatePrompt } from './components/UpdatePrompt';
import AppRoutes from './designs/v2/RoutesV2';

/**
 * Каркас застосунку: провайдери, сесія, мова, синхронізація вигляду. Екрани й
 * гостьові адреси — у таблиці маршрутів `designs/v2/RoutesV2.tsx`.
 *
 * Версія дизайну одна з ADR-065: v1 прибрано разом із перемикачем.
 */
export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <UpdatePrompt />
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AuthProvider>
            <LocaleSync />
            {/* Тема й схема власника їдуть у профіль, щоб переїжджали між
                пристроями. Гостьова сторінка цього не має. */}
            <AppearanceSync />
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </ThemeProvider>
  );
}
