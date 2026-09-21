import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Обидві гарнітури самохостяться, а не тягнуться з Google Fonts: CSP пускає
// лише 'self', і офлайн-оболонка має відкриватися без мережі (ADR-031).
// Обидві покривають cyrillic, cyrillic-ext і latin-ext — тобто всі три мови.
import '@fontsource-variable/rubik';
import '@fontsource-variable/manrope';
import './styles.css';
// Слухач beforeinstallprompt має зʼявитися до того, як браузер надішле подію.
import './lib/install';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Немає #root у index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
