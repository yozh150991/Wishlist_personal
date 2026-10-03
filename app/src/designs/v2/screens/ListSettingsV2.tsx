import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { CURRENCIES } from '../../../lib/types';
import type { Currency, List } from '../../../lib/types';
import type { ListInput } from '../../../lib/db';
import { FieldV2, NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2, YearlySwitchV2, useCounts } from './CommonV2';

/** Межі з `lists` (README, «Обмеження полів»). */
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;

/**
 * Налаштування списку v2: назва, повідомлення гостям, дата, валюта,
 * «Повторювати щороку» (ADR-047) — і вхід у видалення. Решта вигляду (оформлення) — окремим вікном з меню списку.
 */
export function ListSettingsV2({
  open,
  list,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  list: List | null;
  onClose: () => void;
  onSave: (input: ListInput) => Promise<void>;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const descId = useId();
  const currencyId = useId();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [currency, setCurrency] = useState<Currency>('PLN');
  const [yearly, setYearly] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(list?.title ?? '');
    setDescription(list?.description ?? '');
    setDate(list?.event_date ?? '');
    setCurrency(list?.currency ?? 'PLN');
    setYearly(Boolean(list?.repeats_yearly));
    setSubmitted(false);
    setServer(null);
    setBusy(false);
  }, [open, list]);

  async function save() {
    if (busy) return;
    setSubmitted(true);
    if (!title.trim()) return titleRef.current?.focus();
    setBusy(true);
    setServer(null);
    try {
      await onSave({
        title: title.trim(),
        description: description.trim() || null,
        currency,
        event_date: date || null,
        // Без дати нагадувати нема про що — позначка знімається разом із датою.
        repeats_yearly: Boolean(date) && yearly,
      });
      onClose();
    } catch (e) {
      setServer(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetV2 open={open} onClose={onClose} labelledBy={titleId} className="v2-sheet--full" closeOnBackdrop={false}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="v2-bar">
          <button type="button" className="v2-bar__btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <h2 className="v2-bar__title" id={titleId}>
            {t('v2list.settings.title')}
          </h2>
          <span className="v2-bar__spacer" aria-hidden="true" />
        </div>
        <div className="v2-itemsheet__body">
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          <FieldV2
            ref={titleRef}
            label={t('v2app.newList.name')}
            name="list_title"
            maxLength={TITLE_MAX}
            autoComplete="off"
            value={title}
            error={submitted && !title.trim() ? t('v2app.newList.nameEmpty') : null}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="v2-field">
            <label className="v2-field__label" htmlFor={descId}>
              {t('v2list.settings.description')}
            </label>
            <textarea
              id={descId}
              name="list_description"
              className="v2-input v2-input--area"
              rows={3}
              maxLength={DESCRIPTION_MAX}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="v2-row v2-row--even">
            <FieldV2
              label={t('v2app.newList.date')}
              name="list_date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <div className="v2-field">
              <label className="v2-field__label" htmlFor={currencyId}>
                {t('lists.fields.currency')}
              </label>
              <select
                id={currencyId}
                className="v2-input v2-select"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <YearlySwitchV2 date={date} checked={yearly} onChange={setYearly} />
          <SubmitV2 busy={busy} label={t('common.save')} busyLabel={t('common.saving')} />
          <div className="v2-reset">
            <button type="button" className="v2-btn v2-btn--danger v2-btn--start" onClick={onDelete}>
              {t('v2list.delete.cta')}
            </button>
          </div>
        </div>
      </form>
    </SheetV2>
  );
}

/**
 * Видалення списку, який уже хтось відкривав (потік F3): назву треба ввести
 * рукою. Вмикається за переглядами посилань, а не за позначками — щоб діалог
 * не видав сюрприз (ADR-040). Список, який ніхто не бачив, видаляється тостом
 * «Відмінити» на головній, без цього вікна.
 */
export function DeleteListSheetV2({
  open,
  list,
  itemCount,
  views,
  onClose,
  onConfirm,
}: {
  open: boolean;
  list: List | null;
  itemCount: number;
  /** Скільки разів відкривали посилання; `null` — не вдалося дізнатися. */
  views: number | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useI18n();
  const counts = useCounts();
  const titleId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTyped('');
    setBusy(false);
    setServer(null);
    setTried(false);
  }, [open]);

  const name = list?.title ?? '';
  const matches = typed.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() && name.trim() !== '';

  async function confirm() {
    if (busy) return;
    setTried(true);
    if (!matches) return inputRef.current?.focus();
    setBusy(true);
    setServer(null);
    try {
      await onConfirm();
    } catch (e) {
      setServer(errorText(e, t));
      setBusy(false);
    }
  }

  const viewed =
    views === null ? t('v2list.delete.viewedUnknown') : views > 0 ? counts.opened(views) : '';

  return (
    <SheetV2 open={open} onClose={onClose} labelledBy={titleId}>
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <h2 className="v2-sheet__title" id={titleId}>
          {t('v2list.delete.title', { title: name })}
        </h2>
        <p className="v2-lede">
          {t('v2list.delete.body', { items: counts.items(itemCount) })} {viewed}
        </p>
        {server && <NoteV2 tone="error">{server}</NoteV2>}
        <FieldV2
          ref={inputRef}
          label={t('v2list.delete.typeLabel')}
          name="confirm_title"
          autoComplete="off"
          placeholder={name}
          value={typed}
          error={tried && !matches ? t('v2list.delete.typeMismatch') : null}
          onChange={(e) => setTyped(e.target.value)}
        />
        <div className="v2-sheet__actions">
          <button
            type="submit"
            className="v2-btn v2-btn--danger-fill v2-btn--block"
            aria-disabled={busy || !matches || undefined}
            data-busy={busy || undefined}
          >
            {busy && <span className="v2-spinner" aria-hidden="true" />}
            {busy ? t('lists.deleting') : t('v2list.delete.confirm')}
          </button>
          <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
            {t('common.keep')}
          </button>
        </div>
      </form>
    </SheetV2>
  );
}
