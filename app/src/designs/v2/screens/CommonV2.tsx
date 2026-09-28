import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { pendingCount } from '../../../lib/outbox';

/**
 * Частини екранів власника v2, спільні для кількох екранів: модальне вікно,
 * множина, вихід з акаунта. Лише v2 — у v1 свої (`components/`).
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
        {t('design.signOut')}
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
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={hint ? hintId : undefined}
      className="v2-switch-row"
      onClick={() => onChange(!checked)}
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
