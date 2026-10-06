import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { FxRates } from './itemsView';
import type { Currency } from './types';

/**
 * Курс НБП для підказки «≈ … за курсом НБП від …» (ADR-051).
 *
 * Лише підказка власнику під сумою: ні ціни, ні суми ним не перераховуються
 * й ніде не зберігаються. Таблицю `fx_rates` раз на добу оновлює
 * wishlist-jobs; гості її не читають. Без мережі чи без курсу підказки
 * просто немає — сума по валютах лишається точною й без неї.
 */

export type { FxRates };

/** Один запит на сесію сторінки: курс міняється раз на добу. */
let cached: Promise<FxRates> | null = null;

export function fetchFxRates(): Promise<FxRates> {
  if (!cached) {
    cached = (async () => {
      const { data, error } = await supabase.from('fx_rates').select('currency, pln_per_unit, rate_date');
      if (error) throw error;
      const out: FxRates = {};
      for (const row of (data ?? []) as { currency: Currency; pln_per_unit: number | string; rate_date: string }[]) {
        const rate = Number(row.pln_per_unit);
        if (Number.isFinite(rate) && rate > 0) out[row.currency] = { pln_per_unit: rate, rate_date: row.rate_date };
      }
      return out;
    })().catch((e: unknown) => {
      // Збій не кешуємо: наступне відкриття спробує ще раз.
      cached = null;
      throw e;
    });
  }
  return cached;
}

/** Курс, лише коли він справді знадобиться: без іншої валюти в списку запиту немає. */
export function useFxRates(needed: boolean): FxRates | null {
  const [rates, setRates] = useState<FxRates | null>(null);
  useEffect(() => {
    if (!needed) return;
    let alive = true;
    fetchFxRates()
      .then((r) => alive && setRates(r))
      .catch(() => alive && setRates(null));
    return () => {
      alive = false;
    };
  }, [needed]);
  return needed ? rates : null;
}
