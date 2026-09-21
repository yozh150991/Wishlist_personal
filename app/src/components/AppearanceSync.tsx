import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import type { Scheme, Theme } from '../lib/theme';

/**
 * Тримає вигляд власника в профілі, щоб він переїжджав між пристроями.
 *
 * Чому не просто `localStorage`: людина обирає Вугіль на телефоні саме тому,
 * що погано бачить, — і відкриває ноутбук із тією самою потребою. Прив'язка
 * до браузера змусила б обирати заново на кожному пристрої.
 *
 * Порядок при вході навмисний: **профіль виграє в localStorage**. Локальне
 * значення потрібне лише для того, щоб інлайновий скрипт у `<head>` поставив
 * атрибути до першого рендера; щойно профіль приїхав, він стає істиною й
 * одразу лягає назад у localStorage — тож наступний запуск не блимне.
 *
 * Гостя це не стосується: у нього акаунта немає, і на гостьовій сторінці цього
 * компонента просто немає в дереві. Його вибір лишається в його браузері й на
 * сервер не їде — інакше це був би ще один сигнал про те, що хтось відкрив
 * посилання (CLAUDE.md §3.2).
 *
 * Нічого не рендерить.
 */
export function AppearanceSync() {
  const { session } = useAuth();
  const { theme, scheme, setTheme, setScheme } = useTheme();

  const userId = session?.user.id;
  /** Профіль прочитано — далі цей компонент лише пише. */
  const pulled = useRef<string | null>(null);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || pulled.current === userId) return;
    let alive = true;

    void supabase
      .from('profiles')
      .select('theme, scheme')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive || error || !data) return;
        pulled.current = userId;
        const row = data as { theme: Theme | null; scheme: Scheme | null };
        if (row.theme) setTheme(row.theme);
        if (row.scheme) setScheme(row.scheme);
        // Щоб наступний запис не вважав прочитане за зміну й не слав її назад.
        sent.current = `${userId}:${row.theme ?? theme}:${row.scheme ?? scheme}`;
      });

    return () => {
      alive = false;
    };
    // theme і scheme свідомо поза залежностями: читаємо профіль один раз на
    // сесію, інакше кожна зміна теми перезапускала б читання й відкочувала вибір.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, setTheme, setScheme]);

  useEffect(() => {
    if (!userId || pulled.current !== userId) return;
    const key = `${userId}:${theme}:${scheme}`;
    if (sent.current === key) return;
    sent.current = key;

    void supabase
      .from('profiles')
      .update({ theme, scheme })
      .eq('id', userId)
      .then(({ error }) => {
        // Не критично: вибір уже застосований і лежить у localStorage. Спробуємо
        // ще раз при наступній зміні.
        if (error) sent.current = null;
      });
  }, [userId, theme, scheme]);

  return null;
}
