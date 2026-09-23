import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../../components/RequireAuth';
import { AppShell } from '../../components/AppShell';
import Login from '../../routes/Login';
import Register from '../../routes/Register';
import ResetPassword from '../../routes/ResetPassword';
import UpdatePassword from '../../routes/UpdatePassword';
import Lists from '../../routes/Lists';
import ListDetail from '../../routes/ListDetail';
import Shares from '../../routes/Shares';
import SharedList from '../../routes/SharedList';
import Settings from '../../routes/Settings';
import NotFound from '../../routes/NotFound';

/**
 * Таблиця маршрутів дизайну v1 — нинішнього застосунку.
 *
 * Екрани лишилися там, де й були (`src/routes/`, `src/components/`): переїзд
 * у `designs/v1/` перейменував би півсотні імпортів і посварив би кожну
 * незакінчену гілку, не давши натомість нічого. Коли v1 піде на спокій, ці
 * теки зникнуть разом із цим файлом (ADR-032).
 *
 * v2 не переозначує окремі екрани цієї таблиці — у неї своя, повна. Саме тому
 * вона може мати інші адреси, інший порядок кроків і інший каркас.
 */
export default function DesignV1Routes() {
  return (
    <Routes>
      {/* Публічні */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/reset" element={<ResetPassword />} />
      <Route path="/update-password" element={<UpdatePassword />} />
      {/* Гостьовий перегляд: без каркаса застосунку і без входу. */}
      <Route path="/s/:token" element={<SharedList />} />

      {/* Захищені */}
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/lists" element={<Lists />} />
        <Route path="/lists/:id" element={<ListDetail />} />
        <Route path="/shares" element={<Shares />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="/" element={<Navigate to="/lists" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
