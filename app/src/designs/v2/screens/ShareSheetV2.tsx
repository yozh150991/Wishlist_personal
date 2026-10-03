import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { localToday, moneyShort } from '../../../lib/format';
import { useMediaQuery } from '../../../lib/media';
import { createShare, revokeShare, shareUrl } from '../../../lib/shares';
import type { List } from '../../../lib/types';
import { FieldV2, IconCircleV2, NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2, SwitchV2, useCounts } from './CommonV2';
import { ConfirmSheetV2 } from './ListPartsV2';
import { NotifyAskV2 } from './NotifyV2';
import { GuestPreviewV2, useAppearanceHue } from './PreviewV2';
import type { PreviewGroup } from './PreviewV2';
import { DESKTOP } from '../ShellV2';

/** Межі з `shares` і форми v1: заголовок до 120, повідомлення до 1000. */
const TITLE_MAX = 120;
const MESSAGE_MAX = 1000;

type Step = 'form' | 'pick' | 'preview' | 'creating' | 'done' | 'revoked';

/**
 * «Поділитися» v2 (потоки D, H, W1).
 *
 * Поділитися — рішення про приватність, тож вибір видимих позицій стоїть перед
 * створенням посилання: «Що побачать гості · 13 з 15 · Обрати». Усталено — усі
 * актуальні позиції; куплене й подароване гостям не показується й сюди не
 * потрапляє. На десктопі вибір і живе превʼю стоять поруч (H), на телефоні —
 * «Обрати» й «Переглянути як гість» окремими кроками (W1) з рядком про
 * приховане: він ловить «випадково поширив дороге».
 *
 * Після створення посилання копіюється само — тост лише підтверджує (D3).
 * Якщо браузер не дав скопіювати без натиску, лишаються «Копіювати» й
 * «Поділитися». «Відкликати доступ» — одразу тут, з підтвердженням.
 *
 * Жодного слова про позначки — ні скільки, ні чиї (ADR-040). Посилання поки
 * `/s/…`: гостьова v2 ще не готова (ADR-041, ARCHITECTURE).
 */
export function ShareSheetV2({
  open,
  list,
  groups,
  onClose,
}: {
  open: boolean;
  list: List | null;
  /** Актуальні позиції в порядку гостя, по розділах. */
  groups: PreviewGroup[];
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const counts = useCounts();
  const desktop = useMediaQuery(DESKTOP);
  const titleId = useId();
  const messageId = useId();

  const all = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const hue = useAppearanceHue(open ? list?.appearance_id : null);

  const [step, setStep] = useState<Step>('form');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [showPrices, setShowPrices] = useState(true);
  const [allowClaims, setAllowClaims] = useState(true);
  const [expiresOn, setExpiresOn] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [askRevoke, setAskRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const busy = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep('form');
    setTitle(list?.title ?? '');
    setMessage('');
    setShowPrices(true);
    setAllowClaims(true);
    setExpiresOn('');
    setSelected(new Set(all.map((i) => i.id)));
    setSubmitted(false);
    setServer(null);
    setLink(null);
    setShareId(null);
    setCopied(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chosen = all.filter((i) => selected.has(i.id));
  const hidden = all.length - chosen.length;
  const chosenGroups: PreviewGroup[] = groups.map((g) => ({ ...g, items: g.items.filter((i) => selected.has(i.id)) }));

  const titleError = submitted && !title.trim() ? t('share.errors.titleRequired') : null;
  const pastError = expiresOn && expiresOn < localToday() ? t('share.errors.expiresInPast') : null;
  const noneError = submitted && chosen.length === 0 ? t('share.errors.nothingSelected') : null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create() {
    if (busy.current || !list) return;
    setSubmitted(true);
    if (!title.trim()) return titleRef.current?.focus();
    if (pastError || chosen.length === 0) return;
    busy.current = true;
    setServer(null);
    setStep('creating');
    try {
      const share = await createShare({
        listId: list.id,
        // У порядку гостя: той самий, що й у превʼю.
        itemIds: chosen.map((i) => i.id),
        title: title.trim(),
        message: message.trim() || null,
        hidePrices: !showPrices,
        allowReservations: allowClaims,
        // Лише день: кінець дня за зоною власника рахує база (ADR-037).
        expiresOn: expiresOn || null,
      });
      const url = shareUrl(share.token);
      setLink(url);
      setShareId(share.id);
      let ok = false;
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch {
        // Safari не дає писати в буфер без свіжого натиску — лишається кнопка.
      }
      setCopied(ok);
      setStep('done');
    } catch (e) {
      const text = errorText(e, t);
      setServer(/expires_in_past/.test(text) ? t('share.errors.expiresInPast') : text);
      setStep('form');
    } finally {
      busy.current = false;
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

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function shareOut() {
    if (!link) return;
    try {
      await navigator.share({ title: title.trim(), url: link });
    } catch {
      /* людина закрила системне вікно — це її рішення, не збій */
    }
  }

  async function revoke() {
    if (!shareId || revoking) return;
    setRevoking(true);
    try {
      await revokeShare(shareId);
      setAskRevoke(false);
      setStep('revoked');
    } catch (e) {
      setAskRevoke(false);
      setServer(errorText(e, t));
    } finally {
      setRevoking(false);
    }
  }

  /* ── Частини ── */

  const summary = (
    <p className="v2-share__summary">
      <span className="v2-share__summary-label">{t('v2share.whatGuestsSee')}</span>
      <span className="v2-share__summary-count">
        {t('v2share.chosen', { n: chosen.length, m: all.length })}
        {hidden > 0 && ` · ${t('v2share.hiddenShort', { n: hidden })}`}
      </span>
    </p>
  );

  const pickList = (
    <fieldset className="v2-pick">
      <legend className="v2-sr">{t('v2share.whatGuestsSee')}</legend>
      <div className="v2-pick__bulk">
        <button type="button" className="v2-btn v2-btn--ghost" onClick={() => setSelected(new Set(all.map((i) => i.id)))}>
          {t('v2share.all')}
        </button>
        <button type="button" className="v2-btn v2-btn--ghost" onClick={() => setSelected(new Set())}>
          {t('v2share.none')}
        </button>
      </div>
      <ul className="v2-pick__list">
        {all.map((item) => {
          const on = selected.has(item.id);
          const price = moneyShort(item.price, list?.currency ?? 'PLN', locale);
          return (
            <li key={item.id}>
              <label className="v2-pick__row" data-on={on || undefined}>
                <input type="checkbox" checked={on} onChange={() => toggle(item.id)} />
                <span className="v2-pick__text">
                  <span className="v2-pick__name">{item.title}</span>
                  <span className="v2-pick__meta">{on ? price ?? t('v2list.item.noPrice') : t('v2share.notIncluded')}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );

  const preview = list && (
    <GuestPreviewV2
      title={title.trim() || list.title}
      eventDate={list.event_date}
      message={message.trim() || null}
      groups={chosenGroups}
      currency={list.currency}
      hidePrices={!showPrices}
      hue={hue}
    />
  );

  const hiddenLine = hidden > 0 && <p className="v2-hint v2-hint--start">{t('v2share.hidden', { items: counts.items(hidden) })}</p>;

  const settings = (
    <>
      {server && <NoteV2 tone="error">{server}</NoteV2>}
      <FieldV2
        ref={titleRef}
        label={t('share.fields.title')}
        name="share_title"
        maxLength={TITLE_MAX}
        autoComplete="off"
        value={title}
        error={titleError}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="v2-field">
        <label className="v2-field__label" htmlFor={messageId}>
          {t('v2share.message')}
        </label>
        <textarea
          id={messageId}
          name="share_message"
          className="v2-input v2-input--area"
          rows={2}
          maxLength={MESSAGE_MAX}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      <div className="v2-switches">
        <SwitchV2
          label={t('v2share.showPrices')}
          hint={t('v2share.showPricesHint')}
          checked={showPrices}
          onChange={setShowPrices}
        />
        <SwitchV2
          label={t('v2share.allowClaims')}
          hint={t('v2share.allowClaimsHint')}
          checked={allowClaims}
          onChange={setAllowClaims}
        />
      </div>
      <FieldV2
        label={t('v2share.expires')}
        name="share_expires"
        type="date"
        min={localToday()}
        value={expiresOn}
        error={pastError}
        onChange={(e) => setExpiresOn(e.target.value)}
      />
      {noneError && <NoteV2 tone="error">{noneError}</NoteV2>}
    </>
  );

  /* ── Кроки ── */

  let bar: { back: () => void; backLabel: string; heading: string; action?: { label: string; run: () => void } };
  let body;

  if (step === 'creating') {
    bar = { back: onClose, backLabel: t('common.cancel'), heading: t('v2share.title') };
    body = (
      <div className="v2-share__wait" role="status">
        <span className="v2-spinner v2-spinner--big" aria-hidden="true" />
        <p className="v2-share__wait-title">{t('v2share.creating')}</p>
        <p className="v2-hint">{t('v2share.creatingHint')}</p>
      </div>
    );
  } else if (step === 'done' || step === 'revoked') {
    bar = { back: onClose, backLabel: t('common.done'), heading: t('v2share.title') };
    body =
      step === 'revoked' ? (
        <div className="v2-stack v2-share__done">
          <IconCircleV2 icon={Link2} tone="warm" />
          <h3 className="v2-title v2-title--sm">{t('v2share.revokedTitle')}</h3>
          <p className="v2-lede">{t('v2share.revokedBody')}</p>
          <button type="button" className="v2-btn v2-btn--primary v2-btn--block" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      ) : (
        <div className="v2-stack v2-share__done">
          <IconCircleV2 icon={Check} tone="calm" />
          <h3 className="v2-title v2-title--sm">{t('share.ready')}</h3>
          {copied && <NoteV2 tone="info">{t('v2share.copied')}</NoteV2>}
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          <div className="v2-field">
            <label className="v2-field__label" htmlFor={`${titleId}-link`}>
              {t('share.link')}
            </label>
            <input
              id={`${titleId}-link`}
              className="v2-input"
              readOnly
              value={link ?? ''}
              onFocus={(e) => e.target.select()}
            />
          </div>
          <p className="v2-hint v2-hint--start">{t('v2share.linkHint')}</p>
          <div className="v2-sheet__actions">
            {canShare && (
              <button type="button" className="v2-btn v2-btn--primary v2-btn--block" onClick={() => void shareOut()}>
                {t('v2share.shareOut')}
              </button>
            )}
            <button
              type="button"
              className={`v2-btn v2-btn--block ${canShare ? 'v2-btn--outline' : 'v2-btn--primary'}`}
              onClick={() => void copy()}
            >
              {copied ? t('share.copied') : t('share.copyLink')}
            </button>
            <button type="button" className="v2-btn v2-btn--danger" onClick={() => setAskRevoke(true)}>
              {t('v2share.revoke')}
            </button>
          </div>
          {/* Після посилання вже є чого чекати — тоді й питаємо про сповіщення (P1). */}
          <NotifyAskV2 />
        </div>
      );
  } else if (step === 'pick' && !desktop) {
    bar = {
      back: () => setStep('form'),
      backLabel: t('v2auth.back'),
      heading: t('v2share.whatGuestsSee'),
      action: { label: t('common.done'), run: () => setStep('form') },
    };
    body = (
      <>
        {summary}
        {pickList}
      </>
    );
  } else if (step === 'preview' && !desktop) {
    bar = { back: () => setStep('form'), backLabel: t('common.close'), heading: t('v2list.preview.title') };
    body = (
      <>
        <p className="v2-hint v2-hint--start">{t('v2share.previewOf', { title: title.trim() || list?.title || '' })}</p>
        {preview}
        {hiddenLine}
      </>
    );
  } else {
    bar = { back: onClose, backLabel: t('common.cancel'), heading: t('v2share.title') };
    body = desktop ? (
      <div className="v2-share__cols">
        <form
          className="v2-stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          {settings}
          {summary}
          {pickList}
          <SubmitV2 busy={false} label={t('share.create')} busyLabel={t('v2share.creating')} />
        </form>
        <aside className="v2-share__aside" aria-label={t('v2share.previewTitle')}>
          <p className="v2-kicker">{t('v2share.previewTitle')}</p>
          {preview}
          {hiddenLine}
          <p className="v2-hint v2-hint--start">{t('v2share.previewNote')}</p>
        </aside>
      </div>
    ) : (
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        {settings}
        <div className="v2-share__pickrow">
          {summary}
          <button type="button" className="v2-btn v2-btn--outline" onClick={() => setStep('pick')}>
            {t('v2share.pick')}
          </button>
        </div>
        <button type="button" className="v2-btn v2-btn--ghost" onClick={() => setStep('preview')}>
          {t('v2share.previewCta')}
        </button>
        <SubmitV2 busy={false} label={t('share.create')} busyLabel={t('v2share.creating')} />
      </form>
    );
  }

  return (
    <>
      <SheetV2
        open={open}
        onClose={onClose}
        labelledBy={titleId}
        className={`v2-sheet--full${desktop ? ' v2-sheet--wide' : ''}`}
        closeOnBackdrop={false}
      >
        <div className="v2-bar">
          <button type="button" className="v2-bar__btn" onClick={bar.back}>
            {bar.backLabel}
          </button>
          <h2 className="v2-bar__title" id={titleId}>
            {bar.heading}
          </h2>
          {bar.action ? (
            <button type="button" className="v2-bar__btn v2-bar__btn--primary" onClick={bar.action.run}>
              {bar.action.label}
            </button>
          ) : (
            <span className="v2-bar__spacer" aria-hidden="true" />
          )}
        </div>
        <div className="v2-itemsheet__body">{body}</div>
      </SheetV2>

      {/* Поруч, а не всередині: вкладене вікно ловило б Escape разом із цим. */}
      <ConfirmSheetV2
        open={askRevoke}
        id="v2-revoke-title"
        title={t('v2share.revokeTitle')}
        body={t('v2share.revokeBody')}
        confirmLabel={t('v2share.revokeConfirm')}
        busyLabel={t('v2share.revoking')}
        busy={revoking}
        onConfirm={() => void revoke()}
        onClose={() => setAskRevoke(false)}
      />
    </>
  );
}
