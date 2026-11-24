import { test, expect } from '@playwright/test';
import { ABOUT_LIMITS, aboutIsEmpty, aboutTooLong, tidyAbout } from '../../src/lib/aboutRules';

// «Про мене» (ROADMAP 8.10): ті самі межі й прибирання пробілів, що в базі
// (`profiles_about_*_check`, тригер `profiles_about_tidy`). Чисті функції.

test.describe('«Про мене» — правила форми', () => {
  test('межі збігаються з базою: 120 / 500 / 500', () => {
    expect(ABOUT_LIMITS).toEqual({ sizes: 120, likes: 500, avoid: 500 });
  });

  test('пробіли по краях геть, порожнє — null', () => {
    expect(tidyAbout({ sizes: '  M / 42  ', likes: '', avoid: '   ' })).toEqual({ sizes: 'M / 42', likes: null, avoid: null });
  });

  test('порожнє — коли всі три поля порожні після прибирання', () => {
    expect(aboutIsEmpty({ sizes: ' ', likes: null, avoid: '' })).toBe(true);
    expect(aboutIsEmpty({ sizes: null, likes: null, avoid: 'Парфуми' })).toBe(false);
    expect(aboutIsEmpty(null)).toBe(true);
  });

  test('довжина — у символах, як char_length, і без пробілів по краях', () => {
    expect(aboutTooLong({ sizes: 'я'.repeat(120), likes: null, avoid: null })).toEqual([]);
    expect(aboutTooLong({ sizes: 'я'.repeat(121), likes: null, avoid: null })).toEqual(['sizes']);
    expect(aboutTooLong({ sizes: `  ${'я'.repeat(120)}  `, likes: null, avoid: null })).toEqual([]);
    // Емодзі — один символ для бази, хоч і два для JS.
    expect(aboutTooLong({ sizes: null, likes: '🎁'.repeat(500), avoid: 'я'.repeat(501) })).toEqual(['avoid']);
  });
});
