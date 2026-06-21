import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Set NEXT_PUBLIC_API_BASE_URL so all SSR fetch calls (which cannot be
    // intercepted by page.route) target the local mock server on port 3001.
    command: 'NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    env: {
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3001',
    },
  },
});
