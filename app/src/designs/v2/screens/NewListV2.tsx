import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { createList, fetchDefaultCurrency, fetchListsOverview } from '../../../lib/db';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { localToday } from '../../../lib/format';
import type { Currency } from '../../../lib/types';
import { FieldV2, NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2, YearlySwitchV2 } from './CommonV2';

/** Межа з БД (`lists.title`, README «Обмеження полів») — і тут, до відправки. */
const TITLE_MAX = 120;
const DRAFT_KEY = 'wl.v2.listDraft';
/** Валюта, якщо в профілі її не задано, — та сама, що в v1. */
const FALLBACK_CURRENCY: Currency = 'PLN';

type Draft = { title: string; date: string; yearly: boolean };

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    return {
      title: typeof d.title === 'string' ? d.title : '',
      date: typeof d.date === 'string' ? d.date : '',
      yearly: d.yearly === true,
    };
  } catch {
    return null;
  }
}

function writeDraft(d: Draft) {
  try {
    if (d.title.trim() || d.date) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* приватний режим — чернетка просто не переживе вкладку */
  }
}

function dropDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* нічого не було */
  }
}

/**
 * Новий список v2 (потоки B2–B4, U3).
 *
 * - Список створюється однією назвою; решта налаштувань — усередині списку.
 *   Дата необов'язкова. Валюта — з профілю, інакше PLN, як у v1.
 * - Дубль назви — попередження, не заборона: у людини може бути два «Дім».
 * - Минула дата — не заборона, а інша кнопка (U3): «Створити як архів» — для
 *   старих свят, які хочуть зберегти в історії, — або «Змінити дату».
 * - Чернетка тримається на пристрої, тож «Назад» завжди має що врятувати:
 *   якщо щось уже вписано — питаємо «Лишити чернетку?», порожню форму
 *   закриваємо мовчки.
 *
 * «Повторювати щороку» (U3, ADR-047): шаблони «День народження» й «Новий
 * рік» вмикають його самі; нагадування — за місяць до річниці.
 */
export default function NewListV2() {
  const { t } = useI18n();
  const { session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = session?.user.id ?? '';
  const template = location.state as { title?: string; yearly?: boolean } | null;

  const [draft, setDraft] = useState<Draft>(() => {
    const saved = readDraft();
    // Шаблон свята важить більше за стару чернетку: людина щойно його обрала.
    return template?.title
      ? { title: template.title, date: saved?.date ?? '', yearly: Boolean(template.yearly) }
      : (saved ?? { title: '', date: '', yearly: false });
  });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [titles, setTitles] = useState<string[]>([]);
  const [currency, setCurrency] = useState<Currency>(FALLBACK_CURRENCY);
  const [asking, setAsking] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  // Назви наявних списків — лише для попередження про дубль; без мережі
  // попередження просто не буде.
  useEffect(() => {
    fetchListsOverview()
      .then((all) => setTitles(all.map((l) => l.title.trim().toLowerCase())))
      .catch(() => undefined);
    if (userId) {
      fetchDefaultCurrency(userId)
        .then((c) => c && setCurrency(c))
        .catch(() => undefined);
    }
  }, [userId]);

  useEffect(() => {
    writeDraft(draft);
  }, [draft]);

  const title = draft.title.trim();
  const titleError = submitted && !title ? t('v2app.newList.nameEmpty') : null;
  const duplicate = title && titles.includes(title.toLowerCase()) ? t('v2app.newList.duplicate') : null;
  const past = Boolean(draft.date) && draft.date < localToday();

  function leave() {
    if (draft.title.trim() || draft.date) setAsking(true);
    else {
      dropDraft();
      navigate('/lists');
    }
  }

  async function save() {
    if (busy) return;
    setSubmitted(true);
    if (!title) return titleRef.current?.focus();
    setBusy(true);
    setServer(null);
    try {
      // Минула дата — одразу в архів (ADR-045): так кнопка й обіцяла.
      const created = await createList(
        {
          title,
          event_date: draft.date || null,
          currency,
          repeats_yearly: Boolean(draft.date) && draft.yearly,
          ...(past ? { is_archived: true } : {}),
        },
        userId,
      );
      dropDraft();
      // Решта налаштувань і перша позиція живуть усередині списку (B, C).
      navigate(`/lists/${created.id}`, { replace: true });
    } catch (e) {
      setServer(errorText(e, t));
      setBusy(false);
    }
  }

  return (
    <main className="v2-page v2-page--narrow">
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="v2-back">
          <button type="button" className="v2-iconbtn" aria-label={t('v2auth.back')} onClick={leave}>
            <ChevronLeft size={22} strokeWidth={2.75} aria-hidden="true" />
          </button>
          <h1 className="v2-back__title">{t('v2app.newList.title')}</h1>
        </div>

        {server && <NoteV2 tone="error">{server}</NoteV2>}

        <FieldV2
          ref={titleRef}
          label={t('v2app.newList.name')}
          name="title"
          placeholder={t('v2app.newList.namePlaceholder')}
          maxLength={TITLE_MAX}
          autoComplete="off"
          value={draft.title}
          error={titleError}
          warning={duplicate}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
        <FieldV2
          ref={dateRef}
          label={t('v2app.newList.date')}
          name="event_date"
          type="date"
          value={draft.date}
          warning={past ? t('v2app.newList.pastDate') : null}
          onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
        />
        <YearlySwitchV2
          date={draft.date}
          checked={draft.yearly}
          onChange={(yearly) => setDraft((d) => ({ ...d, yearly }))}
        />

        <SubmitV2
          busy={busy}
          label={past ? t('v2app.newList.submitArchive') : t('v2app.newList.submit')}
          busyLabel={t('v2app.newList.submitting')}
        />
        {past && (
          <button type="button" className="v2-btn v2-btn--ghost" onClick={() => dateRef.current?.focus()}>
            {t('v2app.newList.changeDate')}
          </button>
        )}
      </form>

      <SheetV2 open={asking} onClose={() => setAsking(false)} labelledBy="v2-draft-title">
        <h2 className="v2-sheet__title" id="v2-draft-title">
          {t('v2app.newList.draftTitle')}
        </h2>
        <p className="v2-lede">{t('v2app.newList.draftBody')}</p>
        <div className="v2-sheet__actions">
          <button
            type="button"
            className="v2-btn v2-btn--primary v2-btn--block"
            onClick={() => {
              // Чернетка вже на пристрої — лишається тільки піти.
              setAsking(false);
              navigate('/lists');
            }}
          >
            {t('v2app.newList.draftKeep')}
          </button>
          <button
            type="button"
            className="v2-btn v2-btn--danger"
            onClick={() => {
              dropDraft();
              setAsking(false);
              navigate('/lists');
            }}
          >
            {t('v2app.newList.draftDrop')}
          </button>
        </div>
      </SheetV2>
    </main>
  );
}
