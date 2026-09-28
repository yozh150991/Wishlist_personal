import { useEffect, useId, useRef, useState } from 'react';
import type { ClipboardEvent } from 'react';
import { ClipboardPaste, Plus, X } from 'lucide-react';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { hostOf, moneyShort } from '../../../lib/format';
import { ParseError, parseUrl, parserConfigured } from '../../../lib/parser';
import { releaseItemClaims } from '../../../lib/shares';
import { cleanVariants, variantsError } from '../../../lib/variants';
import {
  ITEM_NOTE_MAX,
  ITEM_QTY_MAX,
  ITEM_TITLE_MAX,
  ITEM_URL_MAX,
  PRIORITY_ORDER,
  findSameTitle,
  findSameUrl,
  normalizeUrl,
  parsePrice,
} from '../../../lib/itemsView';
import { VARIANTS_MAX, VARIANT_LABEL_MAX, VARIANT_VALUE_MAX } from '../../../lib/types';
import type { Currency, Item, ItemInput, ItemPriority, ItemVariant } from '../../../lib/types';
import type { Section } from '../../../lib/sections';
import { FieldV2, NoteV2, OrDividerV2 } from './AuthPartsV2';
import { SheetV2 } from './CommonV2';
import { ConfirmSheetV2, usePriorityLabel } from './ListPartsV2';

const STROKE = 2.75;

/** Помилки парсера, у яких є що сказати людині понад «допиши сам». */
const TELLING = new Set(['parser.errors.blockedByShop', 'parser.errors.rateLimited', 'parser.errors.notSignedIn']);

type Stage = 'link' | 'form';

type Form = {
  url: string;
  title: string;
  price: string;
  quantity: string;
  priority: ItemPriority;
  note: string;
  image_url: string;
  section_id: string;
};

const EMPTY: Form = {
  url: '',
  title: '',
  price: '',
  quantity: '1',
  priority: 'medium',
  note: '',
  image_url: '',
  section_id: '',
};

function fromItem(item: Item): Form {
  return {
    url: item.url ?? '',
    title: item.title,
    price: item.price === null ? '' : String(item.price),
    quantity: String(item.quantity),
    priority: item.priority,
    note: item.note ?? '',
    image_url: item.image_url ?? '',
    section_id: item.section_id ?? '',
  };
}

type Note = { tone: 'warn' | 'info'; text: string };

/**
 * Нова позиція й зміна позиції v2 (потоки C, J1, L1, R1–R2, V1).
 *
 * Нова починається з посилання (C1): поле, «Вставити з буфера», «або» і
 * «Вписати вручну» — ручний шлях присутній з першого кадру, а не як кара за
 * збій парсера. Вставлене посилання одразу читається (C2), але поля вже
 * активні: що людина встигла вписати, парсер не перетирає. Збій нічого не
 * втрачає — посилання лишається в записі, форма просто ручна (C, гілка).
 *
 * Те саме посилання, що вже є в списку, — не заборона, а вибір (R2):
 * збільшити кількість, відкрити наявну або додати окремою. Схожа назва —
 * тихий рядок під полем.
 *
 * Ознаки («+ Розмір, колір») з'являються на вимогу — у формі за
 * замовчуванням їх немає (V1). Своє фото — пізніше (ROADMAP, крок 4+):
 * поки лише фото з магазину, яке можна прибрати.
 *
 * На телефоні — на весь екран із «Скасувати · Нова позиція · Додати» вгорі,
 * на десктопі — вікно по центру. Клік повз вікно форму не закриває.
 */
export function ItemSheetV2({
  open,
  item,
  presetTitle,
  items,
  sections,
  currency,
  onClose,
  onSave,
  onOpenExisting,
  onBumpQuantity,
}: {
  open: boolean;
  /** Позиція, яку змінюють; `null` — нова. */
  item: Item | null;
  /** «Додати як нову позицію» з порожнього пошуку — одразу ручна форма з назвою. */
  presetTitle?: string;
  /** Усі позиції списку — для перевірки дубля посилання й назви. */
  items: Item[];
  sections: Section[];
  currency: Currency;
  onClose: () => void;
  /** Нова позиція — `id: null`. Кидає помилку, якщо сервер відмовив. */
  onSave: (input: ItemInput, id: string | null) => Promise<void>;
  onOpenExisting: (item: Item) => void;
  onBumpQuantity: (item: Item) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const priorityLabel = usePriorityLabel();
  const titleId = useId();
  const hintsId = useId();

  const [stage, setStage] = useState<Stage>('link');
  const [form, setForm] = useState<Form>(EMPTY);
  const [variants, setVariants] = useState<ItemVariant[]>([]);
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [parsed, setParsed] = useState(false);
  const [parseNote, setParseNote] = useState<Note | null>(null);
  const [server, setServer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bumping, setBumping] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetNote, setResetNote] = useState<{ ok: boolean; text: string } | null>(null);

  const reader = useRef<AbortController | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  /** Куди поставити фокус після відкриття чи зміни кроку. */
  const focusNext = useRef<'link' | 'title' | null>(null);

  const editing = item !== null;

  // Кожне відкриття — з чистого аркуша: попередня позиція не просочується в нову.
  useEffect(() => {
    if (!open) {
      reader.current?.abort();
      return;
    }
    setForm(item ? fromItem(item) : { ...EMPTY, title: presetTitle ?? '' });
    setVariants(item ? item.variants.map((v) => ({ ...v })) : []);
    setVariantsOpen(Boolean(item && item.variants.length > 0));
    setStage(item || presetTitle ? 'form' : 'link');
    setSubmitted(false);
    setLinkError(null);
    setLinkNote(null);
    setReading(false);
    setParsed(false);
    setParseNote(null);
    setServer(null);
    setBusy(false);
    setResetNote(null);
    focusNext.current = item ? null : presetTitle ? 'title' : 'link';
  }, [open, item, presetTitle]);

  // Фокус — після того, як вікно вже відкрите (SheetV2 відкриває його в
  // своєму ефекті, який іде раніше за цей).
  useEffect(() => {
    if (!open || !focusNext.current) return;
    const target = focusNext.current === 'link' ? linkRef.current : titleRef.current;
    // Поля потрібного кроку ще немає (крок міняється тим самим оновленням) —
    // спробуємо, щойно він намалюється.
    if (!target) return;
    focusNext.current = null;
    target.focus();
  }, [open, stage]);

  useEffect(() => () => reader.current?.abort(), []);

  // Помилка збереження може опинитись поза видимою частиною прокрученої форми.
  useEffect(() => {
    if (server) topRef.current?.scrollIntoView({ block: 'nearest' });
  }, [server]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /* ── Посилання й розпізнавання ── */

  /**
   * Читає сторінку й заповнює **порожні** поля. Уже вписане людиною не
   * перезаписуємо: ручний ввід важливіший за здогад парсера (C2).
   */
  async function read(url: string) {
    reader.current?.abort();
    if (!parserConfigured()) return;
    const ctl = new AbortController();
    reader.current = ctl;
    setReading(true);
    setParsed(false);
    setParseNote(null);
    try {
      const got = await parseUrl(url, ctl.signal);
      if (ctl.signal.aborted) return;
      const image = got.image_url && got.image_url.length <= ITEM_URL_MAX ? got.image_url : '';
      setForm((f) => ({
        ...f,
        title: f.title || (got.title ?? '').slice(0, ITEM_TITLE_MAX),
        price: f.price || (got.price !== null ? String(got.price) : ''),
        image_url: f.image_url || image,
      }));
      setParsed(true);
      if (!got.title && got.price === null) setParseNote({ tone: 'warn', text: t('v2item.readFailed') });
      else if (got.partial) setParseNote({ tone: 'info', text: t('parser.partial') });
      else if (got.currency && got.currency !== currency) {
        setParseNote({ tone: 'info', text: t('parser.gotCurrency', { currency: got.currency }) });
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      const key = e instanceof ParseError ? e.key : '';
      setParseNote({ tone: 'warn', text: TELLING.has(key) ? t(key) : t('v2item.readFailed') });
    } finally {
      if (!ctl.signal.aborted) setReading(false);
    }
  }

  /** Посилання прийнято: до форми, і поки сторінка читається — поля вже живі. */
  function takeLink(url: string) {
    setLinkError(null);
    setLinkNote(null);
    setForm((f) => ({ ...f, url }));
    focusNext.current = 'title';
    setStage('form');
    void read(url);
  }

  function submitLink() {
    const url = normalizeUrl(form.url);
    if (!url) {
      setLinkError(form.url.trim() ? t('v2item.link.bad') : t('v2item.link.empty'));
      return linkRef.current?.focus();
    }
    if (url.length > ITEM_URL_MAX) {
      setLinkError(t('v2item.link.tooLong'));
      return linkRef.current?.focus();
    }
    takeLink(url);
  }

  /** Вставили з буфера в поле — не чекаємо «Далі» (C1). */
  function onLinkPaste(e: ClipboardEvent<HTMLInputElement>) {
    const url = normalizeUrl(e.clipboardData.getData('text'));
    if (!url || url.length > ITEM_URL_MAX) return;
    e.preventDefault();
    takeLink(url);
  }

  /** Вставили посилання в ручну форму — теж можна прочитати, якщо поля ще порожні. */
  function onFormUrlPaste(e: ClipboardEvent<HTMLInputElement>) {
    const url = normalizeUrl(e.clipboardData.getData('text'));
    if (!url || url.length > ITEM_URL_MAX) return;
    e.preventDefault();
    set('url', url);
    if (!editing) void read(url);
  }

  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

  /**
   * «Вставити з буфера». Вебсторінка не бачить буфера без дозволу, тож вміст
   * у підписі кнопки не показуємо, як у рідних застосунках, а читаємо на
   * натиск. Відмова браузера — не глухий кут: поле поруч.
   */
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      const url = normalizeUrl(text);
      if (url && url.length <= ITEM_URL_MAX) return takeLink(url);
      setLinkNote(t('v2item.link.pasteNoUrl'));
    } catch {
      setLinkNote(t('v2item.link.pasteFailed'));
    }
    linkRef.current?.focus();
  }

  function manual() {
    reader.current?.abort();
    setLinkError(null);
    setLinkNote(null);
    // Хибне посилання в ручну форму не несемо: там його поле необовʼязкове.
    setForm((f) => ({ ...f, url: normalizeUrl(f.url) ?? '' }));
    focusNext.current = 'title';
    setStage('form');
  }

  /* ── Перевірка й збереження ── */

  const title = form.title.trim();
  const urlNormal = form.url.trim() ? normalizeUrl(form.url) : null;
  const price = parsePrice(form.price);
  const qty = Number(form.quantity);
  const qtyOk = Number.isInteger(qty) && qty >= 1 && qty <= ITEM_QTY_MAX;
  const filledVariants = variants.filter((v) => v.value.trim() !== '');
  const variantsKey = variantsError(filledVariants);

  const titleError = submitted && !title ? t('v2item.title.empty') : null;
  const urlError =
    submitted && form.url.trim() && !urlNormal
      ? t('v2item.link.bad')
      : submitted && urlNormal && urlNormal.length > ITEM_URL_MAX
        ? t('v2item.link.tooLong')
        : null;
  const priceError =
    submitted && price.error === 'format'
      ? t('v2item.price.bad')
      : submitted && price.error === 'tooBig'
        ? t('item.errors.priceTooBig')
        : null;
  const qtyError = submitted && !qtyOk ? t('item.errors.badQuantity') : null;

  const same = stage === 'form' && urlNormal ? findSameUrl(items, urlNormal, item?.id) : undefined;
  const sameTitle = !same && title ? findSameTitle(items, title, item?.id) : undefined;

  async function save() {
    if (busy) return;
    setSubmitted(true);
    if (!title) return titleRef.current?.focus();
    if (form.url.trim() && (!urlNormal || urlNormal.length > ITEM_URL_MAX)) return urlRef.current?.focus();
    if (price.error) return priceRef.current?.focus();
    if (!qtyOk) return qtyRef.current?.focus();
    if (variantsKey) return setServer(t(variantsKey));

    const input: ItemInput = {
      title,
      url: urlNormal,
      price: price.value,
      quantity: qty,
      priority: form.priority,
      note: form.note.trim() || null,
      variants: cleanVariants(filledVariants),
      image_url: form.image_url.trim() || null,
      // Розділ шлемо лише тоді, коли поле є: інакше зміна позиції в списку
      // без розділів мовчки стирала б їй розділ.
      ...(sections.length > 0 ? { section_id: form.section_id || null } : {}),
      // У новому розділі позиція стає зверху, поки власник її не пересуне.
      ...(sections.length > 0 && (item?.section_id ?? '') !== form.section_id ? { position: null } : {}),
    };

    setBusy(true);
    setServer(null);
    try {
      await onSave(input, item?.id ?? null);
      onClose();
    } catch (e) {
      setServer(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function bump(existing: Item) {
    if (bumping) return;
    setBumping(true);
    setServer(null);
    try {
      await onBumpQuantity(existing);
      onClose();
    } catch (e) {
      setServer(errorText(e, t));
    } finally {
      setBumping(false);
    }
  }

  /**
   * Сліпе «Скинути позицію» (ADR-035): сервер не каже, чи були позначки.
   * Кнопка стоїть на кожній позиції однаково — інакше сама її поява щось
   * підказувала б.
   */
  async function resetItem() {
    if (!item || resetting) return;
    setResetting(true);
    try {
      await releaseItemClaims(item.id);
      setResetNote({ ok: true, text: t('item.resetDone') });
    } catch (e) {
      setResetNote({ ok: false, text: errorText(e, t) });
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  }

  /* ── Розмітка ── */

  const heading = editing ? t('v2item.editTitle') : t('v2item.newTitle');
  const showPreview = stage === 'form' && !editing && Boolean(form.url) && (reading || parsed || Boolean(form.image_url));
  const host = hostOf(urlNormal);
  const priceText = price.value !== null ? moneyShort(price.value, currency, locale) : null;

  return (
    <>
      <SheetV2 open={open} onClose={onClose} labelledBy={titleId} className="v2-sheet--full" closeOnBackdrop={false}>
        <form
          className="v2-itemsheet"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (stage === 'link') submitLink();
            else void save();
          }}
        >
          <div className="v2-bar">
            <button type="button" className="v2-bar__btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <h2 className="v2-bar__title" id={titleId}>
              {heading}
            </h2>
            {stage === 'form' ? (
              <button
                type="submit"
                className="v2-bar__btn v2-bar__btn--primary"
                aria-disabled={busy || undefined}
                data-busy={busy || undefined}
              >
                {busy && <span className="v2-spinner" aria-hidden="true" />}
                {busy ? t('common.saving') : editing ? t('common.save') : t('v2item.add')}
              </button>
            ) : (
              <span className="v2-bar__spacer" aria-hidden="true" />
            )}
          </div>

          <div className="v2-itemsheet__body" ref={topRef}>
            {server && <NoteV2 tone="error">{server}</NoteV2>}

            {stage === 'link' ? (
              <>
                <FieldV2
                  ref={linkRef}
                  label={t('v2item.link.label')}
                  name="link"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder={t('v2item.link.placeholder')}
                  value={form.url}
                  error={linkError}
                  warning={linkNote}
                  onChange={(e) => {
                    set('url', e.target.value);
                    setLinkError(null);
                  }}
                  onPaste={onLinkPaste}
                  after={
                    linkError ? (
                      <p className="v2-field__after v2-field__after--start">
                        <button type="button" className="v2-link v2-linkbtn" onClick={manual}>
                          {t('v2item.link.withoutLink')}
                        </button>
                      </p>
                    ) : null
                  }
                />
                <button type="submit" className="v2-btn v2-btn--primary v2-btn--block">
                  {t('v2item.link.next')}
                </button>
                {canPaste && (
                  <button
                    type="button"
                    className="v2-btn v2-btn--outline v2-btn--block"
                    onClick={() => void pasteFromClipboard()}
                  >
                    <ClipboardPaste size={20} strokeWidth={STROKE} aria-hidden="true" />
                    {t('v2item.link.paste')}
                  </button>
                )}
                <OrDividerV2 label={t('v2item.link.or')} />
                <button type="button" className="v2-btn v2-btn--ghost" onClick={manual}>
                  {t('v2item.link.manual')}
                </button>
              </>
            ) : (
              <>
                {showPreview && (
                  <div className="v2-preview" aria-busy={reading || undefined}>
                    {form.image_url ? (
                      <span className="v2-preview__imgbox">
                        <img className="v2-preview__img" src={form.image_url} alt="" />
                        <button
                          type="button"
                          className="v2-preview__remove"
                          aria-label={t('v2item.photo.remove')}
                          onClick={() => set('image_url', '')}
                        >
                          <X size={16} strokeWidth={STROKE} aria-hidden="true" />
                        </button>
                      </span>
                    ) : (
                      <span className="v2-preview__img v2-preview__img--empty" aria-hidden="true" />
                    )}
                    <span className="v2-preview__text">
                      {reading && !title ? (
                        <>
                          <span className="v2-preview__line" aria-hidden="true" />
                          <span className="v2-preview__line v2-preview__line--short" aria-hidden="true" />
                        </>
                      ) : (
                        <>
                          <span className="v2-preview__title">{title || t('v2item.title.placeholder')}</span>
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
                {!reading && parseNote && (
                  <p className={`v2-note v2-note--${parseNote.tone === 'warn' ? 'warm' : 'info'}`} role="status">
                    <span>{parseNote.text}</span>
                  </p>
                )}

                {same && (
                  <div className="v2-same" role="status">
                    <p className="v2-same__title">{t('v2item.same.title')}</p>
                    <p className="v2-same__item">
                      {same.title}
                      {same.price !== null && ` · ${moneyShort(same.price, currency, locale)}`}
                    </p>
                    <p className="v2-same__body">{t('v2item.same.body')}</p>
                    <div className="v2-same__actions">
                      <button
                        type="button"
                        className="v2-btn v2-btn--outline"
                        aria-disabled={bumping || undefined}
                        onClick={() => void bump(same)}
                      >
                        {bumping && <span className="v2-spinner" aria-hidden="true" />}
                        {t('v2item.same.more', { n: Math.min(same.quantity + 1, ITEM_QTY_MAX) })}
                      </button>
                      <button type="button" className="v2-btn v2-btn--ghost" onClick={() => onOpenExisting(same)}>
                        {t('v2item.same.open')}
                      </button>
                    </div>
                  </div>
                )}

                <FieldV2
                  ref={titleRef}
                  label={t('v2item.title.label')}
                  name="title"
                  autoComplete="off"
                  maxLength={ITEM_TITLE_MAX}
                  placeholder={reading ? t('v2item.title.placeholderReading') : t('v2item.title.placeholder')}
                  value={form.title}
                  error={titleError}
                  warning={sameTitle ? t('v2item.title.same', { title: sameTitle.title }) : null}
                  onChange={(e) => set('title', e.target.value)}
                />

                <div className="v2-row">
                  <FieldV2
                    ref={priceRef}
                    label={t('v2item.price.label')}
                    name="price"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={currencySymbol(currency, locale)}
                    value={form.price}
                    error={priceError}
                    onChange={(e) => set('price', e.target.value)}
                  />
                  <FieldV2
                    ref={qtyRef}
                    label={t('v2item.quantity')}
                    name="quantity"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={ITEM_QTY_MAX}
                    step={1}
                    value={form.quantity}
                    error={qtyError}
                    onChange={(e) => set('quantity', e.target.value)}
                  />
                </div>

                <fieldset className="v2-seg">
                  <legend className="v2-field__label">{t('v2item.priority')}</legend>
                  <div className="v2-seg__row">
                    {PRIORITY_ORDER.map((p) => (
                      <label key={p} className="v2-seg__opt">
                        <input
                          type="radio"
                          name="priority"
                          value={p}
                          checked={form.priority === p}
                          onChange={() => set('priority', p)}
                        />
                        <span>{priorityLabel(p)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <NoteFieldV2
                  label={t('v2item.note')}
                  value={form.note}
                  onChange={(v) => set('note', v)}
                />

                {variantsOpen ? (
                  <VariantsV2 hintsId={hintsId} variants={variants} onChange={setVariants} />
                ) : (
                  <button
                    type="button"
                    className="v2-btn v2-btn--ghost v2-btn--start"
                    onClick={() => {
                      setVariants([
                        { label: t('v2item.variants.size'), value: '' },
                        { label: t('v2item.variants.color'), value: '' },
                      ]);
                      setVariantsOpen(true);
                    }}
                  >
                    <Plus size={18} strokeWidth={STROKE} aria-hidden="true" />
                    {t('v2item.variants.open')}
                  </button>
                )}

                {sections.length > 0 && (
                  <SelectV2
                    label={t('v2item.section.label')}
                    value={form.section_id}
                    onChange={(v) => set('section_id', v)}
                    options={[
                      { value: '', label: t('v2item.section.none') },
                      ...sections.map((s) => ({ value: s.id, label: s.title })),
                    ]}
                  />
                )}

                <FieldV2
                  ref={urlRef}
                  label={t('v2item.link.optional')}
                  name="url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://"
                  value={form.url}
                  error={urlError}
                  onChange={(e) => set('url', e.target.value)}
                  onPaste={onFormUrlPaste}
                />

                {editing && (
                  <div className="v2-reset">
                    {resetNote && <NoteV2 tone={resetNote.ok ? 'info' : 'error'}>{resetNote.text}</NoteV2>}
                    <p className="v2-reset__hint">{t('item.resetHint')}</p>
                    <button
                      type="button"
                      className="v2-btn v2-btn--outline v2-btn--start"
                      onClick={() => setConfirmReset(true)}
                    >
                      {t('item.reset')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </form>
      </SheetV2>

      {/* Поруч, а не всередині: вкладене вікно ловило б Escape разом із формою. */}
      <ConfirmSheetV2
        open={confirmReset}
        id="v2-reset-title"
        title={t('item.resetConfirmTitle', { title: item?.title ?? '' })}
        body={t('item.resetConfirmBody')}
        confirmLabel={t('item.reset')}
        busyLabel={t('item.resetting')}
        busy={resetting}
        onConfirm={() => void resetItem()}
        onClose={() => setConfirmReset(false)}
      />
    </>
  );
}

/** «zł», «грн», «€» — підказка в полі ціни замість слова «валюта». */
function currencySymbol(currency: Currency, locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: 'currency', currency })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Нотатка — багаторядкова, тож `textarea` з тим самим виглядом, що й поле. */
function NoteFieldV2({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="v2-field">
      <label className="v2-field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        name="note"
        className="v2-input v2-input--area"
        rows={3}
        maxLength={ITEM_NOTE_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Рідний `<select>` у вигляді поля v2: клавіатура й телефон — без жодного коду. */
function SelectV2({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="v2-field">
      <label className="v2-field__label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="v2-input v2-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Ознаки товару (V1, ADR-030): пари «Розмір → M». Рядок без значення не
 * зберігається — тож заготовлені «Розмір» і «Колір» нічого не псують, якщо
 * лишились порожніми. Підписи — підказки datalist, а не обмеження.
 */
function VariantsV2({
  hintsId,
  variants,
  onChange,
}: {
  hintsId: string;
  variants: ItemVariant[];
  onChange: (next: ItemVariant[]) => void;
}) {
  const { t } = useI18n();
  const patch = (index: number, part: Partial<ItemVariant>) =>
    onChange(variants.map((v, i) => (i === index ? { ...v, ...part } : v)));

  return (
    <fieldset className="v2-variants">
      <legend className="v2-kicker">{t('v2item.variants.legend')}</legend>
      <datalist id={hintsId}>
        <option value={t('v2item.variants.size')} />
        <option value={t('v2item.variants.color')} />
        <option value={t('v2item.variants.model')} />
        <option value={t('v2item.variants.orElse')} />
      </datalist>
      {variants.map((v, i) => (
        // Ключ за позицією: рядки не переставляються, а власного id у пари немає.
        <div className="v2-variants__row" key={i}>
          <input
            className="v2-input v2-variants__label"
            list={hintsId}
            maxLength={VARIANT_LABEL_MAX}
            aria-label={t('v2item.variants.labelAria', { n: i + 1 })}
            value={v.label}
            onChange={(e) => patch(i, { label: e.target.value })}
          />
          <input
            className="v2-input"
            maxLength={VARIANT_VALUE_MAX}
            aria-label={t('v2item.variants.valueAria', { n: i + 1 })}
            value={v.value}
            onChange={(e) => patch(i, { value: e.target.value })}
          />
          <button
            type="button"
            className="v2-iconbtn"
            aria-label={t('v2item.variants.remove', { n: i + 1 })}
            onClick={() => onChange(variants.filter((_, j) => j !== i))}
          >
            <X size={18} strokeWidth={STROKE} aria-hidden="true" />
          </button>
        </div>
      ))}
      {variants.length < VARIANTS_MAX && (
        <button
          type="button"
          className="v2-btn v2-btn--ghost v2-btn--start"
          onClick={() => onChange([...variants, { label: '', value: '' }])}
        >
          <Plus size={18} strokeWidth={STROKE} aria-hidden="true" />
          {t('v2item.variants.add')}
        </button>
      )}
    </fieldset>
  );
}
