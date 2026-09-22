import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { Field, Note } from './ui';
import { useI18n } from '../lib/i18n';
import { money } from '../lib/format';
import { errorText } from '../lib/errors';
import { MAX_IMPORT_ITEMS, parseFile } from '../lib/transfer';
import { CURRENCIES } from '../lib/types';
import type { Currency } from '../lib/types';
import type { Issue, TransferItem, TransferList } from '../lib/transfer';

/**
 * Внесення списку з файлу (ROADMAP 6.3).
 *
 * Створення відділене від читання: спершу людина бачить, що саме зʼявиться, і
 * лише потім натискає кнопку. Файл ніколи не потрапляє в базу «як є» — усі
 * значення проходять ті самі межі, що стоять `check`-обмеженнями в схемі.
 *
 * Назву й валюту можна поправити просто тут: CSV не має де їх зберігати, а
 * вгадувати за вмістом було б гіршим за чесне поле.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_ROWS = 8;

export function ImportDialog({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (list: TransferList, items: TransferItem[]) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [items, setItems] = useState<TransferItem[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [title, setTitle] = useState('');
  const [currency, setCurrency] = useState<Currency>('PLN');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) return;
    setName('');
    setItems([]);
    setIssues([]);
    setTitle('');
    setError(null);
  }, [open]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(t('transfer.import.tooBig', { max: MAX_BYTES / 1024 / 1024 }));
      return;
    }
    try {
      const text = await file.text();
      // Запасна назва — з імені файлу: так найчастіше й називають список.
      const fallback = file.name.replace(/\.(csv|json)$/i, '').replace(/[-_]+/g, ' ').trim();
      const parsed = parseFile(file.name, text, fallback || t('transfer.import.fallbackTitle'));
      setName(file.name);
      setItems(parsed.items);
      setIssues(parsed.issues);
      setTitle(parsed.list.title);
      setCurrency(parsed.list.currency);
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  async function submit() {
    if (busy || items.length === 0) return;
    if (!title.trim()) return setError(t('lists.errors.titleRequired'));
    setBusy(true);
    setError(null);
    try {
      await onImport({ title: title.trim(), description: null, currency, event_date: null }, items);
      onClose();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  return (
    <Dialog open={open} onClose={onClose} title={t('transfer.import.title')}>
      <form
        className="form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <Note tone="error">{error}</Note>}

        {/* Власне поле вибору файлу замість типового. Причина не в оформленні:
            рідний `<input type="file">` підписує себе мовою браузера, тож
            українець із російським Chrome бачив у нашому діалозі «Файл не
            выбран». Сам `<input>` лишається на місці й лишається фокусованим —
            зникає лише його вигляд, а підпис бере на себе `<label>`. */}
        <div className="field">
          <label htmlFor="importFile">{t('transfer.import.file')}</label>
          <div className="filefield">
            <input
              className="filefield__input"
              id="importFile"
              ref={input}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <label className="btn btn--secondary filefield__button" htmlFor="importFile">
              {t('transfer.import.choose')}
            </label>
            <span className="filefield__name">{name === '' ? t('transfer.import.noFile') : name}</span>
          </div>
          <span className="hint">{t('transfer.import.hint', { max: MAX_IMPORT_ITEMS })}</span>
        </div>

        {name === '' ? (
          <p className="small">{t('transfer.import.pick')}</p>
        ) : (
          <>
            <Field
              label={t('lists.fields.title')}
              name="importTitle"
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            <div className="field">
              <label htmlFor="importCurrency">{t('lists.fields.currency')}</label>
              <select
                className="input"
                id="importCurrency"
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

            <div className="transfer__preview" role="region" aria-label={t('transfer.import.region')}>
              <p>
                {items.length > 0
                  ? t('transfer.import.preview', { n: items.length })
                  : t('transfer.import.nothing')}
              </p>

              {items.length > 0 && (
                <ul className="transfer__rows">
                  {items.slice(0, PREVIEW_ROWS).map((i, at) => (
                    <li key={at}>
                      <span>{i.title}</span>
                      {i.price !== null && (
                        <span className="small"> · {money(i.price, currency, locale)}</span>
                      )}
                      {i.quantity > 1 && <span className="small"> · ×{i.quantity}</span>}
                    </li>
                  ))}
                  {items.length > PREVIEW_ROWS && (
                    <li className="small">
                      {t('transfer.import.andMore', { n: items.length - PREVIEW_ROWS })}
                    </li>
                  )}
                </ul>
              )}

              {issues.length > 0 && (
                <details className="transfer__issues">
                  <summary>
                    {t('transfer.import.issues', { errors: errors.length, warnings: warnings.length })}
                  </summary>
                  <ul>
                    {issues.map((issue, at) => (
                      <li key={at} data-tone={issue.level === 'error' ? 'error' : undefined}>
                        <b>
                          {issue.row === 0
                            ? t('transfer.import.fileLabel')
                            : t('transfer.import.rowLabel', { row: issue.row })}
                        </b>{' '}
                        {t(issue.key, issue.vars)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </>
        )}

        <div className="dialog__foot">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || items.length === 0}>
            {busy && <span className="spinner" />}
            {busy ? t('transfer.import.importing') : t('transfer.import.submit', { n: items.length })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
