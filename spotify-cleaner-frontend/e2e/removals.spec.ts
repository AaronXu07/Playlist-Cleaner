import { test, expect } from '@playwright/test';

const mockSongs = [
  {
    id: 'removal-1',
    user_id: 'user-1',
    track_id: 'track-1',
    track_name: 'Test Song One',
    playlist_id: 'playlist-1',
    removed_at: new Date().toISOString(),
    reason: 'skipped',
  },
  {
    id: 'removal-2',
    user_id: 'user-1',
    track_id: 'track-2',
    track_name: 'Test Song Two',
    playlist_id: 'playlist-1',
    removed_at: new Date().toISOString(),
    reason: 'skipped',
  },
];

test.describe('Re-add song removes it from panel', () => {
  test('clicking + on a song row removes it from the Removed Songs panel', async ({ page }) => {
    // Mock auth — server component calls /auth/me server-side; also mock for
    // any client-side re-fetches.
    await page.route('**/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ userId: 'u1', spotifyId: 'testuser' }),
    }));

    // Mock cleaning status
    await page.route('**/api/status', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ registered: true, isRunning: false }),
    }));

    // Mock removals with 2 records — use a mutable array so the DELETE handler
    // can filter it and subsequent GET calls return the updated list.
    let removals = [...mockSongs];
    await page.route('**/api/removals', route => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(removals),
        });
      } else {
        route.continue();
      }
    });

    // Mock DELETE for removal-1: return 204 and remove it from the local list
    await page.route('**/api/removals/removal-1', route => {
      if (route.request().method() === 'DELETE') {
        removals = removals.filter(r => r.id !== 'removal-1');
        route.fulfill({ status: 204 });
      } else {
        route.continue();
      }
    });

    await page.goto('/dashboard');

    // Assert both rows are visible
    await expect(page.getByText('Test Song One')).toBeVisible();
    await expect(page.getByText('Test Song Two')).toBeVisible();

    // Click the + button on the first row
    const reAddBtn = page.getByRole('button', { name: 'Re-add Test Song One to playlist' });
    await expect(reAddBtn).toBeVisible();
    await reAddBtn.click();

    // Assert the first row is removed (optimistic UI animates it out)
    await expect(page.getByText('Test Song One')).not.toBeVisible({ timeout: 2000 });

    // Assert the second row is still visible
    await expect(page.getByText('Test Song Two')).toBeVisible();
  });
});
