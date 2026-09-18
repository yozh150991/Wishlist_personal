import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { clearCache } from './cache';

type AuthState = {
  session: Session | null;
  /** true, поки перша перевірка сесії не завершилась. Під час неї не редіректимо. */
  loading: boolean;
  /** Виставляється, коли користувач прийшов за посиланням скидання пароля. */
  recovery: boolean;
  signOut: () => Promise<void>;
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
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setLoading(false);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_OUT') {
        setRecovery(false);
        // Офлайн-копії списків стираємо саме тут, а не в signOut: вийти можна
        // і з іншої вкладки, і через протухлу сесію. На спільному компʼютері
        // чужі списки не мають лишатися в IndexedDB (ADR-028).
        void clearCache();
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
        await supabase.auth.signOut();
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
