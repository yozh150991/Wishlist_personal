import type { InputHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  /** Помилка цього поля: підсвічує рамку й стає підписом під полем. */
  error?: string;
  /**
   * Поле хибне, але текст помилки спільний для форми й показаний банером над
   * нею. Без цього на формі входу рамки лишались би звичайними, хоча зверху
   * написано «Пошта або пароль не підходять».
   */
  invalid?: boolean;
};

export function Field({ label, hint, error, invalid, id, className, ...rest }: FieldProps) {
  const inputId = id ?? rest.name ?? label;
  const hintId = `${inputId}-hint`;
  const text = error ?? hint;
  const bad = Boolean(error) || Boolean(invalid);
  return (
    <div className="field" data-invalid={bad ? 'true' : 'false'}>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className={className ? `input ${className}` : 'input'}
        aria-describedby={text ? hintId : undefined}
        aria-invalid={bad ? true : undefined}
        {...rest}
      />
      {text && (
        <span className="hint" id={hintId} data-tone={error ? 'error' : undefined}>
          {text}
        </span>
      )}
    </div>
  );
}

/**
 * Повідомлення над формою, а не тост: тост зникає, а людина в цей момент
 * дивиться на поля й повертається до них очима. Помилка — `role="alert"`,
 * решта — `role="status"`, щоб зчитувач екрана не перебивав набір тексту.
 */
export function Note({ tone, children }: { tone?: 'error' | 'success'; children: ReactNode }) {
  return (
    <p
      className={'banner' + (tone === 'error' ? ' banner--danger' : ' banner--accent')}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="banner__icon">
        <Icon name={tone === 'error' ? 'alert' : 'check'} size={18} />
      </span>
      <span className="banner__text">{children}</span>
    </p>
  );
}

/**
 * Кнопка, яка щось робить, ніколи просто не гасне: підпис змінюється на
 * дієслово в процесі («Входжу…», «Зберігаю…»), поруч крутиться спінер.
 * Вимкнена кнопка без пояснення виглядає як зламана.
 */
export function SubmitButton({
  busy,
  label,
  busyLabel,
  block = true,
  disabled,
}: {
  busy: boolean;
  label: string;
  busyLabel: string;
  block?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      className={'btn btn--primary' + (block ? ' btn--block' : '')}
      disabled={busy || disabled}
    >
      {busy && <span className="spinner" />}
      {busy ? busyLabel : label}
    </button>
  );
}
