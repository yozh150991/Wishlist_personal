import { useSyncExternalStore } from 'react';

/**
 * Встановлення застосунку на пристрій.
 *
 * Chrome, Edge і Samsung Internet надсилають `beforeinstallprompt`, коли сайт
 * можна встановити; збережена подія дозволяє показати системне вікно
 * встановлення з нашої кнопки. Safari на iPhone і iPad такої події не має —
 * там лише «Поділитися → На початковий екран», тож для iOS показуємо інструкцію.
 *
 * Модуль імпортується в main.tsx, щоб слухач зʼявився раніше, ніж браузер
 * надішле подію: вона приходить один раз, одразу після завантаження.
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferred: InstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  // Без preventDefault: браузер лишає своє звичне запрошення встановити,
  // а кнопка в налаштуваннях — додатковий шлях для тих, хто його закрив.
  window.addEventListener('beforeinstallprompt', (e) => {
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow = true;
    notify();
  });
}

export type InstallState = 'installed' | 'prompt' | 'ios' | 'manual';

function standalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function ios(): boolean {
  const ua = navigator.userAgent;
  // iPadOS видає себе за Mac, але має сенсорний екран.
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

function snapshot(): InstallState {
  if (installedNow || standalone()) return 'installed';
  if (deferred) return 'prompt';
  if (ios()) return 'ios';
  return 'manual';
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, snapshot, () => 'manual');
}

/** Показує системне вікно встановлення. Подію можна використати лише раз. */
export async function promptInstall(): Promise<void> {
  const e = deferred;
  if (!e) return;
  deferred = null;
  notify();
  await e.prompt();
  await e.userChoice;
}
