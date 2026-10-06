import { useEffect, useId, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useI18n } from '../../../lib/i18n';
import { moneyShort } from '../../../lib/format';
import { errorText } from '../../../lib/errors';
import { MAX_IMPORT_ITEMS, parseFile } from '../../../lib/transfer';
import type { Issue, TransferItem, TransferList } from '../../../lib/transfer';
import { CURRENCIES } from '../../../lib/types';
import type { Currency } from '../../../lib/types';
import { FieldV2, NoteV2 } from './AuthPartsV2';
import { SheetV2 } from './CommonV2';

/** Межі — ті самі, що в імпорті v1 (`ImportDialog`) і в `lists.title`. */
const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_ROWS = 8;
const TITLE_MAX = 120;
const STROKE = 2.75;

/**
 * «Імпорт із файлу» у v2 (ADR-050) — той самий розбір, що й у v1
 * (`lib/transfer.ts`): CSV чи JSON, до 1000 позицій, кожне значення в межах
 * `check`-обмежень. Спершу людина бачить, що саме зʼявиться, і лише потім
 * створює список. Назву й валюту можна поправити тут: у CSV їм немає місця.
 *
 * Вибір файлу — свій, а не рідний `<input type="file">`: той підписує себе
 * мовою браузера («Файл не выбран», CLAUDE.md §4). Справжній `<input>`
 * лишається фокусованим, видиме — `<label>`-кнопка й рядок імені файлу.
 */
export function ImportSheetV2({
  open,
  defaultCurrency,
  onClose,
  onImport,
}: {
  open: boolean;
  defaultCurrency: Currency;
  onClose: () => void;
  /** Кидає помилку, якщо сервер відмовив; на успіх екран сам іде в новий список. */
  onImport: (list: TransferList, items: TransferItem[]) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const fileId = useId();
  const currencyId = useId();
  const [name, setName] = useState('');
  const [items, setItems] = useState<TransferItem[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [title, setTitle] = useState('');
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [parsedList, setParsedList] = useState<TransferList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setItems([]);
    setIssues([]);
    setTitle('');
    setCurrency(defaultCurrency);
    setParsedList(null);
    setError(null);
    setTried(false);
    setBusy(false);
  }, [open, defaultCurrency]);

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
      setParsedList(parsed.list);
      setTitle(parsed.list.title.slice(0, TITLE_MAX));
      setCurrency(parsed.list.currency);
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  async function submit() {
    if (busy || items.length === 0) return;
    setTried(true);
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Опис і дату з JSON переносимо як є — у v1 імпорт їх губив.
      await onImport(
        {
          title: title.trim(),
          description: parsedList?.description ?? null,
          currency,
          event_date: parsedList?.event_date ?? null,
        },
        items,
      );
    } catch (e) {
      setError(errorText(e, t));
      setBusy(false);
    }
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  return (
    <SheetV2 open={open} onClose={onClose} labelledBy="v2-import-title" closeOnBackdrop={name === ''}>
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="v2-sheet__title" id="v2-import-title">
          {t('transfer.import.title')}
        </h2>
        {error && <NoteV2 tone="error">{error}</NoteV2>}

        <div className="v2-field">
          <span className="v2-field__label">{t('transfer.import.file')}</span>
          <div className="v2-file">
            <input
              id={fileId}
              className="v2-file__input"
              type="file"
              accept=".csv,.json,text/csv,application/json"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <label htmlFor={fileId} className="v2-btn v2-btn--outline">
              <FileUp size={20} strokeWidth={STROKE} aria-hidden="true" />
              {t('transfer.import.choose')}
            </label>
            <span className="v2-file__name">{name === '' ? t('transfer.import.noFile') : name}</span>
          </div>
          <p className="v2-hint v2-hint--start">{t('transfer.import.hint', { max: MAX_IMPORT_ITEMS })}</p>
        </div>

        {name !== '' && (
          <>
            <FieldV2
              label={t('v2app.newList.name')}
              name="import_title"
              maxLength={TITLE_MAX}
              autoComplete="off"
              value={title}
              error={tried && !title.trim() ? t('v2app.newList.nameEmpty') : null}
              onChange={(e) => setTitle(e.target.value)}
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

            <section className="v2-import" aria-label={t('transfer.import.region')}>
              <p className="v2-import__lead">
                {items.length > 0 ? t('transfer.import.preview', { n: items.length }) : t('transfer.import.nothing')}
              </p>
              {items.length > 0 && (
                <ul className="v2-import__rows">
                  {items.slice(0, PREVIEW_ROWS).map((i, at) => (
                    <li key={at}>
                      <span className="v2-import__name">{i.title}</span>
                      <span className="v2-import__meta">
                        {[
                          i.price !== null ? moneyShort(i.price, currency, locale) : null,
                          i.quantity > 1 ? `× ${i.quantity}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                  {items.length > PREVIEW_ROWS && (
                    <li className="v2-import__meta">{t('transfer.import.andMore', { n: items.length - PREVIEW_ROWS })}</li>
                  )}
                </ul>
              )}
              {issues.length > 0 && (
                <details className="v2-import__issues">
                  <summary>{t('transfer.import.issues', { errors: errors.length, warnings: warnings.length })}</summary>
                  <ul>
                    {issues.map((issue, at) => (
                      <li key={at} data-tone={issue.level === 'error' ? 'danger' : undefined}>
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
            </section>
          </>
        )}

        <div className="v2-sheet__actions">
          <button
            type="submit"
            className="v2-btn v2-btn--primary v2-btn--block"
            aria-disabled={busy || items.length === 0 || undefined}
            data-busy={busy || undefined}
          >
            {busy && <span className="v2-spinner" aria-hidden="true" />}
            {busy ? t('transfer.import.importing') : t('transfer.import.submit', { n: items.length })}
          </button>
          <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </SheetV2>
  );
}
