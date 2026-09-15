import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * Обгортка над нативним <dialog>: фокус-пастка, Esc і підкладка
 * дістаються від браузера, а не пишуться руками.
 *
 * Прокрутка живе тільки в тілі діалога, заголовок лишається на місці.
 * При відкритті тіло примусово вертається на початок і фокус ставиться
 * на перше поле — інакше браузер прокручує контейнер до того елемента,
 * який отримав фокус сам, і форма відкривається з середини.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
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
        <button className="btn btn--bare" onClick={onClose} aria-label="×">
          ×
        </button>
      </div>
      <div className="dialog__body" ref={body}>
        {children}
      </div>
    </dialog>
  );
}
