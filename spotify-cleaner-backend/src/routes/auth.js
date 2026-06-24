import { Router } from 'express'
import axios from 'axios'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import getSupabase from '../lib/supabase.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { registerUser, deregisterUser } from '../lib/poller.js'

const router = Router()
const OAUTH_CONTEXT_COOKIE = 'spotify_oauth_context'
const DEFAULT_SPOTIFY_REDIRECT_URI = 'https://playlist-cleaner-sooty.vercel.app/auth/callback'

// ─── Scopes we need from Spotify ───────────────────────────────────────────
const SCOPES = [
  'user-read-playback-state',       // See what's currently playing
  'user-read-recently-played',      // Read recently played tracks
  'user-read-private',              // Required for /v1/tracks market resolution
  'playlist-modify-public',         // Remove tracks from public playlists
  'playlist-modify-private',        // Remove tracks from private playlists
].join(' ')

// ─── BYO Spotify app helpers ───────────────────────────────────────────────
function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(64))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function createState() {
  return base64Url(crypto.randomBytes(24))
}

function isValidSpotifyClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{16,128}$/.test(value)
}

function getRedirectUri(req) {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI
  return DEFAULT_SPOTIFY_REDIRECT_URI
}

function getCookieSecureOption(req) {
  const frontendUrl = process.env.FRONTEND_URL ?? ''
  if (frontendUrl.startsWith('http://')) return false
  if (frontendUrl.startsWith('https://')) return true

  const forwardedProto = req.headers['x-forwarded-proto']
  if (Array.isArray(forwardedProto)) {
    return forwardedProto.includes('https')
  }

  return forwardedProto === 'https' || req.secure
}

function hasSharedSpotifyCredentials() {
  return !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET
}

// ─── Step 1: Redirect user to Spotify login ────────────────────────────────
router.get('/spotify', (req, res) => {
  const clientId = String(req.query.client_id ?? '').trim()
  const redirectUri = getRedirectUri(req)

  if (clientId) {
    if (!isValidSpotifyClientId(clientId)) {
      return res.redirect(`${process.env.FRONTEND_URL}/spotify-setup?error=invalid_client_id`)
    }

    const { verifier, challenge } = createPkcePair()
    const state = createState()
    const oauthContext = jwt.sign(
      {
        clientId,
        codeVerifier: verifier,
        state,
        flow: 'byo-client-id',
      },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    )

    res.cookie(OAUTH_CONTEXT_COOKIE, oauthContext, {
      httpOnly: true,
      secure: getCookieSecureOption(req),
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
    })

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    })

    return res.redirect(`https://accounts.spotify.com/authorize?${params}`)
  }

  if (!hasSharedSpotifyCredentials()) {
    return res.redirect(`${process.env.FRONTEND_URL}/spotify-setup?error=client_id_required`)
  }

  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
  })

  res.redirect(`https://accounts.spotify.com/authorize?${params}`)
})

// ─── Step 2: Handle the callback from Spotify ──────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query

  // User denied access
  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=access_denied`)
  }

  if (!code) {
    return res.status(400).json({ error: 'No code provided' })
  }

  try {
    const redirectUri = getRedirectUri(req)
    let byoContext = null
    const contextCookie = req.cookies?.[OAUTH_CONTEXT_COOKIE]

    if (contextCookie) {
      try {
        byoContext = jwt.verify(contextCookie, process.env.JWT_SECRET)
      } catch {
        return res.redirect(`${process.env.FRONTEND_URL}/spotify-setup?error=auth_expired`)
      }

      if (
        byoContext.flow !== 'byo-client-id' ||
        byoContext.state !== state ||
        !isValidSpotifyClientId(byoContext.clientId) ||
        !byoContext.codeVerifier
      ) {
        return res.redirect(`${process.env.FRONTEND_URL}/spotify-setup?error=auth_failed`)
      }
    }

    // ── Exchange code for tokens ──────────────────────────────────────────
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    })

    const tokenHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }

    if (byoContext) {
      tokenParams.append('client_id', byoContext.clientId)
      tokenParams.append('code_verifier', byoContext.codeVerifier)
    } else {
      if (!hasSharedSpotifyCredentials()) {
        return res.redirect(`${process.env.FRONTEND_URL}/spotify-setup?error=client_id_required`)
      }

      tokenHeaders.Authorization = `Basic ${Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString('base64')}`
    }

    const tokenResponse = await axios.post(
      'https://accounts.spotify.com/api/token',
      tokenParams,
      { headers: tokenHeaders }
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
    const displayName = profileResponse.data.display_name ?? null
    // images is an array ordered largest-first; pick the first (largest) one.
    const avatarUrl = profileResponse.data.images?.[0]?.url ?? null

    // ── Encrypt tokens before storing ────────────────────────────────────
    const encryptedAccess = encrypt(access_token)
    const encryptedRefresh = encrypt(refresh_token)
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString()

    // ── Upsert user in Supabase ───────────────────────────────────────────
    // If the user already exists (re-auth), update their tokens and profile.
    // If they're new, insert them.
    const { data: user, error: dbError } = await getSupabase()
      .from('users')
      .upsert(
        {
          spotify_id: spotifyId,
          access_token: encryptedAccess,
          refresh_token: encryptedRefresh,
          token_expires_at: tokenExpiresAt,
          display_name: displayName,
          avatar_url: avatarUrl,
          spotify_client_id: byoContext?.clientId ?? null,
        },
        { onConflict: 'spotify_id', ignoreDuplicates: false }
      )
      .select('id, spotify_id, display_name, avatar_url')
      .single()

    if (dbError) {
      console.error('DB upsert error:', dbError)
      return res.redirect(`${process.env.FRONTEND_URL}?error=db_error`)
    }

    // ── Register user with polling engine ────────────────────────────────
    registerUser(user.id)

    // ── Issue a JWT session cookie ────────────────────────────────────────
    const sessionToken = jwt.sign(
      {
        userId: user.id,
        spotifyId: user.spotify_id,
        displayName: user.display_name ?? null,
        avatarUrl: user.avatar_url ?? null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.cookie('session', sessionToken, {
      httpOnly: true,    // JS cannot read this cookie (XSS protection)
      secure: getCookieSecureOption(req),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    })

    res.clearCookie(OAUTH_CONTEXT_COOKIE, {
      httpOnly: true,
      secure: getCookieSecureOption(req),
      sameSite: 'lax',
      path: '/',
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
    res.json({
      userId: payload.userId,
      spotifyId: payload.spotifyId,
      displayName: payload.displayName ?? null,
      avatarUrl: payload.avatarUrl ?? null,
    })
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' })
  }
})

// ─── POST /auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const token = req.cookies?.session
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET)
      deregisterUser(payload.userId)
    } catch {
      // expired/invalid token — nothing to deregister
    }
  }
  // clearCookie must be given the same options the cookie was set with
  // (httpOnly/sameSite/secure/path) or the browser won't match and clear it.
  res.clearCookie('session', {
    httpOnly: true,
    secure: getCookieSecureOption(req),
    sameSite: 'lax',
    path: '/',
  })
  res.json({ success: true })
})

export default router
