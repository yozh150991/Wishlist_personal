import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { LanguagePicker } from './LanguagePicker';

/**
 * Метафора приватності: п'ять рядків списку, з яких чітко видно рівно один.
 * Решта розмиті — і що далі, то сильніше. Це швидше за будь-яку обіцянку
 * словами пояснює, чим цей застосунок відрізняється від решти вішлістів.
 *
 * Суто декоративна, тож від зчитувача екрана схована: те саме сказано
 * заголовком і абзацом поруч.
 */
function PrivacyDemo() {
  const rows = [
    { width: '72%', blur: 0 },
    { width: '58%', blur: 3 },
    { width: '66%', blur: 4 },
    { width: '44%', blur: 5 },
    { width: '60%', blur: 6 },
  ];
  return (
    <div className="privacy" aria-hidden="true">
      {rows.map((row, i) => (
        <span
          key={i}
          className="privacy__row"
          data-open={i === 0}
          style={{ width: row.width, filter: row.blur ? `blur(${row.blur}px)` : undefined }}
        />
      ))}
    </div>
  );
}

/**
 * Вхід, реєстрація і скидання пароля мають спільну рамку.
 *
 * На телефоні — одна колонка: метафора, заголовок, форма. На десктопі ліва
 * половина стає окремою поверхнею з тією самою метафорою, а форма їде праворуч
 * у колонку 400 px. Змінюється тільки композиція: поля, кнопка й помилки ті самі.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="auth">
      {/* Перемикач мови стоїть у правому верхньому куті на обох розкладках,
          тому він поза колонками — інакше на телефоні опинився б під формою. */}
      <LanguagePicker className="auth__lang" />

      <aside className="auth__promise">
        <PrivacyDemo />
        <div className="auth__promise-text">
          <h2>{t('auth.hero.title')}</h2>
          <p className="lede">{t('auth.hero.body')}</p>
        </div>
      </aside>

      {/* Саме <main>: на цих сторінках немає каркаса застосунку, і без
          орієнтира зчитувач екрана не має куди перейти до головного вмісту. */}
      <main className="auth__pane">
        <div className="auth__form-wrap">{children}</div>
      </main>
    </div>
  );
}
