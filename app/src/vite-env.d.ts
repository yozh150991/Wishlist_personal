/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  readonly VITE_PARSER_URL?: string;
  readonly VITE_PUBLIC_ORIGIN?: string;
  /** '1' — показувати вхід через Google (провайдер налаштовано в Supabase). */
  readonly VITE_AUTH_GOOGLE?: string;
  /** Пошта для запитів щодо даних на сторінці /privacy; без неї рядка з контактом немає. */
  readonly VITE_CONTACT_EMAIL?: string;
  /** Публічний ключ VAPID для push (ADR-049). Без нього push вимкнений, лишається пошта. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  /** Посилання iCloud на готову Команду для iPhone (ADR-077); без нього — лише інструкція. */
  readonly VITE_IOS_SHORTCUT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
