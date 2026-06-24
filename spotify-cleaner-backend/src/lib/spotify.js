import axios from 'axios'
import { encrypt, decrypt } from './crypto.js'
import getSupabase from './supabase.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MAX_RATE_LIMIT_ATTEMPTS = 3
const DEFAULT_RETRY_AFTER_SECONDS = 30
const MAX_RETRY_AFTER_SECONDS = 60

let sharedSpotifyBackoffUntil = 0

export function resetSpotifyRateLimitBackoffForTests() {
  sharedSpotifyBackoffUntil = 0
}

function parseRetryAfterSeconds(rawValue) {
  const parsed = parseInt(rawValue ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETRY_AFTER_SECONDS
  return Math.min(parsed, MAX_RETRY_AFTER_SECONDS)
}

async function waitForSharedSpotifyBackoff(method, url) {
  const waitMs = sharedSpotifyBackoffUntil - Date.now()
  if (waitMs <= 0) return

  console.warn(
    `[spotify] shared rate-limit backoff active for ${method.toUpperCase()} ${url}; waiting ${Math.ceil(waitMs / 1000)}s`
  )
  await sleep(waitMs)
}

/**
 * Execute a Spotify Web API request with up to 3 attempts on HTTP 429.
 * Any 429 extends a module-wide backoff so concurrent Spotify requests pause
 * behind the same Retry-After window instead of continuing to pile on.
 *
 * @param {'get'|'post'|'delete'} method
 * @param {string} url
 * @param {Array} axiosArgs
 * @returns {import('axios').AxiosResponse}
 */
async function requestWithRateLimitRetry(method, url, axiosArgs) {
  let attempt = 0

  while (attempt < MAX_RATE_LIMIT_ATTEMPTS) {
    try {
      await waitForSharedSpotifyBackoff(method, url)
      return await axios[method](url, ...axiosArgs)
    } catch (err) {
      // Axios throws on non-2xx when validateStatus says false, and also on
      // network/timeout errors.  We only handle 429 here; everything else
      // propagates immediately.
      const status = err?.response?.status

      if (status === 429) {
        const headers = err.response.headers ?? {}
        const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After']
        const retryAfter = parseRetryAfterSeconds(retryAfterRaw)
        sharedSpotifyBackoffUntil = Math.max(
          sharedSpotifyBackoffUntil,
          Date.now() + retryAfter * 1000
        )
        console.warn(
          `[spotify] 429 rate-limited on ${method.toUpperCase()} ${url}; Retry-After=${retryAfterRaw ?? 'missing'}; sleeping ${retryAfter}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_ATTEMPTS})`
        )
        await sleep(retryAfter * 1000)
        attempt++
        continue
      }

      // Not a 429 — rethrow immediately
      throw err
    }
  }

  throw new Error(`[spotify] Rate-limit retries exhausted for ${method.toUpperCase()} ${url}`)
}

/**
 * Execute a GET request against a Spotify endpoint with up to 3 attempts on
 * HTTP 429 (rate limit). Axios throws on non-2xx, so 429 arrives as an error
 * with err.response.status === 429.
 *
 * @param {string} url
 * @param {object} headers  - { Authorization: 'Bearer <token>' }
 * @returns {import('axios').AxiosResponse}
 */
async function getWithRateLimitRetry(url, headers) {
  return requestWithRateLimitRetry('get', url, [{
    headers,
    timeout: 10_000,
    // Tell axios not to throw on 204 so we can inspect the status ourselves.
    // We still want it to throw on genuine errors (4xx other than 429, 5xx).
    validateStatus: (status) => status === 200 || status === 204,
  }])
}

// ---------------------------------------------------------------------------
// 3.1  refreshTokenIfNeeded(user)
// ---------------------------------------------------------------------------

/**
 * Check whether the user's access token is within 60 s of expiry (or already
 * expired).  If so, exchange the refresh token for a new access token via the
 * Spotify token endpoint, encrypt and persist both tokens, and return the new
 * plaintext access token.  If no refresh is needed, decrypt and return the
 * existing access token.
 *
 * Throws with { code: 'REVOKED' } on invalid_grant (permissions revoked).
 * Re-throws any other error as-is.
 *
 * @param {{ id: string, access_token: string, refresh_token: string, token_expires_at: string, spotify_client_id?: string | null }} user
 * @returns {Promise<{ accessToken: string }>}
 */
export async function refreshTokenIfNeeded(user) {
  const accessToken = decrypt(user.access_token)
  const refreshToken = decrypt(user.refresh_token)

  const expiresAt = new Date(user.token_expires_at).getTime()
  const needsRefresh = expiresAt <= Date.now() + 60_000

  if (!needsRefresh) {
    return { accessToken }
  }

  // Build form-encoded body for the token endpoint
  const params = new URLSearchParams()
  params.append('grant_type', 'refresh_token')
  params.append('refresh_token', refreshToken)

  const tokenHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  if (user.spotify_client_id) {
    params.append('client_id', user.spotify_client_id)
  } else {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      const reauthError = new Error('Spotify Client ID required for token refresh')
      reauthError.code = 'REAUTH_REQUIRED'
      throw reauthError
    }

    tokenHeaders.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  }

  let tokenResponse
  try {
    tokenResponse = await axios.post(
      'https://accounts.spotify.com/api/token',
      params,
      {
        headers: tokenHeaders,
        timeout: 10_000,
      }
    )
  } catch (err) {
    const status = err?.response?.status
    const errorCode = err?.response?.data?.error

    if ((status === 400 || status === 401) && errorCode === 'invalid_grant') {
      const revokedError = new Error('Spotify permissions revoked (invalid_grant)')
      revokedError.code = 'REVOKED'
      throw revokedError
    }

    throw err
  }

  const {
    access_token: newAccessTokenPlain,
    refresh_token: newRefreshTokenPlain,
    expires_in,
  } = tokenResponse.data

  const newEncryptedAccessToken = encrypt(newAccessTokenPlain)
  const newTokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString()

  const supabase = getSupabase()

  if (newRefreshTokenPlain) {
    // Response includes a new refresh token — update both
    const newEncryptedRefreshToken = encrypt(newRefreshTokenPlain)
    await supabase
      .from('users')
      .update({
        access_token: newEncryptedAccessToken,
        refresh_token: newEncryptedRefreshToken,
        token_expires_at: newTokenExpiresAt,
      })
      .eq('id', user.id)
  } else {
    // No new refresh token — update access token only
    await supabase
      .from('users')
      .update({
        access_token: newEncryptedAccessToken,
        token_expires_at: newTokenExpiresAt,
      })
      .eq('id', user.id)
  }

  return { accessToken: newAccessTokenPlain }
}

// ---------------------------------------------------------------------------
// 3.2  getCurrentlyPlaying(accessToken, userId)
// ---------------------------------------------------------------------------

/**
 * GET /me/player/currently-playing
 *
 * Returns the parsed response body on 200, null on 204 (nothing playing).
 * Applies the 429 retry loop (up to 3 attempts) internally.
 * Throws on any other non-success status or when retries are exhausted.
 *
 * @param {string} accessToken  - plaintext Spotify access token
 * @param {string} userId       - used for logging only
 * @returns {Promise<object|null>}
 */
export async function getCurrentlyPlaying(accessToken, userId) {
  const url = 'https://api.spotify.com/v1/me/player/currently-playing'
  const headers = { Authorization: `Bearer ${accessToken}` }

  let response
  try {
    response = await getWithRateLimitRetry(url, headers)
  } catch (err) {
    console.error(
      `[spotify] getCurrentlyPlaying error for user ${userId}:`,
      err.message
    )
    throw err
  }

  if (response.status === 204) {
    return null
  }

  return response.data
}

// ---------------------------------------------------------------------------
// 3.3  getRecentlyPlayed(accessToken, userId)
// ---------------------------------------------------------------------------

/**
 * GET /me/player/recently-played?limit=50
 *
 * Returns the items array on success.
 * Applies the 429 retry loop (up to 3 attempts) internally.
 * Throws on error.
 *
 * @param {string} accessToken  - plaintext Spotify access token
 * @param {string} userId       - used for logging only
 * @returns {Promise<Array>}
 */
export async function getRecentlyPlayed(accessToken, userId) {
  const url = 'https://api.spotify.com/v1/me/player/recently-played?limit=50'
  const headers = { Authorization: `Bearer ${accessToken}` }

  let response
  try {
    response = await getWithRateLimitRetry(url, headers)
  } catch (err) {
    console.error(
      `[spotify] getRecentlyPlayed error for user ${userId}:`,
      err.message
    )
    throw err
  }

  return response.data.items
}

// ---------------------------------------------------------------------------
// getTracksDetails(accessToken, trackIds)
// ---------------------------------------------------------------------------

/**
 * GET /v1/tracks/{id}  (one request per track, run in parallel with capped concurrency)
 *
 * Resolves Spotify track IDs to display metadata: track name, primary artist
 * name, and a small album-art URL. Used to enrich removal_log rows (which only
 * store the track ID) for the dashboard "Removed Songs" list.
 *
 * Note: The batch endpoint GET /v1/tracks?ids=... was removed in the Spotify
 * February 2026 Dev Mode update. Individual requests are now required.
 *
 * Returns a Map<trackId, { name, artist, albumArt }>. Never throws — on error
 * it logs and returns whatever has been resolved so far.
 *
 * @param {string} accessToken  - plaintext Spotify access token
 * @param {string[]} trackIds   - Spotify track IDs (no "spotify:track:" prefix)
 * @returns {Promise<Map<string, { name: string, artist: string, albumArt: string|null }>>}
 */
export async function getTracksDetails(accessToken, trackIds) {
  const result = new Map()

  // Deduplicate and drop falsy IDs.
  const uniqueIds = [...new Set(trackIds.filter(Boolean))]
  if (uniqueIds.length === 0) return result

  const headers = { Authorization: `Bearer ${accessToken}` }

  // Fetch tracks in parallel, capped at 5 concurrent requests to avoid
  // hammering the rate limit (removal_log is capped at 50 rows anyway).
  const CONCURRENCY = 5

  for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
    const chunk = uniqueIds.slice(i, i + CONCURRENCY)

    await Promise.all(
      chunk.map(async (trackId) => {
        // market=from_token resolves the track in the user's own market.
        const url = `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}?market=from_token`
        try {
          const response = await getWithRateLimitRetry(url, headers)
          const track = response?.data
          if (!track || !track.id) return

          const albumImages = track.album?.images ?? []
          // Prefer the smallest image (images are ordered largest-first).
          const albumArt = albumImages.length > 0
            ? albumImages[albumImages.length - 1].url
            : null
          const artist = (track.artists ?? []).map((a) => a.name).join(', ')

          result.set(track.id, {
            name: track.name ?? track.id,
            artist,
            albumArt,
          })
        } catch (err) {
          const status = err?.response?.status
          console.error(
            `[spotify] getTracksDetails error for track ${trackId}: HTTP ${status ?? 'unknown'} — ${err.message}`
          )
          // Continue — other tracks in the chunk are unaffected.
        }
      })
    )
  }

  return result
}

// ---------------------------------------------------------------------------
// getPlaylistDetails(accessToken, playlistId)
// ---------------------------------------------------------------------------

/**
 * GET /v1/playlists/{id}?fields=name
 *
 * Resolves a Spotify playlist ID to display metadata for removal_log rows.
 * Never throws — playlist names are useful UI metadata, but a lookup failure
 * should not prevent recording a successful removal.
 *
 * @param {string} accessToken  - plaintext Spotify access token
 * @param {string} playlistId   - Spotify playlist ID
 * @returns {Promise<{ name: string|null }|null>}
 */
export async function getPlaylistDetails(accessToken, playlistId) {
  if (!playlistId) return null

  const headers = { Authorization: `Bearer ${accessToken}` }
  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=name`

  try {
    const response = await getWithRateLimitRetry(url, headers)
    const name = response?.data?.name
    return { name: typeof name === 'string' && name.trim() ? name : null }
  } catch (err) {
    const status = err?.response?.status
    console.error(
      `[spotify] getPlaylistDetails error for playlist ${playlistId}: HTTP ${status ?? 'unknown'} — ${err.message}`
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// 3.4  removeTrackFromPlaylist(accessToken, playlistId, trackUri)
// ---------------------------------------------------------------------------

/**
 * DELETE /playlists/{playlistId}/tracks
 *
 * Removes a single track URI from a Spotify playlist.
 * Returns true on 200/201.
 *
 * 403 handling disambiguates two distinct Spotify failure modes:
 *   1. Missing playlist-modify scope on the token — throw { code: 'MISSING_SCOPE' }.
 *      Spotify signals this either with an "insufficient client scope" body
 *      message, OR (for tokens minted before the scopes existed) with a generic
 *      "Forbidden" body. The generic case is disambiguated by probing whether the
 *      authenticated user can actually edit the playlist: if they can, a 403 must
 *      mean the token lacks scope.
 *   2. A genuinely read-only / Spotify-owned / not-editable playlist — throw
 *      { code: 'FORBIDDEN_PLAYLIST' }.
 * Throws on all other non-success codes.
 *
 * @param {string} accessToken
 * @param {string} playlistId
 * @param {string} trackUri   e.g. "spotify:track:4uLU6hMCjMI75M1A2tKUQC"
 * @param {string} [authUserId]  authenticated user's Spotify ID, used to decide
 *                               playlist editability for generic 403s. Optional:
 *                               when absent, a generic 403 fails safe to
 *                               MISSING_SCOPE.
 * @returns {Promise<true>}
 */
export async function removeTrackFromPlaylist(accessToken, playlistId, trackUri, authUserId) {
  // Spotify February 2026 breaking change: endpoint renamed from /tracks to /items,
  // and the request body field renamed from "tracks" to "items".
  const url = `https://api.spotify.com/v1/playlists/${playlistId}/items`

  try {
    await requestWithRateLimitRetry('delete', url, [{
      data: { items: [{ uri: trackUri }] },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    }])
  } catch (err) {
    const status = err?.response?.status

    if (status === 403) {
      const message = err?.response?.data?.error?.message ?? ''

      // Case A — explicit scope message. Preserve the existing short-circuit
      // exactly: classify MISSING_SCOPE with NO playlist lookup.
      if (/insufficient client scope/i.test(message)) {
        const scopeError = new Error(
          `Spotify returned 403 for playlist ${playlistId} — missing playlist-modify scope (user needs to re-authenticate)`
        )
        scopeError.code = 'MISSING_SCOPE'
        throw scopeError
      }

      // Case B — generic 403 ("Forbidden" or any non-scope message). Probe the
      // playlist's write capability to disambiguate missing-scope (editable
      // playlist) from a genuinely read-only playlist.
      const isEditable = await isPlaylistEditable(accessToken, playlistId, authUserId)

      if (isEditable) {
        const scopeError = new Error(
          `Spotify returned 403 for editable playlist ${playlistId} — missing playlist-modify scope (user needs to re-authenticate)`
        )
        scopeError.code = 'MISSING_SCOPE'
        throw scopeError
      }

      const forbiddenError = new Error(
        `Spotify returned 403 for playlist ${playlistId} — likely a Spotify-owned / read-only playlist`
      )
      forbiddenError.code = 'FORBIDDEN_PLAYLIST'
      throw forbiddenError
    }

    throw err
  }

  return true
}

/**
 * Write-capability probe for a playlist. Issues
 * GET /playlists/{playlistId}?fields=owner(id),collaborative via the existing
 * rate-limit-aware GET helper and returns whether the authenticated user can
 * edit the playlist (they own it OR it is collaborative).
 *
 * Fails safe: if the probe cannot determine editability (no authUserId, network
 * error, 404, or unexpected shape), returns true so the caller defaults to the
 * non-destructive MISSING_SCOPE classification. The failure is logged for
 * observability.
 *
 * @param {string} accessToken
 * @param {string} playlistId
 * @param {string} [authUserId]
 * @returns {Promise<boolean>}
 */
async function isPlaylistEditable(accessToken, playlistId, authUserId) {
  if (!authUserId) {
    console.warn(
      `[spotify] editability probe skipped for playlist ${playlistId} — no authUserId available; defaulting to MISSING_SCOPE`
    )
    return true
  }

  try {
    const probeUrl = `https://api.spotify.com/v1/playlists/${playlistId}?fields=owner(id),collaborative`
    const headers = { Authorization: `Bearer ${accessToken}` }
    const response = await getWithRateLimitRetry(probeUrl, headers)

    const ownerId = response?.data?.owner?.id
    const collaborative = response?.data?.collaborative === true

    return ownerId === authUserId || collaborative
  } catch (err) {
    console.warn(
      `[spotify] editability probe failed for playlist ${playlistId}: ${err?.message} — defaulting to MISSING_SCOPE`
    )
    return true
  }
}

// ---------------------------------------------------------------------------
// addTrackToPlaylist(accessToken, playlistId, trackUri)   (needed by task 8.2)
// ---------------------------------------------------------------------------

/**
 * POST /playlists/{playlistId}/tracks
 *
 * Adds a single track URI to a Spotify playlist.
 * Returns true on 200/201.
 * Throws on error.
 *
 * @param {string} accessToken
 * @param {string} playlistId
 * @param {string} trackUri   e.g. "spotify:track:4uLU6hMCjMI75M1A2tKUQC"
 * @returns {Promise<true>}
 */
export async function addTrackToPlaylist(accessToken, playlistId, trackUri) {
  // Spotify February 2026 breaking change: the playlist tracks endpoint was
  // renamed from /tracks to /items (mirrors removeTrackFromPlaylist above).
  // The add body still uses the "uris" field.
  const url = `https://api.spotify.com/v1/playlists/${playlistId}/items`

  await requestWithRateLimitRetry(
    'post',
    url,
    [
      { uris: [trackUri] },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    ]
  )

  return true
}
