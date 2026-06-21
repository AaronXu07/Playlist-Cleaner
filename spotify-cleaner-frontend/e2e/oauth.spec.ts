import { test, expect } from '@playwright/test';

/**
 * E2E tests: full OAuth flow
 * Validates: Requirements 2.4, 6.1
 */
test.describe('Full OAuth flow', () => {
  test('Sign in with Spotify → OAuth redirect → Dashboard renders within 5s', async ({ page }) => {
    // Mock the backend auth/me endpoint
    await page.route('**/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ userId: 'test-user-id', spotifyId: 'testspotify' }),
      });
    });

    // Mock /api/status
    await page.route('**/api/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ registered: true, isRunning: false }),
      });
    });

    // Mock /api/removals
    await page.route('**/api/removals', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Navigate to landing page
    await page.goto('/');

    // Find the "Sign in with Spotify" link
    const signInLink = page.getByText('Sign in with Spotify');
    await expect(signInLink).toBeVisible();

    // Intercept the navigation to /auth/spotify and redirect to /dashboard instead.
    // This simulates a successful OAuth callback — the backend would normally set the
    // session cookie and redirect to /dashboard.
    await page.route('**/auth/spotify', async (route) => {
      await route.fulfill({
        status: 302,
        headers: { Location: 'http://localhost:3000/dashboard' },
      });
    });

    await signInLink.click();

    // Wait for dashboard to load (Requirement 2.4: within 5 seconds of redirect)
    await page.waitForURL('**/dashboard', { timeout: 5000 });

    // Assert Dashboard renders with user avatar within 5 seconds
    // Avatar component has aria-label="User menu" (Avatar.tsx)
    const avatar = page.getByRole('button', { name: /user menu/i });
    await expect(avatar).toBeVisible({ timeout: 5000 });

    // Assert "Dashboard" heading is present (Requirement 6.4)
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
  });

  test('/auth/me is called during dashboard load', async ({ page }) => {
    let authMeCalled = false;

    await page.route('**/auth/me', async (route) => {
      authMeCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ userId: 'test-user-id', spotifyId: 'testspotify' }),
      });
    });

    await page.route('**/api/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"registered":true,"isRunning":false}',
      }),
    );
    await page.route('**/api/removals', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      }),
    );

    await page.goto('/dashboard');

    // Wait for the page to settle
    await page.waitForLoadState('networkidle');

    expect(authMeCalled).toBe(true);
  });
});
