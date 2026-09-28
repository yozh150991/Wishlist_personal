import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { errorText } from '../lib/errors';
import { SECTION_TITLE_MAX } from '../lib/sections';
import type { Section } from '../lib/sections';
import { Dialog } from './Dialog';
import { Field, Note } from './ui';

/**
 * Новий розділ або перейменування наявного (ADR-036). Назву бачать гості —
 * якщо в розділі є позиції, якими поділились.
 */
export function SectionDialog({
  open,
  section,
  onClose,
  onSave,
}: {
  open: boolean;
  /** null — новий розділ. */
  section: Section | null;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(section?.title ?? '');
    setError(null);
  }, [open, section]);

  async function submit() {
    if (busy) return;
    if (!title.trim()) return setError(t('sections.nameRequired'));
    setBusy(true);
    setError(null);
    try {
      await onSave(title.trim());
      onClose();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={section ? t('sections.renameTitle') : t('sections.new')}>
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
          label={t('sections.name')}
          name="sectionTitle"
          maxLength={SECTION_TITLE_MAX}
          count
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="dialog__foot">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? (section ? t('common.saving') : t('sections.creating')) : section ? t('common.save') : t('sections.create')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
