import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Скасування замість підтвердження — логіка, спільна для обох версій дизайну.
 *
 * Зворотна дія не питає дозволу — вона дає кілька секунд, щоб передумати.
 * Діалог лишається тільки незворотному: видаленню списку, масовому видаленню.
 * Підтвердження на те, що й так можна відкотити, люди перестають читати
 * і натискають «так» не дивлячись — тобто воно не захищає ні від чого.
 *
 * Дія справді **не виконується** до кінця відліку: скасування має бути
 * миттєвим і не залежати від мережі. Для видалення позиції це ще й питання
 * гостей: позначки на позицію зникають разом із нею (каскад), тож «видалити
 * одразу й створити знову» мовчки знімало б чужі позначки, а власник цього
 * не побачив би ніколи (CLAUDE.md §3.2, ADR-044). Ціна — кілька секунд,
 * протягом яких зміна живе лише на екрані; тому при виході зі сторінки
 * відлік не втрачається, а завершується негайно.
 *
 * Вигляд тосту в кожної версії свій (`components/UndoToast.tsx` у v1,
 * `designs/v2/screens/ListPartsV2.tsx` у v2).
 */

export type Pending = {
  /** Що сталося — минулим часом: «Позицію видалено». */
  label: string;
  /** Справжня дія. Викликається, коли час вийшов або людина пішла зі сторінки. */
  commit: () => void;
  /** Повернути екран у попередній стан. */
  revert: () => void;
};

/** `delay` — скільки живе тост: у v1 сім секунд, у v2 шість (потік C4). */
export function useUndo(delay = 7000) {
  const [pending, setPending] = useState<Pending | null>(null);
  /** Мить, коли відлік скінчиться, — для видимого таймера. */
  const [until, setUntil] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  // Тримаємо в ref, щоб прибирання ефекту бачило актуальне значення,
  // а не те, яке було на момент підписки.
  const current = useRef<Pending | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
    setPending(null);
    setUntil(null);
  }, []);

  const commitNow = useCallback(() => {
    const p = current.current;
    clear();
    p?.commit();
  }, [clear]);

  const schedule = useCallback(
    (next: Pending) => {
      // Друга дія поспіль не скасовує першу: та вже відбулась на екрані,
      // і людина чекає, що вона доїде.
      commitNow();
      current.current = next;
      setPending(next);
      setUntil(Date.now() + delay);
      timer.current = window.setTimeout(() => {
        const p = current.current;
        clear();
        p?.commit();
      }, delay);
    },
    [clear, commitNow, delay],
  );

  const undo = useCallback(() => {
    const p = current.current;
    clear();
    p?.revert();
  }, [clear]);

  // Пішли зі сторінки — доводимо незавершене до кінця. Мовчки втратити
  // видалення, яке людина вже бачила виконаним, гірше за все інше.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      current.current?.commit();
    },
    [],
  );

  return { pending, until, schedule, undo };
}
