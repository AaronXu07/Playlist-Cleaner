# Implementation Plan: Spotify Playlist Cleaner Frontend

## Overview

Build the `spotify-cleaner-frontend/` Next.js 14 (App Router) + TypeScript application from scratch.
The implementation proceeds in layers: project scaffolding and design tokens → landing page (timeline,
year markers, preview player) → dashboard (auth guard, cleaning toggle, waveform, removed songs panel)
→ accessibility polish → integration wiring and E2E tests.

All code targets the existing Express 5 backend at `NEXT_PUBLIC_API_BASE_URL`.

---

## Tasks

- [ ] 1. Scaffold project and configure design system
  - [ ] 1.1 Initialise Next.js 14 App Router + TypeScript project
    - Run `npx create-next-app@14 spotify-cleaner-frontend --typescript --tailwind --app --no-src-dir --import-alias "@/*"` inside the `Playlist-Cleaner/` root
    - Delete boilerplate (`page.tsx` content, `globals.css` content, sample images)
    - Add `swr`, `framer-motion`, `lucide-react` as production dependencies
    - Add `vitest`, `@vitest/coverage-v8`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `fast-check`, `@playwright/test`, `jsdom` as dev dependencies
    - Configure `vitest.config.ts` with `jsdom` environment and `@testing-library/jest-dom` setup file
    - Configure `playwright.config.ts` targeting `http://localhost:3000`
    - Create `.env.local` with `NEXT_PUBLIC_API_BASE_URL=` and `NEXT_PUBLIC_SPOTIFY_CLIENT_ID=` placeholders
    - _Requirements: 1.1–1.10, 2.1_

  - [ ] 1.2 Define design tokens in `globals.css` and `tailwind.config.ts`
    - Add all CSS custom properties to `:root` in `app/globals.css`: `--color-bg-base` (#121212), `--color-bg-surface` (#181818), `--color-bg-surface-hover` (#282828), `--color-brand` (#1DB954), `--color-danger` (#E74C3C), `--color-text-primary` (#FFFFFF), `--color-text-muted` (#A7A7A7), `--shadow-elevated`, `--radius-card`, `--radius-pill`
    - Extend `tailwind.config.ts` theme with `colors`, `boxShadow`, and `borderRadius` entries mapping each token to its CSS variable
    - Set `fontFamily` to `['Inter', 'system-ui', 'sans-serif']` and restrict `fontSize` to the 8-value type scale (12, 14, 16, 20, 24, 32, 48, 64px)
    - Set `body` background to `bg-base` and default text to `text-primary` in `globals.css`
    - Add `@media (prefers-reduced-motion: reduce)` block in `globals.css` for global animation suppression
    - _Requirements: 1.1–1.10_

  - [ ]* 1.3 Write unit tests for design token values (SMOKE)
    - Verify all 9 CSS custom property values are present in `globals.css` with exact hex values
    - Verify `tailwind.config.ts` exports each token as a Tailwind utility class
    - Verify no purple hue values and no gradient declarations exist anywhere in `globals.css`
    - _Requirements: 1.1–1.4, 1.9_


- [ ] 2. Build the `lib/` layer — API helpers and static data
  - [ ] 2.1 Create `lib/api.ts` with typed fetch wrappers
    - Define all response types: `MeResponse`, `StatusResponse`, `RemovalRecord`
    - Implement `getMe()` → `GET /auth/me`; `getStatus()` → `GET /api/status`; `getRemovals()` → `GET /api/removals`; `postPollingStart()` → `POST /api/polling/start`; `postPollingStop()` → `POST /api/polling/stop`; `deleteRemoval(id)` → `DELETE /api/removals/:id`; `postLogout()` → `POST /auth/logout`
    - All calls include `credentials: 'include'` and base URL from `NEXT_PUBLIC_API_BASE_URL`
    - Apply a 10-second `AbortController` timeout to `getMe()` and `postLogout()`; treat network errors and non-2xx responses uniformly
    - _Requirements: 6.2, 6.7, 7.1, 7.7, 9.2_

  - [ ] 2.2 Create `lib/yearMarkerData.ts` with static curated song data
    - Define the `YearMarkerDatum` TypeScript interface: `{ year, trackTitle, artistName, albumArt, preview_url: string | null }`
    - Add `// TODO: replace with live Spotify year-end data` file-level comment
    - Populate `YEAR_MARKERS` array with 57 entries for years 1970–2026 sourced from Billboard Hot 100 year-end charts; `preview_url` can be `null` for entries without a known preview URL
    - Export `YEAR_MARKERS` as a named const
    - _Requirements: 4.1, 4.4_

  - [ ]* 2.3 Write property test for year-marker data completeness (Property 4)
    - **Property 4: Year-marker data covers every year from 1970 to 2026 without gaps**
    - Assert `YEAR_MARKERS.length === 57`
    - Assert `new Set(YEAR_MARKERS.map(m => m.year)).size === 57` (no duplicates)
    - Assert `Math.min(...years) === 1970` and `Math.max(...years) === 2026`
    - Assert every integer from 1970 to 2026 inclusive is present
    - **Validates: Requirements 4.1**


- [ ] 3. Implement the Timeline SVG path generator
  - [ ] 3.1 Create `lib/generateTimelinePath.ts`
    - Implement `generateTimelinePath(count: number, spacing: number, baseAmplitude: number, seed: number): string` that returns an SVG path `d` attribute string
    - Each of the `count` segments is a cubic Bézier curve alternating left/right; `baseAmplitude` is the center amplitude; per-segment offset is a deterministic pseudo-random value in the range `[-20, +20]`; no two consecutive segments may share identical control-point x-offsets
    - Accept a `mobile` flag (or derive from `baseAmplitude`) to cap amplitude at 20px when viewport < 640px
    - Export the function and a helper `getMarkerSpacings(count, spacing): number[]` returning the cumulative arc-length positions for `getPointAtLength` calls
    - _Requirements: 3.1, 3.2, 3.7_

  - [ ]* 3.2 Write property tests for timeline path amplitude bounds (Properties 1 and 3)
    - **Property 1: Timeline path amplitude is always within the bounded range**
    - Use `fc.integer({min:1, max:100})` for `count`, `fc.integer({min:20, max:200})` for `baseAmplitude`, `fc.integer()` for `seed`
    - Parse generated path segments; assert all control-point amplitudes satisfy `|amplitude - baseAmplitude| <= 20`
    - Assert no two consecutive segments have identical horizontal control-point x-offsets
    - **Property 3: Mobile viewport enforces amplitude cap**
    - Use `fc.integer({min:1, max:639})` for `w`; call `generateTimelinePath` with mobile-capped amplitude; assert all segment amplitudes `<= 20`
    - Run a minimum of 100 iterations each
    - **Validates: Requirements 3.2, 3.7**


- [ ] 4. Build the `AudioContext` provider and `PreviewButton` component
  - [ ] 4.1 Create `context/AudioContext.tsx`
    - Implement `AudioProvider` wrapping a singleton `new Audio()` instance; define `AudioContextValue`: `{ playingUrl: string | null, isLoading: boolean, play: (url: string) => Promise<void>, pause: () => void, stop: () => void }`
    - `play(url)`: call `stop()`, set `audio.src = url`, call `audio.play()`; expose `isLoading` as `audio.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA`
    - Wire `audio.ended` event to reset `playingUrl` to `null` and icon to play state
    - Ensure at most one `Audio` instance exists across the provider lifecycle
    - Export `useAudio()` hook that throws if used outside the provider
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 4.2 Write property test for single audio instance invariant (Property 7)
    - **Property 7: At most one preview audio track plays at any time**
    - Use `fc.array(fc.string({minLength:1}), {minLength:2, maxLength:20})` to generate URL sequences
    - After each `play(url)` call, assert `playingUrl` reflects only the latest URL
    - Assert `HTMLAudioElement` mock is never in a non-paused state for more than one URL simultaneously
    - Assert each new `play()` call invokes `audio.pause()` on the previous source within 500ms
    - Run a minimum of 100 iterations
    - **Validates: Requirements 5.3, 5.6**

  - [ ] 4.3 Create `components/landing/PreviewButton.tsx`
    - Render a Lucide `Play` icon button (20px, stroke 1.5px) on album art when `datum.preview_url !== null`; render nothing when `preview_url` is null but preserve the marker's layout dimensions via a transparent placeholder of equal size
    - Button is disabled while `isLoading` is `true` (audio `readyState < HAVE_ENOUGH_DATA`); switch icon to `Pause` once `playingUrl === datum.preview_url`
    - Add `aria-label="Play preview for {trackTitle}"` / `"Pause preview for {trackTitle}"` and a visible 2px focus ring
    - _Requirements: 4.5, 4.6, 5.2, 5.4, 5.7, 10.2, 10.3_


- [ ] 5. Build `YearMarker` component
  - [ ] 5.1 Create `components/landing/YearMarker.tsx`
    - Accept `YearMarkerProps`: `{ datum, position: {x,y}, side: 'left'|'right', isPlaying, onPlay, onPause }`
    - Render: 48×48px square `<img>` with `alt="{trackTitle} by {artistName} album art"`, track title (`text-sm`), artist name (`text-muted text-xs`), year label (`text-xs font-bold`)
    - Year label and content offset to the left when `side === 'left'`, to the right when `side === 'right'`
    - Wrap content in Framer Motion `motion.div` with `whileInView={{ opacity: 1, scale: 1 }}` from `initial={{ opacity: 0, scale: 0.92 }}`, transition `{ duration: 0.4, ease: 'easeOut' }`, `viewport={{ once: true }}`
    - Compose `PreviewButton` for the album art overlay
    - Position the marker absolutely at `{ left: position.x, top: position.y }` within the SVG container
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 10.5_

  - [ ]* 5.2 Write property tests for YearMarker rendering (Properties 5 and 6)
    - **Property 5: Every YearMarker renders all required fields**
    - Define `fc.record({ year: fc.integer({min:1970,max:2026}), trackTitle: fc.string({minLength:1}), artistName: fc.string({minLength:1}), albumArt: fc.constant('/test.jpg'), preview_url: fc.option(fc.string({minLength:1})) })` arbitrary
    - Render `YearMarker`; assert `img` present with correct `alt`; assert `trackTitle`, `artistName`, `year` text nodes present in DOM
    - Assert year 1970 always rendered with `side='left'`; assert side strictly alternates by index
    - **Property 6: preview_url presence determines audio control visibility + layout parity**
    - Generate pairs (one with `preview_url: string`, one with `preview_url: null`); assert button present/absent accordingly; assert bounding-box dimensions equal between the two
    - Run a minimum of 100 iterations each
    - **Validates: Requirements 4.2, 4.5, 4.6**


- [ ] 6. Build `TimelineSVG` component and the Landing Page
  - [ ] 6.1 Create `components/landing/TimelineSVG.tsx`
    - SVG element with `height={31350}` (57 × 550px); `viewBox` matches; `<motion.path>` with `pathLength` MotionValue
    - On mount: call `generateTimelinePath(57, 550, baseAmplitude, seed)` to set `d`; call `svgPathEl.getPointAtLength(t)` 57 times for marker positions; store positions in state
    - Wire `useScroll({ target: containerRef }).scrollYProgress` via `useTransform` to the `pathLength` MotionValue (identity mapping `p → p`)
    - On `window` `resize`: recompute all 57 marker positions via `getPointAtLength`; if `window.innerWidth < 640` use `baseAmplitude = 20`
    - If `prefers-reduced-motion`: set `pathLength = 1` immediately, skip `useScroll` wiring, all markers visible
    - Render `YearMarker` for each computed position, alternating `side` starting with `'left'` at index 0 (year 1970)
    - _Requirements: 3.1–3.8, 4.1, 4.2_

  - [ ]* 6.2 Write property test for scroll-to-pathLength mapping (Property 2)
    - **Property 2: Scroll progress maps linearly to drawn path length**
    - Use `fc.float({min:0, max:1})` to generate `scrollYProgress` values
    - Mock Framer Motion `useScroll` to return `{ scrollYProgress: mockMotionValue(p) }` for each `p`
    - Render `TimelineSVG` in reduced-motion-off mode; assert the `pathLength` MotionValue equals `p` for every input
    - Assert the mapping holds at boundary values `0` and `1` and for at least 100 arbitrary intermediate values
    - **Validates: Requirements 3.4**

  - [ ]* 6.3 Write unit tests for `TimelineSVG` mount and resize behaviour
    - Assert `getPointAtLength` is called exactly 57 times on mount
    - Assert `getPointAtLength` is called again after `window.resize` event fires
    - Assert `pathLength` MotionValue starts at `0` on mount (without `prefers-reduced-motion`)
    - Assert `pathLength` MotionValue is `1` when `prefers-reduced-motion: reduce` is active
    - _Requirements: 3.3, 3.5, 3.6, 3.8_

  - [ ] 6.4 Create `app/page.tsx` — Landing Page (Client Component)
    - Mark with `'use client'`; wrap in `<AudioProvider>`; use a scroll container `ref` passed to `TimelineSVG`
    - Render the three heading words: "SPOTIFY" pinned to the 1970–2000 scroll range, "PLAYLIST" to 2000–2020, "CLEANER" to 2020–2022; use Framer Motion `useTransform` on `scrollYProgress` for opacity/position of each
    - Render "Sign in with Spotify" `<a href={NEXT_PUBLIC_API_BASE_URL + '/auth/spotify'}>` button styled with `color-brand` outline, `border-radius: 9999px`, positioned at the terminal end of the timeline
    - If URL search param `?error=access_denied` or `?error=auth_failed` is present, display an inline `<p role="alert">` error notice within page content without obscuring interactive elements; no navigation
    - Use semantic HTML: `<main>`, `<section>` landmarks
    - _Requirements: 2.1–2.7, 10.6_

  - [ ]* 6.5 Write unit tests for Landing Page behaviour
    - Assert page renders without a session cookie
    - Assert "Sign in with Spotify" button href equals `NEXT_PUBLIC_API_BASE_URL + '/auth/spotify'`
    - Assert `?error=access_denied` param renders inline error notice
    - Assert heading words "SPOTIFY", "PLAYLIST", "CLEANER" all present in DOM
    - Assert no emoji characters exist in the rendered output
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7_


- [ ] 7. Checkpoint — Landing page complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Build shared UI primitives
  - [ ] 8.1 Create `components/ui/LoadingSkeleton.tsx`
    - Render a `<div>` of given `width`, `height`, and `borderRadius` with a pulsing CSS animation using `bg-surface-hover`; no Framer Motion dependency
    - _Requirements: 9.3_

  - [ ] 8.2 Create `components/ui/Toast.tsx`
    - Render a fixed-position dismissible toast with `aria-live="polite"` on its container
    - Accept `message: string`, `onDismiss: () => void`, `autoDismissMs?: number` (default 5000)
    - Auto-dismiss by calling `onDismiss` after `autoDismissMs`; provide a visible close button with `aria-label="Dismiss notification"`
    - _Requirements: 9.8, 10.1, 10.9_

  - [ ] 8.3 Create `components/ui/Avatar.tsx` and `components/ui/DropdownMenu.tsx`
    - `Avatar`: circular `<button>` (40×40px) displaying the user's Spotify display initials or a fallback icon; `aria-label="User menu"` and a visible focus ring
    - `DropdownMenu`: a `<nav>` panel that appears on avatar click; contains a "Sign out" `<button>` with `aria-label="Sign out"`; closes on outside click and on `Escape` key
    - _Requirements: 6.5, 6.6, 6.7, 10.2, 10.3_


- [ ] 9. Build `CleaningToggle` and `useCleaningState` hook
  - [ ] 9.1 Create `hooks/useCleaningState.ts`
    - SWR fetcher calling `getStatus()` from `lib/api.ts`; return `{ state: CleaningState, isLoading, error, start, stop }` where `CleaningState = 'loading' | 'active' | 'stopped' | 'error'`
    - `start()`: call `postPollingStart()`; on success mutate SWR to `'active'`; on failure revert and set error
    - `stop()`: call `postPollingStop()`; on success mutate SWR to `'stopped'`; on failure revert and set error
    - Default to `'stopped'` if the status fetch fails; expose error string
    - _Requirements: 7.1, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [ ] 9.2 Create `components/dashboard/CleaningToggle.tsx`
    - Accept `CleaningToggleProps`: `{ isRunning, isLoading, onStart, onStop, error }`
    - Stopped state: `bg-brand` button, "Start Cleaning" label, Lucide `Play` icon (20px, stroke 1.5px)
    - Active state: `bg-danger` button, "Stop Cleaning" label, Lucide `Square` icon (20px, stroke 1.5px)
    - `isLoading`: button `disabled`, replace icon with a spinner
    - `error`: render `<p role="alert">` adjacent to button; ensure it remains visible ≥5 seconds before clearing
    - Button `border-radius: 9999px`; visible 2px focus ring
    - _Requirements: 7.1–7.9, 10.3_

  - [ ]* 9.3 Write property test for toggle disabled during in-flight call (Property 9)
    - **Property 9: CleaningToggle is disabled for the entire duration of any in-flight API call**
    - Use `fc.integer({min:10, max:5000})` for mock API response delays
    - Simulate click; at regular intervals during the delay assert `button.disabled === true`
    - Assert button becomes enabled again after response (success or error)
    - Assert no second API call is triggered by intermediate clicks while disabled
    - Run a minimum of 100 iterations
    - **Validates: Requirements 7.8**

  - [ ]* 9.4 Write unit tests for CleaningToggle states
    - Assert stopped state renders green button with "Start Cleaning" and Play icon
    - Assert active state renders red button with "Stop Cleaning" and Square icon
    - Assert error message is visible for ≥5 seconds after a failed API call and button reverts to pre-click state
    - Assert `/api/status` `isRunning` field initialises the toggle state correctly
    - Assert failed status fetch defaults toggle to stopped with an error indication
    - _Requirements: 7.2, 7.3, 7.6, 7.7, 7.9_


- [ ] 10. Build `Waveform` component
  - [ ] 10.1 Create `components/dashboard/Waveform.tsx`
    - Accept `WaveformProps`: `{ isActive: boolean, reducedMotion: boolean }`
    - Render an absolutely-positioned SVG `<motion.path>` spanning the dashboard background negative space
    - Active + `reducedMotion === false`: Framer Motion `animate` drives a looping sinusoidal `d` variation; loop duration between 1000ms and 3000ms; `repeat: Infinity`, `ease: 'easeInOut'`
    - Transition active→stopped: `animate` morphs path to a flat horizontal line in `color-danger`, transition `{ duration: 0.7 }` (700ms, within 600–800ms window)
    - Transition stopped→active: reverse morph to oscillating path in `color-brand`, transition `{ duration: 0.7 }`
    - `reducedMotion === true`: static horizontal line; color matches `isActive` state (`color-brand` / `color-danger`); no CSS `transition` property
    - Render a status text label below the SVG: `"Cleaning in progress"` when active, `"Stopped"` when stopped; apply `role="status"` and `aria-live="polite"`; label updates within the same 700ms transition window
    - _Requirements: 8.1–8.7, 10.4_

  - [ ]* 10.2 Write property test for waveform transition duration (Property 8)
    - **Property 8: Waveform transition duration is always within the 600–800ms window**
    - Use `fc.boolean()` to generate `isActive` sequences; simulate rapid consecutive state transitions
    - Assert every Framer Motion transition applied to the Waveform path has `duration` satisfying `0.6 <= duration <= 0.8` (seconds)
    - Assert the status text label updates within the same transition window as the Waveform animation
    - Run a minimum of 100 iterations
    - **Validates: Requirements 8.3, 8.4, 8.5**

  - [ ]* 10.3 Write unit tests for Waveform reduced-motion behaviour
    - Assert `reducedMotion=true` + `isActive=true` renders static horizontal line in `color-brand` with no CSS `transition`
    - Assert `reducedMotion=true` + `isActive=false` renders static horizontal line in `color-danger`
    - Assert color updates instantly (no transition) when `isActive` toggles while `reducedMotion=true`
    - Assert status text element has `role="status"` and `aria-live="polite"` attributes
    - _Requirements: 8.6, 8.7, 10.4_


- [ ] 11. Build `RemovedSongsPanel` and `useRemovals` hook
  - [ ] 11.1 Create `hooks/useRemovals.ts`
    - SWR fetcher calling `getRemovals()` from `lib/api.ts`; return `{ songs, pendingReAdds: Set<string>, isLoading, error, reAdd, retry }`
    - `reAdd(id)`: immediately remove the record from the local SWR cache (optimistic); call `deleteRemoval(id)`; on failure re-insert the record at its original index, add inline error to the row, and schedule toast dismiss after 5 seconds
    - `retry()`: clear error state and re-trigger the SWR fetch
    - Track `pendingReAdds` as a `Set<string>` of in-flight removal IDs
    - _Requirements: 9.2, 9.7, 9.8_

  - [ ] 11.2 Create `components/dashboard/RemovedSongsPanel.tsx`
    - Accept `RemovedSongsPanelProps`: `{ songs, isLoading, error, onRetry, onReAdd }`
    - Card title `"Removed Songs"` (`text-xl font-bold`); `max-height: 480px`, `overflow-y: auto`; no nested cards
    - Loading state: 3 `LoadingSkeleton` rows at 64px height each
    - Error state: inline `<p>` error message + labeled `<button>Retry</button>` with `aria-label="Retry loading removed songs"`; clicking retry shows skeleton state
    - Empty state: `<p>No songs removed yet — start a clean to see results here.</p>`
    - Each song row: 48×48px `<img>` with `alt="{track_name} by {artist_name} album art"`, `track_name` text, `artist_name` text, `+` button with Lucide `Plus` icon (20px, stroke 1.5px), `aria-label="Re-add {track_name} to playlist"`, visible 2px focus ring
    - On `+` click: animate row out with Framer Motion `exit={{ opacity: 0, height: 0 }}` over 200ms; disable button while in-flight; show `Toast` with `aria-live="polite"` container on failure
    - _Requirements: 9.1–9.10, 10.1, 10.2, 10.3, 10.5, 10.9_

  - [ ]* 11.3 Write property tests for song row rendering and aria-label (Property 10)
    - **Property 10: Every song row renders all required fields and a correctly labeled re-add button**
    - Define `fc.record({ id: fc.uuidV4(), track_id: fc.string(), track_name: fc.string({minLength:1}), artist_name: fc.string({minLength:1}), playlist_id: fc.string(), album_art: fc.constant('/test.jpg'), removed_at: fc.date().map(d => d.toISOString()) })` arbitrary
    - Render `RemovedSongsPanel` with generated records; for each row assert: `img[width=48][height=48]` present, `track_name` visible, `button[aria-label="Re-add {track_name} to playlist"]` present with Lucide `Plus` at 20px
    - Run a minimum of 100 iterations
    - **Validates: Requirements 9.6, 9.10**

  - [ ]* 11.4 Write property tests for optimistic re-add and rollback (Properties 11 and 12)
    - **Property 11: Optimistic re-add animates row out immediately, then calls the API**
    - Generate `fc.array(removalRecordArbitrary, {minLength:1, maxLength:20})`; pick a random target index; simulate `+` click
    - Assert row animation begins within the same event-loop tick (before `await` resolves)
    - Assert `+` button `disabled` before network response
    - Assert `deleteRemoval` called with correct `id` and `credentials: 'include'`
    - **Property 12: Failed re-add rolls back the row to its original position**
    - Mock `deleteRemoval` to return a rejected promise (HTTP 500)
    - Assert row re-inserted at its original index after rollback
    - Assert `+` button re-enabled after rollback
    - Assert toast is visible and `onDismiss` is invoked after exactly 5 seconds
    - Assert rollback is correct even when multiple concurrent re-add requests are in-flight
    - Run a minimum of 100 iterations each
    - **Validates: Requirements 9.7, 9.8**


- [ ] 12. Build the Dashboard route and `DashboardShell` client component
  - [ ] 12.1 Create `app/dashboard/page.tsx` as a Server Component
    - Call `getMe()` server-side (no `'use client'`); if response status is 401, call `redirect('/')`; if response is any other non-200 or throws, render an error state with a visible retry control (do NOT redirect)
    - If the `getMe()` request does not complete within 10 seconds, render the error state with a labeled retry control
    - On success, render `<DashboardShell user={meResponse} />`
    - Use `<Suspense>` with a loading spinner fallback to prevent flashing dashboard content before auth resolves
    - _Requirements: 6.1–6.3_

  - [ ] 12.2 Create `components/dashboard/DashboardShell.tsx` (Client Component)
    - Mark with `'use client'`; wire `useCleaningState` and `useRemovals` hooks
    - `<header>`: semantic `<header>` with "Dashboard" `<h1>` and `<Avatar>` in top-right; avatar opens `<DropdownMenu>` with "Sign out" action
    - Sign out: call `postLogout()`; on success redirect to `/`; on failure or timeout (10s) clear local auth state, redirect to `/`, display "sign-out may be incomplete" error message
    - `<main>`: render `<Waveform isActive={state === 'active'} reducedMotion={prefersReducedMotion} />` in background; render central card with `<CleaningToggle>` and `<RemovedSongsPanel>` in the foreground
    - Read `prefersReducedMotion` via `window.matchMedia('(prefers-reduced-motion: reduce)')` in a `useEffect`
    - Use semantic HTML: `<header>`, `<main>`, `<section>`
    - _Requirements: 6.4–6.8, 8.1, 9.1, 10.4, 10.6_

  - [ ]* 12.3 Write unit tests for Dashboard auth and header behaviour
    - Assert `/auth/me` 401 response triggers redirect to `/`
    - Assert `/auth/me` 500 response renders error state without redirecting
    - Assert auth load timeout at 10s shows error state with retry control
    - Assert Dashboard header renders "Dashboard" title and user avatar
    - Assert avatar dropdown contains "Sign out"
    - Assert successful logout redirects to `/`
    - Assert failed logout redirects to `/` with "sign-out may be incomplete" message
    - Assert loading indicator shown while auth check is in-flight, dashboard content not visible
    - _Requirements: 6.1–6.8_


- [ ] 13. Checkpoint — Dashboard components complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Accessibility and cross-cutting concerns
  - [ ] 14.1 Audit and enforce accessible names on all icon-only interactive elements
    - Sweep all `<button>` elements in `PreviewButton`, `CleaningToggle`, `Avatar`, `DropdownMenu`, `RemovedSongsPanel`, `Toast`
    - Add or correct `aria-label` / `aria-labelledby` on any button that has no visible text child
    - Ensure every interactive element has a 2px focus ring with ≥3:1 contrast against `bg-base` / `bg-surface`
    - _Requirements: 10.2, 10.3_

  - [ ]* 14.2 Write property tests for accessible names and alt text (Properties 13 and 14)
    - **Property 13: Every icon-only interactive element has a non-empty accessible name**
    - Generate arbitrary component state combinations via `fc.record`; render each component tree; query all `<button>` elements with no visible text child; assert each has a non-empty `aria-label` attribute
    - **Property 14: All album art images carry correctly formatted alt text**
    - Generate `fc.record({ trackTitle: fc.string({minLength:1}), artistName: fc.string({minLength:1}) })` pairs; render `YearMarker` and `RemovedSongsPanel` rows; assert every `img.alt === "{trackTitle} by {artistName} album art"` with actual values substituted; assert `alt` is never empty or undefined
    - Run a minimum of 100 iterations each
    - **Validates: Requirements 10.2, 10.5**

  - [ ] 14.3 Verify semantic HTML structure on both routes
    - Assert `<main>` and `<header>` present on both `/` and `/dashboard`
    - Assert `<section>` landmarks used for major content regions
    - Assert no `<div>` acting as a button (no `onClick` without `role="button"` or native `<button>`)
    - Assert `role="status"` and `aria-live="polite"` on Waveform status label
    - Assert `aria-live="polite"` on toast containers
    - _Requirements: 10.4, 10.6, 10.9_

  - [ ] 14.4 Enforce Design System compliance — purge unsanctioned colors
    - Scan all `*.tsx` and `*.css` files for inline `color`, `background`, `border-color` values not derived from Design System tokens
    - Override any component-library default styles (e.g. SWR, Lucide) that introduce unsanctioned colors
    - Verify no purple hues and no `gradient` declarations exist in the codebase
    - _Requirements: 1.3, 1.9, 10.7, 10.8_


- [ ] 15. Wire root layout and providers
  - [ ] 15.1 Create `app/layout.tsx` — root layout with global providers
    - Wrap `{children}` in `<SWRConfig>` with global `fetcher` and `shouldRetryOnError: false`
    - Import and apply `globals.css`
    - Set `<html lang="en">` and `<body className="bg-base text-primary">`
    - No `<AudioProvider>` here — scope it to `app/page.tsx` only (landing page only)
    - _Requirements: 2.1, 6.1_

  - [ ] 15.2 Create `next.config.ts`
    - Add `images.remotePatterns` for `i.scdn.co` (Spotify CDN for album art) and `p.scdn.co` (preview URLs)
    - Set `reactStrictMode: true`
    - _Requirements: 4.2, 5.1_

- [ ] 16. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 17. End-to-end integration tests (Playwright)
  - [ ]* 17.1 Write Playwright E2E test: full OAuth flow
    - Navigate to `/`; click "Sign in with Spotify"; mock OAuth redirect back to `/dashboard`; assert Dashboard renders with user avatar within 5 seconds
    - Assert `/auth/me` was called with the session cookie
    - **Validates: Requirements 2.4, 6.1**

  - [ ]* 17.2 Write Playwright E2E test: start/stop cleaning toggle end-to-end
    - On Dashboard, mock `/api/status` returning `{ isRunning: false }`; assert "Start Cleaning" button visible
    - Click "Start Cleaning"; mock `/api/polling/start` returning `{ polling: true }`; assert toggle switches to "Stop Cleaning"
    - Click "Stop Cleaning"; mock `/api/polling/stop`; assert toggle reverts to "Start Cleaning"
    - **Validates: Requirements 7.4, 7.5**

  - [ ]* 17.3 Write Playwright E2E test: re-add song removes it from the panel
    - Mock `/api/removals` with 2 records; assert both rows visible
    - Click `+` on first row; mock `DELETE /api/removals/:id` with 204; assert row removed from panel
    - **Validates: Requirements 9.2, 9.7**

  - [ ]* 17.4 Write Playwright E2E test: sign out and session expiry
    - On Dashboard, click avatar → "Sign out"; mock `/auth/logout`; assert redirect to `/`
    - Navigate to `/dashboard` with no session cookie; assert redirect to `/`
    - **Validates: Requirements 6.6, 6.7**


---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP build
- Each task references specific requirements for full traceability
- The design document already uses TypeScript — no language selection step needed
- Correctness Properties 1–14 from the design document each map to exactly one `*` sub-task
- All `fetch` calls must include `credentials: 'include'`; never expose the `session` cookie value to client JS
- SWR's `mutate` is used for optimistic updates; always store the pre-mutation snapshot for rollback
- `fast-check` property tests must run a minimum of 100 iterations (`fc.assert(fc.property(...), { numRuns: 100 })`)
- Playwright tests mock the backend; the backend does not need to be running for E2E tests
- `generateTimelinePath` seed must be deterministic so SSR and client hydration produce identical paths

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "2.2", "3.1", "8.1", "8.2", "8.3"] },
    { "id": 2, "tasks": ["2.3", "3.2", "4.1", "9.1", "11.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.1", "9.2", "10.1", "11.2"] },
    { "id": 4, "tasks": ["5.2", "6.1", "9.3", "9.4", "10.2", "10.3", "11.3", "11.4"] },
    { "id": 5, "tasks": ["6.2", "6.3", "6.4", "12.1", "12.2"] },
    { "id": 6, "tasks": ["6.5", "12.3", "14.1", "15.1", "15.2"] },
    { "id": 7, "tasks": ["14.2", "14.3", "14.4"] },
    { "id": 8, "tasks": ["17.1", "17.2", "17.3", "17.4"] }
  ]
}
```
