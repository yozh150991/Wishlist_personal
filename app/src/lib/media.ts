import { useEffect, useState } from 'react';

/**
 * Медіазапит як стан React.
 *
 * Потрібен там, де «намалювати обидва варіанти й сховати зайвий» — не варіант.
 * Дві копії тих самих контролів означають однакові `id` у документі, а
 * `<label for>` веде на **перший** збіг, тобто на схований: підпис у листі
 * фокусує поле в панелі, зчитувач екрана оголошує кожен фільтр двічі, а тест
 * знаходить не те, що бачить людина. Тому вибір робить рендер, а не CSS.
 *
 * Значення зчитується синхронно при першому рендері — без спалаху не тієї
 * розкладки.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    // Ширина могла змінитись між першим рендером і підпискою.
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);

  return matches;
}
