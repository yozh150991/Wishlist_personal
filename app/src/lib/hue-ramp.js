/**
 * Рампа оформлення з одного відтінку (дизайн, файл 09 «Свої кольори й події»).
 *
 * Оформлення списку — це назва й відтінок H (0–359), і нічого більше. Світлість
 * і насиченість кожного кроку задає система цими анкерами, тими самими для
 * будь-якого H. Тому контраст — властивість конструкції: якщо L .42 тримає
 * 4,5:1 на всіх полотнах, його тримає кожен відтінок. `npm run check:contrast`
 * проганяє крок H по 15° у двох темах і падає, якщо хтось зсуне анкер.
 *
 * **Обрізаємо хрому, не світлість.** Жовті й лаймові відтінки при L .42 не
 * існують у sRGB із C .10. Покладатися на браузер не можна: Chrome зводить
 * `oklch()` у гамут обрізанням каналів, а воно зсуває й світлість. Тому колір
 * рахується тут — двійковим пошуком по хромі при сталих L і H — і в CSS
 * потрапляє вже готовим hex. Світлість не правиться ніколи: втрата кольору
 * прийнятна, втрата контрасту — ні.
 *
 * Файл — JavaScript, а не TypeScript, бо його без збірки імпортує ще й
 * `scripts/check-contrast.mjs`. Типи — у `hue-ramp.d.ts` поруч.
 */

/** Анкери світлої теми: крок → [L, C]. 200/500/700/900 — з макета, решта між ними. */
export const LIGHT_STEPS = {
  100: [0.95, 0.03],
  200: [0.91, 0.055],
  300: [0.82, 0.085],
  400: [0.7, 0.11],
  500: [0.58, 0.12],
  600: [0.5, 0.11],
  700: [0.42, 0.1],
  800: [0.37, 0.085],
  900: [0.32, 0.07],
};

/** Анкери темної: 200, 500/700, 900 — з макета; 600 = 500 = 700, як у дзеркальних числах. */
export const DARK_STEPS = {
  100: [0.22, 0.045],
  200: [0.28, 0.06],
  300: [0.4, 0.08],
  400: [0.62, 0.1],
  500: [0.82, 0.11],
  600: [0.82, 0.11],
  700: [0.82, 0.11],
  800: [0.88, 0.08],
  900: [0.93, 0.05],
};

/**
 * Готові відтінки для аркуша «Новий вигляд» — крок 30°. 105 пропущено: жовто-
 * лаймовий при L .42 втрачає майже всю хрому й від 75 на око не відрізняється.
 * Будь-який інший H дає повзунок.
 */
export const HUE_PRESETS = [15, 45, 75, 135, 165, 195, 225, 255, 285, 315, 345];

/** З чого починається аркуш «Новий вигляд». */
export const DEFAULT_HUE = HUE_PRESETS[0];

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLCH → лінійний sRGB (може вийти за [0, 1] — це й перевіряє гамут). */
function oklchToLinearRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * Колір OKLCH у hex sRGB. Якщо він поза гамутом — хрома зменшується, доки не
 * влізе; L і H не рухаються.
 */
export function oklchToHex(L, C, H) {
  let rgb = oklchToLinearRgb(L, C, H);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearRgb(L, mid, H))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinearRgb(L, lo, H);
  }
  return (
    '#' +
    rgb
      .map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255))
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Нормалізує відтінок у ціле 0–359. */
export function normalizeHue(h) {
  const n = Math.round(Number(h));
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

/**
 * Змінні оверлею для теми. Оверлей перевизначає **лише** акцентну рампу,
 * заливку й чорнило головної кнопки та смужку «Високий» — нейтраль, полотно,
 * поверхні, небезпека й гостьові токени лишаються від схеми глядача.
 *
 * Чорнило на заливці: біле на світлій, полотно схеми на темній — задано
 * схемою, не користувачем. Тому в темній це посилання на `--color-bg`.
 *
 * @param {number} hue
 * @param {'light' | 'dark'} theme
 * @returns {Record<string, string>}
 */
export function overlayVars(hue, theme) {
  const h = normalizeHue(hue);
  const steps = theme === 'dark' ? DARK_STEPS : LIGHT_STEPS;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [step, [L, C]] of Object.entries(steps)) {
    out[`--color-accent-${step}`] = oklchToHex(L, C, h);
  }
  const base = theme === 'dark' ? out['--color-accent-500'] : out['--color-accent-700'];
  out['--color-accent'] = base;
  out['--color-primary-fill'] = base;
  out['--color-primary-ink'] = theme === 'dark' ? 'var(--color-bg)' : '#ffffff';
  out['--color-prio-high'] = base;
  return out;
}

/** Імена всіх змінних, які ставить оверлей, — щоб зняти їх разом. */
export const OVERLAY_VARS = [
  '--color-accent',
  ...Object.keys(LIGHT_STEPS).map((s) => `--color-accent-${s}`),
  '--color-primary-fill',
  '--color-primary-ink',
  '--color-prio-high',
];
