// Feature: core-polling-engine
// Property 4: Token refresh is triggered exactly when needed
// Property 16: Retry-After wait is capped at 60 seconds and applied up to 3 times

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before imports of the module under test)
// ---------------------------------------------------------------------------

// Mock axios so no real HTTP calls are made
vi.mock('axios')

// Mock crypto.js so we don't need a real ENCRYPTION_KEY in tests
vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn((v) => `enc:${v}`),
  decrypt: vi.fn((v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)),
}))

// Mock supabase.js so no real DB calls are made
vi.mock('../lib/supabase.js', () => {
  const eqMock = vi.fn().mockResolvedValue({ error: null })
  const updateMock = vi.fn(() => ({ eq: eqMock }))
  const fromMock = vi.fn(() => ({ update: updateMock }))
  const client = { from: fromMock }
  return { default: vi.fn(() => client) }
})

// Now import the module under test (after mocks are registered)
import axios from 'axios'
import {
  refreshTokenIfNeeded,
  getCurrentlyPlaying,
  getRecentlyPlayed,
  removeTrackFromPlaylist,
  addTrackToPlaylist,
  resetSpotifyRateLimitBackoffForTests,
} from '../lib/spotify.js'
import getSupabase from '../lib/supabase.js'

beforeEach(() => {
  resetSpotifyRateLimitBackoffForTests()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal user object whose token_expires_at is `offsetMs` ms from now.
 * Positive offsetMs → expires in the future; negative → already expired.
 */
function makeUser(offsetMs) {
  return {
    id: 'user-123',
    // encrypt mock just prepends "enc:", decrypt strips it
    access_token: 'enc:plaintext-access-token',
    refresh_token: 'enc:plaintext-refresh-token',
    token_expires_at: new Date(Date.now() + offsetMs).toISOString(),
  }
}

/**
 * Set up `axios.post` to return a successful token response.
 */
function mockSuccessfulTokenExchange() {
  axios.post = vi.fn().mockResolvedValue({
    data: {
      access_token: 'new-access-token',
      expires_in: 3600,
      // no new refresh_token — update access only path
    },
  })
}

// ---------------------------------------------------------------------------
// Property 4 — Token refresh threshold
// Validates: Requirements 2.2
// ---------------------------------------------------------------------------

describe('Property 4: Token refresh is triggered exactly when needed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the supabase mock chain for every test
    const eqMock = vi.fn().mockResolvedValue({ error: null })
    const updateMock = vi.fn(() => ({ eq: eqMock }))
    const fromMock = vi.fn(() => ({ update: updateMock }))
    getSupabase.mockReturnValue({ from: fromMock })
  })

  it('calls the token endpoint iff token expires within 60 s (or is already expired)', async () => {
    // Feature: core-polling-engine, Property 4: Token refresh is triggered exactly when needed
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -120_000, max: 120_000 }),
        async (offsetMs) => {
          // Reset mocks for this run
          axios.post = vi.fn().mockResolvedValue({
            data: { access_token: 'new-access-token', expires_in: 3600 },
          })

          const eqMock = vi.fn().mockResolvedValue({ error: null })
          const updateMock = vi.fn(() => ({ eq: eqMock }))
          const fromMock = vi.fn(() => ({ update: updateMock }))
          getSupabase.mockReturnValue({ from: fromMock })

          const user = makeUser(offsetMs)

          // refreshTokenIfNeeded should not throw for any valid offsetMs
          await refreshTokenIfNeeded(user)

          // The threshold: token_expires_at <= now + 60_000
          // i.e. offsetMs (= expires_at - now) <= 60_000
          const shouldRefresh = offsetMs <= 60_000

          if (shouldRefresh) {
            // Token exchange MUST have been called
            expect(axios.post).toHaveBeenCalledOnce()
            expect(axios.post).toHaveBeenCalledWith(
              'https://accounts.spotify.com/api/token',
              expect.any(URLSearchParams),
              expect.objectContaining({
                headers: expect.objectContaining({
                  'Content-Type': 'application/x-www-form-urlencoded',
                }),
              })
            )
          } else {
            // offsetMs > 60_000 — token is not near expiry, NO exchange
            expect(axios.post).not.toHaveBeenCalled()
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 16 — Retry-After capping
// Validates: Requirements 10.1, 10.2, 10.3, 10.4
// ---------------------------------------------------------------------------

describe('Property 16: Retry-After wait is capped at 60 s and applied up to 3 times', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits Math.min(retryAfter, 60) * 1000 ms before retrying after a 429', async () => {
    // Feature: core-polling-engine, Property 16: Retry-After wait is capped at 60 seconds and applied up to 3 times
    //
    // Note: the implementation uses `parseInt(header, 10) || 30`, which means a
    // header value of 0 is treated as the fallback default (30 s).  The spec says
    // "if no Retry-After header, wait 30 s"; a zero-value header is treated as
    // absent/invalid.  We therefore test with retryAfter >= 1 and model the same
    // fallback formula the code applies.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 120 }),
        async (retryAfter) => {
          vi.clearAllMocks()

          // Build a 429 error the way axios would throw it
          const make429 = (headerValue) => {
            const err = Object.assign(new Error('Request failed with status 429'), {
              response: {
                status: 429,
                headers: headerValue != null
                  ? { 'retry-after': String(headerValue) }
                  : {},
              },
            })
            return err
          }

          // First call → 429; second call → 200 success
          axios.get = vi.fn()
            .mockRejectedValueOnce(make429(retryAfter))
            .mockResolvedValueOnce({ status: 200, data: { items: [] } })

          // Spy on setTimeout to capture sleep durations
          const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

          // Start the async call but don't await yet — fake timers must fire
          const promise = getRecentlyPlayed('tok', 'user-1')

          // Advance timers so the sleep resolves
          await vi.runAllTimersAsync()

          // Now the promise should have resolved
          await promise

          // Check axios.get was called twice (first 429, then 200)
          expect(axios.get).toHaveBeenCalledTimes(2)

          // The expected sleep duration (in ms): same formula as the implementation
          // parseInt(retryAfter, 10) || 30  →  for retryAfter >= 1 this equals retryAfter
          const expectedMs = Math.min(retryAfter, 60) * 1_000

          // Find the setTimeout call that corresponds to the sleep
          // sleep(ms) → setTimeout(resolve, ms)
          const sleepCalls = setTimeoutSpy.mock.calls.filter(
            ([, delay]) => delay === expectedMs
          )
          expect(sleepCalls.length).toBeGreaterThanOrEqual(1)

          setTimeoutSpy.mockRestore()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('defaults to 30 000 ms sleep when Retry-After header is absent', async () => {
    // Feature: core-polling-engine, Property 16: Retry-After wait is capped at 60 seconds and applied up to 3 times

    // 429 with NO retry-after header
    const err = Object.assign(new Error('429'), {
      response: { status: 429, headers: {} },
    })

    axios.get = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ status: 200, data: { items: [] } })

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

    const promise = getRecentlyPlayed('tok', 'user-1')
    await vi.runAllTimersAsync()
    await promise

    const sleepCalls = setTimeoutSpy.mock.calls.filter(
      ([, delay]) => delay === 30_000
    )
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1)

    setTimeoutSpy.mockRestore()
  })

  it('logs Retry-After and retries playlist mutations after a 429', async () => {
    const err = Object.assign(new Error('429'), {
      response: { status: 429, headers: { 'retry-after': '7' } },
    })

    axios.post = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ status: 201, data: {} })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const promise = addTrackToPlaylist('tok', 'playlist-1', 'spotify:track:track-1')
    await vi.runAllTimersAsync()
    await promise

    expect(axios.post).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('POST https://api.spotify.com/v1/playlists/playlist-1/items')
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Retry-After=7'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sleeping 7s'))

    warnSpy.mockRestore()
  })

  it('throws after 3 consecutive 429s (retries exhausted)', async () => {
    // Feature: core-polling-engine, Property 16: Retry-After wait is capped at 60 seconds and applied up to 3 times
    const make429 = () =>
      Object.assign(new Error('429'), {
        response: { status: 429, headers: { 'retry-after': '1' } },
      })

    axios.get = vi.fn()
      .mockRejectedValue(make429()) // always 429

    // Wrap in a single awaited promise to avoid unhandled-rejection warnings:
    // we advance timers concurrently with the async operation via Promise.all.
    await expect(
      Promise.all([
        getCurrentlyPlaying('tok', 'user-1'),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow(/retries exhausted/i)

    expect(axios.get).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// Unit tests: refreshTokenIfNeeded — token refresh scenarios
// Validates: Requirements 2.3, 2.4, 2.5, 12.2
// ---------------------------------------------------------------------------

describe('Unit tests: refreshTokenIfNeeded', () => {
  // Within 60 s → refresh is triggered for all 4 tests
  const EXPIRY_OFFSET_MS = 0 // token expires right now → always needs refresh

  let fromMock, updateMock, eqMock

  beforeEach(() => {
    vi.clearAllMocks()

    // Rebuild the Supabase mock chain so we can inspect calls per-test
    eqMock = vi.fn().mockResolvedValue({ error: null })
    updateMock = vi.fn(() => ({ eq: eqMock }))
    fromMock = vi.fn(() => ({ update: updateMock }))
    getSupabase.mockReturnValue({ from: fromMock })
  })

  // -------------------------------------------------------------------------
  // Test 1 — new refresh_token in response → both tokens written to DB
  // Validates: Requirements 2.3
  // -------------------------------------------------------------------------
  it('updates both access_token and refresh_token in DB when response includes a new refresh_token', async () => {
    // Arrange
    axios.post = vi.fn().mockResolvedValue({
      data: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      },
    })

    const user = makeUser(EXPIRY_OFFSET_MS)

    // Act
    await refreshTokenIfNeeded(user)

    // Assert — update() must have been called with BOTH encrypted tokens
    expect(updateMock).toHaveBeenCalledOnce()
    const updatePayload = updateMock.mock.calls[0][0]

    // encrypt mock prefixes "enc:" so encrypted values are "enc:new-access" / "enc:new-refresh"
    expect(updatePayload).toMatchObject({
      access_token: 'enc:new-access',
      refresh_token: 'enc:new-refresh',
    })
    expect(updatePayload).toHaveProperty('token_expires_at')

    // eq() must target the correct user
    expect(eqMock).toHaveBeenCalledWith('id', user.id)
  })

  // -------------------------------------------------------------------------
  // Test 2 — no refresh_token in response → only access_token updated
  // Validates: Requirements 2.4
  // -------------------------------------------------------------------------
  it('updates only access_token in DB when response does not include a new refresh_token', async () => {
    // Arrange — response omits refresh_token
    axios.post = vi.fn().mockResolvedValue({
      data: {
        access_token: 'new-access',
        expires_in: 3600,
        // no refresh_token field
      },
    })

    const user = makeUser(EXPIRY_OFFSET_MS)

    // Act
    await refreshTokenIfNeeded(user)

    // Assert — update() must NOT include refresh_token in the payload
    expect(updateMock).toHaveBeenCalledOnce()
    const updatePayload = updateMock.mock.calls[0][0]

    expect(updatePayload).toHaveProperty('access_token', 'enc:new-access')
    expect(updatePayload).not.toHaveProperty('refresh_token')
  })

  // -------------------------------------------------------------------------
  // Test 3 — HTTP 500 from token endpoint → error re-thrown (not REVOKED)
  // Validates: Requirements 2.5, 12.2
  // -------------------------------------------------------------------------
  it('re-throws non-revocation errors (500) and does not mark them as REVOKED', async () => {
    // Arrange — simulate a 500 server error
    const serverError = Object.assign(new Error('500'), {
      response: { status: 500, data: {} },
    })
    axios.post = vi.fn().mockRejectedValue(serverError)

    const user = makeUser(EXPIRY_OFFSET_MS)

    // Act & Assert — the function must throw
    await expect(refreshTokenIfNeeded(user)).rejects.toThrow('500')

    // The thrown error must NOT carry code: 'REVOKED'
    let caughtError
    try {
      await refreshTokenIfNeeded(user)
    } catch (err) {
      caughtError = err
    }
    expect(caughtError).toBeDefined()
    expect(caughtError.code).not.toBe('REVOKED')

    // Supabase update must never have been called (no successful token exchange)
    expect(updateMock).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Test 4 — invalid_grant response → throws with { code: 'REVOKED' }
  // Validates: Requirements 12.2
  // -------------------------------------------------------------------------
  it('throws with err.code === "REVOKED" when Spotify returns invalid_grant', async () => {
    // Arrange — simulate the 400 invalid_grant response
    const invalidGrantError = Object.assign(new Error('invalid_grant'), {
      response: {
        status: 400,
        data: { error: 'invalid_grant' },
      },
    })
    axios.post = vi.fn().mockRejectedValue(invalidGrantError)

    const user = makeUser(EXPIRY_OFFSET_MS)

    // Act & Assert — must throw
    let caughtError
    try {
      await refreshTokenIfNeeded(user)
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeDefined()
    expect(caughtError.code).toBe('REVOKED')
  })
})

// ---------------------------------------------------------------------------
// Feature: playlist-403-blocklist-fix
// Task 1 — Bug condition exploration tests
// Property 1: Bug Condition — an editable-playlist 403 (generic, non
//             "insufficient client scope" message) must be classified as
//             MISSING_SCOPE, NOT FORBIDDEN_PLAYLIST.
//
// These tests MUST FAIL on the UNFIXED code: removeTrackFromPlaylist currently
// maps any 403 whose message does not match /insufficient client scope/i to
// FORBIDDEN_PLAYLIST, regardless of whether the authenticated user can actually
// edit the playlist. The failure confirms the bug.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4 (encodes expected behavior 2.1)
// ---------------------------------------------------------------------------

describe('Bug condition (Property 1): editable-playlist 403 is MISSING_SCOPE, not FORBIDDEN_PLAYLIST', () => {
  // Feature: playlist-403-blocklist-fix, Property 1: Bug Condition

  const authUserId = 'auth-user-spotify-id'
  const playlistId = '44mvOQyxuqicfjBpwIQYcb'
  const trackUri = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Arbitrary 403 body messages that are NOT the special-cased
  // "insufficient client scope" string (varied, but always non-matching).
  const nonScopeMessage = fc
    .oneof(
      fc.constant('Forbidden'),
      fc.constant('You cannot modify this playlist'),
      fc.constant('Insufficient permissions'),
      fc.constant(''),
      fc.string()
    )
    .filter((m) => !/insufficient client scope/i.test(m))

  /** Build the axios mocks for a generic-403 DELETE plus an editability probe. */
  function mockGeneric403(message, ownerId, collaborative) {
    const err403 = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { error: { status: 403, message } } },
    })
    // DELETE /playlists/{id}/tracks → 403 "Forbidden" (generic, missing-scope body)
    axios.delete = vi.fn().mockRejectedValue(err403)
    // GET /playlists/{id}?fields=owner(id),collaborative → editability probe.
    // (The UNFIXED code never issues this lookup; the FIXED code relies on it.)
    axios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { owner: { id: ownerId }, collaborative },
    })
  }

  it('owned playlist (owner.id === authUserId) + generic 403 → MISSING_SCOPE', async () => {
    // Feature: playlist-403-blocklist-fix, Property 1: Bug Condition
    await fc.assert(
      fc.asyncProperty(nonScopeMessage, async (message) => {
        vi.clearAllMocks()
        mockGeneric403(message, authUserId, false)

        let caught
        try {
          await removeTrackFromPlaylist('access-token', playlistId, trackUri, authUserId)
        } catch (err) {
          caught = err
        }

        // An editable (user-owned) playlist returning a generic 403 means the
        // token lacks playlist-modify scope → MISSING_SCOPE, not blocklist.
        expect(caught).toBeDefined()
        expect(caught.code).toBe('MISSING_SCOPE')
      }),
      { numRuns: 50 }
    )
  })

  it('collaborative playlist (different owner, collaborative === true) + generic 403 → MISSING_SCOPE', async () => {
    // Feature: playlist-403-blocklist-fix, Property 1: Bug Condition
    await fc.assert(
      fc.asyncProperty(nonScopeMessage, async (message) => {
        vi.clearAllMocks()
        mockGeneric403(message, 'some-other-user', true)

        let caught
        try {
          await removeTrackFromPlaylist('access-token', playlistId, trackUri, authUserId)
        } catch (err) {
          caught = err
        }

        // A collaborative playlist is editable regardless of owner → MISSING_SCOPE.
        expect(caught).toBeDefined()
        expect(caught.code).toBe('MISSING_SCOPE')
      }),
      { numRuns: 50 }
    )
  })
})

// ---------------------------------------------------------------------------
// Feature: playlist-403-blocklist-fix
// Task 2 — Preservation property tests (spotify layer)
// Property 2: Preservation — non-bug 403 classifications are unchanged.
//
// These tests MUST PASS on the UNFIXED code (they encode the baseline behavior
// to preserve) AND must continue to pass on the FIXED code:
//   - Req 3.1: a 403 whose body message matches /insufficient client scope/i
//              is classified MISSING_SCOPE. Both code paths short-circuit on
//              the scope message before any editability probe, so the
//              classification is identical.
//   - Req 3.4: a 403 on a genuinely non-editable playlist (owner.id !==
//              authUserId AND collaborative === false) is classified
//              FORBIDDEN_PLAYLIST. The UNFIXED code reaches this because the
//              message is not the scope string; the FIXED code reaches it
//              because the editability probe (mocked here as non-editable)
//              confirms the playlist is read-only.
//
// Validates: Requirements 3.1, 3.4
// ---------------------------------------------------------------------------

describe('Preservation (Property 2): non-bug 403 classifications are unchanged (spotify layer)', () => {
  // Feature: playlist-403-blocklist-fix, Property 2: Preservation

  const authUserId = 'auth-user-spotify-id'
  const playlistId = 'pl-preserve'
  const trackUri = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Arbitrary 403 body messages that DO match /insufficient client scope/i.
  // We embed the phrase (with varied casing) inside arbitrary surrounding text
  // so the property covers the whole matching sub-domain, not a single string.
  const scopeMessage = fc
    .tuple(
      fc.string(),
      fc.constantFrom(
        'insufficient client scope',
        'Insufficient client scope',
        'Insufficient Client Scope',
        'INSUFFICIENT CLIENT SCOPE'
      ),
      fc.string()
    )
    .map(([pre, phrase, post]) => `${pre}${phrase}${post}`)
    .filter((m) => /insufficient client scope/i.test(m))

  // Arbitrary 403 body messages that do NOT match the scope regex.
  const nonScopeMessage = fc
    .oneof(
      fc.constant('Forbidden'),
      fc.constant('You cannot modify this playlist'),
      fc.constant('Insufficient permissions'),
      fc.constant(''),
      fc.string()
    )
    .filter((m) => !/insufficient client scope/i.test(m))

  function mock403(message, ownerId, collaborative) {
    const err403 = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { error: { status: 403, message } } },
    })
    axios.delete = vi.fn().mockRejectedValue(err403)
    // Editability probe used only by the FIXED code; the UNFIXED code never
    // issues it. Returning a 200 here keeps both worlds happy.
    axios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { owner: { id: ownerId }, collaborative },
    })
  }

  it('Req 3.1: 403 matching /insufficient client scope/i → MISSING_SCOPE (unchanged)', async () => {
    // Feature: playlist-403-blocklist-fix, Property 2: Preservation
    await fc.assert(
      fc.asyncProperty(scopeMessage, fc.boolean(), async (message, collaborative) => {
        vi.clearAllMocks()
        // Owner is irrelevant: the scope message short-circuits before any probe.
        mock403(message, authUserId, collaborative)

        let caught
        try {
          await removeTrackFromPlaylist('access-token', playlistId, trackUri, authUserId)
        } catch (err) {
          caught = err
        }

        expect(caught).toBeDefined()
        expect(caught.code).toBe('MISSING_SCOPE')
      }),
      { numRuns: 50 }
    )
  })

  it('Req 3.4: generic 403 on a non-editable playlist (owner !== authUserId, collaborative false) → FORBIDDEN_PLAYLIST (unchanged)', async () => {
    // Feature: playlist-403-blocklist-fix, Property 2: Preservation
    const otherOwnerId = fc.string().filter((id) => id !== authUserId)

    await fc.assert(
      fc.asyncProperty(nonScopeMessage, otherOwnerId, async (message, ownerId) => {
        vi.clearAllMocks()
        // Non-editable: a different owner AND not collaborative.
        mock403(message, ownerId, false)

        let caught
        try {
          await removeTrackFromPlaylist('access-token', playlistId, trackUri, authUserId)
        } catch (err) {
          caught = err
        }

        expect(caught).toBeDefined()
        expect(caught.code).toBe('FORBIDDEN_PLAYLIST')
      }),
      { numRuns: 50 }
    )
  })
})

// ---------------------------------------------------------------------------
// Feature: playlist-403-blocklist-fix
// Task 5 — Unit tests for the fix: removeTrackFromPlaylist 403 classification
//
// Concrete, deterministic example-based tests (distinct from the property
// tests above). Each test drives a single input through the FIXED
// removeTrackFromPlaylist and asserts the exact err.code produced.
//
// Validates: Requirements 2.1, 3.1
// ---------------------------------------------------------------------------

describe('Unit tests: removeTrackFromPlaylist 403 classification', () => {
  // Feature: playlist-403-blocklist-fix

  const accessToken = 'access-token'
  const authUserId = 'auth-user-spotify-id'
  const playlistId = '44mvOQyxuqicfjBpwIQYcb'
  const trackUri = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** DELETE → 403 with the given body message. */
  function mockDelete403(message) {
    const err403 = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { error: { status: 403, message } } },
    })
    axios.delete = vi.fn().mockRejectedValue(err403)
  }

  /** Editability probe (GET /playlists/{id}) → 200 with owner/collaborative. */
  function mockProbe(ownerId, collaborative) {
    axios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { owner: { id: ownerId }, collaborative },
    })
  }

  it('403 generic "Forbidden" on an owned playlist → MISSING_SCOPE', async () => {
    // Feature: playlist-403-blocklist-fix
    mockDelete403('Forbidden')
    mockProbe(authUserId, false) // owner.id === authUserId → editable

    let caught
    try {
      await removeTrackFromPlaylist(accessToken, playlistId, trackUri, authUserId)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    expect(caught.code).toBe('MISSING_SCOPE')
    // The generic 403 path probes editability.
    expect(axios.get).toHaveBeenCalledOnce()
  })

  it('403 generic "Forbidden" on a collaborative playlist (different owner) → MISSING_SCOPE', async () => {
    // Feature: playlist-403-blocklist-fix
    mockDelete403('Forbidden')
    mockProbe('some-other-user', true) // collaborative → editable

    let caught
    try {
      await removeTrackFromPlaylist(accessToken, playlistId, trackUri, authUserId)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    expect(caught.code).toBe('MISSING_SCOPE')
    expect(axios.get).toHaveBeenCalledOnce()
  })

  it('403 generic "Forbidden" on a non-editable playlist → FORBIDDEN_PLAYLIST', async () => {
    // Feature: playlist-403-blocklist-fix
    mockDelete403('Forbidden')
    mockProbe('some-other-user', false) // different owner AND not collaborative → read-only

    let caught
    try {
      await removeTrackFromPlaylist(accessToken, playlistId, trackUri, authUserId)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    expect(caught.code).toBe('FORBIDDEN_PLAYLIST')
    expect(axios.get).toHaveBeenCalledOnce()
  })

  it('403 "Insufficient client scope" → MISSING_SCOPE without issuing the editability probe', async () => {
    // Feature: playlist-403-blocklist-fix (Req 3.1 — preserved short-circuit)
    mockDelete403('Insufficient client scope')
    // Probe would resolve, but the scope-message short-circuit must run first.
    axios.get = vi.fn().mockResolvedValue({
      status: 200,
      data: { owner: { id: 'some-other-user' }, collaborative: false },
    })

    let caught
    try {
      await removeTrackFromPlaylist(accessToken, playlistId, trackUri, authUserId)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    expect(caught.code).toBe('MISSING_SCOPE')
    // No editability probe is issued for the explicit scope message.
    expect(axios.get).not.toHaveBeenCalled()
  })

  it('editability probe failure → fail-safe MISSING_SCOPE', async () => {
    // Feature: playlist-403-blocklist-fix
    mockDelete403('Forbidden')
    // The probe itself fails (network/404) — fail safe to the non-destructive
    // MISSING_SCOPE classification.
    axios.get = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), {
        response: { status: 404 },
      })
    )

    let caught
    try {
      await removeTrackFromPlaylist(accessToken, playlistId, trackUri, authUserId)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    expect(caught.code).toBe('MISSING_SCOPE')
  })
})
