import { Route, Routes } from 'react-router-dom';
import Placeholder from './screens/PlaceholderV2';
import LoginV2 from './screens/LoginV2';
import RegisterV2 from './screens/RegisterV2';
import ResetV2 from './screens/ResetV2';
import NewPasswordV2 from './screens/NewPasswordV2';
// Стилі форми v2 їдуть разом із цим лінивим модулем (ADR-039, п. 9).
import './v2.css';

/**
 * Таблиця маршрутів дизайну v2.
 *
 * Свої екрани, свій каркас, свої адреси. Таблиця повна й незалежна саме для
 * цього — v2 переробляє флоу, а не перефарбовує екрани v1, тож ділити з нею
 * таблицю маршрутів означало б прив'язати новий флоу до порядку кроків
 * старого (ADR-032).
 *
 * Що v2 **не** переробляє — дані й палітру. Усе з `src/lib/` (Supabase,
 * автентифікація, вигляд, офлайн-кеш, черга змін, парсер, експорт) спільне з
 * v1 і не дублюється: інакше кожне виправлення довелося б робити двічі, а
 * інваріанти приватності (CLAUDE.md §3) роз'їхалися б між версіями непомітно.
 * Потрібен новий запит — він з'являється в `lib/` і доступний обом версіям.
 *
 * Гостьових адрес тут немає: `/s/…` і `/l/…` стоять вище, у `App.tsx`, бо
 * їхню версію визначає адреса, а не вибір власника (ADR-039).
 *
 * Крок 2 (ROADMAP): вхід, реєстрація, скидання й новий пароль — свої, без
 * кодів із пошти (ADR-042). Решта адрес — поки що заглушка з дорогою назад.
 */
export default function DesignV2Routes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginV2 />} />
      <Route path="/register" element={<RegisterV2 />} />
      <Route path="/reset" element={<ResetV2 />} />
      <Route path="/update-password" element={<NewPasswordV2 />} />
      <Route path="*" element={<Placeholder />} />
    </Routes>
  );
}
