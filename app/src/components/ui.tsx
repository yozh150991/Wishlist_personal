import type { InputHTMLAttributes, ReactNode } from 'react';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ label, hint, error, id, ...rest }: FieldProps) {
  const inputId = id ?? rest.name ?? label;
  const hintId = `${inputId}-hint`;
  const text = error ?? hint;
  return (
    <div className="field" data-invalid={error ? 'true' : 'false'}>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        aria-describedby={text ? hintId : undefined}
        aria-invalid={error ? true : undefined}
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

export function Note({ tone, children }: { tone?: 'error' | 'success'; children: ReactNode }) {
  return (
    <p className="note" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}
