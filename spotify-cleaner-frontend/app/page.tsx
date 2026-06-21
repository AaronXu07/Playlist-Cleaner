'use client';

import { useCallback, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, useScroll, useTransform } from 'framer-motion';
import { AudioProvider } from '@/context/AudioContext';
import TimelineSVG from '@/components/landing/TimelineSVG';
import { YEAR_MARKERS } from '@/lib/yearMarkerData';
import {
  PATH_TAIL,
  TIMELINE_BOTTOM_PADDING,
  VERTICAL_SPACING,
  TIMELINE_TOP_OFFSET,
} from '@/lib/generateTimelinePath';

// Total scroll height of the timeline — must exactly match the height
// TimelineSVG renders: path endpoint plus bottom padding.
const TIMELINE_HEIGHT =
  TIMELINE_TOP_OFFSET +
  (YEAR_MARKERS.length - 1) * VERTICAL_SPACING +
  PATH_TAIL +
  TIMELINE_BOTTOM_PADDING;

// Timeline span derived from the dataset (drives the section aria-label).
const firstYear = YEAR_MARKERS[0].year;
const lastYear = YEAR_MARKERS[YEAR_MARKERS.length - 1].year;

// ─── Error Notice ────────────────────────────────────────────────────────────

/**
 * Reads ?error= URL param and renders an inline alert when the OAuth callback
 * returns an error. Wrapped in Suspense because useSearchParams requires it.
 *
 * Requirements: 2.5
 */
function ErrorNotice() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  if (
    error !== 'access_denied' &&
    error !== 'auth_failed' &&
    error !== 'logout_failed'
  ) {
    return null;
  }

  const message =
    error === 'access_denied'
      ? 'Access was denied. Please try signing in again.'
      : error === 'logout_failed'
        ? 'Sign out may not have completed. Please try again.'
        : 'Authentication failed. Please try again.';

  return (
    <p
      role="alert"
      className="text-sm text-danger text-center mt-4 px-4"
      style={{ marginBottom: '0' }}
    >
      {message}
    </p>
  );
}

// ─── Heading Word ────────────────────────────────────────────────────────────

interface HeadingWordProps {
  word: string;
  scrollYProgress: ReturnType<typeof useScroll>['scrollYProgress'];
  /** [fadeIn start, peak start, peak end, fadeOut end] — all in [0, 1] */
  range: [number, number, number, number];
}

/**
 * Renders a large sticky heading word whose opacity is driven by scroll
 * position. Pinned to the vertical centre of the viewport while in range.
 *
 * Requirements: 2.6
 */
function HeadingWord({ word, scrollYProgress, range }: HeadingWordProps) {
  const [r0, r1, r2, r3] = range;

  const opacity = useTransform(
    scrollYProgress,
    [r0, r1, r2, r3],
    [0, 1, 1, 0]
  );

  return (
    <motion.span
      style={{
        opacity,
        position: 'sticky',
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'block',
        pointerEvents: 'none',
        userSelect: 'none',
        textAlign: 'center',
        fontSize: 'clamp(2rem, 7vw, 3rem)',
        fontWeight: 700,
        letterSpacing: '0.08em',
        color: 'var(--color-text-primary)',
        lineHeight: 1.2,
        zIndex: 10,
      }}
      aria-hidden="true"
    >
      {word}
    </motion.span>
  );
}

// ─── Landing Page Inner (needs scroll container ref) ─────────────────────────

function LandingPageInner() {
  // Scroll container ref — passed to both useScroll and TimelineSVG (Req 3.4)
  const containerRef = useRef<HTMLDivElement>(null);
  const [timelineHeight, setTimelineHeight] = useState(TIMELINE_HEIGHT);

  const { scrollYProgress } = useScroll({ container: containerRef });
  const handleTimelineHeightChange = useCallback((height: number) => {
    setTimelineHeight(height);
  }, []);

  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

  return (
    /*
     * Scroll container: overflow-y: auto so Framer Motion useScroll can track
     * scrollYProgress relative to this element, not the window.
     * Requirements: 2.1, 10.6 — <main> wrapper, <section> for timeline region
     */
    <main
      ref={containerRef}
      style={{
        position: 'relative',
        height: '100vh',
        overflowY: 'auto',
        backgroundColor: 'var(--color-bg-base)',
      }}
    >
      {/* ── Inline error notice (Req 2.5) ─────────────────────────────────── */}
      <Suspense fallback={null}>
        <ErrorNotice />
      </Suspense>

      {/*
       * Sticky heading words — rendered above the timeline SVG via z-index.
       * Each word is position:sticky within the scroll container so it anchors
       * to the viewport centre while its opacity window is active.
       *
       * Scroll ranges divide scrollYProgress (0→1) into thirds (Req 2.6):
       *   "SPOTIFY"  → first third  (0.0–0.33)
       *   "PLAYLIST" → middle third (0.33–0.66)
       *   "CLEANER"  → final third  (0.66–1.0)
       * Each word fades in/out within its third via its
       * [fadeIn, peak, peak, fadeOut] opacity keyframes.
       *
       * Requirements: 2.6
       */}
      <div
        aria-label="Spotify Playlist Cleaner"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          // Matches the timeline scroll canvas so it doesn't add empty scroll space
          height: `${timelineHeight}px`,
          pointerEvents: 'none',
          zIndex: 10,
        }}
      >
        {/* First third of scroll progress (0.0–0.33) */}
        <HeadingWord
          word="SPOTIFY"
          scrollYProgress={scrollYProgress}
          range={[0.0, 0.04, 0.29, 0.33]}
        />
        {/* Middle third of scroll progress (0.33–0.66) */}
        <HeadingWord
          word="PLAYLIST"
          scrollYProgress={scrollYProgress}
          range={[0.33, 0.37, 0.62, 0.66]}
        />
        {/* Final third of scroll progress (0.66–1.0) */}
        <HeadingWord
          word="CLEANER"
          scrollYProgress={scrollYProgress}
          range={[0.66, 0.7, 0.95, 1.0]}
        />
      </div>

      {/*
       * Timeline section — contains the SVG path and year markers.
       * Requirements: 3.1–3.8, 4.1, 4.2, 10.6
       */}
      <section aria-label={`Musical timeline ${firstYear}–${lastYear}`}>
        <TimelineSVG
          scrollYProgress={scrollYProgress}
          scrollContainerRef={containerRef}
          onHeightChange={handleTimelineHeightChange}
          cta={
            <a
              href={`${apiBase}/auth/spotify`}
              style={{
                display: 'inline-block',
                padding: '16px 40px',
                border: '2px solid var(--color-brand)',
                borderRadius: 'var(--radius-pill)',
                color: 'var(--color-brand)',
                backgroundColor: 'transparent',
                fontSize: '16px',
                fontWeight: 700,
                letterSpacing: '0.04em',
                textDecoration: 'none',
                outline: 'none',
                transition: 'background-color 0.15s, color 0.15s',
                whiteSpace: 'nowrap',
              }}
              onFocus={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.outline =
                  '2px solid var(--color-brand)';
                (e.currentTarget as HTMLAnchorElement).style.outlineOffset = '3px';
              }}
              onBlur={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.outline = 'none';
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.backgroundColor =
                  'var(--color-brand)';
                (e.currentTarget as HTMLAnchorElement).style.color =
                  'var(--color-bg-base)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.backgroundColor =
                  'transparent';
                (e.currentTarget as HTMLAnchorElement).style.color =
                  'var(--color-brand)';
              }}
            >
              Sign in with Spotify
            </a>
          }
        />
      </section>
    </main>
  );
}

// ─── Page Export ──────────────────────────────────────────────────────────────

/**
 * Landing Page — `/`
 *
 * Public, no session cookie required. Wraps content in AudioProvider so the
 * shared audio singleton is scoped to the landing page only (not root layout).
 *
 * Requirements: 2.1–2.7, 10.6
 */
export default function LandingPage() {
  return (
    <AudioProvider>
      <LandingPageInner />
    </AudioProvider>
  );
}
