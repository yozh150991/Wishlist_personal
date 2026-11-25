import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Обидві гарнітури самохостяться, а не тягнуться з Google Fonts: CSP пускає
// лише 'self', і офлайн-оболонка має відкриватися без мережі (ADR-031).
// Обидві покривають cyrillic, cyrillic-ext і latin-ext — тобто всі три мови.
import '@fontsource-variable/rubik';
import '@fontsource-variable/manrope';
import './styles.css';
// Стилі екранів (`designs/v2/v2.css`) імпортує таблиця маршрутів.
// Слухач beforeinstallprompt має зʼявитися до того, як браузер надішле подію.
import './lib/install';
import './lib/androidApp';
import App from './App';
import { prepareI18n } from './lib/i18n';
import { preloadScreens } from './designs/v2/RoutesV2';

const root = document.getElementById('root');
if (!root) throw new Error('Немає #root у index.html');

// Словник активної мови — окремий чанк (ROADMAP 8.24): перший рендер чекає на
// нього, щоб не показати ні ключів, ні тексту чужою мовою. До того на екрані
// фон теми — так само, як і під час будь-якого завантаження. Чанк гостьової
// просимо паралельно, щоб гість не чекав на два запити поспіль.
preloadScreens(window.location.pathname);
void prepareI18n().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
