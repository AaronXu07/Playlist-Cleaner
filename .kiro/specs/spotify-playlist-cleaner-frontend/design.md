# Design Document: Spotify Playlist Cleaner Frontend

## Overview

The Spotify Playlist Cleaner Frontend is a Next.js 14 (App Router) + TypeScript application
deployed to Vercel. It consists of two routes:

- `/` — a public, scroll-driven landing page that tells the product story through an animated
  SVG timeline of Billboard Hot 100 songs (1970–2026) and ends with a Spotify sign-in CTA.
- `/dashboard` — a protected page that lets authenticated users start/stop the background
  cleaning engine, monitor status via an EKG waveform, and review or undo removed songs.

All backend communication targets the existing Express 5 API at `NEXT_PUBLIC_API_BASE_URL`.
Authentication is managed entirely via an `httpOnly` JWT cookie; the frontend never reads the
token value directly.

### Key Design Decisions

1. **App Router over Pages Router** — React Server Components allow the `/dashboard` route to
   perform the `/auth/me` check server-side before rendering, eliminating the flash of
   unauthenticated content. Client Components are used only where interactivity is required.
2. **Single shared audio object for preview playback** — a module-level `Audio` instance in a
   React context provider ensures at most one preview plays at a time without prop-drilling.
3. **Framer Motion `useScroll` for timeline animation** — `scrollYProgress` is mapped directly
   to a `pathLength` motion value, which is the idiomatic Framer Motion pattern and avoids
   manual `scroll` event listeners.
4. **CSS custom properties for design tokens** — tokens defined in `globals.css` and mirrored
   in `tailwind.config.ts` as theme extensions; this gives both Tailwind utility classes and
   raw CSS access to the same values.
5. **Optimistic UI for re-add actions** — the removed-songs panel animates rows out immediately
   and reverts on failure, giving the perception of instant responsiveness over network latency.


---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Vercel (Next.js 14)                             │
│                                                                        │
│  ┌──────────────┐    ┌──────────────────────────────────────────────┐ │
│  │  Route: /    │    │  Route: /dashboard                           │ │
│  │  (RSC leaf)  │    │  Server Component — calls /auth/me           │ │
│  │              │    │  ├── redirects to / if 401                   │ │
│  │  LandingPage │    │  └── renders DashboardShell (Client)         │ │
│  │  (Client)    │    │       ├── CleaningToggle                     │ │
│  └──────────────┘    │       ├── Waveform                           │ │
│                       │       └── RemovedSongsPanel                 │ │
│  ┌──────────────┐    └──────────────────────────────────────────────┘ │
│  │  Providers   │                                                      │
│  │  AudioCtx    │    ┌──────────────────────────────────────────────┐ │
│  │  QueryClient │    │  lib/api.ts  — typed fetch wrappers           │ │
│  └──────────────┘    │  All calls: credentials:'include'             │ │
│                       │  Base URL: NEXT_PUBLIC_API_BASE_URL           │ │
└───────────────────────┴──────────────────────────────────────────────┘
                                      │  HTTP (cookie)
                                      ▼
                ┌─────────────────────────────────────┐
                │   Express 5 Backend (Railway/Render) │
                │   /auth/me  /auth/logout             │
                │   /api/status  /api/removals         │
                │   /api/polling/start  /stop          │
                └─────────────────────────────────────┘
```

### Directory Layout

```
spotify-cleaner-frontend/
├── app/
│   ├── layout.tsx            # Root layout — providers, global CSS
│   ├── page.tsx              # Landing page (Client Component)
│   ├── dashboard/
│   │   └── page.tsx          # Server Component — auth check + shell
│   └── globals.css           # CSS custom properties (design tokens)
├── components/
│   ├── landing/
│   │   ├── TimelineSVG.tsx
│   │   ├── YearMarker.tsx
│   │   └── PreviewButton.tsx
│   ├── dashboard/
│   │   ├── CleaningToggle.tsx
│   │   ├── Waveform.tsx
│   │   └── RemovedSongsPanel.tsx
│   └── ui/
│       ├── Avatar.tsx
│       ├── DropdownMenu.tsx
│       ├── LoadingSkeleton.tsx
│       └── Toast.tsx
├── lib/
│   ├── api.ts                # Typed fetch helpers (auth, status, removals)
│   └── yearMarkerData.ts     # Static curated song data (1970–2026)
├── hooks/
│   ├── useCleaningState.ts   # SWR hook: /api/status
│   └── useRemovals.ts        # SWR hook: /api/removals + optimistic updates
├── context/
│   └── AudioContext.tsx      # Shared Audio instance for preview playback
├── tailwind.config.ts
├── next.config.ts
└── tsconfig.json
```


---

## Components and Interfaces

### Design Token Layer (`globals.css` + `tailwind.config.ts`)

CSS custom properties defined in `:root`:

```css
--color-bg-base:          #121212;
--color-bg-surface:       #181818;
--color-bg-surface-hover: #282828;
--color-brand:            #1DB954;
--color-danger:           #E74C3C;
--color-text-primary:     #FFFFFF;
--color-text-muted:       #A7A7A7;
--shadow-elevated:        0 4px 16px rgba(0,0,0,0.48);
--radius-card:            8px;
--radius-pill:            9999px;
```

Tailwind extension maps each token to a utility class:
`bg-base`, `bg-surface`, `bg-surface-hover`, `text-brand`, `text-danger`,
`text-primary`, `text-muted`, `shadow-elevated`.

Spacing enforced via Tailwind's default `spacing` scale (multiples of `0.5rem` = 8px base).
Font sizes restricted to the exact token set: `text-xs`(12), `text-sm`(14), `text-base`(16),
`text-xl`(20), `text-2xl`(24), `text-3xl`(32 approx), `text-5xl`(48), `text-7xl`(64).

---

### `TimelineSVG` Component

**Responsibility**: Renders the scroll-linked SVG path and places `YearMarker` nodes.

**Key implementation details**:

- A `<svg>` element with `height={TOTAL_HEIGHT}` where `TOTAL_HEIGHT = 57 * 550 = 31,350px`.
- The path `d` attribute is generated at build time by `generateTimelinePath(count, spacing)`
  which produces 57 cubic Bézier segments alternating between left and right. Horizontal
  amplitude per segment is sampled from `baseAmplitude + randomOffset` where `randomOffset`
  is seeded (deterministic) and stays within ±20px of `baseAmplitude`. On mobile (width < 640)
  `baseAmplitude` is capped to 20px.
- A `<motion.path>` wraps the `<path>` element; `pathLength` is a Framer Motion `MotionValue`
  driven by `useScroll({ target: containerRef }).scrollYProgress` via `useTransform`.
- On mount and on `resize`, the component calls `svgPath.getPointAtLength(t)` for each of the
  57 marker positions to compute `{ x, y }` coordinates.
- If `prefers-reduced-motion` is active, `pathLength` is set to `1` immediately and no
  `useScroll` transform is applied.

```ts
interface TimelineSVGProps {
  markers: YearMarkerDatum[]
  // containerRef attached to the page scroll container
  containerRef: React.RefObject<HTMLElement>
}
```

---

### `YearMarker` Component

**Responsibility**: Displays album art, title, artist, year label, and optional play button
at a computed `(x, y)` position on the timeline.

```ts
interface YearMarkerProps {
  datum: YearMarkerDatum
  position: { x: number; y: number }
  side: 'left' | 'right'
  isPlaying: boolean
  onPlay: () => void
  onPause: () => void
}

interface YearMarkerDatum {
  year: number
  trackTitle: string
  artistName: string
  albumArt: string        // static import or URL
  preview_url: string | null
  // TODO: replace with live Spotify year-end data
}
```

Entrance animation: Framer Motion `whileInView` — `opacity: 0→1`, `scale: 0.92→1`,
`duration: 0.4s`, `ease: 'easeOut'`, `viewport: { once: true }`.

---

### `AudioContext` Provider

**Responsibility**: Owns the singleton `HTMLAudioElement` and exposes play/pause/stop
controls to all `YearMarker` components without prop-drilling.

```ts
interface AudioContextValue {
  playingUrl: string | null
  play: (url: string) => Promise<void>
  pause: () => void
  stop: () => void
}
```

- A single `new Audio()` instance is created once in the provider.
- `play(url)` stops the current track within 500ms, sets `audio.src = url`, calls `audio.play()`.
- The `audio` object's `ended` event resets `playingUrl` to `null`.
- Play button disabled state is managed locally in `PreviewButton` while `audio.readyState < 3`.

---

### `CleaningToggle` Component

```ts
interface CleaningToggleProps {
  isRunning: boolean
  isLoading: boolean   // true while start/stop API call is in-flight
  onStart: () => Promise<void>
  onStop: () => Promise<void>
  error: string | null
}
```

- Renders a single `<button>` that switches label, icon, and color based on `isRunning`.
- `isLoading` disables the button and shows a spinner icon.
- `error` renders an inline `<p role="alert">` adjacent to the button for ≥5 seconds.

---

### `Waveform` Component

```ts
interface WaveformProps {
  isActive: boolean
  reducedMotion: boolean
}
```

- Renders an SVG `<polyline>` or `<path>` positioned absolutely in the dashboard background.
- When `isActive` is `true` and `reducedMotion` is `false`: Framer Motion `animate` drives
  sinusoidal `d` attribute variation with a 1000–3000ms loop duration.
- Transition from active→stopped: `animate` morphs the wave path to a flat horizontal line
  in `color-danger` over 700ms.
- Transition from stopped→active: reverse morph to oscillating path in `color-brand` over 700ms.
- When `reducedMotion` is `true`: static horizontal line, color switches instantly with no
  `transition` duration.

---

### `RemovedSongsPanel` Component

```ts
interface RemovedSong {
  id: string
  track_id: string
  track_name: string
  artist_name?: string   // derived from removal_log or enriched
  playlist_id: string
  album_art?: string
  removed_at: string
}

interface RemovedSongsPanelProps {
  songs: RemovedSong[]
  isLoading: boolean
  error: string | null
  onRetry: () => void
  onReAdd: (id: string) => Promise<void>
}
```

- Maximum height 480px with `overflow-y: auto`.
- Loading state: 3 `LoadingSkeleton` rows at 64px height each.
- Empty state: `<p>No songs removed yet — start a clean to see results here.</p>`
- Re-add: `useRemovals` hook handles optimistic removal (immediate list update) and rollback
  on failure. Error toast auto-dismisses after 5 seconds.


---

## Data Models

### API Response Types

These TypeScript types mirror the shapes returned by the existing Express backend.

```ts
// GET /auth/me
interface MeResponse {
  userId: string
  spotifyId: string
}

// GET /api/status
interface StatusResponse {
  registered: boolean
  isRunning?: boolean
  consecutive204s?: number
  reducedMode?: boolean
  hasLiveTrack?: boolean
}

// GET /api/removals — each item maps to a removal_log row
interface RemovalRecord {
  id: string
  user_id: string
  track_id: string
  playlist_id: string
  track_name: string
  removed_at: string   // ISO 8601
  reason: string
}

// DELETE /api/removals/:id — 204 No Content on success
```

### Static Year-Marker Data Shape

```ts
// lib/yearMarkerData.ts
// TODO: replace with live Spotify year-end data
export const YEAR_MARKERS: YearMarkerDatum[] = [
  {
    year: 1970,
    trackTitle: "Bridge Over Troubled Water",
    artistName: "Simon & Garfunkel",
    albumArt: "/album-art/1970.jpg",
    preview_url: "https://p.scdn.co/mp3-preview/...",   // or null
  },
  // ... 56 more entries (1971–2026)
]
```

### Client-Side Cleaning State

Managed by the `useCleaningState` SWR hook. No local storage — always sourced from the server.

```ts
type CleaningState = 'loading' | 'active' | 'stopped' | 'error'
```

### Audio Playback State

Managed in `AudioContext`; not persisted.

```ts
type AudioPlaybackState = {
  playingUrl: string | null   // null = nothing playing
  isLoading: boolean          // true while audio.readyState < HAVE_ENOUGH_DATA
}
```

### Optimistic Removals State

Managed in `useRemovals` hook using SWR's `mutate` with rollback.

```ts
type RemovalsState = {
  songs: RemovalRecord[]
  pendingReAdds: Set<string>   // set of removal IDs currently in-flight
}
```

### Environment Variables (Frontend)

```
NEXT_PUBLIC_API_BASE_URL         # e.g. https://your-backend.railway.app
NEXT_PUBLIC_SPOTIFY_CLIENT_ID    # for display/audit only; OAuth handled server-side
```


---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system — essentially, a formal statement about what the system should do. Properties serve as the
bridge between human-readable specifications and machine-verifiable correctness guarantees.*

**Property reflection note**: After analyzing all 60+ acceptance criteria, the following criteria
yielded testable properties. Several criteria about component rendering, specific interactions, and
configuration checks are better served by example-based unit tests; those are handled in the Testing
Strategy section. Properties 3 and 4 (waveform transitions) share the same timing invariant and are
combined. Properties 7 and 8 (re-add optimistic UI and rollback) both express invariants over any
removal record and are listed separately because they test distinct parts of the same operation.

---

### Property 1: Timeline path amplitude is always within the bounded range

*For any* call to `generateTimelinePath(count, spacing)` with `count >= 1`, every generated
cubic Bézier segment must have a horizontal control-point amplitude that falls within the
configured `±20px` range of the baseline amplitude, and no two consecutive segments may
have identical control-point x-offsets.

**Validates: Requirements 3.2**

---

### Property 2: Scroll progress maps linearly to drawn path length

*For any* `scrollYProgress` value `p` in the range `[0, 1]`, the `pathLength` motion value
applied to the Timeline_SVG stroke must equal `p` (linear identity mapping). This must hold
for all intermediate scroll positions, not only 0 and 1.

**Validates: Requirements 3.4**

---

### Property 3: Mobile viewport enforces amplitude cap

*For any* viewport width `w` in the range `[1, 639]` pixels, the Timeline_SVG path generation
must produce segments whose horizontal amplitude does not exceed 20px, ensuring no Year_Marker
extends outside the visible screen width.

**Validates: Requirements 3.7**

---

### Property 4: Year-marker data covers every year from 1970 to 2026 without gaps

*For any* rendering of the Landing_Page, the count of `YearMarker` components rendered must
equal exactly 57, and the set of years in the static `YEAR_MARKERS` data must contain every
integer from 1970 to 2026 inclusive with no duplicates and no gaps.

**Validates: Requirements 4.1**

---

### Property 5: Every YearMarker renders all required fields

*For any* `YearMarkerDatum` in the data set, the rendered `YearMarker` component must produce
DOM output containing the track title, artist name, year label, and an `<img>` element. Year
1970 must render with `side='left'`; all subsequent markers must strictly alternate sides
(left, right, left, …) in year order.

**Validates: Requirements 4.2**

---

### Property 6: Preview-URL presence determines audio control visibility

*For any* `YearMarkerDatum`, if `preview_url` is non-null then the rendered `YearMarker` must
include a play/pause button; if `preview_url` is null then no audio control element must be
rendered, and the layout bounding box dimensions of the marker must be identical in both cases.

**Validates: Requirements 4.5, 4.6**

---

### Property 7: At most one preview audio track plays at any time

*For any* sequence of `play(url)` calls issued to the `AudioContext`, the number of
`HTMLAudioElement` instances that are simultaneously in a non-paused state must never exceed 1.
Each new `play()` call must stop the currently playing track within 500ms before starting the
new one.

**Validates: Requirements 5.3, 5.6**

---

### Property 8: Waveform transition duration is always within the 600–800ms window

*For any* cleaning-state transition (active→stopped or stopped→active), the Framer Motion
animation duration applied to the Waveform SVG path must be a value `d` where
`600 <= d <= 800` (milliseconds). The status text label must update within the same `d` ms
window as the Waveform animation. This must hold regardless of how rapidly consecutive
transitions are triggered.

**Validates: Requirements 8.3, 8.4, 8.5**

---

### Property 9: CleaningToggle is disabled for the entire duration of any in-flight API call

*For any* start or stop action triggered by the user, the `CleaningToggle` button must remain
in a disabled state from the moment the API call is initiated until a response (success or
error) is received. No intermediate click events must be processed while disabled.

**Validates: Requirements 7.8**

---

### Property 10: Every song row renders all required fields and a correctly labeled re-add button

*For any* `RemovalRecord` in the removals list, the rendered song row must include: an `<img>`
element with `width=48` and `height=48`, the `track_name` as visible text, and a `<button>`
whose `aria-label` equals exactly `"Re-add {track_name} to playlist"` with the Lucide plus
icon at 20px / stroke 1.5px.

**Validates: Requirements 9.6, 9.10**

---

### Property 11: Optimistic re-add animates row out immediately, then calls the API

*For any* `RemovalRecord` shown in the `RemovedSongsPanel`, clicking its `+` button must
(1) immediately begin animating the row out of the list (within the same event-loop tick),
(2) disable the `+` button before the network request completes, and
(3) issue `DELETE /api/removals/:id` with `credentials: 'include'`.
This sequence must hold regardless of network latency.

**Validates: Requirements 9.7**

---

### Property 12: Failed re-add rolls back the row to its original position

*For any* `RemovalRecord` whose re-add API call returns a non-2xx response, the row must be
re-inserted at the same index it occupied before the optimistic removal, the `+` button must
be re-enabled, and an error toast must be visible and auto-dismiss after exactly 5 seconds.
The rollback must occur even if multiple concurrent re-add requests are in-flight.

**Validates: Requirements 9.8**

---

### Property 13: Every icon-only interactive element has a non-empty accessible name

*For any* interactive element rendered by the App that has no visible text label (icon-only
button), the element's accessible name — resolved via `aria-label`, `aria-labelledby`, or a
visually hidden `<span>` — must be a non-empty string.

**Validates: Requirements 10.2**

---

### Property 14: All album art images carry correctly formatted alt text

*For any* `<img>` element rendered from a `YearMarkerDatum` or `RemovalRecord`, its `alt`
attribute must equal the string `"{trackTitle} by {artistName} album art"` with the actual
track title and artist name substituted; the `alt` attribute must not be empty or missing.

**Validates: Requirements 10.5**


---

## Error Handling

### Authentication Errors

| Scenario | Behavior |
|---|---|
| `/auth/me` returns 401 | Redirect to `/` (server-side in RSC or client-side redirect) |
| `/auth/me` returns 4xx/5xx (non-401) | Show error state on `/dashboard` with retry button; do NOT redirect |
| `/auth/me` request times out (>10s) | Show error state with labeled retry control |
| OAuth callback returns `?error=access_denied` | Inline error notice on landing page; no navigation |
| OAuth callback returns `?error=auth_failed` | Inline error notice on landing page; no navigation |
| POST `/auth/logout` fails or times out | Clear local auth state, redirect to `/`, show "sign-out may be incomplete" message |

### Cleaning Toggle Errors

| Scenario | Behavior |
|---|---|
| POST `/api/polling/start` returns non-2xx | Display inline error adjacent to toggle for ≥5s; revert toggle to stopped state |
| POST `/api/polling/stop` returns non-2xx | Display inline error adjacent to toggle for ≥5s; revert toggle to active state |
| GET `/api/status` fails on load | Default toggle to stopped state; show error indication to user |

### Removed Songs Panel Errors

| Scenario | Behavior |
|---|---|
| GET `/api/removals` returns error | Show inline error message with labeled "Retry" button; clicking retry re-issues the request and shows skeleton loading state |
| DELETE `/api/removals/:id` returns non-2xx | Show dismissible toast (auto-dismisses after 5s); re-insert row at original index; re-enable `+` button; show inline error on the row |
| DELETE `/api/removals/:id` request times out | Treat as non-2xx failure; apply same rollback behavior |

### Preview Player Errors

| Scenario | Behavior |
|---|---|
| Audio `src` fails to load / network error | Play button re-enables; icon returns to play icon; no user-visible error message required (Spotify preview URLs are optional) |
| `preview_url` is null | Play button never rendered; no action taken on click |

### General API Error Conventions

- All `fetch` calls to the backend include `credentials: 'include'` to send the `session` cookie.
- A `10-second` `AbortController` timeout is applied to all auth-related requests.
- Network errors (fetch throws) are treated the same as non-2xx responses for UI purposes.
- Error messages shown to the user are human-readable and do not expose raw API error payloads.

---

## Testing Strategy

This feature involves a mix of UI rendering, scroll-driven animation, audio playback state machines,
and API integration. Property-based testing applies to the mathematical and universal behavioral
constraints; example-based unit tests cover specific UI states and interactions.

### Testing Libraries

| Concern | Library |
|---|---|
| Component rendering + interaction | Vitest + React Testing Library |
| Property-based testing | `fast-check` (TypeScript-native PBT library) |
| End-to-end / integration flows | Playwright |

### Property-Based Tests

Each property below maps to a correctness property in the design. All property tests run a
minimum of **100 iterations**. Each test is tagged with the property it validates.

```
// Tag format: Feature: spotify-playlist-cleaner-frontend, Property {N}: {short description}
```

**Property 1 — Timeline path amplitude bounds**
Generate random `(count, baseAmplitude, seed)` values. Call `generateTimelinePath`. Assert:
- All segment amplitudes satisfy `|amplitude - baseAmplitude| <= 20`.
- No two consecutive segments have identical horizontal control-point offsets.
- `fast-check` arbitraries: `fc.integer({min:1, max:100})` for count.

**Property 2 — Scroll-to-pathLength linear mapping**
Generate random `p` in `[0, 1]` via `fc.float({min:0, max:1})`. Mock `useScroll` to return
`{ scrollYProgress: p }`. Assert the `pathLength` motion value equals `p`.

**Property 3 — Mobile amplitude cap**
Generate random `w` in `[1, 639]` via `fc.integer({min:1, max:639})`. Mock `window.innerWidth = w`.
Call `generateTimelinePath`. Assert all segment amplitudes `<= 20`.

**Property 4 — Year marker data completeness**
Assert `YEAR_MARKERS.length === 57`. Assert `new Set(YEAR_MARKERS.map(m => m.year)).size === 57`.
Assert `min(years) === 1970` and `max(years) === 2026`. *(Also run as a SMOKE test — no PBT
needed here, but verifying the invariant as a computed assertion from the static data.)*

**Property 5 — YearMarker renders all fields**
Generate random `YearMarkerDatum` objects via a `fast-check` arbitrary. Render `YearMarker`.
Assert required fields present in DOM. Assert side alternation from index.

**Property 6 — preview_url determines control visibility + layout parity**
Generate pairs of `YearMarkerDatum` where one has `preview_url = null` and one has a URL.
Assert button present/absent. Assert bounding box dimensions are equal.

**Property 7 — Single audio instance invariant**
Generate a random sequence of `play(url)` calls (2–20 items) via `fc.array(fc.string())`.
After each call, assert `playingCount <= 1`. Assert each new play stops the previous within 500ms.

**Property 8 — Waveform transition duration**
Generate random `isActive` boolean sequences and transition timestamps. Assert animation
duration `d` satisfies `600 <= d <= 800` for each transition.

**Property 9 — Toggle disabled during in-flight call**
Generate random API response delays (10ms–5000ms) via `fc.integer({min:10, max:5000})`.
Assert button has `disabled` attribute for the entire duration of the request.

**Property 10 — Song row required fields and aria-label**
Generate random `RemovalRecord` objects. Render `RemovedSongsPanel`. Assert img dimensions,
track name text, and aria-label format for each row.

**Property 11 — Optimistic re-add sequence**
Generate random `RemovalRecord` lists. Simulate `+` click. Assert row animation starts within
same tick, button disabled before response, DELETE called with correct ID.

**Property 12 — Re-add rollback correctness**
Generate random `RemovalRecord` lists with random target index. Mock DELETE to return 500.
Simulate `+` click. Assert row re-inserted at original index, button re-enabled, toast shown
and auto-dismissed after 5s.

**Property 13 — Icon-only elements have accessible names**
Generate random component states. For all rendered `<button>` elements without visible text
children, assert `aria-label` is non-empty string.

**Property 14 — Alt text format**
Generate random `{trackTitle, artistName}` pairs via `fc.string()`. Render components.
Assert `img.alt === "{trackTitle} by {artistName} album art"`.

---

### Example-Based Unit Tests

Example tests focus on specific UI states, branching conditions, and single-event behaviors.

- Design system token values match spec (SMOKE — run once per CI build)
- `LandingPage` renders without session cookie
- "Sign in with Spotify" button redirects to `NEXT_PUBLIC_API_BASE_URL + /auth/spotify`
- Error query param `?error=access_denied` displays inline error notice
- Heading words "SPOTIFY", "PLAYLIST", "CLEANER" present in correct scroll ranges
- `TimelineSVG` mounts with `pathLength = 0`; `getPointAtLength` called 57 times on mount
- `getPointAtLength` called again on window resize
- `prefers-reduced-motion`: `TimelineSVG` renders with `pathLength = 1`, no scroll listener
- `YearMarker` entrance animation config: `opacity 0→1`, `scale 0.92→1`, `400ms ease-out`
- Audio play button disables while loading (`readyState < HAVE_ENOUGH_DATA`)
- Audio pause click sets `audio.paused = true` and reverts icon
- `audio` `ended` event resets icon to play
- `null` `preview_url` renders no audio control
- Dashboard `/auth/me` 401 → redirect to `/`
- Dashboard `/auth/me` 500 → error state (no redirect)
- Auth load timeout at 10s shows error with retry
- Dashboard header renders "Dashboard" title and user avatar
- Avatar dropdown contains "Sign out"
- Successful logout redirects to `/`
- Failed logout redirects with "sign-out may be incomplete" message
- `CleaningToggle` stopped state: green, "Start Cleaning", play icon
- `CleaningToggle` active state: red, "Stop Cleaning", stop icon
- Toggle state reverts on API failure, error shown for ≥5s
- `/api/status` called on Dashboard load; `isRunning` initializes toggle
- Failed `/api/status` defaults to stopped + error indication
- `Waveform` active + reduced-motion: static line, no transition
- `Waveform` state change + reduced-motion: instant color change
- `RemovedSongsPanel` title "Removed Songs", no nested cards
- `/api/removals` populates panel with data
- Loading state shows exactly 3 skeleton rows
- Error state shows error message + retry button; retry re-issues request
- Empty state shows correct message text
- Panel height capped at 480px with independent scroll
- Waveform status text has `role="status"` and `aria-live="polite"`
- Removal toast container has `aria-live="polite"`
- Semantic HTML: `main`, `header`, `section`, `button` present on both pages

---

### Integration / E2E Tests (Playwright)

- Full OAuth flow: click "Sign in with Spotify" → OAuth redirect → dashboard renders
- Dashboard data loads within 5 seconds of OAuth redirect
- Start/stop cleaning toggle updates state end-to-end
- Re-add song removes from panel and calls correct backend endpoint
- Sign out returns to landing page
- Session expiry at `/dashboard` redirects to `/`

