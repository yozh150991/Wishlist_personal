/** Типи до `hue-ramp.js` — генератора рампи оформлення з одного відтінку. */
export declare const LIGHT_STEPS: Record<number, [number, number]>;
export declare const DARK_STEPS: Record<number, [number, number]>;
export declare const HUE_PRESETS: readonly number[];
export declare const DEFAULT_HUE: number;
export declare const OVERLAY_VARS: readonly string[];
export declare function oklchToHex(L: number, C: number, H: number): string;
export declare function normalizeHue(h: number): number;
export declare function overlayVars(hue: number, theme: 'light' | 'dark'): Record<string, string>;
