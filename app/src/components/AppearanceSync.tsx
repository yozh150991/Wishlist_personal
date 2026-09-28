import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { isScheme, isTheme } from '../lib/appearance';

/**
 * Тримає вигляд власника в профілі, щоб він переїжджав між пристроями.
 *
 * Три поля: тема, схема смаку й висока контрастність. Чому не просто
 * `localStorage`: людина вмикає високу контрастність на телефоні саме тому, що
 * погано бачить, — і відкриває ноутбук із тією самою потребою. Прив'язка до
 * браузера змусила б вмикати її заново на кожному пристрої.
 *
 * Порядок при вході навмисний: **профіль виграє в localStorage**. Локальне
 * значення потрібне лише для того, щоб інлайновий скрипт у `<head>` поставив
 * атрибути до першого рендера; щойно профіль приїхав, він стає істиною й
 * одразу лягає назад у localStorage — тож наступний запуск не блимне.
 *
 * Гостя це не стосується: у нього акаунта немає, і на гостьовій сторінці цього
 * компонента просто немає в дереві. Його тема й контраст лишаються в його
 * браузері й на сервер не їдуть — інакше це був би ще один сигнал про те, що
 * хтось відкрив посилання (CLAUDE.md §3.2).
 *
 * Нічого не рендерить.
 */
export function AppearanceSync() {
  const { session } = useAuth();
  const { theme, scheme, highContrast, setTheme, setScheme, setHighContrast } = useTheme();

  const userId = session?.user.id;
  /** Профіль прочитано — далі цей компонент лише пише. */
  const pulled = useRef<string | null>(null);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || pulled.current === userId) return;
    let alive = true;

    void supabase
      .from('profiles')
      .select('theme, scheme, high_contrast')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive || error || !data) return;
        pulled.current = userId;
        const row = data as { theme: unknown; scheme: unknown; high_contrast: unknown };
        const nextTheme = isTheme(row.theme) ? row.theme : theme;
        const nextScheme = isScheme(row.scheme) ? row.scheme : scheme;
        const nextContrast = typeof row.high_contrast === 'boolean' ? row.high_contrast : highContrast;
        setTheme(nextTheme);
        setScheme(nextScheme);
        setHighContrast(nextContrast);
        // Щоб наступний запис не вважав прочитане за зміну й не слав її назад.
        sent.current = `${userId}:${nextTheme}:${nextScheme}:${nextContrast}`;
      });

    return () => {
      alive = false;
    };
    // theme, scheme і highContrast свідомо поза залежностями: профіль читається
    // один раз на сесію, інакше кожна зміна перезапускала б читання й відкочувала вибір.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, setTheme, setScheme, setHighContrast]);

  useEffect(() => {
    if (!userId || pulled.current !== userId) return;
    const key = `${userId}:${theme}:${scheme}:${highContrast}`;
    if (sent.current === key) return;
    sent.current = key;

    void supabase
      .from('profiles')
      .update({ theme, scheme, high_contrast: highContrast })
      .eq('id', userId)
      .then(({ error }) => {
        // Не критично: вибір уже застосований і лежить у localStorage. Спробуємо
        // ще раз при наступній зміні.
        if (error) sent.current = null;
      });
  }, [userId, theme, scheme, highContrast]);

  return null;
}
