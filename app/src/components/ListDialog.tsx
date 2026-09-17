import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { Field, Note } from './ui';
import { useI18n } from '../lib/i18n';
import { CURRENCIES } from '../lib/types';
import type { Currency, List } from '../lib/types';
import type { ListInput } from '../lib/db';

export function ListDialog({
  open,
  list,
  onClose,
  onSave,
}: {
  open: boolean;
  list: List | null;
  onClose: () => void;
  onSave: (input: ListInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState<Currency>('PLN');
  const [eventDate, setEventDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTitle(list?.title ?? '');
    setDescription(list?.description ?? '');
    setCurrency(list?.currency ?? 'PLN');
    setEventDate(list?.event_date ?? '');
  }, [open, list]);

  async function submit() {
    if (busy) return;
    if (!title.trim()) return setError(t('lists.errors.titleRequired'));
    setBusy(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        description: description.trim() || null,
        currency,
        event_date: eventDate || null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={list ? t('lists.edit') : t('lists.create')}>
      {/* <form>: Enter у текстовому полі зберігає (CLAUDE.md §4). */}
      <form
        className="form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <Note tone="error">{error}</Note>}

        <Field
          label={t('lists.fields.title')}
          name="listTitle"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <div className="field">
          <label htmlFor="description">{t('lists.fields.description')}</label>
          <textarea
            id="description"
            rows={2}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="currency">{t('lists.fields.currency')}</label>
            <select
              id="currency"
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

          <Field
            label={t('lists.fields.eventDate')}
            name="eventDate"
            type="date"
            hint={t('lists.fields.eventDateHint')}
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
          />
        </div>

        <div className="dialog__foot">
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
