import { VARIANTS_MAX, VARIANT_LABEL_MAX, VARIANT_VALUE_MAX } from './types';
import type { ItemVariant } from './types';

/**
 * Ознаки товару перед відправкою (ADR-030) — спільно для обох версій дизайну.
 * Редактори в кожної версії свої (`components/VariantsField.tsx` у v1,
 * `designs/v2/screens/ItemSheetV2.tsx` у v2), а межі й перевірка — одні,
 * ті самі, що в check-обмеженні `items_variants_shape`.
 */

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
