/**
 * Віддає рядок користувачеві як файл.
 *
 * Окремо від `transfer.ts`, бо той навмисне не знає ні про DOM, ні про
 * браузер — його правила перевіряються тестами без сторінки.
 *
 * `URL.createObjectURL` під CSP `default-src 'self'` працює: завантаження за
 * `<a download>` не є ні навігацією, ні підключенням ресурсу, тож жодної
 * директиви не зачіпає. Перевірено тестом, який ловить подію завантаження.
 */
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Відкликаємо не одразу: Safari встигає почати завантаження не миттєво.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
