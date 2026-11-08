import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { pendingCount } from '../../../lib/outbox';
import { nextOccurrence } from '../../../lib/afterEvent';
import { formatDay, localToday } from '../../../lib/format';

/**
 * Частини екранів власника, спільні для кількох екранів: модальне вікно,
 * множина, вихід з акаунта.
 */

/**
 * Модальне вікно на рідному `<dialog>`: фокус замикає сам браузер, Escape
 * закриває, фокус після закриття повертається туди, звідки відкрили. На
 * телефоні — нижній лист, на десктопі — по центру (лише CSS, розмітка одна).
 */
export function SheetV2({
  open,
  onClose,
  labelledBy,
  className,
  closeOnBackdrop = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  /** Додатковий клас — напр. `v2-sheet--full` для форми позиції на весь екран. */
  className?: string;
  /**
   * Чи закривати кліком повз вікно. Форма, у яку вже щось вписано, не має
   * зникати від випадкового дотику до затемнення — їй `false`.
   */
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={className ? `v2-sheet ${className}` : 'v2-sheet'}
      aria-labelledby={labelledBy}
      // Escape: закриваємо через стан, а не силами браузера, інакше стан і
      // вікно розійдуться.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Клік по затемненню повз вікно — те саме, що «Скасувати».
      onClick={(e) => {
        if (closeOnBackdrop && e.target === ref.current) onClose();
      }}
    >
      <div className="v2-sheet__body">{children}</div>
    </dialog>
  );
}

type Plural = 'one' | 'few' | 'many' | 'other';

/**
 * «1 позиція / 3 позиції / 5 позицій» — за правилами мови з `Intl.PluralRules`.
 * Кожна форма — окремий ключ, і викликається буквально: так `check:i18n`
 * бачить їх усі.
 */
export function useCounts() {
  const { t, locale } = useI18n();
  const rules = new Intl.PluralRules(locale);
  const pick = (n: number, forms: Record<Plural, string>) => forms[rules.select(n) as Plural] ?? forms.other;
  return {
    items: (n: number) =>
      pick(n, {
        one: t('v2app.count.items.one', { n }),
        few: t('v2app.count.items.few', { n }),
        many: t('v2app.count.items.many', { n }),
        other: t('v2app.count.items.other', { n }),
      }),
    open: (n: number) =>
      pick(n, {
        one: t('v2app.count.open.one', { n }),
        few: t('v2app.count.open.few', { n }),
        many: t('v2app.count.open.many', { n }),
        other: t('v2app.count.open.other', { n }),
      }),
    /** «у 12 актуальних позиціях» — рядок під сумою списку. */
    inActive: (n: number) =>
      pick(n, {
        one: t('v2list.sum.inActive.one', { n }),
        few: t('v2list.sum.inActive.few', { n }),
        many: t('v2list.sum.inActive.many', { n }),
        other: t('v2list.sum.inActive.other', { n }),
      }),
    /** «Посилання на нього вже відкривали 7 разів…» — у видаленні списку (F3). */
    opened: (n: number) =>
      pick(n, {
        one: t('v2list.delete.viewed.one', { n }),
        few: t('v2list.delete.viewed.few', { n }),
        many: t('v2list.delete.viewed.many', { n }),
        other: t('v2list.delete.viewed.other', { n }),
      }),
    /** «23 перегляди» — на картці посилання (перегляди, не позначки). */
    views: (n: number) =>
      pick(n, {
        one: t('v2shares.views.one', { n }),
        few: t('v2shares.views.few', { n }),
        many: t('v2shares.views.many', { n }),
        other: t('v2shares.views.other', { n }),
      }),
    /** «Пошук у 42 позиціях» — підказка в полі пошуку. */
    searchIn: (n: number) =>
      pick(n, {
        one: t('v2list.search.placeholder.one', { n }),
        few: t('v2list.search.placeholder.few', { n }),
        many: t('v2list.search.placeholder.many', { n }),
        other: t('v2list.search.placeholder.other', { n }),
      }),
  };
}

/**
 * Кнопка виходу. Вихід стирає офлайн-кеш і чергу змін (CLAUDE.md §3.5),
 * тож незакінчену чергу не викидаємо мовчки — спершу питаємо.
 */
export function SignOutV2({ className = 'v2-btn v2-btn--ghost' }: { className?: string }) {
  const { t } = useI18n();
  const { session, signOut } = useAuth();
  const [waiting, setWaiting] = useState(0);
  const [busy, setBusy] = useState(false);

  async function request() {
    const n = session?.user.id ? await pendingCount(session.user.id) : 0;
    if (n > 0) setWaiting(n);
    else await leave();
  }

  async function leave() {
    setBusy(true);
    await signOut();
    setBusy(false);
    setWaiting(0);
  }

  return (
    <>
      <button type="button" className={className} onClick={() => void request()}>
        {t('v2app.signOut.action')}
      </button>
      <SheetV2 open={waiting > 0} onClose={() => setWaiting(0)} labelledBy="v2-signout-title">
        <h2 className="v2-sheet__title" id="v2-signout-title">
          {t('v2app.signOut.title')}
        </h2>
        <p className="v2-lede">{t('outbox.confirmSignOut', { n: waiting })}</p>
        <div className="v2-sheet__actions">
          <button type="button" className="v2-btn v2-btn--danger v2-btn--block" onClick={() => void leave()}>
            {busy && <span className="v2-spinner" aria-hidden="true" />}
            {t('v2app.signOut.confirm')}
          </button>
          <button type="button" className="v2-btn v2-btn--ghost" onClick={() => setWaiting(0)}>
            {t('v2app.signOut.stay')}
          </button>
        </div>
      </SheetV2>
    </>
  );
}

/**
 * Перемикач на всю смугу: підпис і пояснення ліворуч, повзунок праворуч.
 * `role="switch"` з `aria-checked` — зчитувач каже «увімкнено / вимкнено»,
 * а натиск будь-де на смузі перемикає. Кнопка, а не прихований чекбокс:
 * так її не можна відправити як поле форми.
 */
export function SwitchV2({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Стан задає не людина (напр. система просить контраст) — видно, але не міняється. */
  disabled?: boolean;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-describedby={hint ? hintId : undefined}
      className="v2-switch-row"
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="v2-switch-row__text">
        <span className="v2-switch-row__label">{label}</span>
        {hint && (
          <span className="v2-switch-row__hint" id={hintId}>
            {hint}
          </span>
        )}
      </span>
      <span className="v2-switch" aria-hidden="true">
        <span className="v2-switch__knob" />
      </span>
    </button>
  );
}

/**
 * «Повторювати щороку» (U3, ADR-047) — у новому списку, налаштуваннях і
 * повторі. Під перемикачем — коли саме нагадаємо; без дати нагадувати нема
 * про що, тож перемикач приглушений і каже чому.
 */
export function YearlySwitchV2({
  date,
  checked,
  onChange,
}: {
  /** Дата події з поля форми, `YYYY-MM-DD` або порожньо. */
  date: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const next = date ? nextOccurrence(date, localToday()) : null;
  return (
    <SwitchV2
      label={t('v2yearly.label')}
      hint={next ? t('v2yearly.hint', { date: formatDay(next, locale) ?? next }) : t('v2yearly.needsDate')}
      checked={Boolean(next) && checked}
      disabled={!next}
      onChange={onChange}
    />
  );
}

/**
 * Фото позиції на весь екран (гостьова сторінка, свій список, форма позиції).
 * Закривається тапом будь-де, «×», Escape і кнопкою «Назад» на телефоні.
 *
 * Рідний `<dialog>`: відкритий поверх форми позиції (теж `<dialog>`), він лягає
 * над нею у верхньому шарі браузера, а фокус після закриття повертається на
 * мініатюру.
 *
 * «Назад»: при відкритті додаємо в історію запис із тією самою адресою. Будь-яке
 * закриття йде через нього — тап, «×» і Escape викликають `history.back()`, а
 * закриває перегляд уже `popstate`; так «Назад» на телефоні закриває перегляд,
 * а не сторінку чи форму під ним. Роутер на такий запис не зважає: адреса та
 * сама, а `idx` у стані скопійовано з поточного. Запис не дублюється, якщо
 * ефект виконано двічі (StrictMode у розробці).
 */
export function PhotoViewerV2({ src, onClose }: { src: string; onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Вікно не закривається, а зникає з DOM, тож фокус на мініатюру браузер не
  // поверне — повертаємо самі. Беремо його під час першого рендера (ще до
  // `showModal()`), щоб повторний ефект StrictMode не підмінив його на «×».
  const openerRef = useRef(document.activeElement);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    if (!isViewerEntry(window.history.state)) {
      const base: unknown = window.history.state;
      window.history.pushState({ ...(typeof base === 'object' && base ? base : {}), photoViewer: true }, '');
    }
    const onPop = () => closeRef.current();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const close = () => {
    if (isViewerEntry(window.history.state)) window.history.back();
    else onClose();
  };

  return (
    <dialog
      ref={ref}
      className="v2-viewer"
      aria-label={t('v2app.photo.viewer')}
      data-testid="photo-viewer"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      // Тап будь-де — і по фото, і по затемненню — закриває перегляд.
      onClick={(e) => {
        e.stopPropagation();
        close();
      }}
    >
      <img className="v2-viewer__img" src={src} alt="" />
      <button type="button" className="v2-iconbtn v2-viewer__close" aria-label={t('v2app.photo.close')}>
        <X size={24} strokeWidth={2.75} aria-hidden="true" />
      </button>
    </dialog>
  );
}

function isViewerEntry(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'photoViewer' in state;
}

/**
 * Мініатюра фото, що відкриває його на весь екран. `children` — сама `<img>`
 * зі своїм класом розміру; кнопка лише робить її натисканою.
 */
export function PhotoThumbV2({ src, children }: { src: string; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="v2-thumb" aria-label={t('v2app.photo.open')} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && <PhotoViewerV2 src={src} onClose={() => setOpen(false)} />}
    </>
  );
}
