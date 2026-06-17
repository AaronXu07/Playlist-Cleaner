# Tech Stack

## Backend (current — `spotify-cleaner-backend/`)
- **Runtime**: Node.js with ES Modules (`"type": "module"`)
- **Framework**: Express 5
- **Language**: JavaScript (no TypeScript)
- **Key libraries**:
  - `@supabase/supabase-js` — database client
  - `axios` — HTTP requests to Spotify API
  - `jsonwebtoken` — JWT session tokens
  - `cookie-parser` — reading `session` cookie
  - `dotenv` — environment variable loading
  - `nodemon` — dev auto-restart

## Frontend (planned)
- **Framework**: Next.js (React)
- **Hosting**: Vercel
- **Key env vars**: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SPOTIFY_CLIENT_ID`

## Database
- **PostgreSQL** via Supabase (free tier)
- **Client**: `@supabase/supabase-js` using the service role key
- **Tables**: `users`, `listen_events`, `removal_log`
- Tokens stored encrypted at rest using AES-256-GCM

## Auth
- Spotify OAuth 2.0 (authorization code flow, server-side exchange)
- Sessions issued as `httpOnly` JWT cookies (7-day expiry)
- Spotify tokens encrypted before DB storage; decrypted at poll time

## Hosting
- **Backend**: Railway or Render (persistent Node process required for polling)
- **Frontend**: Vercel

## Environment Variables

### Backend
```
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
SPOTIFY_REDIRECT_URI
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL
JWT_SECRET
ENCRYPTION_KEY        # must be exactly 32 bytes (UTF-8)
FRONTEND_URL          # used for CORS and redirects
PORT                  # defaults to 3000
```

### Frontend
```
NEXT_PUBLIC_API_BASE_URL
NEXT_PUBLIC_SPOTIFY_CLIENT_ID
```

## Common Commands

```bash
# Install dependencies
cd spotify-cleaner-backend && npm install

# Start dev server (auto-restarts on change)
npm run dev

# Start production server
npm start
```
