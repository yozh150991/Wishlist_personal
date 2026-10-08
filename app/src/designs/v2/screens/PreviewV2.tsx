import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { itemCurrency } from '../../../lib/itemsView';
import { useI18n } from '../../../lib/i18n';
import { useTheme } from '../../../lib/theme';
import { fetchAppearanceHue } from '../../../lib/appearances';
import { formatDay } from '../../../lib/format';
import { overlayVars } from '../../../lib/hue-ramp.js';
import type { SharedItem } from '../../../lib/shares';
import type { Currency, Item } from '../../../lib/types';
import { SheetV2, useCounts } from './CommonV2';
import { GuestCardV2, GuestHeadV2 } from './GuestPartsV2';

/**
 * «Як побачать гості» — превʼю гостьової сторінки для власника (потоки D, H,
 * W1; «Показати, як бачить гість»).
 *
 * З кроку 5г це справжня гостьова v2 — та сама шапка-листівка й ті самі
 * картки (`GuestHeadV2`, `GuestCardV2`), що бачить гість під `/l/…`, а не
 * наближення. Малюється з позицій власника, тож позначок тут немає й бути не
 * може (CLAUDE.md §3.2): «Беру» — зображення кнопки, а не кнопка. Тло й
 * картки — гостьові токени, поверх них — оформлення списку, якщо воно діє;
 * висока контрастність вимикає його й тут (ADR-033, правило 1).
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

/** Позиція власника так, як її віддає гостю `get_guest_list`: без позначок. */
function asShared(item: Item, currency: Currency, hidePrices: boolean): SharedItem {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    price: hidePrices ? null : item.price,
    currency: itemCurrency(item, currency),
    quantity: item.quantity,
    priority: item.priority,
    note: item.note,
    variants: item.variants,
    image_url: item.image_url,
    status: item.status,
    created_at: item.created_at,
    section_id: item.section_id ?? null,
    taken_qty: null,
    mine_qty: null,
  };
}

const noop = () => undefined;

export function GuestPreviewV2({
  title,
  eventDate,
  message,
  groups,
  currency,
  hidePrices,
  canClaim = true,
  hue,
}: {
  title: string;
  eventDate: string | null;
  message: string | null;
  /** Позиції в порядку гостя; заголовок групи — назва розділу. */
  groups: PreviewGroup[];
  currency: Currency;
  hidePrices: boolean;
  /** «Гості можуть бронювати» в посиланні: без цього — картки без «Беру». */
  canClaim?: boolean;
  hue: number | null;
}) {
  const { t, locale } = useI18n();
  const counts = useCounts();
  const { resolved } = useTheme();
  const day = formatDay(eventDate, locale);
  const style =
    hue !== null && resolved.locked !== 'a11y' ? (overlayVars(hue, resolved.theme) as CSSProperties) : undefined;
  const shown = groups.filter((g) => g.items.length > 0);
  const total = shown.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="v2-guest v2-guest--preview" style={style}>
      <GuestHeadV2 as="p" day={day} title={title} count={counts.items(total)} message={message} />
      <div className="v2-guest__body">
        {total === 0 ? (
          <p className="v2-hint">{t('appearance.previewEmpty')}</p>
        ) : (
          shown.map((g) => (
            <section key={g.key} className="v2-group" aria-label={g.title ?? undefined}>
              {g.title && (
                <div className="v2-group__head">
                  <p className="v2-kicker v2-group__title">{g.title}</p>
                </div>
              )}
              <ul className="v2-gcards">
                {g.items.map((item) => (
                  <GuestCardV2
                    key={item.id}
                    item={asShared(item, currency, hidePrices)}
                    currency={currency}
                    counts={{ left: item.quantity, mine: 0 }}
                    canClaim={canClaim}
                    flag={null}
                    preview
                    onTake={noop}
                    onRelease={noop}
                    onKeep={noop}
                    onBought={noop}
                    onShop={noop}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
        {canClaim && total > 0 && <p className="v2-hint">{t('v2guest.ownerBlind')}</p>}
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
