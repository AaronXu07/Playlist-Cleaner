import express from 'express'
import requireAuth from '../middleware/auth.js'
import getSupabase from '../lib/supabase.js'
import {
  addTrackToPlaylist,
  refreshTokenIfNeeded,
  getTracksDetails,
} from '../lib/spotify.js'
import { userState, registerUser, deregisterUser } from '../lib/poller.js'

const router = express.Router()

// ---------------------------------------------------------------------------
// Task 8.1 — GET /api/removals
// List the 50 most recent removal log entries for the authenticated user,
// enriched with the real track name, artist, and album art from Spotify so the
// dashboard can show song titles + cover images (not raw track IDs).
// Requirements: 7.2
// ---------------------------------------------------------------------------
router.get('/removals', requireAuth, async (req, res) => {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('removal_log')
    .select('*')
    .eq('user_id', req.user.userId)
    .order('removed_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('[api] GET /removals error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch removals' })
  }

  const rows = data ?? []

  // Best-effort enrichment with Spotify track metadata. If the token can't be
  // loaded/refreshed or the Spotify call fails, fall back to the raw rows so
  // the list still renders.
  let details = new Map()
  try {
    const { data: userRows, error: userError } = await supabase
      .from('users')
      .select('id, access_token, refresh_token, token_expires_at')
      .eq('id', req.user.userId)
      .limit(1)

    if (!userError && userRows && userRows.length > 0) {
      const { accessToken } = await refreshTokenIfNeeded(userRows[0])
      const trackIds = rows.map((r) => r.track_id)
      details = await getTracksDetails(accessToken, trackIds)
    }
  } catch (enrichErr) {
    console.error('[api] GET /removals enrichment error:', enrichErr.message)
  }

  const enriched = rows.map((row) => {
    const meta = details.get(row.track_id)
    return {
      ...row,
      // Prefer the live Spotify name; fall back to stored track_name (which may
      // be the raw track ID for older rows).
      track_name: meta?.name ?? row.track_name,
      artist_name: meta?.artist ?? null,
      album_art: meta?.albumArt ?? null,
    }
  })

  return res.json(enriched)
})

// ---------------------------------------------------------------------------
// Task 8.2 — DELETE /api/removals/:id
// Undo a removal: re-add the track to its playlist and delete the log entry.
// Requirements: 7.2
// ---------------------------------------------------------------------------
router.delete('/removals/:id', requireAuth, async (req, res) => {
  const supabase = getSupabase()
  const { id } = req.params
  const { userId } = req.user

  // Fetch the removal_log row, enforcing ownership.
  const { data: rows, error: fetchError } = await supabase
    .from('removal_log')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .limit(1)

  if (fetchError) {
    console.error('[api] DELETE /removals/:id fetch error:', fetchError.message)
    return res.status(500).json({ error: 'Failed to fetch removal record' })
  }

  if (!rows || rows.length === 0) {
    return res.status(404).json({ error: 'Removal record not found' })
  }

  const row = rows[0]

  try {
    // Load user tokens from DB.
    const { data: userRows, error: userError } = await supabase
      .from('users')
      .select('id, access_token, refresh_token, token_expires_at')
      .eq('id', userId)
      .limit(1)

    if (userError || !userRows || userRows.length === 0) {
      throw new Error('Could not load user record')
    }

    const user = userRows[0]

    // Refresh token if needed, get plaintext access token.
    const { accessToken } = await refreshTokenIfNeeded(user)

    // Re-add the track to the playlist via Spotify API.
    await addTrackToPlaylist(accessToken, row.playlist_id, `spotify:track:${row.track_id}`)

    // Delete the removal_log row now that the track has been re-added.
    const { error: deleteError } = await supabase
      .from('removal_log')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)

    if (deleteError) {
      console.error('[api] DELETE /removals/:id delete log error:', deleteError.message)
      return res.status(500).json({ error: 'Track re-added but failed to delete removal record' })
    }

    return res.status(204).send()
  } catch (err) {
    console.error('[api] DELETE /removals/:id error:', err.message)
    return res.status(500).json({ error: 'Failed to undo removal' })
  }
})

// ---------------------------------------------------------------------------
// Task 8.3 — GET /api/events
// List the 100 most recent listen events for the authenticated user.
// Requirements: 5.1
// ---------------------------------------------------------------------------
router.get('/events', requireAuth, async (req, res) => {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('listen_events')
    .select('*')
    .eq('user_id', req.user.userId)
    .order('listened_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('[api] GET /events error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch listen events' })
  }

  return res.json(data)
})

// ---------------------------------------------------------------------------
// Task 8.4 — GET /api/status
// Return the durable cleaning-enabled state plus current poller diagnostics.
// Requirements: 1.9, 13.1
// ---------------------------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  const { userId } = req.user
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('users')
    .select('polling_enabled')
    .eq('id', userId)
    .limit(1)

  if (error) {
    console.error('[api] GET /status db error:', error.message)
    return res.status(500).json({ error: 'Failed to fetch polling state' })
  }

  const user = data?.[0]
  const pollingEnabled = user?.polling_enabled === true

  if (!user) {
    return res.json({
      registered: false,
      pollingEnabled: false,
      isRunning: false,
      isPollCycleRunning: false,
    })
  }

  if (pollingEnabled && !userState.has(userId)) {
    registerUser(userId)
  }

  if (!pollingEnabled && userState.has(userId)) {
    deregisterUser(userId)
  }

  const state = userState.get(userId)

  return res.json({
    registered: !!state,
    pollingEnabled,
    // Backwards-compatible name consumed by the current frontend toggle.
    isRunning: pollingEnabled,
    isPollCycleRunning: state?.isRunning ?? false,
    consecutive204s: state?.consecutive204s ?? 0,
    reducedMode: state?.reducedMode ?? false,
    hasLiveTrack: !!state?.liveTrack,
  })
})

// ---------------------------------------------------------------------------
// POST /api/polling/start — register (or re-register) the user with the
// polling engine so automatic playlist cleaning is active.
// ---------------------------------------------------------------------------
router.post('/polling/start', requireAuth, async (req, res) => {
  const { userId } = req.user
  const supabase = getSupabase()

  const { error } = await supabase
    .from('users')
    .update({ polling_enabled: true })
    .eq('id', userId)

  if (error) {
    console.error('[api] POST /polling/start db error:', error.message)
    return res.status(500).json({ error: 'Failed to update polling state' })
  }

  registerUser(userId)
  return res.json({ polling: true })
})

// ---------------------------------------------------------------------------
// POST /api/polling/stop — deregister the user from the polling engine so
// no further monitoring or removals happen until they start again.
// ---------------------------------------------------------------------------
router.post('/polling/stop', requireAuth, async (req, res) => {
  const { userId } = req.user
  const supabase = getSupabase()

  const { error } = await supabase
    .from('users')
    .update({ polling_enabled: false })
    .eq('id', userId)

  if (error) {
    console.error('[api] POST /polling/stop db error:', error.message)
    return res.status(500).json({ error: 'Failed to update polling state' })
  }

  deregisterUser(userId)
  return res.json({ polling: false })
})

export default router
