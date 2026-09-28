import { useId } from 'react';

/**
 * Тумблер: рядок із назвою, поясненням і повзунком праворуч.
 *
 * Уся смуга — одна кнопка `role="switch"`, тож ціль для пальця широка, а не
 * 44 px повзунка. Доступна назва — лише заголовок (`aria-labelledby`), а
 * пояснення йде описом: інакше зчитувач екрана читав би абзац замість назви.
 *
 * `disabled` — коли стан вирішує не людина, а система (наприклад,
 * `prefers-contrast: more`). Пояснення тоді має сказати чому.
 */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      className="switch-row"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-row__text">
        <span className="switch-row__label" id={`${id}-label`}>
          {label}
        </span>
        {hint && (
          <span className="switch-row__hint" id={`${id}-hint`}>
            {hint}
          </span>
        )}
      </span>
      <span className="switch" aria-hidden="true">
        <span className="switch__knob" />
      </span>
    </button>
  );
}
