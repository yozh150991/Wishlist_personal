import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { ABOUT_LIMITS, EMPTY_ABOUT, aboutTooLong, fetchAbout, saveAbout } from '../../../lib/about';
import type { AboutField, AboutMe } from '../../../lib/about';
import { NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2 } from './CommonV2';

const STROKE = 2.75;

/**
 * «Про мене» власника (ROADMAP 8.10): читання з профілю. `null` — ще
 * читається; помилка — окремо, щоб форма не показала порожнє замість збою.
 */
export function useAbout(enabled = true) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [about, setAbout] = useState<AboutMe | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    try {
      setAbout(await fetchAbout(userId));
    } catch (e) {
      setError(e);
    }
  }, [userId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return { userId, about, setAbout, error, reload: load };
}

/** Одне поле «Про мене»: рядок для розмірів, багаторядкове — для решти. */
function AboutFieldV2({
  field,
  label,
  hint,
  value,
  error,
  onChange,
}: {
  field: AboutField;
  label: string;
  hint: string;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const common = {
    id,
    name: `about_${field}`,
    maxLength: ABOUT_LIMITS[field],
    value,
    autoComplete: 'off',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': [hintId, error ? errId : null].filter(Boolean).join(' '),
  } as const;
  return (
    <div className="v2-field" data-invalid={error ? 'true' : undefined}>
      <label className="v2-field__label" htmlFor={id}>
        {label}
      </label>
      {field === 'sizes' ? (
        <input className="v2-input" {...common} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <textarea
          className="v2-input v2-input--area"
          rows={2}
          {...common}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p className="v2-hint v2-hint--start" id={hintId}>
        {hint}
      </p>
      {error && (
        <p className="v2-field__error" id={errId}>
          <AlertCircle size={16} strokeWidth={STROKE} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Форма «Про мене»: три поля вільним текстом і «Зберегти». Межі — ті самі, що
 * в базі (`ABOUT_LIMITS`), і перевіряються до відправки (CLAUDE.md §4).
 */
export function AboutFormV2({
  userId,
  initial,
  onSaved,
  extra,
}: {
  userId: string;
  initial: AboutMe;
  onSaved: (about: AboutMe) => void;
  /** Ще кнопки поруч зі «Зберегти» — напр. «Скасувати» в аркуші. */
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({
    sizes: initial.sizes ?? '',
    likes: initial.likes ?? '',
    avoid: initial.avoid ?? '',
  });
  const [tooLong, setTooLong] = useState<AboutField[]>([]);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busyRef = useRef(false);

  function set(field: AboutField, v: string) {
    setDraft((d) => ({ ...d, [field]: v }));
    setSaved(false);
    setTooLong((l) => l.filter((f) => f !== field));
  }

  async function submit() {
    if (busyRef.current) return;
    const next: AboutMe = { sizes: draft.sizes, likes: draft.likes, avoid: draft.avoid };
    const long = aboutTooLong(next);
    setTooLong(long);
    if (long.length > 0) return;
    busyRef.current = true;
    setBusy(true);
    setServer(null);
    try {
      const stored = await saveAbout(userId, next);
      setDraft({ sizes: stored.sizes ?? '', likes: stored.likes ?? '', avoid: stored.avoid ?? '' });
      setSaved(true);
      onSaved(stored);
    } catch (e) {
      setServer(errorText(e, t));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const err = (f: AboutField) => (tooLong.includes(f) ? t('about.tooLong', { n: ABOUT_LIMITS[f] }) : null);

  return (
    <form
      className="v2-stack"
      noValidate
      data-testid="about-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {server && <NoteV2 tone="error">{server}</NoteV2>}
      <AboutFieldV2
        field="sizes"
        label={t('about.sizes')}
        hint={t('about.sizesHint')}
        value={draft.sizes}
        error={err('sizes')}
        onChange={(v) => set('sizes', v)}
      />
      <AboutFieldV2
        field="likes"
        label={t('about.likes')}
        hint={t('about.likesHint')}
        value={draft.likes}
        error={err('likes')}
        onChange={(v) => set('likes', v)}
      />
      <AboutFieldV2
        field="avoid"
        label={t('about.avoid')}
        hint={t('about.avoidHint')}
        value={draft.avoid}
        error={err('avoid')}
        onChange={(v) => set('avoid', v)}
      />
      {saved && <NoteV2 tone="info">{t('about.saved')}</NoteV2>}
      <div className="v2-sheet__actions">
        <SubmitV2 busy={busy} label={t('about.save')} busyLabel={t('about.saving')} />
        {extra}
      </div>
    </form>
  );
}

/**
 * Блок «Про мене» в Налаштуваннях. Гості бачать його лише на посиланнях, де
 * власник увімкнув «Показати гостям» — про це каже підказка під заголовком.
 */
export function AboutCardV2() {
  const { t } = useI18n();
  const { userId, about, setAbout, error, reload } = useAbout();

  return (
    <section
      className="v2-settings__card"
      aria-labelledby="v2-set-about"
      id="about"
      data-testid="about-card"
    >
      <h2 className="v2-settings__label" id="v2-set-about">
        {t('about.title')}
      </h2>
      <p className="v2-hint v2-hint--start">{t('about.body')}</p>
      {error ? (
        <>
          <NoteV2 tone="error">{errorText(error, t)}</NoteV2>
          <button type="button" className="v2-btn v2-btn--outline v2-btn--start" onClick={() => void reload()}>
            {t('common.retry')}
          </button>
        </>
      ) : !about || !userId ? (
        <p className="v2-hint v2-hint--start" role="status">
          <span className="v2-spinner" aria-hidden="true" /> {t('about.loading')}
        </p>
      ) : (
        <AboutFormV2 key={userId} userId={userId} initial={about} onSaved={setAbout} />
      )}
    </section>
  );
}

/**
 * «Заповнити» з аркуша «Поділитися»: та сама форма в окремому вікні, поруч з
 * аркушем, а не всередині (вкладене вікно ловило б Escape разом із ним).
 */
export function AboutSheetV2({
  open,
  userId,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  userId: string | null;
  initial: AboutMe | null;
  onClose: () => void;
  onSaved: (about: AboutMe) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <SheetV2 open={open} onClose={onClose} labelledBy={titleId} closeOnBackdrop={false}>
      <h2 className="v2-sheet__title" id={titleId}>
        {t('about.title')}
      </h2>
      <p className="v2-hint v2-hint--start">{t('about.body')}</p>
      {open && userId && (
        <AboutFormV2
          userId={userId}
          initial={initial ?? EMPTY_ABOUT}
          onSaved={(a) => {
            onSaved(a);
            onClose();
          }}
          extra={
            <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
          }
        />
      )}
    </SheetV2>
  );
}
