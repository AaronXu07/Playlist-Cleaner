// lib/api.ts
// Typed fetch wrappers for the Spotify Playlist Cleaner backend API.
// All requests include credentials:'include' to send the httpOnly session cookie.
// Base URL is read from NEXT_PUBLIC_API_BASE_URL at build/runtime.

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

// ---------------------------------------------------------------------------
// Response types — mirror the shapes returned by the Express backend
// ---------------------------------------------------------------------------

export interface MeResponse {
  userId: string;
  spotifyId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface StatusResponse {
  registered: boolean;
  pollingEnabled?: boolean;
  isRunning?: boolean;
  isPollCycleRunning?: boolean;
  consecutive204s?: number;
  reducedMode?: boolean;
  hasLiveTrack?: boolean;
}

export interface RemovalRecord {
  id: string;
  user_id: string;
  track_id: string;
  playlist_id: string;
  track_name: string;
  removed_at: string; // ISO 8601
  reason: string;
  /** Primary artist name, enriched from Spotify by GET /api/removals. */
  artist_name?: string | null;
  /** Album cover URL, enriched from Spotify by GET /api/removals. */
  album_art?: string | null;
}

// ---------------------------------------------------------------------------
// Internal helper — throws on non-2xx, propagates network errors as-is
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    credentials: 'include',
    ...init,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  // For void endpoints (204 No Content) return undefined cast to T
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status === 204 || !contentType.includes('application/json')) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

/**
 * GET /auth/me
 * Returns the currently authenticated user.
 * Times out after 10 seconds via AbortController.
 *
 * @param cookieHeader  Optional raw Cookie header value, used when calling
 *                      from a Next.js server component to forward the browser
 *                      session cookie (which is not sent automatically in
 *                      server-side fetches).
 */
export async function getMe(cookieHeader?: string): Promise<MeResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const extraHeaders: Record<string, string> = {};
    if (cookieHeader) {
      extraHeaders['Cookie'] = cookieHeader;
    }
    return await apiFetch<MeResponse>('/auth/me', {
      signal: controller.signal,
      headers: extraHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * POST /auth/logout
 * Signs the user out by clearing the session cookie server-side.
 * Times out after 10 seconds via AbortController.
 */
export async function postLogout(): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    await apiFetch<void>('/auth/logout', {
      method: 'POST',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/status
 * Returns the current cleaning engine state for the authenticated user.
 */
export async function getStatus(): Promise<StatusResponse> {
  return apiFetch<StatusResponse>('/api/status');
}

/**
 * GET /api/removals
 * Returns the list of tracks removed by the cleaning engine.
 */
export async function getRemovals(): Promise<RemovalRecord[]> {
  return apiFetch<RemovalRecord[]>('/api/removals');
}

/**
 * POST /api/polling/start
 * Starts the background cleaning engine for the authenticated user.
 */
export async function postPollingStart(): Promise<void> {
  return apiFetch<void>('/api/polling/start', { method: 'POST' });
}

/**
 * POST /api/polling/stop
 * Stops the background cleaning engine for the authenticated user.
 */
export async function postPollingStop(): Promise<void> {
  return apiFetch<void>('/api/polling/stop', { method: 'POST' });
}

/**
 * DELETE /api/removals/:id
 * Deletes a removal record and re-adds the track to its Spotify playlist.
 */
export async function deleteRemoval(id: string): Promise<void> {
  return apiFetch<void>(`/api/removals/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
