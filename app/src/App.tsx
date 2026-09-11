import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { I18nProvider } from './lib/i18n';
import { ThemeProvider } from './lib/theme';
import { RequireAuth } from './components/RequireAuth';
import { AppShell } from './components/AppShell';
import Login from './routes/Login';
import Register from './routes/Register';
import ResetPassword from './routes/ResetPassword';
import UpdatePassword from './routes/UpdatePassword';
import Lists from './routes/Lists';
import Settings from './routes/Settings';
import NotFound from './routes/NotFound';

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              {/* Публічні */}
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/reset" element={<ResetPassword />} />
              <Route path="/update-password" element={<UpdatePassword />} />

              {/* Захищені */}
              <Route
                element={
                  <RequireAuth>
                    <AppShell />
                  </RequireAuth>
                }
              >
                <Route path="/lists" element={<Lists />} />
                <Route path="/settings" element={<Settings />} />
              </Route>

              <Route path="/" element={<Navigate to="/lists" replace />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </I18nProvider>
    </ThemeProvider>
  );
}
