import { test, expect } from '@playwright/test';

// Browser integration of the real IndexedDB/outbox modules. Synthetic IDs and
// intercepted REST traffic only: no account or production writes are needed.
// Runs against Vite, like the other E2E suites, not the production bundle.
test.describe('ST + EG: offline durability under storage failure', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/rest/v1/**', route => route.abort('failed'));
    await page.goto('/login');
    await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible();
  });

  test('network failure → queued → reload keeps pending operation isolated by user', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const modulePath = '/src/lib/outbox.ts';
      const outbox: typeof import('../../src/lib/outbox') = await import(modulePath);
      const result = await outbox.run('qa-user', { kind: 'delete', listId: 'qa-list', ids: ['00000000-0000-4000-8000-000000000001'] });
      return { result, own: await outbox.pendingCount('qa-user'), other: await outbox.pendingCount('qa-other') };
    });
    expect(result).toEqual({ result: 'queued', own: 1, other: 0 });
    await page.reload();
    const pending = await page.evaluate(async () => {
      const modulePath = '/src/lib/outbox.ts';
      const outbox: typeof import('../../src/lib/outbox') = await import(modulePath);
      return outbox.pending('qa-user');
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.op).toMatchObject({ kind: 'delete', listId: 'qa-list' });
  });

  test('BUG-QA-30: unavailable IndexedDB must not report a durable queued change', async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const modulePath = '/src/lib/outbox.ts';
      const outbox: typeof import('../../src/lib/outbox') = await import(modulePath);
      const original = IDBFactory.prototype.open;
      IDBFactory.prototype.open = () => { throw new DOMException('Storage denied', 'SecurityError'); };
      try {
        try {
          const result = await outbox.run('qa-user', { kind: 'delete', listId: 'qa-list', ids: ['00000000-0000-4000-8000-000000000001'] });
          return { result, count: await outbox.pendingCount('qa-user') };
        } catch {
          return { result: 'rejected', count: 0 };
        }
      } finally {
        IDBFactory.prototype.open = original;
      }
    });
    expect(outcome.count).toBe(0);
    expect(outcome.result).toBe('rejected');
  });
});
