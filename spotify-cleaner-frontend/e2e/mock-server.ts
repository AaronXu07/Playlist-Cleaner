/**
 * Lightweight mock API server for Playwright E2E tests.
 *
 * Launched by Playwright's globalSetup so that server-side (RSC) fetch calls
 * from Next.js reach a real HTTP endpoint — Playwright's page.route() only
 * intercepts browser-originated requests and cannot intercept SSR fetches.
 *
 * The server listens on port 3001. Set NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
 * in the webServer environment so all server-side API calls resolve here.
 *
 * State mutations (pollingEnabled, removals list) are held in module-level variables
 * so that start/stop calls update the state returned by /api/status.
 */

import http from 'http';
import { AddressInfo } from 'net';

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------
let pollingEnabled = false;

const mockRemovals = [
  {
    id: 'removal-1',
    user_id: 'u1',
    track_id: 'track-1',
    track_name: 'Test Song One',
    playlist_id: 'playlist-1',
    playlist_name: 'Road Trip',
    removed_at: new Date().toISOString(),
    reason: 'skipped',
  },
  {
    id: 'removal-2',
    user_id: 'u1',
    track_id: 'track-2',
    track_name: 'Test Song Two',
    playlist_id: 'playlist-1',
    playlist_name: 'Road Trip',
    removed_at: new Date().toISOString(),
    reason: 'skipped',
  },
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

export function createMockServer(): http.Server {
  const server = http.createServer((req, res) => {
    // Allow CORS for browser-side requests with credentials.
    // credentials:'include' requires an explicit origin (not '*') and
    // Access-Control-Allow-Credentials: true.
    const origin = req.headers.origin ?? 'http://localhost:3000';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Cookie');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // GET /auth/me — always return a test user
    if (url === '/auth/me' && method === 'GET') {
      return json(res, { userId: 'u1', spotifyId: 'testuser' });
    }

    // GET /api/status
    if (url === '/api/status' && method === 'GET') {
      return json(res, {
        registered: pollingEnabled,
        pollingEnabled,
        isRunning: pollingEnabled,
        isPollCycleRunning: false,
      });
    }

    // POST /api/polling/start
    if (url === '/api/polling/start' && method === 'POST') {
      pollingEnabled = true;
      return json(res, { polling: true });
    }

    // POST /api/polling/stop
    if (url === '/api/polling/stop' && method === 'POST') {
      pollingEnabled = false;
      return json(res, {});
    }

    // GET /api/removals
    if (url === '/api/removals' && method === 'GET') {
      return json(res, mockRemovals);
    }

    // DELETE /api/removals/:id
    const deleteMatch = url.match(/^\/api\/removals\/(.+)$/);
    if (deleteMatch && method === 'DELETE') {
      const id = decodeURIComponent(deleteMatch[1]);
      const idx = mockRemovals.findIndex((r) => r.id === id);
      if (idx !== -1) mockRemovals.splice(idx, 1);
      res.writeHead(204);
      res.end();
      return;
    }

    // POST /auth/logout
    if (url === '/auth/logout' && method === 'POST') {
      return json(res, {});
    }

    // 404 fallback
    res.writeHead(404);
    res.end('Not found');
  });

  return server;
}

/** Reset mutable state between tests (call from beforeEach if needed) */
export function resetMockServerState() {
  pollingEnabled = false;
}

// ---------------------------------------------------------------------------
// Standalone entry point (used by globalSetup)
// ---------------------------------------------------------------------------

let _server: http.Server | null = null;

export async function startMockServer(port = 3001): Promise<http.Server> {
  if (_server) return _server;
  _server = createMockServer();
  await new Promise<void>((resolve) => _server!.listen(port, resolve));
  const addr = _server.address() as AddressInfo;
  console.log(`[mock-server] Listening on http://localhost:${addr.port}`);
  return _server;
}

export async function stopMockServer(): Promise<void> {
  if (!_server) return;
  await new Promise<void>((resolve, reject) =>
    _server!.close((err) => (err ? reject(err) : resolve())),
  );
  _server = null;
}
