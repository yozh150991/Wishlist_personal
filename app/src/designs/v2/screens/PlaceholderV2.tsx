import { Link } from 'react-router-dom';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { useTheme } from '../../../lib/theme';

/**
 * Екран v2 для всього, що ще не намальовано: поки що — екрани власника
 * (ROADMAP, «Дизайн v2», крок 3). Вхід, реєстрація й пароль уже свої.
 *
 * Він існує не «щоб було»: без нього вибір v2 давав би порожній застосунок
 * без жодного способу повернутися. Тому тут завжди є дорога назад, і вона
 * не залежить від того, чи встиг щось відрендерити решта застосунку.
 * Хто вже увійшов, бачить, під яким акаунтом, і може вийти — інакше
 * перевірити вхід v2 з іншим акаунтом не було б як.
 *
 * Другий, надійніший вихід — адреса `?design=v1`: його ставить інлайновий
 * скрипт у `<head>` ще до React, тож він працює навіть тоді, коли v2 падає
 * на першому ж рендері (ADR-032).
 *
 * Цей файл видаляється разом з останнім екраном v2, якого бракує.
 */
export default function Placeholder() {
  const { t } = useI18n();
  const { setDesign } = useTheme();
  const { session, loading, signOut } = useAuth();

  return (
    <div className="booting" role="status" aria-live="polite">
      <h1>{t('design.emptyTitle')}</h1>
      <p>{t('design.emptyBody')}</p>
      {!loading &&
        (session ? (
          <p>
            {t('design.signedInAs', { email: session.user.email ?? '' })}{' '}
            <button type="button" className="btn btn--ghost" onClick={() => void signOut()}>
              {t('design.signOut')}
            </button>
          </p>
        ) : (
          <p>
            <Link to="/login">{t('design.toLogin')}</Link>
          </p>
        ))}
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => {
          setDesign('v1');
          // Повне перезавантаження, а не navigate: адреси v1 і v2 не зобовʼязані
          // збігатися, і найнадійніший спосіб опинитися на робочому екрані —
          // зайти в v1 з кореня.
          window.location.assign('/');
        }}
      >
        {t('design.backToV1')}
      </button>
    </div>
  );
}
