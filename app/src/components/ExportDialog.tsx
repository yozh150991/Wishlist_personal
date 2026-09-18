import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { Note } from './ui';
import { useI18n } from '../lib/i18n';
import { errorText } from '../lib/errors';
import { fetchAllItems } from '../lib/db';
import { downloadText } from '../lib/download';
import { fileName, toCsv, toJson } from '../lib/transfer';
import type { List } from '../lib/types';

/**
 * Вивантаження списку у файл (ROADMAP 6.3).
 *
 * Позиції беремо з бази наново, а не зі сторінки: там лише поточна партія, а
 * людина чекає на весь список. Що саме не потрапляє у файл — написано прямо в
 * діалозі: броні власник не бачить ніде, і файл не має ставати винятком.
 */
export function ExportDialog({
  open,
  list,
  onClose,
}: {
  open: boolean;
  list: List | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function save(kind: 'csv' | 'json') {
    if (busy || !list) return;
    setBusy(true);
    setError(null);
    try {
      const items = await fetchAllItems(list.id);
      const text = kind === 'csv' ? toCsv(items) : toJson(list, items);
      const type = kind === 'csv' ? 'text/csv' : 'application/json';
      downloadText(fileName(list.title, kind), text, type);
      onClose();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('transfer.export.title')}>
      {error && <Note tone="error">{error}</Note>}
      <p className="small">{t('transfer.export.body')}</p>

      <div className="transfer__choice">
        <button
          type="button"
          className="btn btn--wide"
          disabled={busy}
          onClick={() => void save('csv')}
        >
          {t('transfer.export.csv')}
        </button>
        <p className="hint">{t('transfer.export.csvHint')}</p>

        <button
          type="button"
          className="btn btn--wide"
          disabled={busy}
          onClick={() => void save('json')}
        >
          {t('transfer.export.json')}
        </button>
        <p className="hint">{t('transfer.export.jsonHint')}</p>
      </div>

      <div className="dialog__actions">
        <button type="button" className="btn btn--quiet" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </Dialog>
  );
}
