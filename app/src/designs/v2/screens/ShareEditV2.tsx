import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { fetchAllItems, fetchList } from '../../../lib/db';
import { fetchSections } from '../../../lib/sections';
import type { Section } from '../../../lib/sections';
import { editShareItems } from '../../../lib/shares';
import type { LiveShare } from '../../../lib/shares';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { useMediaQuery } from '../../../lib/media';
import { isDraft, viewGroups } from '../../../lib/itemsView';
import type { Item, List } from '../../../lib/types';
import { NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2, useCounts } from './CommonV2';
import { GuestPreviewV2, useAppearanceHue } from './PreviewV2';
import type { PreviewGroup } from './PreviewV2';
import { SharePickListV2, ShareSummaryV2 } from './ShareSheetV2';
import { DESKTOP } from '../ShellV2';

/** Те, що гостю можна показати: актуальне й з назвою (ADR-046). */
export function shareableItems(items: Item[]): Item[] {
  return items.filter((i) => i.status === 'active' && !isDraft(i));
}

/** Помилка бази → текст для людини. Жодна з них не залежить від броней (§3.2). */
function editError(e: unknown, t: Parameters<typeof errorText>[1]): string {
  const text = errorText(e, t);
  if (/no_items/.test(text)) return t('share.errors.nothingSelected');
  if (/share_not_live|not_found/.test(text)) return t('v2shareEdit.notLive');
  return text;
}

export type EditableShare = {
  id: string;
  title: string;
  message: string | null;
  hide_prices: boolean;
  allow_reservations: boolean;
  source_list_id: string;
  item_ids: string[];
};

type Step = 'pick' | 'preview';

/**
 * «Змінити склад» з «Моїх посилань» (8.9): той самий вибір і превʼю, що в
 * «Поділитися» (`SharePickListV2`, `ShareSummaryV2`, `GuestPreviewV2`), лише
 * для вже розданого посилання. Нові позиції гості побачать за тим самим
 * URL. Зберігається різниця — що додали й що прибрали: позиція, яку власник
 * тим часом додав деінде, не зникне через старий набір.
 *
 * Текст про броні однаковий для будь-якого посилання й будь-якої позиції:
 * «якщо хтось узяв — знімемо й напишемо; чи є такі, не дізнаєшся» (ADR-040,
 * як попередження J у ADR-055).
 */
export function ShareEditSheetV2({
  open,
  share,
  onClose,
  onSaved,
}: {
  open: boolean;
  share: EditableShare | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useI18n();
  const counts = useCounts();
  const desktop = useMediaQuery(DESKTOP);
  const titleId = useId();

  const [list, setList] = useState<List | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>('pick');
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const busyRef = useRef(false);
  const hue = useAppearanceHue(open ? list?.appearance_id : null);

  useEffect(() => {
    if (!open || !share) return;
    let alive = true;
    setList(null);
    setItems(null);
    setLoadError(null);
    setServer(null);
    setSubmitted(false);
    setStep('pick');
    Promise.all([fetchList(share.source_list_id), fetchAllItems(share.source_list_id), fetchSections(share.source_list_id)])
      .then(([l, all, secs]) => {
        if (!alive) return;
        setList(l);
        setItems(all);
        setSections(secs);
        const inShare = new Set(share.item_ids);
        setSelected(new Set(shareableItems(all).filter((i) => inShare.has(i.id)).map((i) => i.id)));
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(errorText(e, t));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, share?.id]);

  const shareable = useMemo(() => (items ? shareableItems(items) : []), [items]);
  const groups = useMemo<PreviewGroup[]>(
    () =>
      viewGroups(shareable, 'manual', sections, { keepEmpty: false }).map((g) => ({
        key: g.key,
        title: g.kind === 'section' ? g.section.title : null,
        items: g.items,
      })),
    [shareable, sections],
  );
  const chosenGroups = groups.map((g) => ({ ...g, items: g.items.filter((i) => selected.has(i.id)) }));
  const original = useMemo(() => new Set(share?.item_ids ?? []), [share]);
  const add = shareable.filter((i) => selected.has(i.id) && !original.has(i.id)).map((i) => i.id);
  const remove = shareable.filter((i) => !selected.has(i.id) && original.has(i.id)).map((i) => i.id);
  const hidden = shareable.length - selected.size;
  const noneError = submitted && selected.size === 0 ? t('share.errors.nothingSelected') : null;

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (busyRef.current || !share || !items) return;
    setSubmitted(true);
    if (selected.size === 0) return;
    if (add.length === 0 && remove.length === 0) {
      onClose();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setServer(null);
    try {
      await editShareItems(share.id, add, remove);
      onSaved(t('v2shareEdit.saved', { title: share.title }));
    } catch (err) {
      setServer(editError(err, t));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const preview = share && list && (
    <GuestPreviewV2
      title={share.title}
      eventDate={list.event_date}
      message={share.message}
      groups={chosenGroups}
      currency={list.currency}
      hidePrices={share.hide_prices}
      canClaim={share.allow_reservations}
      hue={hue}
    />
  );
  const hiddenLine = hidden > 0 && (
    <p className="v2-hint v2-hint--start">{t('v2share.hidden', { items: counts.items(hidden) })}</p>
  );

  let body;
  if (loadError) {
    body = <NoteV2 tone="error">{loadError}</NoteV2>;
  } else if (!items) {
    body = (
      <div className="v2-share__wait" role="status">
        <span className="v2-spinner v2-spinner--big" aria-hidden="true" />
        <p className="v2-hint">{t('v2shareEdit.loading')}</p>
      </div>
    );
  } else if (step === 'preview' && !desktop) {
    body = (
      <>
        <p className="v2-hint v2-hint--start">{t('v2share.previewOf', { title: share?.title ?? '' })}</p>
        {preview}
        {hiddenLine}
      </>
    );
  } else {
    const form = (
      <form className="v2-stack" noValidate onSubmit={(e) => void save(e)}>
        {server && <NoteV2 tone="error">{server}</NoteV2>}
        <ShareSummaryV2 chosen={selected.size} all={shareable.length} />
        <SharePickListV2 items={shareable} selected={selected} currency={list?.currency ?? 'PLN'} onChange={setSelected} />
        {noneError && <NoteV2 tone="error">{noneError}</NoteV2>}
        {add.length > 0 && <p className="v2-hint v2-hint--start">{t('v2shareEdit.addNote')}</p>}
        {remove.length > 0 && <p className="v2-hint v2-hint--start">{t('v2shareEdit.removeNote')}</p>}
        {!desktop && (
          <button type="button" className="v2-btn v2-btn--ghost" onClick={() => setStep('preview')}>
            {t('v2share.previewCta')}
          </button>
        )}
        <SubmitV2 busy={busy} label={t('v2shareEdit.save')} busyLabel={t('v2shareEdit.saving')} />
      </form>
    );
    body = desktop ? (
      <div className="v2-share__cols">
        {form}
        <aside className="v2-share__aside" aria-label={t('v2share.previewTitle')}>
          <p className="v2-kicker">{t('v2share.previewTitle')}</p>
          {preview}
          {hiddenLine}
          <p className="v2-hint v2-hint--start">{t('v2share.previewNote')}</p>
        </aside>
      </div>
    ) : (
      form
    );
  }

  const inPreview = step === 'preview' && !desktop && Boolean(items);
  return (
    <SheetV2
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      className={`v2-sheet--full${desktop ? ' v2-sheet--wide' : ''}`}
      closeOnBackdrop={false}
    >
      <div className="v2-bar">
        <button type="button" className="v2-bar__btn" onClick={inPreview ? () => setStep('pick') : onClose}>
          {inPreview ? t('common.close') : t('common.cancel')}
        </button>
        <h2 className="v2-bar__title" id={titleId}>
          {inPreview ? t('v2list.preview.title') : t('v2shareEdit.title', { title: share?.title ?? '' })}
        </h2>
        <span className="v2-bar__spacer" aria-hidden="true" />
      </div>
      <div className="v2-itemsheet__body">{body}</div>
    </SheetV2>
  );
}

/**
 * «Додати в посилання «…»?» (8.9) — після нової позиції в списку з живими
 * посиланнями. Само в посилання не потрапляє нічого: одне посилання — так чи
 * ні, кілька — прапорці, усі зняті. Позиція з'являється в гостей за тим самим
 * URL. Відповідь однакова для будь-якого посилання: додавання броней не
 * чіпає.
 */
export function AddToSharesV2({
  shares,
  itemId,
  itemTitle,
  headingId,
  onDone,
}: {
  shares: LiveShare[];
  itemId: string;
  itemTitle: string;
  /** id заголовка — щоб аркуш, у який це вкладено, мав назву. */
  headingId?: string;
  /** Скільки посилань отримало позицію (0 — «Не зараз»). */
  onDone: (added: number) => void;
}) {
  const { t } = useI18n();
  const ownId = useId();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const busyRef = useRef(false);
  const one = shares.length === 1;
  const targets = one ? shares.map((s) => s.id) : [...picked];
  const pickError = submitted && targets.length === 0 ? t('v2shareEdit.pickOne') : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    setSubmitted(true);
    if (targets.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setServer(null);
    try {
      for (const shareId of targets) await editShareItems(shareId, [itemId], []);
      onDone(targets.length);
    } catch (err) {
      setServer(editError(err, t));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <form className="v2-stack v2-addshare" noValidate onSubmit={(e) => void submit(e)}>
      <h2 className="v2-sheet__title" id={headingId ?? ownId}>
        {one
          ? t('v2shareEdit.askOne', { item: itemTitle, share: shares[0]?.title ?? '' })
          : t('v2shareEdit.askMany', { item: itemTitle })}
      </h2>
      <p className="v2-hint v2-hint--start">{t('v2shareEdit.askHint')}</p>
      {server && <NoteV2 tone="error">{server}</NoteV2>}
      {!one && (
        <fieldset className="v2-pick">
          <legend className="v2-sr">{t('v2shareEdit.askMany', { item: itemTitle })}</legend>
          <ul className="v2-pick__list">
            {shares.map((s) => (
              <li key={s.id}>
                <label className="v2-pick__row" data-on={picked.has(s.id) || undefined}>
                  <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                  <span className="v2-pick__text">
                    <span className="v2-pick__name">{s.title}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {pickError && <NoteV2 tone="error">{pickError}</NoteV2>}
      <div className="v2-sheet__actions">
        <SubmitV2 busy={busy} label={t('v2shareEdit.add')} busyLabel={t('v2shareEdit.adding')} />
        <button type="button" className="v2-btn v2-btn--ghost v2-btn--block" onClick={() => onDone(0)}>
          {t('v2shareEdit.notNow')}
        </button>
      </div>
    </form>
  );
}
