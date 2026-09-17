import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { Field, Note } from './ui';
import { useI18n } from '../lib/i18n';
import { createShare, shareUrl } from '../lib/shares';

export function ShareDialog({
  open,
  listId,
  itemIds,
  defaultTitle,
  onClose,
  onCreated,
}: {
  open: boolean;
  listId: string;
  itemIds: string[];
  defaultTitle: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [hidePrices, setHidePrices] = useState(false);
  const [allowReservations, setAllowReservations] = useState(true);
  const [expiresAt, setExpiresAt] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle);
    setMessage('');
    setHidePrices(false);
    setAllowReservations(true);
    setExpiresAt('');
    setLink(null);
    setCopied(false);
    setError(null);
  }, [open, defaultTitle]);

  async function submit() {
    // Подвійний Enter не має створити два посилання.
    if (busy) return;
    if (!title.trim()) return setError(t('share.errors.titleRequired'));
    if (itemIds.length === 0) return setError(t('share.errors.nothingSelected'));

    setBusy(true);
    setError(null);
    try {
      const share = await createShare({
        listId,
        itemIds,
        title: title.trim(),
        message: message.trim() || null,
        hidePrices,
        allowReservations,
        // Кінець обраного дня, а не його початок.
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      });
      setLink(shareUrl(share.token));
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('share.create')}>
      {link ? (
        <div className="form-grid">
          <Note tone="success">{t('share.ready')}</Note>

          <div className="field">
            <label htmlFor="shareLink">{t('share.link')}</label>
            <div className="url-row">
              <input id="shareLink" readOnly value={link} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn" onClick={() => void copy()}>
                {copied ? t('share.copied') : t('share.copy')}
              </button>
            </div>
            <span className="hint">{t('share.linkHint')}</span>
          </div>

          <div className="dialog__foot">
            <button type="button" className="btn btn--quiet" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : (
        // <form>: Enter у текстовому полі створює посилання (CLAUDE.md §4).
        <form
          className="form-grid"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error && <Note tone="error">{error}</Note>}
          <p className="lede">{t('share.intro', { n: itemIds.length })}</p>

          <Field
            label={t('share.fields.title')}
            name="shareTitle"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div className="field">
            <label htmlFor="shareMessage">{t('share.fields.message')}</label>
            <textarea
              id="shareMessage"
              rows={2}
              maxLength={1000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <span className="hint">{t('share.fields.messageHint')}</span>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={allowReservations}
              onChange={(e) => setAllowReservations(e.target.checked)}
            />
            <span>
              {t('share.fields.allowReservations')}
              <span className="hint">{t('share.fields.allowReservationsHint')}</span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={hidePrices}
              onChange={(e) => setHidePrices(e.target.checked)}
            />
            <span>{t('share.fields.hidePrices')}</span>
          </label>

          <Field
            label={t('share.fields.expiresAt')}
            name="expiresAt"
            type="date"
            hint={t('share.fields.expiresAtHint')}
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />

          <div className="dialog__foot">
            <button type="button" className="btn btn--quiet" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn" disabled={busy}>
              {t('share.create')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
