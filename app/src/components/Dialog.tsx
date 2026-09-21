import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';

/**
 * Обгортка над нативним <dialog>: фокус-пастка, Esc і підкладка дістаються
 * від браузера, а не пишуться руками.
 *
 * На телефоні діалог виїжджає знизу листом, на десктопі стоїть по центру —
 * це різниця в CSS, розмітка одна.
 *
 * Прокрутка живе тільки в тілі діалога, заголовок лишається на місці.
 * При відкритті тіло примусово вертається на початок і фокус ставиться на
 * перше поле — інакше браузер прокручує контейнер до того елемента, який
 * отримав фокус сам, і форма відкривається з середини.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  foot,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Липкий підвал із кнопками дії. Без нього діалог — просто текст. */
  foot?: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (open && !el.open) {
      el.showModal();
      // Після showModal, інакше браузер перекриє нашу позицію своєю.
      requestAnimationFrame(() => {
        if (body.current) body.current.scrollTop = 0;
        const first = body.current?.querySelector<HTMLElement>(
          'input:not([type="hidden"]), select, textarea',
        );
        first?.focus({ preventScroll: true });
      });
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog className="dialog" ref={ref} onClose={onClose} onCancel={onClose}>
      <div className="dialog__head">
        <h2>{title}</h2>
        <button
          type="button"
          className="btn btn--icon btn--secondary"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog__body" ref={body}>
        {children}
      </div>
      {foot && <div className="dialog__foot">{foot}</div>}
    </dialog>
  );
}

/**
 * Підтвердження незворотної дії.
 *
 * Заголовок називає **наслідок** («Видалити список і всі 12 позицій?»), тіло —
 * побічний ефект, про який людина могла не подумати, кнопка дії — **дієслово**,
 * а не «ОК». Кнопки йдуть одна під одною на телефоні, безпечна нижче: промах
 * пальцем не має нічого видаляти.
 *
 * Зворотні дії сюди не потрапляють: для них є тост «Скасувати». Діалог, який
 * питає дозволу на те, що й так можна відкотити, люди перестають читати.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busyLabel,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const safe = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // Фокус на безпечній кнопці: Enter одразу після відкриття не має
      // підтверджувати незворотне.
      requestAnimationFrame(() => safe.current?.focus({ preventScroll: true }));
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog className="dialog dialog--confirm" ref={ref} onClose={onClose} onCancel={onClose}>
      <div className="dialog__body">
        <h2>{title}</h2>
        {body && <p className="muted">{body}</p>}
      </div>
      <div className="dialog__foot dialog__foot--stack">
        <button
          type="button"
          className="btn btn--danger-fill"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy && <span className="spinner" />}
          {busy && busyLabel ? busyLabel : confirmLabel}
        </button>
        <button type="button" className="btn btn--secondary" ref={safe} onClick={onClose}>
          {t('common.keep')}
        </button>
      </div>
    </dialog>
  );
}
