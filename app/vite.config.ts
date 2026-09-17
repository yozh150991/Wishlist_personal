import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Якщо порт зайнятий, не перескакувати мовчки на 5174, а впасти з помилкою.
    // Інакше старий процес лишається на 5173, новий тихо сідає поруч, і браузер
    // та Playwright ходять на старий — з чужим токеном HMR і, можливо, з бойовою базою.
    strictPort: true,
  },
  build: { target: 'es2022', sourcemap: true },
});
