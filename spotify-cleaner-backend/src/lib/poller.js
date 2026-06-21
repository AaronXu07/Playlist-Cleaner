import getSupabase from './supabase.js'
import {
  refreshTokenIfNeeded,
  getCurrentlyPlaying,
  getRecentlyPlayed,
  getPlaylistDetails,
  removeTrackFromPlaylist,
} from './spotify.js'

// ---------------------------------------------------------------------------
// Task 5.1 — In-memory state
// ---------------------------------------------------------------------------

/**
 * Map<userId, {
 *   intervalId:      ReturnType<setInterval> | null,
 *   isRunning:       boolean,
 *   consecutive204s: number,
 *   reducedMode:     boolean,
 *   liveTrack:       {
 *     trackId:       string,
 *     durationMs:    number,
 *     maxProgressMs: number,
 *     playlistId:    string,
 *     pausedSince:   number | null,
 *   } | null,
 * }>
 */
export const userState = new Map()

/**
 * TTL for blocklist entries. A genuinely forbidden (Spotify-owned / read-only)
 * playlist is skipped only while its entry is active; once it expires the
 * playlist becomes eligible for retry. Default: 6 hours.
 */
export const BLOCKLIST_TTL_MS = 6 * 60 * 60 * 1000

/**
 * In-memory blocklist of playlists that returned a genuine 403
 * FORBIDDEN_PLAYLIST. Keyed by playlistId, the value is the epoch-ms timestamp
 * at which the entry expires (lazy eviction via {@link isPlaylistBlocked}).
 *
 * Tracks in an *active* blocklisted playlist are not re-attempted for removal.
 *
 * @type {Map<string, number>}
 */
export const forbiddenPlaylists = new Map()

/**
 * Durable re-auth signal store. Holds the Supabase user IDs of users whose
 * stored token lacks playlist-modify scope (a MISSING_SCOPE 403). An API/UI
 * layer can read this to prompt the user to re-authenticate. Cleared when the
 * user successfully re-authenticates (see {@link registerUser}).
 *
 * @type {Set<string>}
 */
export const usersNeedingReauth = new Set()

const POLL_INTERVAL_MS = 15_000
const RECENTLY_PLAYED_CYCLE_INTERVAL = 4

/**
 * Return true only if `playlistId` has an active (non-expired) blocklist entry.
 * If the entry exists but has expired, it is deleted (lazy eviction) and false
 * is returned, making the playlist eligible for retry again.
 *
 * @param {string} playlistId
 * @returns {boolean}
 */
export function isPlaylistBlocked(playlistId) {
  const expiresAt = forbiddenPlaylists.get(playlistId)
  if (expiresAt === undefined) return false
  if (Date.now() < expiresAt) return true
  // Expired — evict so the playlist can be retried.
  forbiddenPlaylists.delete(playlistId)
  return false
}

/**
 * Add (or refresh) a TTL-bearing blocklist entry for `playlistId`.
 * Sets expiry to now + {@link BLOCKLIST_TTL_MS}.
 *
 * @param {string} playlistId
 */
export function blockPlaylist(playlistId) {
  forbiddenPlaylists.set(playlistId, Date.now() + BLOCKLIST_TTL_MS)
}

/**
 * Tiny async sleep helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Extract the small display metadata we already receive from player/recently
 * played payloads. This lets the removal log render without calling Spotify
 * again from GET /api/removals.
 *
 * @param {object|null|undefined} track
 * @returns {{ name: string|null, artist: string|null, albumArt: string|null }}
 */
function extractTrackMetadata(track) {
  if (!track) {
    return { name: null, artist: null, albumArt: null }
  }

  const albumImages = track.album?.images ?? []
  const albumArt = albumImages.length > 0
    ? albumImages[albumImages.length - 1].url
    : null
  const artist = (track.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || null

  return {
    name: track.name ?? null,
    artist,
    albumArt,
  }
}

// ---------------------------------------------------------------------------
// Task 5.4–5.6 helpers
// ---------------------------------------------------------------------------

/**
 * Close an open liveTrack: compute listened_pct, assign source, clear state.
 * Returns a listen event object, or null if liveTrack is null or durationMs <= 0.
 *
 * @param {{ liveTrack: object|null }} state
 * @param {string} userId
 * @returns {object|null}
 */
function closeLiveTrack(state, userId) {
  const lt = state.liveTrack
  if (!lt || lt.durationMs <= 0) {
    state.liveTrack = null
    return null
  }
  const listenedPct = Math.min(lt.maxProgressMs / lt.durationMs, 1.0)
  const source = listenedPct < 0.50 ? 'delta' : 'live'
  state.liveTrack = null
  return {
    userId,
    trackId: lt.trackId,
    playlistId: lt.playlistId,
    listenedPct,
    listenedAt: new Date().toISOString(),
    source,
    trackMetadata: lt.trackMetadata ?? { name: null, artist: null, albumArt: null },
  }
}

// ---------------------------------------------------------------------------
// Task 5.5 — processLiveTrack
// ---------------------------------------------------------------------------

/**
 * Process the currently-playing result against the per-user live track state.
 *
 * Returns an array of emitted listen event objects (may be empty).
 *
 * @param {string} userId
 * @param {object|null} cpResult   - null on 204; response body on 200
 * @param {object} state           - the UserPollState entry from userState
 * @returns {object[]}
 */
export function processLiveTrack(userId, cpResult, state) {
  const events = []

  // ── 204 No Content: nothing is playing ──────────────────────────────────
  if (cpResult === null) {
    const ev = closeLiveTrack(state, userId)
    if (ev) events.push(ev)

    state.consecutive204s += 1
    if (state.consecutive204s >= 5) {
      state.reducedMode = true
    }
    return events
  }

  // ── 200: something is playing ────────────────────────────────────────────
  const contextUri = cpResult?.context?.uri ?? null
  const isPlaylistContext =
    typeof contextUri === 'string' && contextUri.startsWith('spotify:playlist:')

  if (!isPlaylistContext) {
    // Non-playlist context: close any open live event, discard new track
    const ev = closeLiveTrack(state, userId)
    if (ev) events.push(ev)
    return events
  }

  // Playlist context — extract fields
  const trackId = cpResult?.item?.id ?? null
  const durationMs = cpResult?.item?.duration_ms ?? 0
  const progressMs = cpResult?.progress_ms ?? 0
  const isPlaying = cpResult?.is_playing ?? true
  const playlistId = contextUri.split(':').pop()

  const existingTrackId = state.liveTrack?.trackId ?? null

  if (existingTrackId !== null && existingTrackId !== trackId) {
    // Track changed: close old live event
    const ev = closeLiveTrack(state, userId)
    if (ev) events.push(ev)
  }

  if (state.liveTrack === null) {
    // Open a new live track (either first track or just closed the old one)
    if (trackId === null) return events

    state.liveTrack = {
      trackId,
      durationMs,
      maxProgressMs: progressMs,
      playlistId,
      pausedSince: null,
      trackMetadata: extractTrackMetadata(cpResult?.item),
    }
    // Reset reduced mode / consecutive 204 counter on active track
    state.consecutive204s = 0
    if (state.reducedMode) {
      state.reducedMode = false
    }
    return events
  }

  // Same track — update maxProgressMs
  if (isPlaying) {
    state.liveTrack.maxProgressMs = Math.max(state.liveTrack.maxProgressMs, progressMs)
    state.liveTrack.pausedSince = null
  } else {
    // Paused
    if (state.liveTrack.pausedSince === null) {
      state.liveTrack.pausedSince = Date.now()
    }
    // Update max even while paused, in case progress_ms was reported higher
    state.liveTrack.maxProgressMs = Math.max(state.liveTrack.maxProgressMs, progressMs)

    const pausedDurationMs = Date.now() - state.liveTrack.pausedSince
    if (pausedDurationMs > 30 * 60 * 1000) {
      // Paused for more than 30 minutes — close the event
      const ev = closeLiveTrack(state, userId)
      if (ev) events.push(ev)
    }
  }

  return events
}

// ---------------------------------------------------------------------------
// Task 5.6 — reconcileRecentlyPlayed
// ---------------------------------------------------------------------------

/**
 * Reconcile the recently-played list against last_poll_at to produce listen
 * events for tracks that were played entirely between two poll cycles.
 *
 * Items from Spotify are ordered newest-first (items[0] is most recent).
 *
 * @param {string} userId
 * @param {object[]} rpItems   - response.data.items from getRecentlyPlayed
 * @param {string|null} lastPollAt - ISO timestamp string or null
 * @returns {object[]}
 */
export function reconcileRecentlyPlayed(userId, rpItems, lastPollAt) {
  const cutoff = lastPollAt ? new Date(lastPollAt) : new Date(0)

  // 1. Filter: only items newer than cutoff
  // 2. Filter: only playlist context
  const filtered = rpItems.filter((item) => {
    if (!item?.played_at) return false
    if (new Date(item.played_at) <= cutoff) return false
    const uri = item?.context?.uri
    if (typeof uri !== 'string' || !uri.startsWith('spotify:playlist:')) return false
    return true
  })

  // 3. Deduplicate by played_at (keep first occurrence)
  const seenPlayedAt = new Set()
  const deduped = []
  for (const item of filtered) {
    const key = item.played_at
    if (!seenPlayedAt.has(key)) {
      seenPlayedAt.add(key)
      deduped.push(item)
    }
  }

  // 4. Compute listened_pct for each item
  // Items are newest-first: deduped[0] is most recent.
  // For item at index i:
  //   - i === 0 (most recent): no successor → use duration_ms as gap
  //   - i > 0: successor is at i-1 → gap = played_at[i-1] - played_at[i]
  const events = []
  for (let i = 0; i < deduped.length; i++) {
    const item = deduped[i]
    const durationMs = item?.track?.duration_ms ?? 0

    if (durationMs <= 0) continue

    let gapMs
    if (i === 0) {
      // Most recent item — no successor in the list
      gapMs = durationMs
    } else {
      // Successor is deduped[i-1] (the item played right after this one)
      gapMs =
        new Date(deduped[i - 1].played_at).getTime() -
        new Date(item.played_at).getTime()
    }

    const listenedPct = Math.min(gapMs / durationMs, 1.0)
    const playlistId = item.context.uri.split(':').pop()
    const trackId = item?.track?.id ?? null

    if (!trackId) continue

    events.push({
      userId,
      trackId,
      playlistId,
      listenedPct,
      listenedAt: item.played_at,
      source: 'recent',
      trackMetadata: extractTrackMetadata(item.track),
    })
  }

  return events
}

// ---------------------------------------------------------------------------
// Task 5.7 — writeListenEvent(event) — Listen_Event_Writer
// ---------------------------------------------------------------------------

/**
 * Validate, deduplicate, and insert a single listen event into listen_events.
 *
 * Returns true if the row was inserted, false if skipped (dup or invalid) or
 * if the DB write failed.
 *
 * @param {{ userId, trackId, playlistId, listenedPct, listenedAt, source }} event
 * @returns {Promise<boolean>}
 */
export async function writeListenEvent(event) {
  const { userId, trackId, playlistId, listenedPct, listenedAt, source: rawSource } = event

  // Req 5.4 — validate listened_pct
  if (typeof listenedPct !== 'number' || listenedPct < 0.0 || listenedPct > 1.0) {
    console.error(
      `[poller] writeListenEvent: invalid listened_pct ${listenedPct} for (${userId}, ${trackId}, ${listenedAt}) — discarding`
    )
    return false
  }

  const supabase = getSupabase()

  // Req 5.1, 5.2 — dedup check: SELECT id WHERE user_id + track_id + listened_at match
  const { data: existing, error: selectError } = await supabase
    .from('listen_events')
    .select('id')
    .eq('user_id', userId)
    .eq('track_id', trackId)
    .eq('listened_at', listenedAt)
    .limit(1)

  if (selectError) {
    console.error(
      `[poller] writeListenEvent: dedup query failed for (${userId}, ${trackId}, ${listenedAt}):`,
      selectError.message
    )
    return false
  }

  if (existing && existing.length > 0) {
    // Row already exists — skip silently (Req 5.2)
    return false
  }

  // Req 4.8 — source = "delta" override: if listened_pct < 0.50 and source was "live"
  const source = (listenedPct < 0.50 && rawSource === 'live') ? 'delta' : rawSource

  // Guard: source must be one of the three valid DB values
  if (source !== 'live' && source !== 'recent' && source !== 'delta') {
    console.error(
      `[poller] writeListenEvent: invalid source "${source}" for (${userId}, ${trackId}, ${listenedAt}) — discarding`
    )
    return false
  }

  // Req 5.3 — was_skipped = listened_pct < 0.25
  const wasSkipped = listenedPct < 0.25

  // Insert the row
  const { error: insertError } = await supabase
    .from('listen_events')
    .insert({
      user_id: userId,
      track_id: trackId,
      playlist_id: playlistId,
      listened_pct: listenedPct,
      was_skipped: wasSkipped,
      source,
      listened_at: listenedAt,
    })

  if (insertError) {
    // Req 5.5 — log but do not retry
    console.error(
      `[poller] writeListenEvent: insert failed for (${userId}, ${trackId}, ${listenedAt}):`,
      insertError.message
    )
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Task 5.8 — detectSkip + removeTrack — Skip_Detector + Track_Remover
// ---------------------------------------------------------------------------

/**
 * Internal helper: remove a track from its Spotify playlist and record the
 * removal in removal_log.
 *
 * - Checks the in-memory forbiddenPlaylists blocklist (TTL-aware) before
 *   calling Spotify.
 * - On 403 FORBIDDEN_PLAYLIST: logs, adds a TTL blocklist entry, returns early
 *   (no removal_log row written) — genuine read-only playlist, now recoverable.
 * - On 403 MISSING_SCOPE: does NOT blocklist; records a durable re-auth signal
 *   for the user and returns early (the playlist itself is editable).
 * - On success: inserts a removal_log row.
 * - On removal_log insert failure: logs the inconsistency.
 *
 * @param {string} userId
 * @param {string} trackId
 * @param {string} playlistId
 * @param {string} accessToken
 * @param {string} [authUserId] - the authenticated user's Spotify ID, threaded
 *   to removeTrackFromPlaylist so it can probe playlist editability on a 403.
 * @param {{ name?: string|null, artist?: string|null, albumArt?: string|null }} [trackMetadata]
 * @returns {Promise<void>}
 */
async function removeTrack(userId, trackId, playlistId, accessToken, authUserId, trackMetadata = {}) {
  // Req 9.6 / 3.5 — skip silently if playlist has an active blocklist entry
  if (isPlaylistBlocked(playlistId)) return

  const trackUri = 'spotify:track:' + trackId

  try {
    await removeTrackFromPlaylist(accessToken, playlistId, trackUri, authUserId)
  } catch (err) {
    if (err?.code === 'FORBIDDEN_PLAYLIST') {
      // Req 3.4 / 2.4 — log, add a TTL blocklist entry (now recoverable), skip removal_log
      console.error(
        `[poller] removeTrack: 403 FORBIDDEN_PLAYLIST for playlist ${playlistId} — blocklisting for ${BLOCKLIST_TTL_MS} ms`
      )
      blockPlaylist(playlistId)
      return
    }
    if (err?.code === 'MISSING_SCOPE') {
      // Req 2.2 / 2.3 — token was issued without playlist-modify scope. Do NOT
      // blocklist the playlist (it is editable); record a durable re-auth signal
      // so the user can be prompted to re-authenticate and obtain a write token.
      usersNeedingReauth.add(userId)
      console.error(
        `[poller] removeTrack: 403 MISSING_SCOPE for playlist ${playlistId} — user ${userId} flagged for re-authentication to grant playlist write permissions`
      )
      return
    }
    // Any other Spotify error — log, skip removal_log (Req 7.3)
    console.error(
      `[poller] removeTrack: Spotify removal failed for track ${trackId} in playlist ${playlistId}:`,
      err.message
    )
    return
  }

  const playlistMetadata = await getPlaylistDetails(accessToken, playlistId)

  // Req 7.2 — write removal_log on success
  const supabase = getSupabase()
  const { error: logError } = await supabase
    .from('removal_log')
    .insert({
      user_id: userId,
      track_id: trackId,
      playlist_id: playlistId,
      playlist_name: playlistMetadata?.name ?? null,
      track_name: trackMetadata?.name ?? trackId,
      artist_name: trackMetadata?.artist ?? null,
      album_art: trackMetadata?.albumArt ?? null,
      reason: 'skipped 2/2 recent listens',
    })

  if (logError) {
    // Req 7.4 — log inconsistency but do not throw
    console.error(
      '[poller] removal_log insert failed — inconsistency:',
      userId, trackId, playlistId, logError.message
    )
  }
}

/**
 * Query the 2 most-recent listen events for a (user_id, track_id, playlist_id)
 * triple (applying the re-add history cutoff from removal_log) and trigger
 * track removal when both are skips.
 *
 * Requirements: 6.1–6.6, 7.1–7.5, 9.6, 11.1–11.4
 *
 * @param {string} userId
 * @param {string} trackId
 * @param {string} playlistId
 * @param {string} accessToken
 * @param {string} [authUserId] - the authenticated user's Spotify ID, forwarded
 *   to removeTrack → removeTrackFromPlaylist for 403 editability disambiguation.
 * @param {{ name?: string|null, artist?: string|null, albumArt?: string|null }} [trackMetadata]
 * @returns {Promise<void>}
 */
export async function detectSkip(userId, trackId, playlistId, accessToken, authUserId, trackMetadata = {}) {
  const supabase = getSupabase()

  // Req 11.1, 11.2 — query most-recent removal_log row for this triple
  const { data: removalRows, error: removalError } = await supabase
    .from('removal_log')
    .select('removed_at')
    .eq('user_id', userId)
    .eq('track_id', trackId)
    .eq('playlist_id', playlistId)
    .order('removed_at', { ascending: false })
    .limit(1)

  if (removalError) {
    console.error(
      `[poller] detectSkip: removal_log query failed for (${userId}, ${trackId}, ${playlistId}):`,
      removalError.message
    )
    return
  }

  const cutoff = removalRows && removalRows.length > 0 ? removalRows[0].removed_at : null

  // Req 6.1 — query 2 most-recent listen_events, applying cutoff if present
  let query = supabase
    .from('listen_events')
    .select('was_skipped')
    .eq('user_id', userId)
    .eq('track_id', trackId)
    .eq('playlist_id', playlistId)
    .order('listened_at', { ascending: false })
    .limit(2)

  if (cutoff !== null) {
    // Req 11.2 — exclude events at or before the removal cutoff
    query = query.gt('listened_at', cutoff)
  }

  const { data: events, error: eventsError } = await query

  if (eventsError) {
    // Req 6.5 — log and take no removal action
    console.error(
      `[poller] detectSkip: listen_events query failed for (${userId}, ${trackId}, ${playlistId}):`,
      eventsError.message
    )
    return
  }

  // Req 6.3 / 11.3 — fewer than 2 rows → no action
  if (!events || events.length < 2) return

  // Req 6.4 — not all skipped → no action
  if (!events.every((row) => row.was_skipped === true)) return

  // Req 6.2 — all 2 are skips → trigger removal
  await removeTrack(userId, trackId, playlistId, accessToken, authUserId, trackMetadata)
}

// ---------------------------------------------------------------------------
// Task 5.4 — runPollCycle (replaces stub)
// ---------------------------------------------------------------------------

/**
 * One full poll cycle for a single user.
 *
 * - Skip-if-running guard
 * - Token refresh
 * - Parallel fetch: currently-playing + recently-played
 * - processLiveTrack → reconcileRecentlyPlayed → collect events
 *   (writeListenEvent + detectSkip wired in task 5.9)
 *
 * @param {string} userId
 */
export async function runPollCycle(userId) {
  const state = userState.get(userId)
  if (!state) return
  if (state.isRunning) return
  state.isRunning = true
  const cycleStart = new Date()

  try {
    const supabase = getSupabase()

    // Load user row from Supabase
    const { data: userRows, error: userError } = await supabase
      .from('users')
      .select('access_token, refresh_token, token_expires_at, last_poll_at, spotify_id')
      .eq('id', userId)
      .limit(1)

    if (userError || !userRows || userRows.length === 0) {
      console.error(`[poller] Failed to load user row for ${userId}:`, userError?.message ?? 'not found')
      return
    }

    const user = { id: userId, ...userRows[0] }

    // Token refresh — handle revocation
    let accessToken
    try {
      const result = await refreshTokenIfNeeded(user)
      accessToken = result.accessToken
    } catch (err) {
      if (err?.code === 'REVOKED') {
        console.warn(`[poller] Permissions revoked for user ${userId} — deregistering`)
        await supabase.from('users').update({ refresh_token: null }).eq('id', userId)
        deregisterUser(userId)
        return
      }
      throw err
    }

    // Increment cycle counter and decide whether to fetch recently-played.
    // /recently-played only updates when a track finishes, so every 4th 15s
    // cycle (~60s) is sufficient and avoids hammering the rate limit.
    state.pollCount = (state.pollCount ?? 0) + 1
    const fetchRecentlyPlayed = state.pollCount % RECENTLY_PLAYED_CYCLE_INTERVAL === 0

    // Parallel fetch — recently-played only on every 4th cycle
    const [cpResult, rpItems] = await Promise.all([
      getCurrentlyPlaying(accessToken, userId),
      fetchRecentlyPlayed ? getRecentlyPlayed(accessToken, userId) : Promise.resolve([]),
    ])

    // Process live track state machine
    const liveEvents = processLiveTrack(userId, cpResult, state)

    // Reconcile recently-played
    const recentEvents = reconcileRecentlyPlayed(userId, rpItems, user.last_poll_at)

    // Combined event list: live-tracked events + recently-played reconciled events
    const allEvents = [...liveEvents, ...recentEvents]

    // Write each event and trigger skip detection on successful inserts (Req 1.5, 8.1)
    for (const event of allEvents) {
      const inserted = await writeListenEvent(event)
      if (inserted) {
        await detectSkip(
          event.userId,
          event.trackId,
          event.playlistId,
          accessToken,
          user.spotify_id,
          event.trackMetadata
        )
      }
    }
  } catch (err) {
    console.error(`[poller] cycle error for user ${userId}:`, err.message)
  } finally {
    // Update last_poll_at unconditionally (Req 8.1, 8.3)
    try {
      const supabase = getSupabase()
      await supabase
        .from('users')
        .update({ last_poll_at: cycleStart.toISOString() })
        .eq('id', userId)
    } catch (updateErr) {
      console.error(`[poller] Failed to update last_poll_at for user ${userId}:`, updateErr.message)
    }
    state.isRunning = false
  }
}

// ---------------------------------------------------------------------------
// Task 5.3 — registerUser / deregisterUser
// ---------------------------------------------------------------------------

/**
 * Start a polling interval for a single user.
 * Idempotent: calling again for an already-registered user is a no-op for the
 * polling interval. Applies a random Stagger_Offset in [0, 5000] ms before the
 * first tick.
 *
 * Recovery (Req 2.4): registerUser is called on a successful re-authentication
 * from the auth callback. On every call it clears the user's durable re-auth
 * signal and drops blocklist entries so previously-blocked playlists become
 * retryable with the freshly-minted (correctly-scoped) token. This MUST run
 * even when the user is already registered, so it happens before the
 * idempotency guard. (Per-user playlist ownership is not tracked in memory, so
 * the blocklist is cleared wholesale; entries that are still genuinely
 * forbidden will simply be re-blocked on the next 403.)
 *
 * @param {string} userId - Supabase user UUID
 */
export function registerUser(userId) {
  // Recovery: clear the durable re-auth signal and drop stale blocklist entries
  // on (re-)registration so cleaning resumes after a successful re-auth.
  usersNeedingReauth.delete(userId)
  forbiddenPlaylists.clear()

  // No-op for the polling interval if this user is already registered.
  if (userState.has(userId)) return

  // Store state immediately with intervalId: null; update inside the callback.
  const state = {
    intervalId: null,
    staggerTimeoutId: null,
    isRunning: false,
    consecutive204s: 0,
    reducedMode: false,
    liveTrack: null,
    pollCount: 0,
  }
  userState.set(userId, state)

  // Stagger_Offset: uniformly random in [0, 5000] ms (Req 1.10).
  const staggerMs = Math.floor(Math.random() * 5001)

  state.staggerTimeoutId = setTimeout(() => {
    state.staggerTimeoutId = null
    // Guard against a deregister that happened during the stagger window:
    // if the user was removed (or re-registered with a fresh state), do not
    // create an orphaned interval that can never be cleared.
    if (userState.get(userId) !== state) return
    state.intervalId = setInterval(() => runPollCycle(userId), POLL_INTERVAL_MS)
  }, staggerMs)
}

/**
 * Clear the polling interval and remove in-memory state for a user.
 *
 * @param {string} userId
 */
export function deregisterUser(userId) {
  const state = userState.get(userId)
  if (!state) return
  // Clear a pending stagger timeout (deregister during the stagger window) so
  // it cannot fire later and create an untracked interval.
  if (state.staggerTimeoutId) clearTimeout(state.staggerTimeoutId)
  clearInterval(state.intervalId)
  userState.delete(userId)
}

// ---------------------------------------------------------------------------
// Task 5.2 — startPollingEngine
// ---------------------------------------------------------------------------

/**
 * Load all users with a non-null refresh_token from Supabase and
 * start a polling interval for each. Called once from src/index.js.
 */
export async function startPollingEngine() {
  const supabase = getSupabase()

  const { data: users, error } = await supabase
    .from('users')
    .select('id')
    .not('refresh_token', 'is', null)
    .eq('polling_enabled', true)

  if (error) {
    console.error('[poller] Failed to load users at startup:', error.message)
    return
  }

  console.log(`[poller] Starting polling engine for ${users.length} user(s)`)

  for (const user of users) {
    registerUser(user.id)
  }
}
