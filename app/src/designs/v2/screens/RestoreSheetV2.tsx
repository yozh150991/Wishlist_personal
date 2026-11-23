import { useEffect, useId, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { useTheme } from '../../../lib/theme';
import { errorText } from '../../../lib/errors';
import { BACKUP_MAX_BYTES } from '../../../lib/backup';
import type { OpenedBackup, RestoreProgress, RestoreResult } from '../../../lib/backupZip';
import { NoteV2 } from './AuthPartsV2';
import { SheetV2, SwitchV2 } from './CommonV2';

const STROKE = 2.75;

/** Лінивий модуль копії: разом із ним приїздить `fflate` (ROADMAP 8.12). */
const loadBackup = () => import('../../../lib/backupZip');

type Problem = { key: string; vars?: Record<string, string | number> } | { text: string };

/**
 * «Відновити з копії» (ROADMAP 8.12). Спершу файл повністю читається й
 * перевіряється (`parseBackup`) — зламаний, чужий чи новіший файл дає
 * помилку, і в базі нічого не з'являється. Далі — що саме буде відновлено:
 * списки, що вже є в акаунті, пропускаються (повтор після обриву чи ліміту
 * фото докладає решту), мова й вигляд беруться з копії лише на вимогу.
 *
 * Вибір файлу — свій, як в імпорті: рідний `<input type="file">` підписує
 * себе мовою браузера (CLAUDE.md §4).
 */
export function RestoreSheetV2({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const { session } = useAuth();
  const { setTheme, chooseScheme, setHighContrast } = useTheme();
  const fileId = useId();
  const [name, setName] = useState('');
  const [opened, setOpened] = useState<OpenedBackup | null>(null);
  const [budget, setBudget] = useState<{ quota: number; hour: number } | null>(null);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [applyLook, setApplyLook] = useState(false);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  /** Номер запуску: «Зупинити» й закриття аркуша його міняють — запуск стає перед наступним списком. */
  const runId = useRef(0);

  useEffect(() => {
    if (!open) return;
    setName('');
    setOpened(null);
    setBudget(null);
    setIncludeExisting(false);
    setApplyLook(false);
    setReading(false);
    setProgress(null);
    setResult(null);
    setProblem(null);
  }, [open]);

  function show(e: unknown, mod: Awaited<ReturnType<typeof loadBackup>> | null) {
    if (mod && e instanceof mod.BackupError) setProblem({ key: e.key, vars: e.vars });
    else setProblem({ text: errorText(e, t) });
  }

  async function pick(file: File | undefined) {
    if (!file || reading || progress) return;
    setProblem(null);
    setResult(null);
    setOpened(null);
    setName(file.name);
    setReading(true);
    let mod: Awaited<ReturnType<typeof loadBackup>> | null = null;
    try {
      mod = await loadBackup();
      const next = await mod.openBackup(file, t('transfer.import.fallbackTitle'));
      setOpened(next);
      if (next.photos > 0) setBudget(await mod.photoBudget().catch(() => null));
    } catch (e) {
      show(e, mod);
    } finally {
      setReading(false);
    }
  }

  const toRestore = opened ? opened.existing.filter((x) => includeExisting || !x).length : 0;
  const existingCount = opened ? opened.existing.filter(Boolean).length : 0;
  const items = opened ? opened.plan.lists.reduce((n, l) => n + l.items.length, 0) : 0;
  const profile = opened?.plan.profile ?? null;
  const hasLook = Boolean(profile && (profile.locale || profile.theme || profile.scheme || profile.high_contrast !== null));

  async function submit() {
    if (!opened || progress || toRestore === 0 || !session) return;
    const mine = ++runId.current;
    setProblem(null);
    setResult(null);
    setProgress({ list: 0, lists: toRestore, photo: 0, photos: 0 });
    let mod: Awaited<ReturnType<typeof loadBackup>> | null = null;
    try {
      mod = await loadBackup();
      const done = await mod.restoreBackup(opened, {
        ownerId: session.user.id,
        includeExisting,
        copySuffix: t('backup.restore.copySuffix'),
        onProgress: (p) => {
          if (runId.current === mine) setProgress(p);
        },
        cancelled: () => runId.current !== mine,
      });
      if (applyLook && profile && !done.cancelled) {
        if (profile.theme) setTheme(profile.theme);
        if (profile.scheme) chooseScheme(profile.scheme);
        if (profile.high_contrast !== null) setHighContrast(profile.high_contrast);
        if (profile.locale) setLocale(profile.locale);
      }
      setResult(done);
      // Відновлене тепер «вже є»: повтор без перевибору файлу нічого не задвоїть.
      setOpened(null);
    } catch (e) {
      show(e, mod);
      setOpened(null);
    } finally {
      setProgress(null);
    }
  }

  function close() {
    runId.current++;
    onClose();
  }

  const busy = reading || Boolean(progress);
  const made = opened?.plan.exportedAt ? new Date(opened.plan.exportedAt) : null;

  return (
    <SheetV2 open={open} onClose={close} labelledBy="v2-restore-title" closeOnBackdrop={!busy && !opened}>
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="v2-sheet__title" id="v2-restore-title">
          {t('backup.restore.title')}
        </h2>
        <p className="v2-hint v2-hint--start">{t('backup.restore.intro')}</p>
        {problem && <NoteV2 tone="error">{'text' in problem ? problem.text : t(problem.key, problem.vars)}</NoteV2>}

        <div className="v2-field">
          <span className="v2-field__label">{t('backup.restore.file')}</span>
          <div className="v2-file">
            <input
              id={fileId}
              className="v2-file__input"
              type="file"
              accept=".zip,.json,application/zip,application/json"
              data-testid="restore-file"
              disabled={busy}
              onChange={(e) => {
                void pick(e.target.files?.[0]);
                // Той самий файл ще раз (після ліміту фото) — теж подія change.
                e.target.value = '';
              }}
            />
            <label htmlFor={fileId} className="v2-btn v2-btn--outline">
              <FileUp size={20} strokeWidth={STROKE} aria-hidden="true" />
              {t('backup.restore.choose')}
            </label>
            <span className="v2-file__name">{name === '' ? t('backup.restore.noFile') : name}</span>
          </div>
          <p className="v2-hint v2-hint--start">
            {t('backup.restore.hint', { max: BACKUP_MAX_BYTES / 1024 / 1024 })}
          </p>
        </div>

        {reading && (
          <p className="v2-hint v2-hint--start" role="status">
            {t('backup.restore.reading')}
          </p>
        )}

        {opened && !progress && (
          <section className="v2-import" aria-label={t('backup.restore.title')} data-testid="restore-summary">
            <p className="v2-import__lead">
              {t('backup.restore.summary', { lists: opened.plan.lists.length, items, photos: opened.photos })}
              {made && !Number.isNaN(made.getTime()) && ` ${t('backup.restore.made', { date: made.toLocaleDateString(locale) })}`}
            </p>
            {opened.plan.kind === 'legacy' && <NoteV2 tone="info">{t('backup.restore.legacy')}</NoteV2>}
            {opened.plan.warnings > 0 && (
              <p className="v2-hint v2-hint--start">{t('backup.restore.warnings', { n: opened.plan.warnings })}</p>
            )}
            {budget && opened.photos > budget.quota ? (
              <NoteV2 tone="error">{t('backup.restore.quotaAhead', { n: opened.photos, quota: budget.quota })}</NoteV2>
            ) : budget && opened.photos > budget.hour ? (
              <NoteV2 tone="info">{t('backup.restore.rateAhead', { n: opened.photos, hour: budget.hour })}</NoteV2>
            ) : null}
            {existingCount > 0 && (
              <>
                <NoteV2 tone="info">{t('backup.restore.existing', { n: existingCount })}</NoteV2>
                <SwitchV2
                  label={t('backup.restore.includeExisting')}
                  hint={t('backup.restore.includeExistingHint')}
                  checked={includeExisting}
                  onChange={setIncludeExisting}
                />
              </>
            )}
            {hasLook && (
              <SwitchV2
                label={t('backup.restore.applyLook')}
                hint={t('backup.restore.applyLookHint')}
                checked={applyLook}
                onChange={setApplyLook}
              />
            )}
            {toRestore === 0 && <p className="v2-hint v2-hint--start">{t('backup.restore.nothing')}</p>}
          </section>
        )}

        {progress && (
          <p className="v2-hint v2-hint--start" role="status" data-testid="restore-progress">
            {t('backup.restore.progress', { n: Math.min(progress.list + 1, progress.lists), m: progress.lists })}
            {progress.photos > 0 && ` · ${t('backup.restore.progressPhotos', { n: progress.photo, m: progress.photos })}`}
          </p>
        )}

        {result && (
          <NoteV2 tone="info">
            {[
              t('backup.restore.done', { n: result.restored }),
              result.skipped > 0 ? t('backup.restore.skipped', { n: result.skipped }) : null,
              result.badPhotos > 0 ? t('backup.restore.badPhotos', { n: result.badPhotos }) : null,
              result.cancelled ? t('backup.restore.stopped') : null,
            ]
              .filter(Boolean)
              .join(' ')}
          </NoteV2>
        )}

        <div className="v2-sheet__actions">
          {opened && !progress && (
            <button
              type="submit"
              className="v2-btn v2-btn--primary v2-btn--block"
              aria-disabled={toRestore === 0 || undefined}
            >
              {t('backup.restore.submit', { n: toRestore })}
            </button>
          )}
          {progress ? (
            <button type="button" className="v2-btn v2-btn--ghost" onClick={() => runId.current++}>
              {progress && <span className="v2-spinner" aria-hidden="true" />}
              {t('backup.restore.stop')}
            </button>
          ) : (
            <button type="button" className="v2-btn v2-btn--ghost" onClick={close}>
              {result ? t('common.done') : t('common.cancel')}
            </button>
          )}
        </div>
      </form>
    </SheetV2>
  );
}
