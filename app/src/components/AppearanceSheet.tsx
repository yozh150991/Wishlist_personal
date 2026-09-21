import { useEffect, useRef } from 'react';
import { useI18n } from '../lib/i18n';
import { SCHEMES, THEMES, useTheme } from '../lib/theme';
import type { Theme } from '../lib/theme';
import { Icon } from './Icon';

/**
 * Лист «Вигляд» на гостьовій сторінці.
 *
 * Гість **не успадковує** схему власника й обирає сам. Причина не естетична, а
 * доступнісна: гостю може бути потрібен Вугіль, і чужий вибір не має йому
 * цього забороняти.
 *
 * Акаунта в гостя немає, тож вибір живе в localStorage його браузера й на
 * сервер не їде — інакше це був би ще один сигнал про те, що хтось відкрив
 * посилання (CLAUDE.md §3.2).
 */
export function AppearanceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { theme, scheme, setTheme, setScheme } = useTheme();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const themeLabel: Record<Theme, string> = {
    light: t('settings.themeLight'),
    dark: t('settings.themeDark'),
    system: t('settings.themeSystem'),
  };

  return (
    <dialog className="dialog sheet" ref={ref} onClose={onClose} onCancel={onClose}>
      <div className="dialog__head">
        <h2>{t('guest.appearance')}</h2>
        <button
          type="button"
          className="btn btn--icon btn--secondary"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="dialog__body">
        <div className="filters__group">
          <span className="filters__label" id="g-scheme">
            {t('settings.colors')}
          </span>
          <div className="scheme-list" role="radiogroup" aria-labelledby="g-scheme">
            {SCHEMES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scheme === s}
                className="scheme-list__item"
                onClick={() => setScheme(s)}
              >
                <span className="scheme-dot scheme-dot--big" data-scheme-dot={s} aria-hidden="true" />
                <span className="scheme-list__text">
                  {t(`settings.scheme.${s}`)}
                  {s === 'vuhil' && (
                    <span className="small muted">{t('settings.contrastShort')}</span>
                  )}
                </span>
                {scheme === s && <Icon name="check" size={18} />}
              </button>
            ))}
          </div>
        </div>

        <div className="filters__group">
          <span className="filters__label" id="g-theme">
            {t('settings.theme')}
          </span>
          <div className="filters__row" role="radiogroup" aria-labelledby="g-theme">
            {THEMES.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={theme === v}
                className={theme === v ? 'btn btn--primary' : 'btn btn--secondary'}
                onClick={() => setTheme(v)}
              >
                {themeLabel[v]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </dialog>
  );
}
