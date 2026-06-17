# Project Structure

```
Playlist-Cleaner/
├── plan.md                          # Full product plan, architecture decisions, data model
├── spotify-cleaner-backend/         # Node.js + Express backend (exists)
│   ├── package.json
│   ├── .env                         # Local env vars (never commit)
│   └── src/
│       ├── index.js                 # App entry point — Express setup, middleware, route mounting
│       ├── routes/
│       │   └── auth.js              # /auth/* routes (OAuth flow, /me, /logout)
│       └── lib/
│           ├── supabase.js          # Lazy Supabase client singleton
│           └── crypto.js            # AES-256-GCM encrypt/decrypt for token storage
└── spotify-cleaner-frontend/        # Next.js frontend (planned, not yet created)
```

## Conventions

### Backend
- All source files use ES Module syntax (`import`/`export`), no `require()`
- Entry point is `src/index.js`; routes go in `src/routes/`, shared utilities in `src/lib/`
- Routes are mounted in `index.js` via `app.use('/prefix', routerModule)`
- Supabase client is a lazy singleton from `src/lib/supabase.js` — always call `getSupabase()`, never instantiate directly
- Tokens must always be encrypted with `encrypt()`/`decrypt()` from `src/lib/crypto.js` before DB reads/writes
- Environment variables are loaded via `import 'dotenv/config'` at the top of `index.js` only
- CORS is handled manually in `index.js` using `FRONTEND_URL` env var

### Planned additions (follow same patterns)
- `src/routes/api.js` — `/api/*` routes (removals, settings, poll control)
- `src/lib/spotify.js` — Spotify API calls (currently-playing, recently-played, delete track, token refresh)
- `src/lib/poller.js` — per-user polling loop logic
- `src/middleware/auth.js` — JWT cookie verification middleware (reusable guard for protected routes)

### Database
- All DB access goes through the `getSupabase()` singleton
- Use `.upsert()` with `onConflict` for user records to handle re-auth gracefully
- Always `.select()` after mutations to get the affected row back

### Security
- `session` cookie is `httpOnly: true` — never expose session token to client JS
- Set `secure: true` on cookies in production (HTTPS required)
- Never log or return raw access/refresh tokens
