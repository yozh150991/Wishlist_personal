import { rmSync } from 'node:fs';

/**
 * Початок прогону `npm run check:shops`: прибирає рядки звіту минулого разу
 * (`test-results/shops.jsonl`), щоб `shops.md` містив лише цей прогін.
 */
export default function shopsSetup() {
  rmSync(new URL('../../test-results/shops.jsonl', import.meta.url), { force: true });
}
