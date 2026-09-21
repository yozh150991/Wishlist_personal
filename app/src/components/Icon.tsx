import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Filter,
  Link2,
  List,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Іконки — Lucide з товщиною штриха 2.75: тонший штрих на теплому тлі
 * розчиняється, а на дрібних розмірах іконка перестає читатись.
 *
 * Набір зібраний тут явно, а не береться з бібліотеки в кожному місці:
 * так видно, скільки їх насправді, і збірка не тягне зайвого.
 */
const ICONS = {
  alert: AlertCircle,
  check: Check,
  chevronDown: ChevronDown,
  clock: Clock,
  copy: Copy,
  filter: Filter,
  link: Link2,
  list: List,
  plus: Plus,
  search: Search,
  sliders: SlidersHorizontal,
  trash: Trash2,
  wifiOff: WifiOff,
  x: X,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/**
 * `size` у пікселях. Іконка завжди декоративна: підпис поруч або aria-label на
 * кнопці, тож окремої назви вона не отримує й від зчитувача екрана схована.
 */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return <Glyph size={size} strokeWidth={2.75} aria-hidden="true" />;
}
