import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { formatDay, hostOf, money } from '../lib/format';
import type { Currency, ItemPriority, ItemVariant } from '../lib/types';

/**
 * Спільні частини гостьової сторінки: шапка-листівка й тіло картки позиції.
 *
 * Ними малюють і справжня гостьова (`routes/SharedList.tsx`), і превʼю для
 * власника «Показати, як бачить гість» (`routes/GuestPreview.tsx`) — інакше
 * превʼю показувало б те, як сторінка виглядала колись.
 *
 * Дія на картці («Я візьму це», «Ти береш це», «Хтось уже взяв») сюди не
 * входить: вона своя в кожного місця, а у власника її немає зовсім.
 */

export function GuestHeader({
  title,
  message,
  eventDate,
  validUntil = null,
}: {
  title: string;
  message: string | null;
  eventDate: string | null;
  /** «Діє до 20 грудня, 23:59 за Києвом» — уже готовий рядок (lib/zones.ts). */
  validUntil?: string | null;
}) {
  const { locale } = useI18n();
  const day = formatDay(eventDate, locale);
  return (
    <header className="guest__head">
      {/* Над заголовком — дата події, а не назва оформлення: вона приватна,
          і гостю знати, що власник назвав вигляд «мамин синій», ні до чого. */}
      {day && <p className="guest__kicker">{day}</p>}
      <h1>{title}</h1>
      {message && <p className="guest__message">{message}</p>}
      {validUntil && <p className="guest__valid">{validUntil}</p>}
    </header>
  );
}

export type GuestItemView = {
  id: string;
  title: string;
  url: string | null;
  price: number | string | null;
  /** Валюта ціни позиції (ADR-051); немає — валюта списку. */
  currency?: Currency | null;
  quantity: number;
  priority: ItemPriority;
  note: string | null;
  variants: ItemVariant[];
  image_url: string | null;
  /** Замість «потрібно N», коли частину вже взяли: «потрібно 6 · лишилось 4». */
  quantityNote?: string;
};

/**
 * Тіло гостьової картки: смужка пріоритету, картинка, назва-посилання, ціна й
 * кількість, домен, ознаки, нотатка. Пріоритет — як і в застосунку: смужка й
 * значок для «Високого» та «Низького», «Середній» не позначається нічим, а
 * місце під смужку лишається, щоб текст не стрибав.
 */
export function GuestItemBody({
  item,
  currency,
  children,
}: {
  item: GuestItemView;
  currency: Currency;
  /** Блок дії внизу картки. */
  children?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const price = money(item.price, item.currency ?? currency, locale);
  const host = hostOf(item.url);
  return (
    <>
      <div className="gcard__top">
        <span className="prio" data-prio={item.priority} aria-hidden="true" />
        {item.image_url && <img className="gcard__image" src={item.image_url} alt="" loading="lazy" />}
        <div className="gcard__text">
          <h2 className="gcard__title">
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer noopener">
                {item.title}
              </a>
            ) : (
              item.title
            )}
          </h2>

          {/* «Приховати ціни» прибирає рядок зовсім — без порожнього
              місця й без слова «приховано». */}
          <p className="gcard__meta">
            {price && <span className="gcard__price">{price}</span>}
            {item.priority !== 'medium' && (
              <span className={item.priority === 'high' ? 'tag tag--accent' : 'tag tag--accent-2'}>
                {t(`item.priority.${item.priority}`)}
              </span>
            )}
            {item.quantity > 1 && (
              <span className="small muted">{item.quantityNote ?? t('guest.needed', { n: item.quantity })}</span>
            )}
          </p>
          {host && <p className="meta muted">{host}</p>}
        </div>
      </div>

      {/* Заради цього варіанти й існують: той, хто дарує, має бачити розмір
          і колір, не питаючи власника. */}
      {item.variants.length > 0 && (
        <ul className="variants-chips">
          {item.variants.map((v, i) => (
            <li className="tag tag--neutral" key={i}>
              <span className="muted">{v.label}</span>&nbsp;{v.value}
            </li>
          ))}
        </ul>
      )}

      {item.note && <p className="small muted">{item.note}</p>}

      {children}
    </>
  );
}
