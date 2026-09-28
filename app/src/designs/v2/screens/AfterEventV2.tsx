import { useEffect, useId, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Check, CopyPlus, Gift, Repeat } from 'lucide-react';
import { copyItems, createListWithItems, fetchListsOverview, repeatList } from '../../../lib/db';
import { copyInput, eventYear, repeatTarget, repeatTitle } from '../../../lib/afterEvent';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { formatDay, localToday, moneyShort } from '../../../lib/format';
import type { Item, List, Section } from '../../../lib/types';
import { FieldV2, NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2, SwitchV2, YearlySwitchV2 } from './CommonV2';

const STROKE = 2.75;
/** Межа з БД (`lists.title`) — і тут, до відправки. */
const TITLE_MAX = 120;

export type AfterStep = 'received' | 'carry' | 'repeat';

/**
 * «Свято минуло» (потік M, ADR-045) — картка вгорі сторінки списку наступного
 * дня після події. Кроки в будь-якому порядку; нічого не відбувається саме.
 *
 * Свідомо інакше, ніж у макеті (ADR-040): у «Позначити отримане» нічого не
 * позначено наперед, а переносити пропонуємо те, що власник сам не позначив
 * отриманим, — а не «те, що ніхто не взяв». Що брали гості, застосунок не
 * знає за власника й після свята. «Подякувати гостям» — разом із гостьовою v2
 * (крок 5): поки гість подяки не побачить, обіцяти її нема чого.
 */
export function AfterEventCardV2({
  list,
  openCount,
  done,
  archiving,
  onStep,
  onArchive,
  onLater,
}: {
  list: List;
  /** Скільки позицій ще актуальні — статус самого власника. */
  openCount: number;
  /** Кроки, пройдені в цьому відкритті сторінки, — з галочкою. */
  done: Set<AfterStep>;
  archiving: boolean;
  onStep: (step: AfterStep) => void;
  onArchive: () => void;
  onLater: () => void;
}) {
  const { t, locale } = useI18n();
  const headingId = useId();
  const year = repeatTarget(list, localToday()).year ?? new Date().getFullYear() + 1;
  const mark = (step: AfterStep) =>
    done.has(step) ? (
      <span className="v2-after__done">
        <Check size={20} strokeWidth={STROKE} aria-hidden="true" />
        <span className="v2-sr">{t('v2after.card.doneMark')}</span>
      </span>
    ) : null;

  return (
    <section className="v2-after" aria-labelledby={headingId}>
      <p className="v2-kicker">
        {t('v2after.card.kicker', {
          date: formatDay(list.event_date, locale) ?? '',
        })}
      </p>
      <h2 className="v2-after__title" id={headingId}>
        {t('v2after.card.title')}
      </h2>
      <p className="v2-hint v2-hint--start">{openCount > 0 ? t('v2after.card.body') : t('v2after.card.bodyAllDone')}</p>
      <div className="v2-menu v2-after__steps">
        {openCount > 0 && (
          <button type="button" className="v2-menu__item" onClick={() => onStep('received')}>
            <Gift size={20} strokeWidth={STROKE} aria-hidden="true" />
            <span className="v2-after__label">{t('v2after.card.received')}</span>
            {mark('received')}
          </button>
        )}
        {openCount > 0 && (
          <button type="button" className="v2-menu__item" onClick={() => onStep('carry')}>
            <CopyPlus size={20} strokeWidth={STROKE} aria-hidden="true" />
            <span className="v2-after__label">{t('v2after.card.carry')}</span>
            {mark('carry')}
          </button>
        )}
        <button type="button" className="v2-menu__item" onClick={() => onStep('repeat')}>
          <Repeat size={20} strokeWidth={STROKE} aria-hidden="true" />
          <span className="v2-after__label">{t('v2after.card.repeat', { year })}</span>
          {mark('repeat')}
        </button>
        <button
          type="button"
          className="v2-menu__item"
          aria-disabled={archiving || undefined}
          onClick={() => {
            if (!archiving) onArchive();
          }}
        >
          {archiving ? (
            <span className="v2-spinner" aria-hidden="true" />
          ) : (
            <Archive size={20} strokeWidth={STROKE} aria-hidden="true" />
          )}
          <span className="v2-after__label">{archiving ? t('v2after.archiving') : t('v2after.card.archive')}</span>
        </button>
      </div>
      {/* Там, де людина могла б чекати інформації про позначки, — пояснення
          замість мовчання (ADR-040, «Наслідки»). */}
      <p className="v2-hint v2-hint--start">{t('v2after.card.noHints')}</p>
      <button type="button" className="v2-btn v2-btn--ghost v2-btn--start" onClick={onLater}>
        {t('v2after.card.later')}
      </button>
    </section>
  );
}

/** Список в архіві: полиця, а не замок. Повернути — одним натиском. */
export function ArchivedNoteV2({ busy, onRestore }: { busy: boolean; onRestore: () => void }) {
  const { t } = useI18n();
  return (
    <div className="v2-archived" role="status">
      <Archive className="v2-archived__icon" size={22} strokeWidth={STROKE} aria-hidden="true" />
      <p className="v2-archived__text">
        <strong>{t('v2after.archived.title')}</strong> {t('v2after.archived.body')}
      </p>
      <button
        type="button"
        className="v2-btn v2-btn--outline v2-btn--small"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) onRestore();
        }}
      >
        {busy ? (
          <span className="v2-spinner" aria-hidden="true" />
        ) : (
          <ArchiveRestore size={18} strokeWidth={STROKE} aria-hidden="true" />
        )}
        {t('v2after.archived.restore')}
      </button>
    </div>
  );
}

/** Шапка вікна на весь екран: «Скасувати · Назва · (дія)». */
function Bar({ titleId, title, onClose }: { titleId: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="v2-bar">
      <button type="button" className="v2-bar__btn" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <h2 className="v2-bar__title" id={titleId}>
        {title}
      </h2>
      <span className="v2-bar__spacer" aria-hidden="true" />
    </div>
  );
}

/** Перелік позицій із галочками — той самий вигляд, що й у «Поділитися». */
function PickList({
  legend,
  items,
  selected,
  currency,
  onToggle,
  onAll,
  onNone,
}: {
  legend: string;
  items: Item[];
  selected: Set<string>;
  currency: List['currency'];
  onToggle: (id: string) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <fieldset className="v2-pick">
      <legend className="v2-sr">{legend}</legend>
      <div className="v2-pick__bulk">
        <button type="button" className="v2-btn v2-btn--ghost" onClick={onAll}>
          {t('v2share.all')}
        </button>
        <button type="button" className="v2-btn v2-btn--ghost" onClick={onNone}>
          {t('v2share.none')}
        </button>
      </div>
      <ul className="v2-pick__list">
        {items.map((item) => {
          const on = selected.has(item.id);
          return (
            <li key={item.id}>
              <label className="v2-pick__row" data-on={on || undefined}>
                <input type="checkbox" checked={on} onChange={() => onToggle(item.id)} />
                <span className="v2-pick__text">
                  <span className="v2-pick__name">{item.title}</span>
                  <span className="v2-pick__meta">
                    {moneyShort(item.price, currency, locale) ?? t('v2list.item.noPrice')}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * «Позначити отримане» (M2). Нічого не позначено наперед: застосунок не знає,
 * що брали гості, і не вдає, що знає (ADR-040). Позначене стає «Подаровано» —
 * тим самим шляхом, що й статус із меню позиції, тож працює й без мережі.
 */
export function ReceivedSheetV2({
  open,
  items,
  currency,
  onClose,
  onSave,
}: {
  open: boolean;
  items: Item[];
  currency: List['currency'];
  onClose: () => void;
  onSave: (ids: string[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setBusy(false);
    setServer(null);
  }, [open]);

  async function save() {
    if (busy) return;
    if (selected.size === 0) return onClose();
    setBusy(true);
    setServer(null);
    try {
      await onSave([...selected]);
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
        <Bar titleId={titleId} title={t('v2after.received.title')} onClose={onClose} />
        <div className="v2-itemsheet__body">
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          <p className="v2-hint v2-hint--start">{t('v2after.received.body')}</p>
          <PickList
            legend={t('v2after.received.title')}
            items={items}
            selected={selected}
            currency={currency}
            onToggle={(id) => setSelected((s) => toggled(s, id))}
            onAll={() => setSelected(new Set(items.map((i) => i.id)))}
            onNone={() => setSelected(new Set())}
          />
          <SubmitV2
            busy={busy}
            label={selected.size > 0 ? t('v2after.received.save', { n: selected.size }) : t('common.done')}
            busyLabel={t('common.saving')}
          />
        </div>
      </form>
    </SheetV2>
  );
}

type Target = { kind: 'new' } | { kind: 'list'; id: string; title: string };

/**
 * «Перенести, що ще хочу» (M4). Переносимо **копії**: цей список лишається
 * правдивим знімком свята, а позначки гостей належать оригіналам і нікуди не
 * їдуть. Куди — у новий список або в наявний, крім архівних.
 */
export function CarrySheetV2({
  open,
  list,
  items,
  userId,
  onClose,
  onDone,
}: {
  open: boolean;
  list: List;
  /** Ще не отримане — статус «актуальна». */
  items: Item[];
  userId: string;
  onClose: () => void;
  onDone: (target: { id: string; title: string }, n: number) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<List[]>([]);
  const [target, setTarget] = useState<Target>({ kind: 'new' });
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(items.map((i) => i.id)));
    setTarget({ kind: 'new' });
    setName(t('v2after.carry.newDefault'));
    setSubmitted(false);
    setBusy(false);
    setServer(null);
    // Куди ще можна перенести: живі списки, крім цього. Без мережі — лише новий.
    fetchListsOverview()
      .then((all) => setTargets(all.filter((l) => l.id !== list.id && !l.is_archived)))
      .catch(() => setTargets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const nameError = submitted && target.kind === 'new' && !name.trim() ? t('v2app.newList.nameEmpty') : null;

  async function save() {
    if (busy) return;
    setSubmitted(true);
    if (selected.size === 0) return;
    if (target.kind === 'new' && !name.trim()) return nameRef.current?.focus();
    setBusy(true);
    setServer(null);
    const inputs = items.filter((i) => selected.has(i.id)).map((i) => copyInput(i));
    try {
      if (target.kind === 'new') {
        const created = await createListWithItems({ title: name.trim(), currency: list.currency }, inputs, userId);
        onDone({ id: created.id, title: created.title }, inputs.length);
      } else {
        await copyItems(target.id, inputs);
        onDone({ id: target.id, title: target.title }, inputs.length);
      }
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
        <Bar titleId={titleId} title={t('v2after.carry.title')} onClose={onClose} />
        <div className="v2-itemsheet__body">
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          <p className="v2-hint v2-hint--start">{t('v2after.carry.body')}</p>
          <PickList
            legend={t('v2after.carry.title')}
            items={items}
            selected={selected}
            currency={list.currency}
            onToggle={(id) => setSelected((s) => toggled(s, id))}
            onAll={() => setSelected(new Set(items.map((i) => i.id)))}
            onNone={() => setSelected(new Set())}
          />
          {submitted && selected.size === 0 && (
            <p className="v2-field__error" role="alert">
              {t('v2after.carry.nothing')}
            </p>
          )}

          <fieldset className="v2-pick">
            <legend className="v2-field__label">{t('v2after.carry.where')}</legend>
            <ul className="v2-pick__list">
              <li>
                <label className="v2-pick__row" data-on={target.kind === 'new' || undefined}>
                  <input
                    type="radio"
                    name="carry-target"
                    checked={target.kind === 'new'}
                    onChange={() => setTarget({ kind: 'new' })}
                  />
                  <span className="v2-pick__text">
                    <span className="v2-pick__name">{t('v2after.carry.newList')}</span>
                  </span>
                </label>
              </li>
              {targets.map((l) => {
                const on = target.kind === 'list' && target.id === l.id;
                return (
                  <li key={l.id}>
                    <label className="v2-pick__row" data-on={on || undefined}>
                      <input
                        type="radio"
                        name="carry-target"
                        checked={on}
                        onChange={() => setTarget({ kind: 'list', id: l.id, title: l.title })}
                      />
                      <span className="v2-pick__text">
                        <span className="v2-pick__name">{l.title}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {target.kind === 'new' && (
            <FieldV2
              ref={nameRef}
              label={t('v2after.carry.newName')}
              name="carry_title"
              maxLength={TITLE_MAX}
              autoComplete="off"
              value={name}
              error={nameError}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <SubmitV2
            busy={busy}
            label={t('v2after.carry.submit', { n: selected.size })}
            busyLabel={t('v2after.carry.submitting')}
          />
        </div>
      </form>
    </SheetV2>
  );
}

/**
 * «Повторити на наступний рік» (S3): новий список із тими самими
 * налаштуваннями й копіями неподарованого. Позначки й посилання не
 * переносяться ніколи: новий рік — чистий аркуш для гостей.
 */
export function RepeatSheetV2({
  open,
  list,
  sections,
  items,
  userId,
  onClose,
  onCreated,
}: {
  open: boolean;
  list: List;
  sections: Section[];
  /** Ще не отримане — статус «актуальна». */
  items: Item[];
  userId: string;
  onClose: () => void;
  onCreated: (created: List) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [carry, setCarry] = useState(true);
  const [yearly, setYearly] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const from = eventYear(list);
  // Найближча річниця: наступного дня після свята — через рік, а давній
  // список — цьогорічна дата, а не минула (ADR-047).
  const target = repeatTarget(list, localToday());

  useEffect(() => {
    if (!open) return;
    setName(repeatTitle(list.title, from, target.year));
    setDate(target.date ?? '');
    setCarry(items.length > 0);
    setYearly(Boolean(list.repeats_yearly));
    setSubmitted(false);
    setBusy(false);
    setServer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    if (busy) return;
    setSubmitted(true);
    if (!name.trim()) return nameRef.current?.focus();
    setBusy(true);
    setServer(null);
    try {
      const created = await repeatList(
        { list, sections, items: carry ? items : [] },
        { title: name.trim(), event_date: date || null, repeats_yearly: Boolean(date) && yearly },
        userId,
      );
      onCreated(created);
    } catch (e) {
      setServer(errorText(e, t));
      setBusy(false);
    }
  }

  const title = target.year !== null ? t('v2after.card.repeat', { year: target.year }) : t('v2after.repeat.titlePlain');

  return (
    <SheetV2 open={open} onClose={onClose} labelledBy={titleId} className="v2-sheet--full" closeOnBackdrop={false}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Bar titleId={titleId} title={title} onClose={onClose} />
        <div className="v2-itemsheet__body">
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          <p className="v2-hint v2-hint--start">{t('v2after.repeat.body')}</p>
          <FieldV2
            ref={nameRef}
            label={t('v2app.newList.name')}
            name="repeat_title"
            maxLength={TITLE_MAX}
            autoComplete="off"
            value={name}
            error={submitted && !name.trim() ? t('v2app.newList.nameEmpty') : null}
            onChange={(e) => setName(e.target.value)}
          />
          <FieldV2
            label={t('v2app.newList.date')}
            name="repeat_date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          {items.length > 0 ? (
            <SwitchV2
              label={t('v2after.repeat.items', { n: items.length })}
              hint={t('v2after.repeat.itemsHint')}
              checked={carry}
              onChange={setCarry}
            />
          ) : (
            <p className="v2-hint v2-hint--start">{t('v2after.repeat.noItems')}</p>
          )}
          <YearlySwitchV2 date={date} checked={yearly} onChange={setYearly} />
          <p className="v2-hint v2-hint--start">{t('v2after.repeat.links')}</p>
          <SubmitV2 busy={busy} label={t('v2after.repeat.submit')} busyLabel={t('v2after.repeat.submitting')} />
        </div>
      </form>
    </SheetV2>
  );
}
