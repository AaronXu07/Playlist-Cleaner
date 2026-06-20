# Requirements Document

## Introduction

The Spotify Playlist Cleaner Frontend is a Next.js (React) + TypeScript web application that provides two routes: a public landing page (`/`) and an authenticated dashboard (`/dashboard`). The landing page uses a scroll-driven animated SVG timeline to present the product story, ending with a Spotify sign-in call-to-action. The dashboard lets authenticated users start or stop the background cleaning engine, view removed songs, and re-add tracks — all connected to the existing Express backend via its HTTP API. The design system enforces a single-accent color palette (Spotify green for active/brand, status red for stopped/destructive, no gradients) and respects the user's motion preferences throughout.

---

## Glossary

- **App**: The Spotify Playlist Cleaner Next.js frontend application.
- **Landing_Page**: The public route at `/`, visible to unauthenticated visitors.
- **Dashboard**: The protected route at `/dashboard`, accessible only to authenticated users.
- **Design_System**: The shared set of color tokens, type scale, spacing scale, icon rules, and motion rules defined in Section 1 of the spec and referenced by all components.
- **Timeline_SVG**: The single `<path>` SVG element that spans the full scroll height of the Landing_Page and animates its draw progress relative to the user's scroll position.
- **Year_Marker**: A visual element placed exactly on the Timeline_SVG curve for a given year (1970–2026), displaying a representative album cover thumbnail, track title, and year label.
- **Preview_Player**: The in-page audio component that plays a 30-second Spotify preview clip when a Year_Marker is activated; only one Preview_Player instance plays at a time.
- **Waveform**: The EKG-style animated SVG graphic rendered in the Dashboard background that reflects the current cleaning state — oscillating green when active, collapsing to a flat red line when stopped.
- **Cleaning_Toggle**: The single button on the Dashboard that starts or stops the cleaning engine by calling the backend polling endpoints; its label, icon, and color update to reflect the current state.
- **Removed_Songs_Panel**: The card on the Dashboard that lists tracks removed by the cleaning engine and allows the user to re-add them via the backend API.
- **Backend_API**: The Express backend already deployed, exposing `/auth/*` and `/api/*` endpoints consumed by the App.
- **Session_Cookie**: The `httpOnly` JWT cookie issued by the backend after OAuth; the App relies on this for authentication state without accessing the token value directly.
- **Optimistic_UI**: A UI pattern where the interface updates immediately on user action before the backend confirms the result, reverting and showing an error on failure.
- **Reduced_Motion**: The user-agent or OS preference expressed via the CSS media query `prefers-reduced-motion: reduce`.

---

## Requirements

### Requirement 1: Design System Tokens

**User Story:** As a developer, I want a single source of truth for colors, typography, spacing, icons, and motion, so that every component is visually consistent without per-component overrides.

#### Acceptance Criteria

1. THE Design_System SHALL define the following background color tokens: `bg-base` (#121212), `bg-surface` (#181818), `bg-surface-hover` (#282828).
2. THE Design_System SHALL define `color-brand` (#1DB954) as the sole primary accent, used for active states, brand buttons, links, the scroll line draw, and the active Waveform.
3. THE Design_System SHALL define `color-danger` (#E74C3C) used exclusively for the stopped/flatline Waveform state and destructive actions; no CSS color with a hue in the range 0°–15° or 345°–360° other than `color-danger` (#E74C3C) SHALL appear in the App.
4. THE Design_System SHALL define text color tokens: `text-primary` (#FFFFFF) and `text-muted` (#A7A7A7).
5. THE Design_System SHALL define a type scale with exactly these sizes in pixels: 12, 14, 16, 20, 24, 32, 48, 64; font family Inter or system sans-serif; font-weight 400 for body (line-height 1.5) and 700 for emphasis only (line-height 1.2); no other font weights SHALL be introduced.
6. THE Design_System SHALL define a spacing scale based on an 8px base unit; all padding, margin, and gap values throughout the App SHALL be multiples of 8px with no arbitrary values.
7. THE Design_System SHALL specify Lucide as the sole icon library, with stroke-width 1.5px and sizes restricted to 16px, 20px, or 24px; no emoji SHALL appear anywhere in the App.
8. THE Design_System SHALL define border-radius 8px for cards and 9999px for pills and buttons, plus one elevated shadow token value of `0 4px 16px rgba(0, 0, 0, 0.48)` for raised surfaces.
9. THE Design_System SHALL contain no purple tones and no CSS gradients.
10. WHEN the user's device reports `prefers-reduced-motion: reduce`, THE App SHALL disable the Timeline_SVG scroll-draw animation and the Waveform oscillation animation; the Timeline_SVG SHALL render in its fully drawn state (pathLength 1) and the Waveform SHALL render as a flat horizontal line at its resting midpoint; no independent in-app controls for disabling animations are provided.

---

### Requirement 2: Landing Page — Structure and Authentication Entry Point

**User Story:** As a visitor, I want a visually compelling page that explains the product and lets me sign in with Spotify, so that I can start using the cleaner without friction.

#### Acceptance Criteria

1. THE Landing_Page SHALL be accessible at the route `/` and SHALL be renderable without an active Session_Cookie.
2. THE Landing_Page SHALL contain a single "Sign in with Spotify" call-to-action button styled with a `color-brand` outline, positioned at the point where the Timeline_SVG terminates at the end of the scroll sequence.
3. WHEN a visitor clicks "Sign in with Spotify", THE App SHALL redirect the browser to `{NEXT_PUBLIC_API_BASE_URL}/auth/spotify`.
4. WHEN the backend redirects back to `/dashboard` after successful OAuth, THE App SHALL render the Dashboard; IF the user's identity or playlist data is not displayed within 5 seconds of the redirect, THEN THE App SHALL display an error message on the `/dashboard` route and SHALL NOT perform a full page reload.
5. IF the backend redirects back to `/` with a query parameter `error=access_denied` or `error=auth_failed`, THEN THE Landing_Page SHALL display an inline error notice positioned within page content without obscuring interactive elements, and SHALL NOT navigate away.
6. THE Landing_Page SHALL display the three title words "SPOTIFY", "PLAYLIST", and "CLEANER" as large heading text positioned along the scroll — "SPOTIFY" within the 1970–2000 scroll range, "PLAYLIST" within the 2000–2020 scroll range, and "CLEANER" within the 2020–2022 scroll range — together spelling the full product name progressively as the user scrolls.
7. THE Landing_Page SHALL have no nested cards and SHALL contain no emoji.

---

### Requirement 3: Landing Page — Scroll-Driven Timeline SVG

**User Story:** As a visitor, I want a scroll-linked animated line that traces through musical history, so that the page feels alive and contextualises the product concept.

#### Acceptance Criteria

1. THE Timeline_SVG SHALL be a single SVG `<path>` element spanning the full scroll height of the Landing_Page, computed as 57 (Year_Markers) multiplied by a fixed vertical spacing of 550px per marker, giving a total height of 31,350px.
2. THE Timeline_SVG path SHALL follow a smooth S-curve alternating left and right using cubic Bézier segments; the horizontal amplitude SHALL vary between segments within a ±20px range of a baseline amplitude, and no two consecutive segments SHALL have identical control point offsets.
3. WHEN the Landing_Page mounts, THE Timeline_SVG stroke SHALL start in the fully undrawn state (pathLength 0) and SHALL NOT be fully drawn (pathLength 1) until the user has scrolled to the bottom.
4. WHILE the user scrolls the Landing_Page, THE App SHALL map `scrollYProgress` (via Framer Motion `useScroll`) to the `pathLength` motion value of the Timeline_SVG stroke so that the drawn length advances proportionally with scroll position.
5. WHEN the Landing_Page component mounts, THE App SHALL compute Year_Marker positions using `SVGPathElement.getPointAtLength()` and place markers at those coordinates.
6. WHEN the browser window is resized, THE App SHALL recompute Year_Marker positions using `SVGPathElement.getPointAtLength()` and update marker coordinates accordingly.
7. WHEN the viewport width falls below 640px, THE Timeline_SVG SHALL reduce its left–right weave amplitude to a maximum of 20px so that no Year_Marker extends outside the visible screen width.
8. WHEN `prefers-reduced-motion: reduce` is active, THE App SHALL render the Timeline_SVG in its fully drawn end-state (pathLength 1) with all Year_Markers visible, with no scroll-linked animation.

---

### Requirement 4: Landing Page — Year Markers

**User Story:** As a visitor, I want to see representative songs for each year along the timeline, so that the scroll journey feels grounded in real musical context.

#### Acceptance Criteria

1. THE Landing_Page SHALL include one Year_Marker per year from 1970 to 2026 inclusive (57 markers total), each positioned at the exact point on the Timeline_SVG curve computed by `getPointAtLength()`.
2. WHEN a Year_Marker is rendered, THE Year_Marker SHALL display: a square album art thumbnail, the track title, the artist name, and the year label; the year label for 1970 SHALL appear on the left side of the curve, and subsequent labels SHALL alternate sides (left, right, left, …) as the curve weaves.
3. WHEN a Year_Marker enters the viewport, THE App SHALL animate it in using Framer Motion `whileInView` with opacity transitioning from 0 to 1 and scale transitioning from 0.92 to 1, over 400ms with ease-out easing.
4. THE Year_Marker data SHALL be provided as static curated data sourced from Billboard Hot 100 year-end charts for years 1970–2026 and SHALL be flagged with a `// TODO: replace with live Spotify year-end data` comment in the data file.
5. IF a Year_Marker's `preview_url` is non-null, THEN THE Year_Marker SHALL display a play/pause icon button on the album art thumbnail that begins audio playback of that track's `preview_url` when clicked.
6. IF a Year_Marker's `preview_url` is null, THEN THE Year_Marker SHALL display no audio control and SHALL render with identical layout dimensions and visual styling as a Year_Marker with a non-null `preview_url`.

---

### Requirement 5: Landing Page — Preview Player

**User Story:** As a visitor, I want to listen to a 30-second preview of a year's defining song directly on the page, so that I can experience the musical journey without leaving the site.

#### Acceptance Criteria

1. THE Preview_Player SHALL be scoped to the Landing_Page and SHALL play audio by setting the `src` attribute of a shared audio object and calling its `play()` method; playback SHALL NOT leave the Landing_Page.
2. WHEN a visitor clicks the play button on a Year_Marker, THE play button SHALL be disabled while the audio source loads, THE Preview_Player SHALL begin playback of that marker's `preview_url`, and the icon on that Year_Marker SHALL change from a play icon to a pause icon once playback starts.
3. WHEN the Preview_Player is already playing and the visitor clicks play on a different Year_Marker, THE Preview_Player SHALL stop the current track within 500ms and immediately begin playback of the newly selected track.
4. WHEN the visitor clicks the pause icon on the currently playing Year_Marker, THE Preview_Player SHALL pause playback and the icon SHALL revert to the play icon.
5. WHEN a preview reaches the end of its clip, THE Preview_Player SHALL reset the icon on the corresponding Year_Marker to the play icon without navigating the page.
6. THE App SHALL ensure at most one preview plays at a time across all Year_Markers on the Landing_Page.
7. IF a visitor clicks the play button on a Year_Marker whose `preview_url` is null, THEN THE play button SHALL remain disabled and no playback SHALL be attempted.

---

### Requirement 6: Dashboard — Access Control

**User Story:** As a user, I want the dashboard to be protected so that only authenticated users can access it, so that my cleaning data stays private.

#### Acceptance Criteria

1. WHEN a visitor navigates to `/dashboard` without a valid Session_Cookie, THE App SHALL redirect the visitor to `/`.
2. WHEN the Dashboard route loads, THE App SHALL call `GET {NEXT_PUBLIC_API_BASE_URL}/auth/me` with `credentials: 'include'`; IF the response status is 401, THEN THE App SHALL treat the user as unauthenticated and redirect to `/`; IF the response status is any other non-200 code or the request fails with a network error, THEN THE App SHALL display an error state rather than redirecting.
3. WHILE the App is loading authentication state on the Dashboard route, THE App SHALL display a loading indicator and SHALL NOT flash the Dashboard content before the auth check completes; IF the auth check request does not complete within 10 seconds, THEN THE App SHALL display an error state with a visible retry control that, when activated, re-triggers the auth check request.
4. THE Dashboard header SHALL display the text "Dashboard" as the page title.
5. THE Dashboard header SHALL display a user avatar in the top-right corner.
6. WHEN the avatar is clicked, THE App SHALL show a dropdown menu containing a "Sign out" action.
7. WHEN the user selects "Sign out" from the dropdown, THE App SHALL call `POST {NEXT_PUBLIC_API_BASE_URL}/auth/logout` with `credentials: 'include'`; IF the response is successful, THEN THE App SHALL redirect to `/`.
8. IF the `POST /auth/logout` call fails or does not respond within 10 seconds, THEN THE App SHALL clear local authentication state, redirect to `/`, and display an error message indicating that sign-out may be incomplete.

---

### Requirement 7: Dashboard — Cleaning Toggle

**User Story:** As a user, I want a single, clearly labelled button to start or stop the cleaning engine, so that I can control the service without confusion.

#### Acceptance Criteria

1. THE Cleaning_Toggle SHALL be the sole control for starting and stopping the cleaning engine on the Dashboard.
2. WHEN the cleaning state is idle or stopped, THE Cleaning_Toggle SHALL render as a green (`color-brand`) button labelled "Start Cleaning" with a play Lucide icon; no "Stop" button SHALL be visible simultaneously.
3. WHEN the cleaning state is active, THE Cleaning_Toggle SHALL render as a red (`color-danger`) button labelled "Stop Cleaning" with a square (stop) Lucide icon; no "Start" button SHALL be visible simultaneously.
4. WHEN the user clicks "Start Cleaning" and the backend returns a success response, THE App SHALL update the Cleaning_Toggle to the active state.
5. WHEN the user clicks "Stop Cleaning" and the backend returns a success response, THE App SHALL update the Cleaning_Toggle to the stopped state.
6. IF the start or stop API call returns a non-success response, THEN THE App SHALL display an inline error message adjacent to the Cleaning_Toggle for at least 5 seconds and SHALL revert the button to the state prior to the click.
7. WHEN the Dashboard loads, THE App SHALL call the status endpoint with `credentials: 'include'` and read the `isRunning` field to initialise the Cleaning_Toggle state.
8. WHILE a start or stop API call is in flight, THE Cleaning_Toggle button SHALL be disabled to prevent concurrent requests.
9. IF the status fetch on Dashboard load fails, THEN THE Cleaning_Toggle SHALL default to the stopped state and SHALL display an error indication to the user.

---

### Requirement 8: Dashboard — Background Waveform

**User Story:** As a user, I want a live visual indicator in the background showing whether cleaning is active, so that I can tell the system's state at a glance and with text confirmation.

#### Acceptance Criteria

1. THE Waveform SHALL be rendered as an EKG-style animated SVG positioned in the negative space left and right of the central Dashboard card.
2. WHILE the cleaning state is active, THE Waveform SHALL display a continuously looping oscillation in `color-brand` (green), with each animation cycle lasting between 1000ms and 3000ms, animating smoothly without strobing or hard cuts.
3. WHEN the cleaning state transitions from active to stopped, THE Waveform SHALL animate the oscillation collapsing to a flat horizontal line in `color-danger` (red) over a duration of 600–800ms.
4. WHEN the cleaning state transitions from stopped to active, THE Waveform SHALL animate the flat line expanding back into the oscillating waveform in `color-brand` over a duration of 600–800ms.
5. THE Dashboard SHALL always display a visible text label that updates within the same 600–800ms transition window as the Waveform: "Cleaning in progress" when active and "Stopped" when stopped; this label SHALL be the primary accessible status indicator.
6. WHEN `prefers-reduced-motion: reduce` is active, THE Waveform SHALL render as a static horizontal line in `color-brand` when active and `color-danger` when stopped, with no CSS transition or animation duration applied.
7. WHEN the cleaning state transitions while `prefers-reduced-motion: reduce` is active, THE Waveform SHALL update its color with no CSS transition or animation duration applied.

---

### Requirement 9: Dashboard — Removed Songs Panel

**User Story:** As a user, I want to see which songs have been removed by the cleaner and be able to re-add any of them to my playlist, so that I can correct mistakes and review cleaning activity.

#### Acceptance Criteria

1. THE Removed_Songs_Panel SHALL be a single card centred on the Dashboard, titled "Removed Songs", with no nested cards inside it.
2. WHEN the Dashboard loads, THE App SHALL call `GET {NEXT_PUBLIC_API_BASE_URL}/api/removals` with `credentials: 'include'` and populate the Removed_Songs_Panel with the returned data.
3. WHILE the `/api/removals` request is in flight, THE Removed_Songs_Panel SHALL display a loading skeleton of 3 placeholder rows in place of the song rows.
4. IF the `/api/removals` request returns an error, THEN THE Removed_Songs_Panel SHALL display an inline error message with a labeled retry button that, when clicked, re-issues the `GET /api/removals` request and returns the panel to the loading skeleton state.
5. WHEN the `/api/removals` response contains zero records, THE Removed_Songs_Panel SHALL display the empty-state message: "No songs removed yet — start a clean to see results here."
6. EACH song row in the Removed_Songs_Panel SHALL display: a 48×48px square album art thumbnail, the track title, the artist name, and a `+` (re-add) button aligned to the right of the row.
7. WHEN the user clicks the `+` button on a song row, THE App SHALL immediately animate the row out of the list over 200ms (Optimistic_UI), disable the `+` button during the in-flight request, and call the removal re-add endpoint with `credentials: 'include'` to both delete the removal record and re-add the track to its Spotify playlist.
8. IF the re-add API call returns a non-success response (either the removal record deletion or the Spotify re-add fails), THEN THE App SHALL display a dismissible error toast that auto-dismisses after 5 seconds, re-insert the row at its original position in the Removed_Songs_Panel, re-enable the `+` button on the row, and show an inline error message on the row.
9. THE Removed_Songs_Panel SHALL have a maximum height of 480px and SHALL scroll independently within its card when the song list exceeds that height, without scrolling the rest of the Dashboard.
10. THE `+` button on each row SHALL use a Lucide plus icon at 20px with stroke 1.5px, SHALL have a visible focus ring of at least 2px width, and SHALL have an `aria-label` of "Re-add [track title] to playlist".

---

### Requirement 10: Accessibility and Cross-Cutting Concerns

**User Story:** As a user with accessibility needs, I want the App to communicate state through text and icons in addition to color, so that I can use it regardless of how I perceive color or motion.

#### Acceptance Criteria

1. THE App SHALL ensure every status signal (cleaning active/stopped, preview playing/paused, row removed, error) is communicated through both a visible text or icon indicator AND color; the "row removed" indicator SHALL remain visible for at least 3 seconds before dismissal; color alone SHALL NOT be used for any status signal.
2. THE App SHALL ensure all icon-only interactive elements (elements with no visible text label) have a non-empty accessible name provided via `aria-label`, `aria-labelledby`, or an equivalent WCAG-compliant technique.
3. THE App SHALL ensure all interactive elements have a visible focus ring with a minimum outline width of 2px and a contrast ratio of at least 3:1 against the adjacent background color when focused via keyboard navigation.
4. THE App SHALL set `role="status"` and `aria-live="polite"` on the Waveform status text label so that screen readers announce cleaning state changes.
5. THE App SHALL include `alt` text on all album art thumbnail `<img>` elements, using the format "{track title} by {artist name} album art".
6. THE App SHALL use semantic HTML elements (`<main>`, `<header>`, `<nav>`, `<section>`, `<button>`) in the structure of both Landing_Page and Dashboard.
7. THE App SHALL not introduce any CSS color outside the Design_System token set — no purple tones, no gradients, and no unsanctioned accent colors from component libraries or third-party defaults.
8. WHEN a component library default style conflicts with the Design_System, THE App SHALL override the conflicting style to comply with the Design_System tokens.
9. THE App SHALL set `aria-live="polite"` on containers that display removal confirmation messages and error notification toasts so that screen readers announce those dynamic updates.
