import { supabase } from './supabase';
import { forgetPushOnThisDevice } from './notifications';

/**
 * Видалення акаунта (ADR-072).
 *
 * Пароль звіряє сервер (`delete_my_account`), а не браузер: інакше для
 * видалення досить було б чужої відкритої сесії. Невдача приходить у тілі
 * відповіді, а не помилкою, — так сервер рахує спроби.
 *
 * Після видалення сесія лишається в браузері, але користувача вже немає:
 * виходимо лише локально (`scope: 'local'`), бо серверний вихід для
 * неіснуючого користувача відповів би помилкою. Подія `SIGNED_OUT` у
 * `AuthProvider` стирає офлайн-копії й чергу змін, як за звичайного виходу.
 */
export type DeleteAccountResult = 'deleted' | 'wrong_password' | 'too_many' | 'no_password';

/** Скільки чекаємо відповіді: кнопка, вимкнена на час запиту, мусить ожити (CLAUDE.md §4). */
const TIMEOUT_MS = 20_000;

const RESULTS: DeleteAccountResult[] = ['deleted', 'wrong_password', 'too_many', 'no_password'];

/**
 * Коли акаунт видалено в цій вкладці. Екран входу, що відкрився одразу
 * після цього, каже «Акаунт видалено». Прапорець не «забирається» при
 * читанні: StrictMode викликає ініціалізатор стану двічі, і друге читання
 * інакше загубило б повідомлення. Перезавантаження сторінки його стирає.
 */
let deletedAt = 0;
const NOTICE_MS = 10_000;

export function justDeletedAccount(now = Date.now()): boolean {
  return deletedAt > 0 && now - deletedAt < NOTICE_MS;
}

export async function deleteAccount(password: string): Promise<DeleteAccountResult> {
  const { data, error } = await supabase
    .rpc('delete_my_account', { p_password: password })
    .abortSignal(AbortSignal.timeout(TIMEOUT_MS));

  // Користувача вже немає: попередня спроба видалила акаунт, а відповідь на
  // неї загубилась у мережі. Для людини це те саме, що щойно видалити.
  const result: DeleteAccountResult | null =
    error?.code === 'P0002' ? 'deleted' : error ? null : RESULTS.find((r) => r === data) ?? null;
  if (error && result === null) throw error;
  if (result === null) throw new Error(String(data));

  if (result === 'deleted') {
    deletedAt = Date.now();
    // Рядок підписки на сервері вже стер каскад — лишається підписка браузера.
    await forgetPushOnThisDevice(false);
    await supabase.auth.signOut({ scope: 'local' });
  }
  return result;
}
