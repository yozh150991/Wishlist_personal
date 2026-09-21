import { useState } from 'react';
import { useI18n } from '../lib/i18n';

/**
 * QR з адресою застосунку — для десктопа.
 *
 * На великому екрані кнопка «Встановити» мало що дає: ставити застосунок
 * зазвичай хочуть на телефон, а він в іншій руці. QR переносить адресу туди
 * за секунду, без диктування вголос.
 *
 * Бібліотека тягнеться **ліниво**, окремим чанком, і навмисно виключена з
 * precache (`globIgnores` у `vite.config.ts`): 50 КБ у кеш офлайн-оболонки
 * заради панелі, яку відкривають раз у житті, — погана угода. Офлайн QR
 * однаково марний: його нікуди сканувати без мережі.
 */
export function InstallQr() {
  const { t } = useI18n();
  const [svg, setSvg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = window.location.origin;

  async function show() {
    if (busy || svg) return;
    setBusy(true);
    try {
      const { default: qrcode } = await import('qrcode-generator');
      // 0 — автоматичний розмір під довжину рядка; 'M' — рівень корекції,
      // якого вистачає для екрана (для друку беруть вищий).
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      setSvg(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qr">
      <p className="small muted">{t('pwa.qrHint')}</p>
      {svg ? (
        <>
          {/* Картинка декоративна: та сама адреса нижче текстом, і саме її
              читає зчитувач екрана. */}
          <div className="qr__code" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
          <code className="qr__url">{url}</code>
        </>
      ) : (
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void show()}>
          {busy && <span className="spinner" />}
          {t('pwa.qrShow')}
        </button>
      )}
    </div>
  );
}
