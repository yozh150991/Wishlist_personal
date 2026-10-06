import { test, expect } from '@playwright/test';
import { dateTextToIso, isoToDateText, maskDateText } from '../../src/lib/dateText';

/**
 * Дата з клавіатури у v2 (DateFieldV2): маска «ДД.ММ.РРРР» і перетворення в
 * `YYYY-MM-DD`. Без браузера — чисті функції з `lib/dateText.ts`.
 */
test.describe('дата з клавіатури', () => {
  test('маска ставить крапки сама й доповнює «5.3.» нулями', () => {
    expect(maskDateText('2')).toBe('2');
    expect(maskDateText('201')).toBe('20.1');
    expect(maskDateText('20122026')).toBe('20.12.2026');
    expect(maskDateText('201220261')).toBe('20.12.2026');
    expect(maskDateText('5.')).toBe('05.');
    expect(maskDateText('5.3.')).toBe('05.03.');
    expect(maskDateText('5.3.2026')).toBe('05.03.2026');
    expect(maskDateText('20/12/2026')).toBe('20.12.2026');
    // Стерли крапку — не повертаємо її, доки немає наступної цифри.
    expect(maskDateText('20')).toBe('20');
  });

  test('вставлене «2026-12-20» стає «20.12.2026»', () => {
    expect(maskDateText('2026-12-20')).toBe('20.12.2026');
    expect(isoToDateText('2026-12-20')).toBe('20.12.2026');
    expect(isoToDateText('')).toBe('');
  });

  test('неповна чи неіснуюча дата — null', () => {
    expect(dateTextToIso('20.12.2026')).toBe('2026-12-20');
    expect(dateTextToIso('29.02.2028')).toBe('2028-02-29');
    expect(dateTextToIso('29.02.2026')).toBeNull();
    expect(dateTextToIso('31.04.2026')).toBeNull();
    expect(dateTextToIso('20.13.2026')).toBeNull();
    expect(dateTextToIso('20.12.202')).toBeNull();
    expect(dateTextToIso('')).toBeNull();
  });
});
