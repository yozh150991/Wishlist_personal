import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/commissioner';
import '@fontsource-variable/source-serif-4';
import './styles.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Немає #root у index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
