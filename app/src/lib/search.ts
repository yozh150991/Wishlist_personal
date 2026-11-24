/**
 * Пошук по всіх списках власника (ROADMAP 8.11).
 *
 * Правила без мережі й React — щоб їх перевіряли тести без браузера
 * (`tests/e2e/search.spec.ts`). Тут три речі:
 *
 * 1. **Згортання** (`fold`): регістр і діакритика не важать — «Łyżka» знаходиться
 *    за «lyzka», «Їжак» — за «іжак», «м’яч» — за «м'яч». Таблицю літер
 *    дубльовано в RPC `search_my_items` (функція `translate()` Postgres, без
 *    розширень); тест звіряє, що в міграції стоїть рівно вона.
 * 2. **Збіг** (`matchItem`): кожне слово запиту мусить знайтися хоч у
 *    чомусь — назві, нотатці, магазині (хост посилання чи `source_site`),
 *    підписі чи значенні ознаки. «червоний светр» знаходить светр із ознакою
 *    «Колір → червоний». Слово не перетинає межу двох полів.
 * 3. **Підсвітка** (`markRanges`, `noteSnippet`): де саме збіг, щоб екран
 *    показав його тегом `<mark>`, а не через `dangerouslySetInnerHTML`.
 *
 * Без мережі той самий збіг біжить по офлайн-копіях (`searchLocal`), з
 * чесною позначкою, що копія може бути неповною: на пристрої лежать лише
 * списки, які на ньому відкривали.
 *
 * Про позначки гостей тут нічого немає й бути не може (CLAUDE.md §3.2):
 * шукаємо лише в позиціях власника, а копія позиції — це нова позиція без
 * броней (`copyInput` у `afterEvent.ts`).
 */
import { hostOf } from './format';
import type { Item, List } from './types';

/** Межа запиту — та сама, що в RPC (`bad_query`), і `maxLength` поля. */
export const SEARCH_QUERY_MAX = 100;
/** Скільки слів запиту беремо до уваги — решту відкидає й RPC. */
export const SEARCH_WORDS_MAX = 8;
/** Коротший запит не шукаємо: дві літери — уже щось, одна — пів бази. */
export const SEARCH_MIN_CHARS = 2;
/** Скільки результатів показуємо; запит просить на один більше, щоб знати, чи є ще. */
export const SEARCH_LIMIT = 50;

/**
 * Літери, що згортаються, і їхні пари — рядки однакової довжини, кожна
 * літера — одна кодова одиниця UTF-16. Порядок значення не має, але рядок
 * мусить збігатися з тим, що в міграції `*_search_my_items.sql`.
 *
 * Польська, чеська й словацька, західноєвропейські наголоси, українські
 * ї/є/ґ/й (і російські ё, білоруська ў) та апострофи — бо «мʼяч» друкують
 * трьома різними знаками.
 */
export const FOLD_FROM = "ąáàâäãåāćčçęéèêëěēíìîïīłľĺńňñóòôöõőøōřŕśšťďúùûüůűūýÿźżžїєґйёў’‘ʼ`";
export const FOLD_TO = "aaaaaaaaccceeeeeeeiiiiilllnnnoooooooorrsstduuuuuuuyyzzzіегиеу''''";

const FOLD = new Map<string, string>();
for (let i = 0; i < FOLD_FROM.length; i++) FOLD.set(FOLD_FROM[i]!, FOLD_TO[i]!);

/**
 * Рядок без регістру й діакритики **тієї самої довжини**: кожна кодова
 * одиниця згортається окремо, тож індекси збігу в згорнутому рядку — це
 * індекси в оригіналі (на них тримається підсвітка). Літера, що в нижньому
 * регістрі стає довшою (турецька «İ»), лишається як є.
 */
export function fold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const low = c.toLowerCase();
    const one = low.length === 1 ? low : c;
    out += FOLD.get(one) ?? one;
  }
  return out;
}

/** Слова запиту, згорнуті: не більше `SEARCH_WORDS_MAX`, порожніх немає. */
export function queryWords(query: string): string[] {
  return fold(query.slice(0, SEARCH_QUERY_MAX))
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, SEARCH_WORDS_MAX);
}

/** Чи вартий запит походу в базу: щонайменше дві літери без пробілів. */
export function searchable(query: string): boolean {
  return query.replace(/\s+/g, '').length >= SEARCH_MIN_CHARS;
}

/** Магазин позиції: хост посилання без `www.`; якщо посилання немає — що записав парсер. */
export function shopOf(item: Pick<Item, 'url' | 'source_site'>): string | null {
  return hostOf(item.url) ?? (item.source_site?.trim() || null);
}

export type MatchField = 'title' | 'note' | 'shop' | 'variant';

export type Match = {
  /** Де знайшлося хоч одне слово. */
  fields: Set<MatchField>;
  /** Усі слова — у назві: такі результати йдуть першими. */
  inTitle: boolean;
};

/** Тексти, у яких шукаємо, — окремо, щоб слово не зшивало два поля. */
function haystacks(item: Pick<Item, 'title' | 'note' | 'url' | 'source_site' | 'variants'>) {
  const shop = [hostOf(item.url), item.source_site].filter((s): s is string => Boolean(s)).join('\n');
  const variants = (item.variants ?? []).map((v) => `${v.label} ${v.value}`).join('\n');
  return [
    ['title', fold(item.title)],
    ['note', fold(item.note ?? '')],
    ['shop', fold(shop)],
    ['variant', fold(variants)],
  ] as const;
}

/**
 * Збіг позиції з запитом або `null`. Правило те саме, що в RPC: кожне слово
 * — підрядок хоч одного поля.
 */
export function matchItem(
  item: Pick<Item, 'title' | 'note' | 'url' | 'source_site' | 'variants'>,
  words: string[],
): Match | null {
  if (words.length === 0) return null;
  const fields = new Set<MatchField>();
  const hay = haystacks(item);
  for (const w of words) {
    let found = false;
    for (const [field, text] of hay) {
      if (text.includes(w)) {
        fields.add(field);
        found = true;
      }
    }
    if (!found) return null;
  }
  const title = hay[0][1];
  return { fields, inTitle: words.every((w) => title.includes(w)) };
}

export type Segment = { text: string; hit: boolean };

/**
 * Рядок на шматки «збіг / не збіг» — для `<mark>`. Перекриті й суміжні
 * збіги зливаються в один.
 */
export function markRanges(text: string, words: string[]): Segment[] {
  if (!text) return [];
  const folded = fold(text);
  const hit = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    if (!w) continue;
    for (let at = folded.indexOf(w); at !== -1; at = folded.indexOf(w, at + 1)) {
      for (let i = at; i < at + w.length; i++) hit[i] = true;
    }
  }
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.hit === hit[i]) last.text += text[i];
    else out.push({ text: text[i]!, hit: hit[i]! });
  }
  return out;
}

/** Скільки символів нотатки показуємо довкола збігу. */
export const SNIPPET_AROUND = 40;

/**
 * Уривок нотатки довкола першого збігу: «…купити той самий, що в Олі…».
 * Без збігу — `null`: нотатку під результатом показуємо, лише коли знайшло
 * саме в ній.
 */
export function noteSnippet(note: string | null, words: string[], around = SNIPPET_AROUND): string | null {
  if (!note) return null;
  const flat = note.replace(/\s+/g, ' ').trim();
  const folded = fold(flat);
  let first = -1;
  for (const w of words) {
    const at = folded.indexOf(w);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  if (first === -1) return null;
  const start = Math.max(0, first - around);
  const end = Math.min(flat.length, first + around * 2);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/* ── Результати ─────────────────────────── */

export type SearchHit = {
  item: Item;
  /** Список позиції. Немає — список ще не приїхав (тоді рядок без назви списку). */
  list: List | null;
  match: Match;
};

/**
 * Порядок той самий, що в RPC: спершу ті, де все знайшлося в назві, далі
 * живі списки перед архівом, далі свіжіше змінені.
 */
export function rankHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort(
    (a, b) =>
      Number(b.match.inTitle) - Number(a.match.inTitle) ||
      Number(Boolean(a.list?.is_archived)) - Number(Boolean(b.list?.is_archived)) ||
      b.item.updated_at.localeCompare(a.item.updated_at) ||
      a.item.id.localeCompare(b.item.id),
  );
}

/**
 * Відповідь бази → результати екрана. База вже відібрала й упорядкувала;
 * тут лише приєднуємо списки й рахуємо, де підсвітити. Позицію, яку база
 * віддала, а наш збіг не впізнав (інша нормалізація хоста), не губимо.
 */
export function hitsFromServer(items: Item[], lists: List[], query: string): SearchHit[] {
  const words = queryWords(query);
  const byId = new Map(lists.map((l) => [l.id, l]));
  return items.map((item) => ({
    item,
    list: byId.get(item.list_id) ?? null,
    match: matchItem(item, words) ?? { fields: new Set<MatchField>(['title']), inTitle: false },
  }));
}

/**
 * Пошук без мережі — по офлайн-копіях позицій, які лежать на пристрої.
 * Одна позиція може бути і в першій партії, і в повному списку — беремо раз.
 */
export function searchLocal(items: Item[], lists: List[], query: string, limit = SEARCH_LIMIT): SearchHit[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const byId = new Map(lists.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const match = matchItem(item, words);
    if (match) hits.push({ item, list: byId.get(item.list_id) ?? null, match });
  }
  return rankHits(hits).slice(0, limit);
}

/**
 * Куди можна скопіювати позицію: живі списки, крім її власного. В архів не
 * копіюємо — так само, як «Ще хочу» (ADR-045): архів — знімок свята.
 */
export function copyTargets(lists: List[], sourceListId: string): List[] {
  return lists.filter((l) => l.id !== sourceListId && !l.is_archived);
}
