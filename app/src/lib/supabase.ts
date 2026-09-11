import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    'Немає VITE_SUPABASE_URL або VITE_SUPABASE_PUBLISHABLE_KEY. ' +
      'Скопіюй .env.example у app/.env.local і заповни значення з дашборду Supabase.',
  );
}

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

/** Базова адреса застосунку для листів підтвердження і скидання пароля. */
export const publicOrigin = import.meta.env.VITE_PUBLIC_ORIGIN ?? window.location.origin;
