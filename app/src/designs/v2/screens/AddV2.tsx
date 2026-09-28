import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, CloudOff, PackageOpen } from 'lucide-react';
import { createList, fetchDefaultCurrency, fetchListsOverview } from '../../../lib/db';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { errorText, isNetworkError } from '../../../lib/errors';
import { hostOf, localToday, moneyShort } from '../../../lib/format';
import { LISTS_KEY, readSnapshot } from '../../../lib/cache';
import { ParseError, parseUrl, parserConfigured } from '../../../lib/parser';
import { newId, run } from '../../../lib/outbox';
import { ITEM_TITLE_MAX, ITEM_URL_MAX, PRIORITY_ORDER, draftTitle } from '../../../lib/itemsView';
import { fromShare, readLastList, writeLastList } from '../../../lib/shareTarget';
import type { Currency, ItemInput, ItemPriority, List } from '../../../lib/types';
import { FieldV2, NoteV2, SubmitV2 } from './AuthPartsV2';
import { usePriorityLabel } from './ListPartsV2';

const STROKE = 2.75;
/** Межа з БД (`lists.title`). */
const LIST_TITLE_MAX = 120;
const FALLBACK_CURRENCY: Currency = 'PLN';

type Done = { listId: string; listTitle: string; queued: boolean; draft: boolean };

/** Порядок списків у виборі: найближчі за датою, далі без дати, далі минулі. */
function byRelevance(today: string) {
  const rank = (l: List) => (!l.event_date ? 1 : l.event_date.slice(0, 10) >= today ? 0 : 2);
  return (a: List, b: List) =>
    rank(a) - rank(b) || (a.event_date ?? '').localeCompare(b.event_date ?? '') || a.title.localeCompare(b.title);
}

/**
 * «Додати в Wishlist» із системного «Поділитися» (потік L; ADR-046).
 *
 * Сюди веде `share_target` маніфесту: `/add?title=…&text=…&url=…`. Три
 * рішення й одна кнопка: у який список (усталено — той, куди додавали
 * востаннє), пріоритет, «Додати». Сторінку магазину читає парсер, поки людина
 * вибирає. Магазин не віддав опису — назву можна дописати зараз або зберегти
 * чернетку «Потрібна назва», невидиму гостям. Без мережі позиція лягає в
 * офлайн-чергу й дійде сама; сторінку тоді не читаємо — лишається чернетка.
 *
 * Лише Android і десктопний Chrome: Safari на iPhone не пускає вебзастосунки
 * в системне «Поділитися». Ручна форма в списку — повноцінний шлях для всіх.
 */
export default function AddV2() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const priorityLabel = usePriorityLabel();
  const location = useLocation();
  const navigate = useNavigate();
  const userId = session?.user.id ?? '';

  // Читаємо один раз: одразу після цього адресу з параметрами прибираємо.
  const [shared] = useState(() => {
    const q = new URLSearchParams(location.search);
    return fromShare({ title: q.get('title'), text: q.get('text'), url: q.get('url') });
  });

  // Адресу з тим, що поширили, прибираємо з рядка: F5 не має додати вдруге.
  useEffect(() => {
    if (location.search) navigate(location.pathname, { replace: true, state: location.state });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [lists, setLists] = useState<List[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [target, setTarget] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [title, setTitle] = useState(shared.title ?? '');
  const [price, setPrice] = useState<number | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [priority, setPriority] = useState<ItemPriority>('medium');
  const [reading, setReading] = useState(false);
  const [unread, setUnread] = useState(false);
  /** Що пробували: «Додати» вимагає назви, чернетка — ні. */
  const [tried, setTried] = useState<'add' | 'draft' | null>(null);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  /** Назву вже правила людина — парсер її не чіпає (C2). Поширене — не її слова. */
  const edited = useRef(false);

  // Списки: свіжі, а без мережі — збережена копія (додати можна й офлайн).
  useEffect(() => {
    let alive = true;
    const today = localToday();
    const pick = (all: List[]) => {
      const open = all.filter((l) => !l.is_archived).sort(byRelevance(today));
      const last = readLastList();
      setLists(open);
      setTarget(open.find((l) => l.id === last)?.id ?? open[0]?.id ?? 'new');
    };
    fetchListsOverview()
      .then((all) => alive && pick(all))
      .catch(async (e: unknown) => {
        const snapshot = isNetworkError(e) && userId ? await readSnapshot<List[]>(LISTS_KEY, userId) : null;
        if (!alive) return;
        setOffline(isNetworkError(e));
        if (snapshot) pick(snapshot.data);
        else {
          setLists([]);
          setTarget('new');
          if (!isNetworkError(e)) setServer(errorText(e, t));
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Сторінку магазину читаємо, поки людина вибирає список, — поля вже живі (C2).
  useEffect(() => {
    if (!shared.url || !parserConfigured()) {
      if (shared.url && !shared.title) setUnread(true);
      return;
    }
    const ctl = new AbortController();
    setReading(true);
    parseUrl(shared.url, ctl.signal)
      .then((got) => {
        if (ctl.signal.aborted) return;
        // Назва зі сторінки точніша за супровідний текст («Подивись!»), але не за вписане людиною.
        if (got.title && !edited.current) setTitle(got.title.slice(0, ITEM_TITLE_MAX));
        setPrice(got.price);
        setImage(got.image_url && got.image_url.length <= ITEM_URL_MAX ? got.image_url : null);
        if (!got.title && !shared.title) setUnread(true);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        if (!shared.title) setUnread(true);
        if (e instanceof ParseError && e.key === 'parser.errors.unreachable') setOffline(!navigator.onLine);
      })
      .finally(() => {
        if (!ctl.signal.aborted) setReading(false);
      });
    return () => ctl.abort();
  }, [shared.url, shared.title]);

  const chosen = lists?.find((l) => l.id === target) ?? null;
  const currency = chosen?.currency ?? FALLBACK_CURRENCY;
  const name = title.trim();
  const listName = newName.trim();
  const nameError = tried === 'add' && !name ? t('v2item.title.empty') : null;
  const listError = tried && target === 'new' && !listName ? t('v2app.newList.nameEmpty') : null;

  async function add(asDraft: boolean) {
    if (busy) return;
    setTried(asDraft ? 'draft' : 'add');
    if (!asDraft && !name) return titleRef.current?.focus();
    if (target === 'new' && !listName) return nameRef.current?.focus();
    if (asDraft && !shared.url) return;
    setBusy(true);
    setServer(null);
    try {
      let listId = target;
      let listTitle = chosen?.title ?? '';
      if (target === 'new') {
        // Новий список — лише з мережею: списки в офлайн-черзі не живуть (ADR-029).
        const cur = (await fetchDefaultCurrency(userId).catch(() => null)) ?? FALLBACK_CURRENCY;
        const created = await createList({ title: listName, currency: cur }, userId);
        listId = created.id;
        listTitle = created.title;
      }
      const draft = asDraft || !name;
      const input: ItemInput = {
        title: draft ? draftTitle(shared.url!) : name,
        url: shared.url,
        price,
        image_url: image,
        priority,
        ...(draft ? { needs_title: true } : {}),
      };
      const result = await run(userId, { kind: 'create', listId, id: newId(), input });
      writeLastList(listId);
      setDone({ listId, listTitle, queued: result === 'queued', draft });
    } catch (e) {
      setServer(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  /* ── Розмітка ── */

  const head = (
    <div className="v2-back">
      <Link to="/lists" className="v2-iconbtn" aria-label={t('v2auth.back')}>
        <ChevronLeft size={22} strokeWidth={STROKE} aria-hidden="true" />
      </Link>
      <h1 className="v2-back__title">{t('v2add.title')}</h1>
    </div>
  );

  if (done) {
    return (
      <main className="v2-page v2-page--narrow">
        <div className="v2-empty">
          <span className={`v2-circle v2-circle--${done.queued ? 'warm' : 'calm'}`} aria-hidden="true">
            {done.queued ? <CloudOff size={32} strokeWidth={STROKE} /> : <Check size={32} strokeWidth={STROKE} />}
          </span>
          {/* Заголовок лишається заголовком, а зчитувач однаково почує результат. */}
          <div className="v2-add__result" role="status">
            <h1 className="v2-empty__title">
              {done.queued ? t('v2add.queued', { title: done.listTitle }) : t('v2add.added', { title: done.listTitle })}
            </h1>
            {done.draft && <p className="v2-lede">{t('v2add.draftNote')}</p>}
          </div>
          <Link to={`/lists/${done.listId}`} className="v2-btn v2-btn--primary">
            {t('v2add.open')}
          </Link>
          <Link to="/lists" className="v2-btn v2-btn--ghost">
            {t('v2list.back')}
          </Link>
        </div>
      </main>
    );
  }

  if (!shared.url && !shared.title) {
    return (
      <main className="v2-page v2-page--narrow">
        {head}
        <div className="v2-empty">
          <span className="v2-circle v2-circle--warm" aria-hidden="true">
            <PackageOpen size={32} strokeWidth={STROKE} />
          </span>
          <h2 className="v2-empty__title">{t('v2add.nothingTitle')}</h2>
          <p className="v2-lede">{t('v2add.nothingBody')}</p>
          <Link to="/lists" className="v2-btn v2-btn--primary">
            {t('v2list.back')}
          </Link>
        </div>
      </main>
    );
  }

  const host = hostOf(shared.url);
  const priceText = price !== null ? moneyShort(price, currency, locale) : null;

  return (
    <main className="v2-page v2-page--narrow">
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void add(false);
        }}
      >
        {head}
        {server && <NoteV2 tone="error">{server}</NoteV2>}
        {offline && <NoteV2 tone="info">{t('v2add.offline')}</NoteV2>}

        {shared.url && (
          <div className="v2-preview" aria-busy={reading || undefined}>
            {image ? (
              <img className="v2-preview__img" src={image} alt="" />
            ) : (
              <span className="v2-preview__img v2-preview__img--empty" aria-hidden="true" />
            )}
            <span className="v2-preview__text">
              {reading && !name ? (
                <>
                  <span className="v2-preview__line" aria-hidden="true" />
                  <span className="v2-preview__line v2-preview__line--short" aria-hidden="true" />
                </>
              ) : (
                <>
                  <span className="v2-preview__title">{name || t('v2list.item.draft')}</span>
                  <span className="v2-preview__meta">{[host, priceText].filter(Boolean).join(' · ')}</span>
                </>
              )}
            </span>
          </div>
        )}

        {reading && (
          <p className="v2-reading" role="status">
            <span className="v2-spinner" aria-hidden="true" />
            {t('v2item.reading')}
          </p>
        )}
        {!reading && unread && !name && (
          <p className="v2-note v2-note--warm" role="status">
            <span>{t('v2add.unread')}</span>
          </p>
        )}

        <FieldV2
          ref={titleRef}
          label={t('v2item.title.label')}
          name="title"
          autoComplete="off"
          maxLength={ITEM_TITLE_MAX}
          placeholder={reading ? t('v2item.title.placeholderReading') : t('v2item.title.placeholder')}
          value={title}
          error={nameError}
          onChange={(e) => {
            edited.current = true;
            setTitle(e.target.value);
          }}
        />

        {lists === null ? (
          <p className="v2-reading" role="status">
            <span className="v2-spinner" aria-hidden="true" />
            {t('v2app.lists.loading')}
          </p>
        ) : (
          <fieldset className="v2-seg">
            <legend className="v2-field__label">{t('v2add.list')}</legend>
            <div className="v2-seg__row">
              {lists.map((l) => (
                <label key={l.id} className="v2-seg__opt">
                  <input
                    type="radio"
                    name="add-list"
                    value={l.id}
                    checked={target === l.id}
                    onChange={() => setTarget(l.id)}
                  />
                  <span>{l.title}</span>
                </label>
              ))}
              <label className="v2-seg__opt">
                <input
                  type="radio"
                  name="add-list"
                  value="new"
                  checked={target === 'new'}
                  onChange={() => setTarget('new')}
                />
                <span>{t('v2add.newList')}</span>
              </label>
            </div>
          </fieldset>
        )}
        {target === 'new' && (
          <FieldV2
            ref={nameRef}
            label={t('v2add.newListName')}
            name="list_title"
            autoComplete="off"
            maxLength={LIST_TITLE_MAX}
            value={newName}
            error={listError}
            warning={offline ? t('v2add.newListOffline') : null}
            onChange={(e) => setNewName(e.target.value)}
          />
        )}

        <fieldset className="v2-seg">
          <legend className="v2-field__label">{t('v2item.priority')}</legend>
          <div className="v2-seg__row">
            {PRIORITY_ORDER.map((p) => (
              <label key={p} className="v2-seg__opt">
                <input
                  type="radio"
                  name="add-priority"
                  value={p}
                  checked={priority === p}
                  onChange={() => setPriority(p)}
                />
                <span>{priorityLabel(p)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <SubmitV2 busy={busy} label={t('v2item.add')} busyLabel={t('common.saving')} />
        {shared.url && !name && !reading && (
          <button
            type="button"
            className="v2-btn v2-btn--outline v2-btn--block"
            aria-disabled={busy || undefined}
            onClick={() => void add(true)}
          >
            {t('v2item.draft.save')}
          </button>
        )}
      </form>
    </main>
  );
}
