import { Router } from 'express'
import axios from 'axios'
import jwt from 'jsonwebtoken'
import getSupabase from '../lib/supabase.js'
import { encrypt, decrypt } from '../lib/crypto.js'

const router = Router()

// ─── Scopes we need from Spotify ───────────────────────────────────────────
const SCOPES = [
  'user-read-playback-state',       // See what's currently playing
  'user-read-recently-played',      // Read recently played tracks
  'playlist-modify-public',         // Remove tracks from public playlists
  'playlist-modify-private',        // Remove tracks from private playlists
].join(' ')

// ─── Step 1: Redirect user to Spotify login ────────────────────────────────
router.get('/spotify', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
    show_dialog: 'false', // set to 'true' during dev if you want to re-approve each time
  })

  res.redirect(`https://accounts.spotify.com/authorize?${params}`)
})

// ─── Step 2: Handle the callback from Spotify ──────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, error } = req.query

  // User denied access
  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=access_denied`)
  }

  if (!code) {
    return res.status(400).json({ error: 'No code provided' })
  }

  try {
    // ── Exchange code for tokens ──────────────────────────────────────────
    const tokenResponse = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString('base64')}`,
        },
      }
    )

    const {
      access_token,
      refresh_token,
      expires_in, // seconds until access_token expires (typically 3600)
    } = tokenResponse.data

    // ── Get Spotify user profile ──────────────────────────────────────────
    const profileResponse = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    })

    const spotifyId = profileResponse.data.id

    // ── Encrypt tokens before storing ────────────────────────────────────
    const encryptedAccess = encrypt(access_token)
    const encryptedRefresh = encrypt(refresh_token)
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString()

    // ── Upsert user in Supabase ───────────────────────────────────────────
    // If the user already exists (re-auth), update their tokens.
    // If they're new, insert them.
    const { data: user, error: dbError } = await getSupabase()
      .from('users')
      .upsert(
        {
          spotify_id: spotifyId,
          access_token: encryptedAccess,
          refresh_token: encryptedRefresh,
          token_expires_at: tokenExpiresAt,
        },
        { onConflict: 'spotify_id', ignoreDuplicates: false }
      )
      .select('id, spotify_id')
      .single()

    if (dbError) {
      console.error('DB upsert error:', dbError)
      return res.redirect(`${process.env.FRONTEND_URL}?error=db_error`)
    }

    // ── Issue a JWT session cookie ────────────────────────────────────────
    // This is what the frontend will send on subsequent requests to
    // identify the logged-in user.
    const sessionToken = jwt.sign(
      { userId: user.id, spotifyId: user.spotify_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.cookie('session', sessionToken, {
      httpOnly: true,    // JS cannot read this cookie (XSS protection)
      secure: false,     // set to true in production (requires HTTPS)
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    })

    // ── Redirect to dashboard ─────────────────────────────────────────────
    res.redirect(`${process.env.FRONTEND_URL}/dashboard`)

  } catch (err) {
    console.error('Auth callback error:', err.response?.data || err.message)
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`)
  }
})

// ─── GET /auth/me — return current user info from JWT cookie ───────────────
router.get('/me', (req, res) => {
  const token = req.cookies?.session
  if (!token) return res.status(401).json({ error: 'Not authenticated' })

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    res.json({ userId: payload.userId, spotifyId: payload.spotifyId })
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' })
  }
})

// ─── POST /auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('session')
  res.json({ success: true })
})

export default router