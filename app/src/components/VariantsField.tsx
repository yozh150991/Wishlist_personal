import { useId } from 'react';
import { useI18n } from '../lib/i18n';
import {
  VARIANTS_MAX,
  VARIANT_LABEL_HINTS,
  VARIANT_LABEL_MAX,
  VARIANT_VALUE_MAX,
} from '../lib/types';
import type { ItemVariant } from '../lib/types';

/**
 * Редактор ознак товару: «Розмір → M», «Колір → чорний» (ADR-030).
 *
 * Рядки живуть у стані діалогу як є, разом із порожніми: людина додає рядок і
 * лише потім його заповнює. Прибирає порожні та обрізає пробіли `cleanVariants`
 * перед відправкою — інакше порожня пара впиралася б у check-обмеження.
 *
 * Поля однорядкові (`input`, не `textarea`) навмисно: переноси рядка заборонені
 * і в базі, бо ламають рядок чипів на картці.
 */
export function VariantsField({
  variants,
  onChange,
}: {
  variants: ItemVariant[];
  onChange: (next: ItemVariant[]) => void;
}) {
  const { t } = useI18n();
  const listId = useId();

  function patch(index: number, part: Partial<ItemVariant>) {
    onChange(variants.map((v, i) => (i === index ? { ...v, ...part } : v)));
  }

  function remove(index: number) {
    onChange(variants.filter((_, i) => i !== index));
  }

  function add() {
    if (variants.length >= VARIANTS_MAX) return;
    onChange([...variants, { label: '', value: '' }]);
  }

  return (
    <fieldset className="variants">
      <legend>{t('item.variants.legend')}</legend>

      {/* Підказки не обмежують: це datalist, а не select — свій підпис завжди можна вписати. */}
      <datalist id={listId}>
        {VARIANT_LABEL_HINTS.map((key) => (
          <option key={key} value={t(`item.variants.hints.${key}`)} />
        ))}
      </datalist>

      {variants.length === 0 && <p className="hint">{t('item.variants.empty')}</p>}

      {variants.map((variant, index) => (
        // Ключ за позицією — рядки не переставляються, лише додаються й
        // видаляються з кінця або середини, і власного id у пари немає.
        <div className="variants__row" key={index}>
          <input
            type="text"
            list={listId}
            className="variants__label"
            maxLength={VARIANT_LABEL_MAX}
            placeholder={t('item.variants.labelPlaceholder')}
            aria-label={t('item.variants.labelAria', { n: index + 1 })}
            value={variant.label}
            onChange={(e) => patch(index, { label: e.target.value })}
          />
          <input
            type="text"
            className="variants__value"
            maxLength={VARIANT_VALUE_MAX}
            placeholder={t('item.variants.valuePlaceholder')}
            aria-label={t('item.variants.valueAria', { n: index + 1 })}
            value={variant.value}
            onChange={(e) => patch(index, { value: e.target.value })}
          />
          {/* type="button": усередині <form> будь-яка інша кнопка відправляє форму (CLAUDE.md §4). */}
          <button
            type="button"
            className="btn btn--ghost btn--compact"
            aria-label={t('item.variants.removeAria', { n: index + 1 })}
            onClick={() => remove(index)}
          >
            {t('item.variants.remove')}
          </button>
        </div>
      ))}

      <button
        type="button"
        className="btn btn--secondary"
        disabled={variants.length >= VARIANTS_MAX}
        onClick={add}
      >
        {t('item.variants.add')}
      </button>
      {variants.length >= VARIANTS_MAX && (
        <span className="hint">{t('item.variants.max', { max: VARIANTS_MAX })}</span>
      )}
    </fieldset>
  );
}

/**
 * Готує пари до відправки: обрізає пробіли й прибирає порожні рядки.
 *
 * Пара, де заповнено лише одне з двох полів, не «здогадується» — її ловить
 * перевірка у формі, щоб людина не втратила введене мовчки.
 */
export function cleanVariants(variants: ItemVariant[]): ItemVariant[] {
  return variants
    .map((v) => ({ label: v.label.trim(), value: v.value.trim() }))
    .filter((v) => v.label !== '' || v.value !== '');
}

/** Ключ помилки для форми, або `null`, якщо пари придатні. Межі — ті самі, що в базі. */
export function variantsError(variants: ItemVariant[]): string | null {
  const clean = cleanVariants(variants);
  if (clean.length > VARIANTS_MAX) return 'item.errors.variantsMany';
  if (clean.some((v) => v.label === '' || v.value === '')) return 'item.errors.variantsHalf';
  if (clean.some((v) => v.label.length > VARIANT_LABEL_MAX || v.value.length > VARIANT_VALUE_MAX)) {
    return 'item.errors.variantsLong';
  }
  return null;
}
