import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { ParseError, parseUrl, parserConfigured } from '../lib/parser';
import { Field, Note } from './ui';
import { VariantsField, cleanVariants, variantsError } from './VariantsField';
import { useI18n } from '../lib/i18n';
import { errorText } from '../lib/errors';
import { PRIORITIES, STATUSES } from '../lib/types';
import type { Item, ItemPriority, ItemStatus, ItemVariant } from '../lib/types';
import type { ItemInput } from '../lib/db';

const EMPTY = {
  title: '',
  url: '',
  price: '',
  quantity: '1',
  priority: 'medium' as ItemPriority,
  note: '',
  image_url: '',
  status: 'active' as ItemStatus,
};

export function ItemDialog({
  open,
  item,
  onClose,
  onSave,
}: {
  open: boolean;
  item: Item | null;
  onClose: () => void;
  onSave: (input: ItemInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY);
  // Пари живуть окремо від решти полів: у `form` усе — рядки, і масив у тому
  // самому об'єкті зламав би типізацію `set()`.
  const [variants, setVariants] = useState<ItemVariant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // Помилка може опинитись поза видимою частиною прокрученого діалога.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setForm(
      item
        ? {
            title: item.title,
            url: item.url ?? '',
            price: item.price === null ? '' : String(item.price),
            quantity: String(item.quantity),
            priority: item.priority,
            note: item.note ?? '',
            image_url: item.image_url ?? '',
            status: item.status,
          }
        : EMPTY,
    );
    // Копія, а не посилання: інакше редагування правило б масив у списку
    // ще до збереження.
    setVariants(item ? item.variants.map((v) => ({ ...v })) : []);
  }, [open, item]);

  function set<K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /**
   * Заповнює порожні поля даними з посилання. Уже введене користувачем
   * не перезаписуємо: ручний ввід завжди важливіший за здогад парсера.
   */
  async function fillFromUrl() {
    const url = form.url.trim();
    if (!/^https?:\/\//i.test(url)) return setError(t('item.errors.badUrl'));

    setParsing(true);
    setError(null);
    setNotice(null);
    try {
      const got = await parseUrl(url);
      setForm((f) => ({
        ...f,
        title: f.title || got.title || '',
        price: f.price || (got.price !== null ? String(got.price) : ''),
        image_url: f.image_url || got.image_url || '',
      }));
      if (got.partial) setNotice(t('parser.partial'));
      else if (got.currency) setNotice(t('parser.gotCurrency', { currency: got.currency }));
    } catch (e) {
      setError(e instanceof ParseError ? t(e.key) : t('parser.errors.unknown'));
    } finally {
      setParsing(false);
    }
  }

  // Межі повторюють check-обмеження в таблиці items: краще сказати одразу,
  // ніж отримати 400 від бази.
  async function submit() {
    if (busy) return;
    if (!form.title.trim()) return setError(t('item.errors.titleRequired'));
    if (form.url && !/^https?:\/\//i.test(form.url)) return setError(t('item.errors.badUrl'));

    if (form.price !== '') {
      const price = Number(form.price);
      if (!Number.isFinite(price) || price < 0) return setError(t('item.errors.badPrice'));
      if (price > 9_999_999_999) return setError(t('item.errors.priceTooBig'));
    }

    const qty = Number(form.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      return setError(t('item.errors.badQuantity'));
    }

    const variantsKey = variantsError(variants);
    if (variantsKey) return setError(t(variantsKey));

    setBusy(true);
    setError(null);
    try {
      await onSave({
        title: form.title.trim(),
        url: form.url.trim() || null,
        price: form.price === '' ? null : Number(form.price),
        quantity: qty,
        priority: form.priority,
        note: form.note.trim() || null,
        variants: cleanVariants(variants),
        image_url: form.image_url.trim() || null,
        status: form.status,
      });
      onClose();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={item ? t('item.edit') : t('item.add')}>
      {/* <form>: Enter у текстовому полі зберігає (CLAUDE.md §4). */}
      <form
        className="form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div ref={errorRef}>
          {error && <Note tone="error">{error}</Note>}
          {!error && notice && <Note>{notice}</Note>}
        </div>

        {/* Кнопка стоїть у одному рядку з полем, а не поряд із усім блоком:
            інакше її доводиться вирівнювати відступом під висоту підпису,
            і будь-яка зміна шрифту чи довжини тексту все ламає. */}
        <div className="field">
          <label htmlFor="url">{t('item.fields.url')}</label>
          <div className="url-row">
            <input
              className="input"
              id="url"
              name="url"
              type="url"
              placeholder="https://"
              aria-describedby="url-hint"
              value={form.url}
              onChange={(e) => set('url', e.target.value)}
              onKeyDown={(e) => {
                // Вставив посилання й натиснув Enter — людина чекає автозаповнення,
                // а не помилку «вкажи назву». Тож поки назви немає і парсер
                // доступний, Enter у цьому полі запускає «Заповнити».
                // Коли назва вже є, Enter зберігає, як у будь-якому іншому полі.
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  !form.title.trim() &&
                  form.url.trim() &&
                  parserConfigured()
                ) {
                  e.preventDefault();
                  if (!parsing) void fillFromUrl();
                }
              }}
            />
            <button
              type="button"
              className="btn btn--secondary"
              disabled={parsing || !form.url.trim() || !parserConfigured()}
              onClick={() => void fillFromUrl()}
            >
              {parsing ? `${t('common.loading')}…` : t('parser.fill')}
            </button>
          </div>
          <span className="hint" id="url-hint">
            {parserConfigured() ? t('item.fields.urlHint') : t('parser.errors.notConfigured')}
          </span>
        </div>

        <Field
          label={t('item.fields.title')}
          name="title"
          maxLength={200}
          count
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
        />

        <div className="form-row">
          <Field
            label={t('item.fields.price')}
            name="price"
            type="number"
            min="0"
            max="9999999999"
            step="0.01"
            inputMode="decimal"
            hint={t('item.fields.priceHint')}
            value={form.price}
            onChange={(e) => set('price', e.target.value)}
          />
          <Field
            label={t('item.fields.quantity')}
            name="quantity"
            type="number"
            min="1"
            max="999"
            step="1"
            value={form.quantity}
            onChange={(e) => set('quantity', e.target.value)}
          />
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="priority">{t('item.fields.priority')}</label>
            <select
              className="input"
              id="priority"
              value={form.priority}
              onChange={(e) => set('priority', e.target.value as ItemPriority)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`item.priority.${p}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="status">{t('item.fields.status')}</label>
            <select
              className="input"
              id="status"
              value={form.status}
              onChange={(e) => set('status', e.target.value as ItemStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`item.status.${s}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <VariantsField variants={variants} onChange={setVariants} />

        <Field
          label={t('item.fields.imageUrl')}
          name="image_url"
          type="url"
          placeholder="https://"
          value={form.image_url}
          onChange={(e) => set('image_url', e.target.value)}
        />

        <div className="field">
          <label htmlFor="note">{t('item.fields.note')}</label>
          <textarea
            className="input"
            id="note"
            rows={3}
            maxLength={1000}
            value={form.note}
            onChange={(e) => set('note', e.target.value)}
          />
        </div>

        <div className="dialog__foot">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
