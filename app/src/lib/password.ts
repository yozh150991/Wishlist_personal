/**
 * Вимоги до пароля — одні для реєстрації й для нового пароля (потоки Q, T).
 *
 * Людина бачить їх **наперед** і відмічає під час введення, а не дізнається
 * про них з помилки після натискання. Кнопка при цьому не блокується:
 * натиск із невиконаними вимогами переводить фокус на поле пароля.
 *
 * Це підказка, а не захист. Остаточне слово за Supabase: мінімальна довжина
 * задана в налаштуваннях Auth, а перевірку на злиті паролі він робить сам,
 * якщо її ввімкнено на тарифі. Короткий перелік нижче ловить лише
 * найочевидніше — те, що людина набирає «аби було».
 */

export const MIN_PASSWORD = 8;

/**
 * Найпоширеніші паролі з 8 символів і довших — коротші й так не пройдуть
 * першу вимогу. Порівнюються без урахування регістру. Перелік навмисно
 * короткий: це не словник для перебору, а сито для «12345678» і «qwerty123».
 */
const COMMON = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '0123456789',
  '87654321', '987654321', '11111111', '00000000', '88888888', '66666666',
  '12341234', '12344321', '11223344', '123123123', '147258369', '123456123',
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd',
  'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123', 'qwerty1234', '1qaz2wsx',
  'zaq12wsx', 'zaq1@wsx', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'q1w2e3r4t5',
  '1234qwer', 'qwer1234', 'asdfghjk', 'asdf1234', 'zxcvbnm1', 'abcd1234',
  'abc12345', 'aa123456', 'iloveyou', 'iloveyou1', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'starwars', 'trustno1', 'whatever',
  'welcome1', 'admin123', 'letmein1', 'computer', 'internet', 'michelle',
  'jennifer', 'charlie1', 'michael1', 'cocacola', 'blink182',
  // Польські й українські «класики» — застосунок тримовний.
  'kochamcie', 'kochamcie1', 'polska123', 'haslo123', 'zaq1xsw2',
  'ukraine1', 'ukraina1', 'kyiv2022', 'slavaukraini',
]);

export type PasswordChecks = {
  /** Щонайменше MIN_PASSWORD символів. */
  long: boolean;
  /** Не збігається з поштою і не є її частиною до «@». */
  notEmail: boolean;
  /** Немає в переліку найпоширеніших. */
  notCommon: boolean;
};

export function passwordChecks(password: string, email = ''): PasswordChecks {
  const p = password.trim().toLowerCase();
  const e = email.trim().toLowerCase();
  const local = e.split('@')[0] ?? '';
  return {
    long: password.length >= MIN_PASSWORD,
    notEmail: p.length > 0 && p !== e && (local.length < 3 || p !== local),
    notCommon: p.length > 0 && !COMMON.has(p),
  };
}

export function passwordOk(c: PasswordChecks): boolean {
  return c.long && c.notEmail && c.notCommon;
}
