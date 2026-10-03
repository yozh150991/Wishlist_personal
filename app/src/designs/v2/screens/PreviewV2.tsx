import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useI18n } from '../../../lib/i18n';
import { useTheme } from '../../../lib/theme';
import { fetchAppearanceHue } from '../../../lib/appearances';
import { formatDay, moneyShort } from '../../../lib/format';
import { overlayVars } from '../../../lib/hue-ramp.js';
import type { Currency, Item } from '../../../lib/types';
import { SheetV2 } from './CommonV2';

/**
 * «Як побачать гості» — превʼю гостьової сторінки для власника (потоки D, H,
 * W1; «Показати, як бачить гість»).
 *
 * Малюється з позицій власника, тож позначок тут немає й бути не може
 * (CLAUDE.md §3.2): «Я візьму це» — зображення кнопки, а не кнопка. Тло й
 * картки — гостьові токени, поверх них — оформлення списку, якщо воно діє;
 * висока контрастність вимикає його й тут (ADR-033, правило 1).
 *
 * Гостьова v2 ще не намальована (крок 5), тож превʼю показує суть — шапку,
 * позиції в порядку гостя, ціни чи їх відсутність, — а не пікселі сторінки.
 */

/** Відтінок оформлення списку; `null` — без оформлення або ще не прийшов. */
export function useAppearanceHue(appearanceId: string | null | undefined): number | null {
  const [hue, setHue] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setHue(null);
    if (!appearanceId) return;
    fetchAppearanceHue(appearanceId)
      .then((h) => {
        if (alive) setHue(h);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [appearanceId]);
  return hue;
}

export type PreviewGroup = { key: string; title: string | null; items: Item[] };

export function GuestPreviewV2({
  title,
  eventDate,
  message,
  groups,
  currency,
  hidePrices,
  hue,
}: {
  title: string;
  eventDate: string | null;
  message: string | null;
  /** Позиції в порядку гостя; заголовок групи — назва розділу. */
  groups: PreviewGroup[];
  currency: Currency;
  hidePrices: boolean;
  hue: number | null;
}) {
  const { t, locale } = useI18n();
  const { resolved } = useTheme();
  const day = formatDay(eventDate, locale);
  const style =
    hue !== null && resolved.locked !== 'a11y' ? (overlayVars(hue, resolved.theme) as CSSProperties) : undefined;
  const empty = groups.every((g) => g.items.length === 0);

  return (
    <div className="v2-gprev" style={style}>
      <div className="v2-gprev__head">
        {day && <p className="v2-gprev__kicker">{day}</p>}
        <p className="v2-gprev__title">{title}</p>
        {message && <p className="v2-gprev__message">{message}</p>}
      </div>
      <div className="v2-gprev__body">
        {empty ? (
          <p className="v2-gprev__empty">{t('appearance.previewEmpty')}</p>
        ) : (
          groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.key} className="v2-gprev__group">
                {g.title && <p className="v2-gprev__section">{g.title}</p>}
                <ul className="v2-gprev__items">
                  {g.items.map((item) => {
                    const price = hidePrices ? null : moneyShort(item.price, currency, locale);
                    const variants = item.variants.map((v) => v.value).join(' · ');
                    return (
                      <li key={item.id} className="v2-gprev__card">
                        {item.image_url && <img className="v2-gprev__img" src={item.image_url} alt="" loading="lazy" />}
                        <span className="v2-gprev__text">
                          <span className="v2-gprev__name">{item.title}</span>
                          {(price || variants) && (
                            <span className="v2-gprev__meta">{[price, variants].filter(Boolean).join(' · ')}</span>
                          )}
                        </span>
                        <span className="v2-gprev__take" aria-hidden="true">
                          {t('guest.take')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
        )}
      </div>
    </div>
  );
}

/**
 * «Показати, як бачить гість» з меню списку: усі актуальні позиції в порядку
 * гостя, в оформленні списку. Окремого маршруту немає — вікно поверх списку,
 * «Закрити» повертає туди ж.
 */
export function PreviewSheetV2({
  open,
  onClose,
  title,
  eventDate,
  message,
  groups,
  currency,
  hue,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eventDate: string | null;
  message: string | null;
  groups: PreviewGroup[];
  currency: Currency;
  hue: number | null;
}) {
  const { t } = useI18n();
  return (
    <SheetV2 open={open} onClose={onClose} labelledBy="v2-preview-title" className="v2-sheet--full">
      <div className="v2-bar">
        <button type="button" className="v2-bar__btn" onClick={onClose}>
          {t('common.close')}
        </button>
        <h2 className="v2-bar__title" id="v2-preview-title">
          {t('v2list.preview.title')}
        </h2>
        <span className="v2-bar__spacer" aria-hidden="true" />
      </div>
      <div className="v2-itemsheet__body">
        <p className="v2-hint v2-hint--start">{t('appearance.previewBanner')}</p>
        {open && (
          <GuestPreviewV2
            title={title}
            eventDate={eventDate}
            message={message}
            groups={groups}
            currency={currency}
            hidePrices={false}
            hue={hue}
          />
        )}
      </div>
    </SheetV2>
  );
}
