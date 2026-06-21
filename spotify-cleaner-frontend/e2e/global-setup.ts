/**
 * Playwright globalSetup — starts the mock API server before any tests run.
 * The mock server listens on port 3001 so that Next.js SSR calls
 * (which cannot be intercepted by page.route) reach a real HTTP endpoint.
 */
import { startMockServer } from './mock-server';

export default async function globalSetup() {
  await startMockServer(3001);
}
