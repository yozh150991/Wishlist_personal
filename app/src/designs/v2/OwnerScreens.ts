/**
 * Екрани власника — одним лінивим чанком (Lighthouse, жовтень 2026).
 *
 * Гість і екран входу їх не потребують, а разом з `@dnd-kit` вони були
 * більшою частиною головного пакета. Чанк один на всі екрани навмисно: щойно
 * власник відкрив будь-який, решта вже в памʼяті, і перехід між ними без
 * мережі працює так само, як до розділення (офлайн-копії, ADR-028). У зібраному
 * застосунку чанк ще й у кеші Service Worker — `globPatterns` бере всі `.js`.
 */
export { default as ListsV2 } from './screens/ListsV2';
export { default as NewListV2 } from './screens/NewListV2';
export { default as ListV2 } from './screens/ListV2';
export { default as SharesV2 } from './screens/SharesV2';
export { default as GiftsV2 } from './screens/GiftsV2';
export { default as SettingsV2 } from './screens/SettingsV2';
export { default as AddV2 } from './screens/AddV2';
