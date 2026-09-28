import { useEffect, useRef } from 'react';
import { useI18n } from '../lib/i18n';
import { THEMES, useTheme } from '../lib/theme';
import type { Theme } from '../lib/theme';
import { Icon } from './Icon';
import { Switch } from './Switch';

/**
 * Лист «Вигляд» на гостьовій сторінці — «для себе».
 *
 * Гість керує тим, що справді його: темою й високою контрастністю. Схеми тут
 * **немає** — не прихована, а не існує: оформлення списку належить власникові,
 * це його подія (ADR-033). Доступність від цього не страждає — висока
 * контрастність глядача перемагає будь-яке оформлення (resolveAppearance,
 * правило 1).
 *
 * Акаунта в гостя немає, тож вибір живе в localStorage його браузера й на
 * сервер не їде — інакше це був би ще один сигнал про те, що хтось відкрив
 * посилання (CLAUDE.md §3.2).
 */
export function AppearanceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { theme, setTheme, highContrast, systemContrast, setHighContrast } = useTheme();
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
        <p className="for-me">
          <span className="settings__label">{t('guest.forMe')}</span>
          <span className="small muted">{t('guest.forMeHint')}</span>
        </p>

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

        <Switch
          checked={highContrast || systemContrast}
          disabled={systemContrast}
          onChange={(on) => setHighContrast(on)}
          label={t('settings.highContrast')}
          hint={systemContrast ? t('settings.highContrastSystem') : undefined}
        />

        <p className="small muted">{t('guest.appearanceNote')}</p>
      </div>
    </dialog>
  );
}
