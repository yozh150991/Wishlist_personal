import { useEffect, useId, useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { useI18n } from '../../../lib/i18n';
import { THEMES, useTheme } from '../../../lib/theme';
import type { Theme } from '../../../lib/theme';
import { hostOf, moneyShort } from '../../../lib/format';
import { redeemCode, sendGuestCode } from '../../../lib/shares';
import type { SharedItem } from '../../../lib/shares';
import type { Currency } from '../../../lib/types';
import { FieldV2, NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2, SwitchV2 } from './CommonV2';
import { usePriorityLabel } from './ListPartsV2';

/**
 * Частини гостьової v2 (потік E, ADR-041, ADR-053): картка позиції й аркуші —
 * бронь, «Мої броні», «Уже маю броні», «Вигляд». Дані й правила — у
 * `GuestV2.tsx` і `lib/`; тут лише розмітка й стан вікон.
 *
 * До гостя — на «ви» (README пакета, «Копірайтинг»). Нічого про інших гостей,
 * крім «Уже взяли»: ні імені, ні часу (ADR-035, п. 8).
 */

const STROKE = 2.75;

/** Та сама перевірка, що в базі (`claim_item_v2`): до 254 символів, одне «@», крапка після нього. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX = 254;

/** «Скопіювати код» → «Скопійовано» на дві секунди: підтвердження там, куди дивляться. */
function useCopied(): [boolean, (ok: Promise<boolean>) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return [
    copied,
    (ok) =>
      void ok.then((done) => {
        if (!done) return;
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 2000);
      }),
  ];
}

/** Скільки ще можна взяти й скільки взяв цей гість — з урахуванням знятого тостом. */
export type GuestCounts = { left: number; mine: number };

export type CardState = 'free' | 'mine' | 'taken';

/**
 * Картка гостя: фото → назва (посилання на магазин), ціна й домен, ознаки,
 * нотатка → дія праворуч. Три стани з потоку E: вільна («Беру»), своя
 * (контур, «Ви берете», «Зняти»), чужа («Уже взяли» — без дії).
 */
export function GuestCardV2({
  item,
  currency,
  counts,
  canClaim,
  flag,
  onTake,
  onRelease,
}: {
  item: SharedItem;
  currency: Currency;
  counts: GuestCounts;
  canClaim: boolean;
  /** «нове» / «звільнилось» — з «Стежити за списком». */
  flag: string | null;
  onTake: (item: SharedItem) => void;
  onRelease: (item: SharedItem) => void;
}) {
  const { t, locale } = useI18n();
  const priority = usePriorityLabel();
  const price = moneyShort(item.price, item.currency ?? currency, locale);
  const host = hostOf(item.url);
  const { left, mine } = counts;
  const state: CardState = !canClaim ? 'free' : mine > 0 ? 'mine' : left > 0 ? 'free' : 'taken';
  const multi = item.quantity > 1;
  const taken = item.quantity - left;

  const meta = [
    price,
    multi && canClaim && taken > 0 && left > 0 ? t('v2guest.left', { left, n: item.quantity }) : null,
    multi && !(canClaim && taken > 0) ? t('v2guest.needed', { n: item.quantity }) : null,
    host,
  ].filter(Boolean);

  return (
    <li className="v2-gcard" data-state={state} id={`v2-g-${item.id}`}>
      {item.image_url ? (
        <img className="v2-gcard__img" src={item.image_url} alt="" loading="lazy" />
      ) : null}
      <div className="v2-gcard__text">
        {flag && <span className="v2-tag v2-gcard__flag" data-tone="accent">{flag}</span>}
        <h3 className="v2-gcard__title">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer noopener">
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </h3>
        {meta.length > 0 && <p className="v2-gcard__meta">{meta.join(' · ')}</p>}
        {item.variants.length > 0 && (
          <p className="v2-gcard__meta">
            {item.variants.map((v) => (v.label ? `${v.label}: ${v.value}` : v.value)).join(' · ')}
          </p>
        )}
        {item.note && <p className="v2-gcard__note">{item.note}</p>}
        {(state !== 'free' || item.priority === 'high') && (
          <span className="v2-gcard__tags">
            {state === 'mine' && (
              <span className="v2-tag v2-gcard__mine" data-tone="accent">
                <Check size={14} strokeWidth={STROKE} aria-hidden="true" />
                {multi ? t('v2guest.yoursOf', { n: mine, m: item.quantity }) : t('v2guest.yours')}
              </span>
            )}
            {state === 'taken' && (
              <span className="v2-gcard__taken">
                {multi ? t('v2guest.takenAll', { n: item.quantity }) : t('v2guest.takenByOther')}
              </span>
            )}
            {item.priority === 'high' && state !== 'taken' && (
              <span className="v2-tag" data-tone="accent">
                {priority('high')}
              </span>
            )}
          </span>
        )}
      </div>
      {canClaim && state !== 'taken' && (
        <div className="v2-gcard__actions">
          {state === 'free' && (
            <button type="button" className="v2-btn v2-btn--outline v2-btn--small" onClick={() => onTake(item)}>
              {t('v2guest.take')}
            </button>
          )}
          {state === 'mine' && (
            <>
              <button
                type="button"
                className="v2-btn v2-btn--ghost v2-btn--small v2-gcard__release"
                onClick={() => onRelease(item)}
              >
                {t('v2guest.release')}
              </button>
              {left > 0 && (
                <button type="button" className="v2-btn v2-btn--ghost v2-btn--small" onClick={() => onTake(item)}>
                  {t('v2guest.takeMore')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/* ── Бронь ─────────────────────────────────────────────────── */

export type BookStep =
  | { kind: 'form' }
  | { kind: 'race' }
  | { kind: 'code'; code: string };

/**
 * Аркуш броні (E2): «Берете …?», скільки (для позицій на кілька штук),
 * необовʼязкові підпис і пошта, «Забронювати / Не зараз». Обидва
 * підставляються з попередньої броні. Пошта — для коду й листа про бронь
 * (ADR-054); власник її не бачить.
 *
 * Той самий аркуш показує й наслідок: програну гонку (гілка «встигли
 * раніше») і код після першої броні (E3).
 */
export function BookSheetV2({
  item,
  step,
  counts,
  name,
  email,
  busy,
  error,
  canSimilar,
  onSubmit,
  onClose,
  onSimilar,
  onCopyCode,
  onSendLink,
}: {
  item: SharedItem | null;
  step: BookStep;
  counts: GuestCounts;
  /** Підпис і пошта з минулої броні. */
  name: string;
  email: string;
  busy: boolean;
  error: string | null;
  canSimilar: boolean;
  onSubmit: (quantity: number, name: string, email: string) => void;
  onClose: () => void;
  onSimilar: () => void;
  onCopyCode: (code: string) => Promise<boolean>;
  onSendLink: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [copied, copy] = useCopied();
  const [shown, setShown] = useState<SharedItem | null>(item);
  const [qty, setQty] = useState(1);
  const [signature, setSignature] = useState(name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [mail, setMail] = useState(email);
  const [mailError, setMailError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setShown(item);
    setQty(1);
    setSignature(name);
    setNameError(null);
    setMail(email);
    setMailError(null);
    // Новий аркуш — нова позиція; підпис підставляється раз, на відкритті.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const it = item ?? shown;
  const max = Math.max(1, counts.left);
  const multi = (it?.quantity ?? 1) > 1 && counts.left > 1;

  function submit() {
    if (busy) return;
    const clean = signature.trim();
    const address = mail.trim();
    const badName = clean.length > 60 || /[\u0000-\u001f\u007f]/.test(clean);
    const badMail = address !== '' && (address.length > EMAIL_MAX || !EMAIL_SHAPE.test(address));
    setNameError(badName ? t('v2guest.book.badName') : null);
    setMailError(badMail ? t('v2guest.book.badEmail') : null);
    if (badName || badMail) return;
    onSubmit(multi ? qty : 1, clean, address);
  }

  return (
    <SheetV2 open={item !== null} onClose={onClose} labelledBy={titleId} closeOnBackdrop={!busy}>
      {step.kind === 'race' ? (
        <>
          <h2 className="v2-sheet__title" id={titleId}>
            {t('v2guest.race.title', { title: it?.title ?? '' })}
          </h2>
          <p className="v2-lede" role="status">
            {t('v2guest.race.body')}
          </p>
          <div className="v2-sheet__actions">
            <button type="button" className="v2-btn v2-btn--primary v2-btn--block" onClick={onClose}>
              {t('v2guest.race.back')}
            </button>
            {canSimilar && (
              <button type="button" className="v2-btn v2-btn--ghost" onClick={onSimilar}>
                {t('v2guest.race.similar')}
              </button>
            )}
          </div>
        </>
      ) : step.kind === 'code' ? (
        <>
          <h2 className="v2-sheet__title" id={titleId}>
            {t('v2guest.code.title', { title: it?.title ?? '' })}
          </h2>
          <p className="v2-lede">{t('v2guest.code.body')}</p>
          <p className="v2-gcode" aria-label={t('v2guest.code.label', { code: step.code })}>
            {step.code}
          </p>
          <p className="v2-hint v2-hint--start">{t('v2guest.code.note')}</p>
          <div className="v2-sheet__actions">
            <button
              type="button"
              className="v2-btn v2-btn--primary v2-btn--block"
              onClick={() => copy(onCopyCode(step.code))}
            >
              {copied ? t('v2guest.copied') : t('v2guest.code.copy')}
            </button>
            <button type="button" className="v2-btn v2-btn--outline v2-btn--block" onClick={onSendLink}>
              {t('v2guest.code.link')}
            </button>
            <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
              {t('v2guest.code.done')}
            </button>
          </div>
        </>
      ) : (
        <form
          className="v2-gbook"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <h2 className="v2-sheet__title" id={titleId}>
            {t('v2guest.book.title', { title: it?.title ?? '' })}
          </h2>
          <p className="v2-lede">{t('v2guest.book.body')}</p>
          {error && <NoteV2 tone="error">{error}</NoteV2>}
          {multi && (
            <div className="v2-field">
              <p className="v2-field__label" id={`${titleId}-qty`}>
                {t('v2guest.book.qty')}
              </p>
              <div className="v2-gqty" role="group" aria-labelledby={`${titleId}-qty`}>
                <button
                  type="button"
                  className="v2-iconbtn"
                  aria-label={t('v2guest.book.less')}
                  aria-disabled={qty <= 1 || undefined}
                  onClick={() => setQty((q) => Math.max(1, q - 1))}
                >
                  <Minus size={20} strokeWidth={STROKE} aria-hidden="true" />
                </button>
                <span className="v2-gqty__value" aria-live="polite">
                  {qty}
                </span>
                <button
                  type="button"
                  className="v2-iconbtn"
                  aria-label={t('v2guest.book.more')}
                  aria-disabled={qty >= max || undefined}
                  onClick={() => setQty((q) => Math.min(max, q + 1))}
                >
                  <Plus size={20} strokeWidth={STROKE} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
          <FieldV2
            label={t('v2guest.book.name')}
            name="guest_name"
            autoComplete="nickname"
            maxLength={60}
            value={signature}
            error={nameError}
            onChange={(e) => {
              setSignature(e.target.value);
              setNameError(null);
            }}
            after={<p className="v2-hint v2-hint--start">{t('v2guest.book.nameHint')}</p>}
          />
          <FieldV2
            label={t('v2guest.book.email')}
            name="guest_email"
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={EMAIL_MAX}
            value={mail}
            error={mailError}
            onChange={(e) => {
              setMail(e.target.value);
              setMailError(null);
            }}
            after={<p className="v2-hint v2-hint--start">{t('v2guest.book.emailHint')}</p>}
          />
          <div className="v2-sheet__actions">
            <SubmitV2 busy={busy} label={t('v2guest.book.submit')} busyLabel={t('v2guest.book.submitting')} />
            <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
              {t('v2guest.book.later')}
            </button>
          </div>
        </form>
      )}
    </SheetV2>
  );
}

/* ── «Мої броні» ───────────────────────────────────────────── */

/**
 * «Мої броні» (E3, гілка «зняти бронь»): що бере цей гість у цьому списку,
 * «Зняти бронь» на кожній — тостом із відкатом, без діалогу. Нижче — як
 * повернутись з іншого пристрою: код і особисте посилання.
 */
export function MyPicksSheetV2({
  open,
  items,
  currency,
  code,
  name,
  email,
  onRelease,
  onCopyCode,
  onSendLink,
  onClose,
}: {
  open: boolean;
  items: { item: SharedItem; mine: number }[];
  currency: Currency;
  code: string | null;
  name: string | null;
  email: string | null;
  onRelease: (item: SharedItem) => void;
  onCopyCode: (code: string) => Promise<boolean>;
  onSendLink: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const [copied, copy] = useCopied();
  return (
    <SheetV2 open={open} onClose={onClose} labelledBy={titleId}>
      <h2 className="v2-sheet__title" id={titleId}>
        {t('v2guest.mineSheet.title')}
      </h2>
      <p className="v2-hint v2-hint--start">
        {t('v2guest.mineSheet.count', { n: items.length })}
        {name ? ` · ${t('v2guest.mineSheet.signed', { name })}` : ''}
        {email ? ` · ${t('v2guest.mineSheet.email', { email })}` : ''}
      </p>
      <ul className="v2-gpicks">
        {items.map(({ item, mine }) => {
          const price = moneyShort(item.price, item.currency ?? currency, locale);
          return (
            <li key={item.id} className="v2-gpicks__row">
              <span className="v2-gpicks__text">
                <span className="v2-gpicks__name">{item.title}</span>
                {(price || item.quantity > 1) && (
                  <span className="v2-gpicks__meta">
                    {[price, item.quantity > 1 ? t('v2guest.yoursOf', { n: mine, m: item.quantity }) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="v2-btn v2-btn--ghost v2-btn--small v2-gcard__release"
                onClick={() => onRelease(item)}
              >
                {t('v2guest.mineSheet.release')}
              </button>
            </li>
          );
        })}
      </ul>
      {code && (
        <section className="v2-card v2-gkeep" aria-labelledby={`${titleId}-keep`}>
          <h3 className="v2-card__title" id={`${titleId}-keep`}>
            {t('v2guest.mineSheet.keepTitle')}
          </h3>
          <p className="v2-hint v2-hint--start">{t('v2guest.mineSheet.keepBody')}</p>
          <p className="v2-gcode" aria-label={t('v2guest.code.label', { code })}>
            {code}
          </p>
          <div className="v2-gkeep__actions">
            <button
              type="button"
              className="v2-btn v2-btn--outline v2-btn--small"
              onClick={() => copy(onCopyCode(code))}
            >
              {copied ? t('v2guest.copied') : t('v2guest.code.copy')}
            </button>
            <button type="button" className="v2-btn v2-btn--outline v2-btn--small" onClick={onSendLink}>
              {t('v2guest.code.link')}
            </button>
          </div>
        </section>
      )}
      <div className="v2-sheet__actions">
        <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </SheetV2>
  );
}

/* ── «Уже маю броні» ───────────────────────────────────────── */

/**
 * Гілка «інший пристрій» (E4): код із 5 символів переносить броні на цей
 * пристрій і лишає їх на старому. Після 5 спроб на годину на список не
 * приймається навіть правильний — і це сказано прямо (ADR-035, п. 5).
 *
 * Немає коду під рукою — «Надіслати код на пошту» (ADR-041, п. 4): відповідь
 * однакова, є така адреса в списку чи ні, і ліміт спільний зі спробами коду.
 */
export function RedeemSheetV2({
  open,
  token,
  onClose,
  onRedeemed,
}: {
  open: boolean;
  token: string;
  onClose: () => void;
  onRedeemed: (key: string, claims: number) => void;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const [mode, setMode] = useState<'code' | 'mail'>('code');
  const [code, setCode] = useState('');
  const [mail, setMail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setMode('code');
    setCode('');
    setMail('');
    setError(null);
    setSent(false);
  }, [open]);

  async function run(job: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch {
      setError(t('v2guest.error'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function submitCode() {
    const clean = code.replace(/\s+/g, '').toUpperCase();
    if (clean.length !== 5) {
      setError(t('v2guest.redeem.short'));
      return;
    }
    void run(async () => {
      const res = await redeemCode(token, clean);
      if ('error' in res) {
        setError(res.error === 'too_many_attempts' ? t('v2guest.redeem.tooMany') : t('v2guest.redeem.notFound'));
      } else {
        onRedeemed(res.key, res.claims);
      }
    });
  }

  function submitMail() {
    const address = mail.trim();
    if (address.length > EMAIL_MAX || !EMAIL_SHAPE.test(address)) {
      setError(t('v2guest.book.badEmail'));
      return;
    }
    void run(async () => {
      const res = await sendGuestCode(token, address, locale);
      if ('error' in res) setError(t('v2guest.redeem.tooMany'));
      else {
        setSent(true);
        setMode('code');
      }
    });
  }

  return (
    <SheetV2 open={open} onClose={onClose} labelledBy={titleId} closeOnBackdrop={!busy}>
      <form
        className="v2-gbook"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === 'code') submitCode();
          else submitMail();
        }}
      >
        <h2 className="v2-sheet__title" id={titleId}>
          {t('v2guest.redeem.title')}
        </h2>
        {sent && <NoteV2 tone="info">{t('v2guest.redeem.mailSent')}</NoteV2>}
        {mode === 'code' ? (
          <>
            <p className="v2-lede">{t('v2guest.redeem.body')}</p>
            <FieldV2
              key="code"
              label={t('v2guest.redeem.code')}
              name="guest_code"
              className="v2-input v2-gcode-input"
              maxLength={5}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              error={error}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''));
                setError(null);
              }}
              after={<p className="v2-hint v2-hint--start">{t('v2guest.redeem.noCode')}</p>}
            />
            <div className="v2-sheet__actions">
              <SubmitV2 busy={busy} label={t('v2guest.redeem.submit')} busyLabel={t('v2guest.redeem.submitting')} />
              <button
                type="button"
                className="v2-btn v2-btn--ghost"
                onClick={() => {
                  setError(null);
                  setMode('mail');
                }}
              >
                {t('v2guest.redeem.byMail')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="v2-lede">{t('v2guest.redeem.mailBody')}</p>
            <FieldV2
              key="mail"
              label={t('v2guest.redeem.email')}
              name="guest_code_email"
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={EMAIL_MAX}
              value={mail}
              error={error}
              onChange={(e) => {
                setMail(e.target.value);
                setError(null);
              }}
            />
            <div className="v2-sheet__actions">
              <SubmitV2 busy={busy} label={t('v2guest.redeem.mailSubmit')} busyLabel={t('v2guest.redeem.mailSending')} />
              <button
                type="button"
                className="v2-btn v2-btn--ghost"
                onClick={() => {
                  setError(null);
                  setMode('code');
                }}
              >
                {t('v2guest.redeem.toCode')}
              </button>
            </div>
          </>
        )}
        <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </form>
    </SheetV2>
  );
}

/* ── «Вигляд» ─────────────────────────────────────────────── */

/**
 * «Вигляд» гостя — лише своє: тема й висока контрастність. Схеми тут немає —
 * не прихована, а не існує: оформлення списку належить власнику (ADR-033).
 * Вибір живе в браузері гостя й на сервер не їде.
 */
export function LookSheetV2({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const { theme, setTheme, highContrast, systemContrast, setHighContrast } = useTheme();
  const label = (v: Theme) =>
    v === 'light' ? t('settings.themeLight') : v === 'dark' ? t('settings.themeDark') : t('settings.themeSystem');

  return (
    <SheetV2 open={open} onClose={onClose} labelledBy={titleId}>
      <h2 className="v2-sheet__title" id={titleId}>
        {t('v2guest.look')}
      </h2>
      <p className="v2-hint v2-hint--start">{t('v2guest.lookFor')}</p>
      <fieldset className="v2-seg">
        <legend className="v2-field__label">{t('settings.theme')}</legend>
        <div className="v2-seg__row v2-seg__row--fit">
          {THEMES.map((v) => (
            <label key={v} className="v2-seg__opt">
              <input type="radio" name="v2-guest-theme" value={v} checked={theme === v} onChange={() => setTheme(v)} />
              <span>{label(v)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <SwitchV2
        label={t('settings.highContrast')}
        hint={systemContrast ? t('settings.highContrastSystem') : undefined}
        checked={highContrast || systemContrast}
        disabled={systemContrast}
        onChange={setHighContrast}
      />
      <p className="v2-hint v2-hint--start">{t('v2guest.lookNote')}</p>
      <div className="v2-sheet__actions">
        <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </SheetV2>
  );
}
