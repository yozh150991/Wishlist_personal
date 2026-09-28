import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchAllItems, fetchList } from '../lib/db';
import { fetchAppearanceHue } from '../lib/appearances';
import { errorText } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { useSurface } from '../lib/theme';
import type { Item, List } from '../lib/types';
import { GuestHeader, GuestItemBody } from '../components/GuestParts';
import { Icon } from '../components/Icon';
import { Note } from '../components/ui';

/**
 * «Показати, як бачить гість» — єдиний екран власника, на який лягає
 * оформлення списку (resolveAppearance, виняток із правила 2).
 *
 * Малюється тими самими частинами, що й справжня гостьова, з актуальних
 * позицій списку. Позначок тут немає й бути не може: власник не бачить їх
 * ніде (CLAUDE.md §3.2), тож «Я візьму це» — зображення кнопки, а не кнопка.
 *
 * Без каркаса застосунку: гість його теж не бачить. Дорога назад — у смузі
 * згори.
 */
export default function GuestPreview() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const [list, setList] = useState<List | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [hue, setHue] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fresh = await fetchList(id);
        const [all, h] = await Promise.all([fetchAllItems(id), fetchAppearanceHue(fresh?.appearance_id ?? null)]);
        if (!alive) return;
        setList(fresh);
        setItems(all.filter((i) => i.status === 'active'));
        setHue(h);
      } catch (e) {
        if (alive) setError(errorText(e, t));
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useSurface(ready ? { kind: 'preview', hue } : null);

  return (
    <main className="guest">
      <div className="preview-bar" role="status">
        <Link className="btn btn--secondary btn--compact" to={`/lists/${id}`}>
          <Icon name="chevronDown" size={16} />
          {t('appearance.previewBack')}
        </Link>
        <p className="small">{t('appearance.previewBanner')}</p>
      </div>

      {!ready ? (
        <div className="booting" aria-busy="true">
          <span className="spinner" />
          <span className="visually-hidden">{t('common.loading')}</span>
        </div>
      ) : error || !list ? (
        <div className="guest__body">
          <Note tone="error">{error ?? t('common.notFound')}</Note>
        </div>
      ) : (
        <>
          <GuestHeader title={list.title} message={list.description} eventDate={list.event_date} />
          <div className="guest__body">
            {items && items.length > 0 ? (
              <ul className="guest__grid">
                {items.map((item) => (
                  <li className="gcard" key={item.id}>
                    <GuestItemBody item={item} currency={list.currency}>
                      <div className="gcard__action">
                        <span className="btn btn--primary btn--block" aria-hidden="true">
                          {t('guest.take')}
                        </span>
                      </div>
                    </GuestItemBody>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="lede center">{t('appearance.previewEmpty')}</p>
            )}
            <p className="guest__footer">{t('guest.footer')}</p>
          </div>
        </>
      )}
    </main>
  );
}
