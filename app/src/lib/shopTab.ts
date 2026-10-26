/**
 * Вкладка магазину, яка чекає на бронь (ROADMAP 8.1, ADR-075).
 *
 * «Забронювати й перейти» мусить відкрити магазин лише після того, як
 * `claim_item_v2` підтвердив бронь: інакше гість, що програв гонку, уже
 * стоїть на сторінці товару й купує те саме, що й переможець. Але браузер
 * дозволяє відкрити вікно лише синхронно в обробнику натиску — після `await`
 * це вже «спливне вікно» без натиску, і його блокують. Тому порядок такий:
 *
 * 1. `openPendingTab` — у самому натиску відкриває порожню вкладку з рядком
 *    «Бронюємо…» мовою сторінки й одразу відрізає їй `opener`;
 * 2. бронь іде запитом у цій вкладці;
 * 3. успіх — `sendTab` веде порожню вкладку в магазин, програш чи збій —
 *    `closeTab` закриває її, і гість повертається до списку.
 *
 * Перехід іде посиланням усередині порожньої вкладки з `rel="noreferrer"`:
 * так само, як справжні посилання на картках, магазин не дізнається адреси
 * сторінки (у ній токен посилання — CLAUDE.md §3.5).
 *
 * Якщо вікно відкрити не вдалося (заблоковане, застосунок на екрані «Додому»
 * без вкладок), функції повертають `null` / `false`, а екран дає звичайне
 * посилання на магазин уже після броні — натиск на нього браузер не блокує.
 */

/**
 * Застосунок відкрито з екрана «Додому» (PWA): там `window.open` поводиться
 * по-різному — iOS відкриває окремий перегляд Safari, у якому порожню
 * сторінку не завжди вдається повести далі. Надійніше не відкривати нічого
 * наперед, а дати посилання після броні.
 */
export function canPreopenTab(): boolean {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false;
  try {
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return !standalone;
  } catch {
    return true;
  }
}

/**
 * Порожня вкладка з рядком очікування. Викликати лише синхронно в обробнику
 * натиску — до першого `await`. `null` — вікно не відкрилось.
 */
export function openPendingTab(text: string, lang: string): Window | null {
  let tab: Window | null = null;
  try {
    tab = window.open('', '_blank');
  } catch {
    return null;
  }
  if (!tab) return null;
  try {
    // Магазин, куди піде вкладка, не має досягати цієї сторінки через opener.
    tab.opener = null;
  } catch {
    /* деякі браузери не дають — тоді лишається `noopener` нижче */
  }
  try {
    const doc = tab.document;
    doc.title = text;
    doc.documentElement.lang = lang;
    // Стилі — через CSSOM: атрибут `style` у розмітці CSP міг би відкинути.
    doc.documentElement.style.colorScheme = 'light dark';
    const p = doc.createElement('p');
    p.textContent = text;
    p.style.font = '16px/1.5 system-ui, sans-serif';
    p.style.margin = '40px 24px';
    p.setAttribute('role', 'status');
    doc.body.appendChild(p);
  } catch {
    /* порожня вкладка без підпису — теж прийнятно */
  }
  return tab;
}

/**
 * Веде порожню вкладку в магазин. `false` — вкладки вже немає (гість закрив її
 * сам) або браузер не дав нею керувати: тоді треба показати посилання.
 */
export function sendTab(tab: Window | null, url: string): boolean {
  if (!tab) return false;
  try {
    if (tab.closed) return false;
    const doc = tab.document;
    const a = doc.createElement('a');
    a.href = url;
    a.rel = 'noreferrer noopener';
    doc.body.appendChild(a);
    a.click();
    return true;
  } catch {
    try {
      if (tab.closed) return false;
      tab.location.replace(url);
      return true;
    } catch {
      return false;
    }
  }
}

/** Закриває порожню вкладку, якщо вона ще є; помилок не кидає. */
export function closeTab(tab: Window | null): void {
  try {
    if (tab && !tab.closed) tab.close();
  } catch {
    /* нічого не вдієш — вкладка лишиться з «Бронюємо…» */
  }
}
