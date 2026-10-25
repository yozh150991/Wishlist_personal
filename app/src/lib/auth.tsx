import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { clearCache, setCacheOwner } from './cache';
import { forgetAllPushSubscriptions, forgetPushOnThisDevice } from './notifications';

type AuthState = {
  session: Session | null;
  /** true, поки перша перевірка сесії не завершилась. Під час неї не редіректимо. */
  loading: boolean;
  /** Виставляється, коли користувач прийшов за посиланням скидання пароля. */
  recovery: boolean;
  signOut: () => Promise<void>;
  /**
   * Вихід скрізь (ADR-074): Supabase відкликає всі сесії акаунта, а push
   * більше не йде на жоден пристрій. Тут теж виходимо — подія `SIGNED_OUT`
   * стирає офлайн-копії й чергу, як за звичайного виходу.
   */
  signOutEverywhere: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    let alive = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setCacheOwner(data.session?.user.id ?? null);
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setCacheOwner(next?.user.id ?? null);
      setSession(next);
      setLoading(false);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_OUT') {
        setRecovery(false);
        // Офлайн-копії списків стираємо саме тут, а не в signOut: вийти можна
        // і з іншої вкладки, і через протухлу сесію. На спільному компʼютері
        // чужі списки не мають лишатися в IndexedDB (ADR-028).
        void clearCache();
        // І сповіщення цього власника на пристрій більше не приходять (ADR-049).
        // Сесії вже немає, тож лише підписка браузера — рядок прибере сервіс.
        void forgetPushOnThisDevice(false);
      }
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      recovery,
      signOut: async () => {
        // Поки сесія жива — прибрати й рядок пристрою на сервері.
        await forgetPushOnThisDevice(true);
        await supabase.auth.signOut();
      },
      signOutEverywhere: async () => {
        // Спершу сервер: без мережі не виходимо зовсім, а не наполовину.
        await forgetAllPushSubscriptions();
        await forgetPushOnThisDevice(false);
        const { error } = await supabase.auth.signOut({ scope: 'global' });
        if (error) throw error;
      },
    }),
    [session, loading, recovery],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth використано поза AuthProvider');
  return v;
}
