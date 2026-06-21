import { test, expect } from '@playwright/test';

/**
 * E2E tests: sign out and session expiry
 * Validates: Requirements 6.7
 */
test.describe('Sign out and session expiry', () => {
  test('clicking Sign out redirects to landing page', async ({ page }) => {
    // Mock auth endpoints so the dashboard renders successfully
    await page.route('**/auth/me', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ userId: 'u1', spotifyId: 'testuser' }),
      }),
    );
    await page.route('**/api/status', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ registered: true, isRunning: false }),
      }),
    );
    await page.route('**/api/removals', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      }),
    );
    await page.route('**/auth/logout', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      }),
    );

    await page.goto('/dashboard');

    // Open the avatar dropdown — Avatar has aria-label="User menu"
    const avatarBtn = page.getByRole('button', { name: /user menu/i });
    await expect(avatarBtn).toBeVisible();
    await avatarBtn.click();

    // Click "Sign out" — DropdownMenu button has aria-label="Sign out"
    const signOutBtn = page.getByRole('button', { name: /sign out/i });
    await expect(signOutBtn).toBeVisible();
    await signOutBtn.click();

    // Assert redirect to landing page
    await page.waitForURL('/', { timeout: 5000 });
    await expect(page).toHaveURL('/');
  });

  test('navigating to /dashboard without session redirects to /', async ({ page }) => {
    // Mock /auth/me to return 401 — simulates an unauthenticated visit
    await page.route('**/auth/me', route =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      }),
    );

    await page.goto('/dashboard');

    // The server component detects the 401 and redirects to /
    await page.waitForURL('/', { timeout: 5000 });
    await expect(page).toHaveURL('/');
  });
});
