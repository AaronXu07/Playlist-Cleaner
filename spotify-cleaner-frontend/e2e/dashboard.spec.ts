import { test, expect } from '@playwright/test';
import { resetMockServerState } from './mock-server';

/**
 * E2E tests for the cleaning toggle start/stop flow.
 *
 * These tests rely on the mock API server (started in globalSetup on port 3001)
 * for both SSR fetch calls from Next.js server components AND browser-side SWR
 * calls. page.route() cannot intercept SSR fetches, so all API mocking is
 * handled by the stateful mock server.
 *
 * Validates: Requirements 7.4, 7.5
 */

test.describe('Cleaning toggle end-to-end', () => {
  test.beforeEach(() => {
    // Reset the mock server's cleaning-enabled state to false before each test
    resetMockServerState();
  });

  test('toggle switches from Start to Stop on successful API call', async ({ page }) => {
    await page.goto('/dashboard');

    // ── Step 1: initial stopped state ──────────────────────────────────────
    // Mock server returns { pollingEnabled: false } for /api/status
    const startBtn = page.getByRole('button', { name: 'Start Cleaning' });
    await expect(startBtn).toBeVisible();

    // ── Step 2: click Start Cleaning → toggle to "Stop Cleaning" ───────────
    // Mock server POST /api/polling/start sets pollingEnabled=true; subsequent
    // SWR revalidation of /api/status will see pollingEnabled:true.
    await startBtn.click();

    const stopBtn = page.getByRole('button', { name: 'Stop Cleaning' });
    await expect(stopBtn).toBeVisible();
    // "Start Cleaning" must no longer be visible (Requirement 7.3)
    await expect(page.getByRole('button', { name: 'Start Cleaning' })).not.toBeVisible();

    // ── Step 3: click Stop Cleaning → revert to "Start Cleaning" ───────────
    // Mock server POST /api/polling/stop sets pollingEnabled=false.
    await stopBtn.click();

    await expect(page.getByRole('button', { name: 'Start Cleaning' })).toBeVisible();
    // "Stop Cleaning" must no longer be visible (Requirement 7.2)
    await expect(page.getByRole('button', { name: 'Stop Cleaning' })).not.toBeVisible();
  });
});
