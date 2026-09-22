import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { I18nProvider } from './lib/i18n';
import { ThemeProvider } from './lib/theme';
import { LocaleSync } from './components/LocaleSync';
import { AppearanceSync } from './components/AppearanceSync';
import { UpdatePrompt } from './components/UpdatePrompt';
import { DesignRoutes } from './designs/DesignRoutes';

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
            <DesignRoutes />
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </ThemeProvider>
  );
}
