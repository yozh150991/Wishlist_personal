import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

/**
 * Тримає `user_metadata.locale` рівним мові інтерфейсу.
 *
 * Supabase бачить у шаблонах листів лише `user_metadata` (як `.Data`), тож
 * без цього листи не знали б, якою мовою писати, і приходили б усіма трьома
 * (ADR-024). Нічого не рендерить.
 *
 * Мова листів = мова, якою користувач востаннє відкривав застосунок
 * під своїм акаунтом. На двох пристроях з різними мовами перемагає останній.
 */
export function LocaleSync() {
  const { session } = useAuth();
  const { locale } = useI18n();
  // Ключ «користувач:мова», щоб не слати той самий запит двічі,
  // але й не пропустити запис після зміни акаунта в тому ж браузері.
  const sent = useRef<string | null>(null);

  const userId = session?.user.id;
  const stored: unknown = session?.user.user_metadata?.locale;

  useEffect(() => {
    if (!userId || stored === locale) return;
    const key = `${userId}:${locale}`;
    if (sent.current === key) return;
    sent.current = key;

    void supabase.auth.updateUser({ data: { locale } }).then(({ error }) => {
      // Не критично: лист просто прийде всіма мовами. Повторимо при наступній зміні сесії.
      if (error) sent.current = null;
    });
  }, [userId, stored, locale]);

  return null;
}
