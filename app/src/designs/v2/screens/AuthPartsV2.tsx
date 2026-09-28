import { forwardRef, useEffect, useId, useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertCircle, Check, ChevronLeft, Eye, EyeOff, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useI18n, LOCALES } from '../../../lib/i18n';
import type { Locale } from '../../../lib/i18n';
import { designSwitchHref } from '../../../lib/authFlow';
import type { EmailProblem } from '../../../lib/authFlow';

/**
 * Частини екранів входу, реєстрації й пароля v2 (потоки A, Q, T).
 *
 * Лише розмітка й стилі v2 (`v2.css`, префікс `v2-`). Логіка — у
 * `lib/authFlow.ts` і `lib/password.ts`, спільних з v1: листи, адреси
 * повернення й Google у двох версій одні (ADR-039, ADR-042).
 */

/** Іконки — Lucide зі штрихом 2.75, як у всьому застосунку. */
const STROKE = 2.75;

/** Повна назва мови її ж мовою — людина впізнає свою, не знаючи поточної. */
const LANGUAGE: Record<Locale, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };

/**
 * Рамка: одна колонка по центру, мова вгорі праворуч, дорога до старого
 * вигляду внизу. На десктопі та сама колонка, лише ширше полотно довкола:
 * потоки 2.0 окремої десктопної композиції для входу не дають.
 */
export function AuthFrameV2({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const { pathname, search } = useLocation();
  const id = useId();
  return (
    <div className="v2-auth">
      <div className="v2-auth__top">
        {/* Мова потрібна ще до входу: обрана тут, вона їде в user_metadata
            і визначає мову листа підтвердження (ADR-024). */}
        <label className="v2-sr" htmlFor={id}>
          {t('v2auth.language')}
        </label>
        <select
          id={id}
          className="v2-lang"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>
              {LANGUAGE[l]}
            </option>
          ))}
        </select>
      </div>
      <main className="v2-auth__main">
        <div className="v2-auth__col">{children}</div>
      </main>
      <p className="v2-auth__design">
        {/* Звичайне <a>: інша версія — інша таблиця маршрутів (ADR-039, п. 4). */}
        <a href={designSwitchHref(pathname, search, 'v1')}>{t('design.backToV1Link')}</a>
      </p>
    </div>
  );
}

/** Шапка з кнопкою «назад» — як у кадрах «Новий акаунт» і «Новий пароль». */
export function BackHeaderV2({ to, state, title }: { to: string; state?: unknown; title: string }) {
  const { t } = useI18n();
  return (
    <div className="v2-back">
      <Link to={to} state={state} className="v2-iconbtn" aria-label={t('v2auth.back')}>
        <ChevronLeft size={22} strokeWidth={STROKE} aria-hidden="true" />
      </Link>
      <h1 className="v2-back__title">{title}</h1>
    </div>
  );
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  label: string;
  error?: string | null;
  /**
   * Попередження — «зверни увагу», а не «так не можна»: теракота, а не
   * червоний, і дію воно не блокує (потік B, дубль назви).
   */
  warning?: string | null;
  /** Кнопка чи інший вміст праворуч у полі (показати пароль). */
  addon?: ReactNode;
  /** Рядок під полем (посилання «Не памʼятаєш пароль?»), і з помилкою теж. */
  after?: ReactNode;
  /** Id елемента з вимогами — додається до aria-describedby. */
  describedBy?: string;
};

/**
 * Поле: підпис над ним, помилка під ним. Помилка живе під своїм полем і
 * зникає, щойно рядок стає коректним (потік A, кадр 2) — тож її рахує
 * батьківський екран зі значення, а не зберігає окремо.
 */
export const FieldV2 = forwardRef<HTMLInputElement, FieldProps>(function FieldV2(
  { label, error, warning, addon, after, describedBy, ...rest },
  ref,
) {
  const id = useId();
  const errId = `${id}-err`;
  const warnId = `${id}-warn`;
  const warn = !error && warning ? warning : null;
  const described = [error ? errId : null, warn ? warnId : null, describedBy].filter(Boolean).join(' ') || undefined;
  return (
    <div className="v2-field" data-invalid={error ? 'true' : undefined} data-warn={warn ? 'true' : undefined}>
      <label className="v2-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="v2-field__box">
        <input
          ref={ref}
          id={id}
          className="v2-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          {...rest}
        />
        {addon}
      </div>
      {error && (
        <p className="v2-field__error" id={errId}>
          <AlertCircle size={16} strokeWidth={STROKE} aria-hidden="true" />
          {error}
        </p>
      )}
      {warn && (
        <p className="v2-field__warn" id={warnId}>
          <TriangleAlert size={16} strokeWidth={STROKE} aria-hidden="true" />
          {warn}
        </p>
      )}
      {/* «Не пам'ятаєш пароль?» лишається й поруч із помилкою: саме тоді він
          найпотрібніший. */}
      {after}
    </div>
  );
});

/** Пароль із кнопкою «показати» — одне поле замість «повторіть пароль» (T2). */
export const PasswordFieldV2 = forwardRef<HTMLInputElement, Omit<FieldProps, 'type' | 'addon'>>(
  function PasswordFieldV2(props, ref) {
    const { t } = useI18n();
    const [shown, setShown] = useState(false);
    return (
      <FieldV2
        ref={ref}
        {...props}
        type={shown ? 'text' : 'password'}
        addon={
          <button
            type="button"
            className="v2-iconbtn v2-field__addon"
            aria-pressed={shown}
            aria-label={shown ? t('v2auth.hide') : t('v2auth.show')}
            onClick={() => setShown((v) => !v)}
          >
            {shown ? (
              <EyeOff size={20} strokeWidth={STROKE} aria-hidden="true" />
            ) : (
              <Eye size={20} strokeWidth={STROKE} aria-hidden="true" />
            )}
          </button>
        }
      />
    );
  },
);

/**
 * Вимоги до пароля наперед: відмічаються під час введення, а не після
 * помилки (Q1, T2). Для зчитувача екрана стан кожної сказано словами.
 */
export function RulesV2({ id, rules }: { id: string; rules: { label: string; met: boolean }[] }) {
  const { t } = useI18n();
  return (
    <ul className="v2-rules" id={id}>
      {rules.map((r) => (
        <li key={r.label} className="v2-rules__item" data-met={r.met ? 'true' : undefined}>
          <span className="v2-rules__mark" aria-hidden="true">
            {r.met && <Check size={14} strokeWidth={STROKE} />}
          </span>
          {r.label}
          <span className="v2-sr">{r.met ? t('v2auth.ruleMet') : t('v2auth.ruleOpen')}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Головна кнопка. Ніколи не гасне мовчки: під час запиту підпис стає
 * дієсловом зі спінером, а порожні поля перевіряє натиск, не блокування (A1).
 */
export function SubmitV2({
  busy,
  label,
  busyLabel,
  paused,
}: {
  busy: boolean;
  label: string;
  busyLabel: string;
  /** Підпис на час паузи — кнопка лишається, але натиск нічого не робить. */
  paused?: string | null;
}) {
  return (
    <button
      type="submit"
      className="v2-btn v2-btn--primary v2-btn--block"
      aria-disabled={busy || Boolean(paused) || undefined}
      data-busy={busy || undefined}
    >
      {busy && <span className="v2-spinner" aria-hidden="true" />}
      {busy ? busyLabel : (paused ?? label)}
    </button>
  );
}

/** Повідомлення над полями: помилка — alert, решта — status. */
export function NoteV2({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  return (
    <p className={`v2-note v2-note--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'error' ? (
        <AlertCircle size={18} strokeWidth={STROKE} aria-hidden="true" />
      ) : (
        <Check size={18} strokeWidth={STROKE} aria-hidden="true" />
      )}
      <span>{children}</span>
    </p>
  );
}

/** Коло з іконкою над заголовком екранів «Лист уже в пошті», «Посилання не діє». */
export function IconCircleV2({ icon: Icon, tone }: { icon: LucideIcon; tone: 'calm' | 'warm' }) {
  return (
    <div className={`v2-circle v2-circle--${tone}`} aria-hidden="true">
      <Icon size={32} strokeWidth={STROKE} />
    </div>
  );
}

/** «або поштою» між Google і формою. */
export function OrDividerV2() {
  const { t } = useI18n();
  return (
    <p className="v2-or">
      <span>{t('v2auth.or')}</span>
    </p>
  );
}

/**
 * Секунди до моменту `until` із щосекундним оновленням; 0 — час минув.
 * Для «Надіслати ще раз · через 0:42» і паузи після невдалих спроб.
 */
export function useCountdown(until: number | null): number {
  const left = () => (until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0);
  const [value, setValue] = useState(left);
  useEffect(() => {
    setValue(left());
    if (!until) return;
    const id = window.setInterval(() => {
      const v = left();
      setValue(v);
      if (v === 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return value;
}

/** 42 → «0:42». */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Текст помилки пошти. «Порожньо» кажемо лише після натиску кнопки,
 * решту — вже на виході з поля (потік A, кадр 2).
 */
export function useEmailError(problem: EmailProblem | null, touched: boolean, submitted: boolean): string | null {
  const { t } = useI18n();
  if (!problem) return null;
  if (!submitted && !(touched && problem !== 'empty')) return null;
  if (problem === 'empty') return t('v2auth.email.empty');
  if (problem === 'noAt') return t('v2auth.email.noAt');
  return t('v2auth.email.incomplete');
}
