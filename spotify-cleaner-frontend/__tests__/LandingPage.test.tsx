/**
 * Unit tests for Landing Page behaviour.
 *
 * Validates: Requirements 2.1, 2.3, 2.5, 2.6, 2.7
 *
 * 1. Page renders without a session cookie (Req 2.1)
 * 2. "Sign in with Spotify" button href contains `/auth/spotify` with NEXT_PUBLIC_API_BASE_URL prepended (Req 2.3)
 * 3. `?error=access_denied` query param renders inline `<p role="alert">` error notice (Req 2.5)
 * 4. Heading words "SPOTIFY", "PLAYLIST", "CLEANER" are all present in rendered output (Req 2.6)
 * 5. No emoji Unicode characters in the rendered output (Req 2.7)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React, { Suspense } from 'react';

// ── Mock: next/navigation ────────────────────────────────────────────────────
// Default: no search params. Individual tests override useSearchParams as needed.
const mockUseSearchParams = vi.fn().mockReturnValue(new URLSearchParams());

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockUseSearchParams(),
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}));

// ── Mock: framer-motion ───────────────────────────────────────────────────────
// Replace animated components with plain HTML equivalents so jsdom tests work
// without a real scroll/animation engine.
vi.mock('framer-motion', () => ({
  motion: {
    span: ({
      children,
      style,
      ...rest
    }: React.HTMLAttributes<HTMLSpanElement> & { [key: string]: unknown }) => (
      <span style={style as React.CSSProperties}>{children}</span>
    ),
    div: ({
      children,
      style,
      ...rest
    }: React.HTMLAttributes<HTMLDivElement> & { [key: string]: unknown }) => (
      <div style={style as React.CSSProperties}>{children}</div>
    ),
  },
  useScroll: vi.fn().mockReturnValue({
    scrollYProgress: {
      on: vi.fn(() => () => {}),
      get: vi.fn(() => 0),
    },
  }),
  useTransform: vi.fn().mockReturnValue(0),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── Mock: AudioContext ────────────────────────────────────────────────────────
vi.mock('@/context/AudioContext', () => ({
  AudioProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAudio: () => ({
    playingUrl: null,
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    isLoading: false,
  }),
}));

// ── Mock: TimelineSVG ─────────────────────────────────────────────────────────
// Prevent the complex scroll-driven SVG subtree from rendering — we only care
// about the Landing Page's own structure and behaviour. The sign-in CTA is now
// passed into TimelineSVG via its `cta` prop, so the mock renders that prop.
vi.mock('@/components/landing/TimelineSVG', () => ({
  default: ({ cta }: { cta?: React.ReactNode }) => (
    <div data-testid="timeline-svg">{cta}</div>
  ),
}));

// ── Import component under test (after mocks are registered) ─────────────────
import LandingPage from '../app/page';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Render LandingPage and flush all effects including Suspense boundaries. */
async function renderLandingPage() {
  let result!: ReturnType<typeof render>;

  await act(async () => {
    result = render(
      <Suspense fallback={null}>
        <LandingPage />
      </Suspense>
    );
  });

  // Flush any pending state updates / Suspense resolutions
  await act(async () => {});

  return result;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let originalAudio: typeof window.Audio;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  originalAudio = window.Audio;
  originalMatchMedia = window.matchMedia;

  // Minimal Audio mock so AudioProvider doesn't throw during component init
  const MockAudioCtor = function () {
    return {
      src: '',
      paused: true,
      readyState: 4,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  } as unknown as typeof Audio;
  window.Audio = MockAudioCtor;

  // Default: no prefers-reduced-motion
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Reset search params to empty for each test
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
});

afterEach(() => {
  window.Audio = originalAudio;
  window.matchMedia = originalMatchMedia;
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Landing Page behaviour', () => {
  /**
   * Test 1 — Page renders without a session cookie (Req 2.1)
   *
   * The landing page must be accessible at `/` without any authentication.
   * This test verifies it renders without throwing.
   */
  test('renders without a session cookie (no auth required)', async () => {
    await expect(renderLandingPage()).resolves.toBeDefined();
  });

  /**
   * Test 2 — "Sign in with Spotify" button href (Req 2.3)
   *
   * The link href must include `/auth/spotify` and must prepend
   * NEXT_PUBLIC_API_BASE_URL (which may be an empty string).
   */
  test('"Sign in with Spotify" link href contains /auth/spotify with NEXT_PUBLIC_API_BASE_URL prepended', async () => {
    const { container } = await renderLandingPage();

    const link = container.querySelector('a[href*="/auth/spotify"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();

    const href = link!.getAttribute('href') ?? '';

    // href must contain "/auth/spotify"
    expect(href).toContain('/auth/spotify');

    // href must start with NEXT_PUBLIC_API_BASE_URL (empty string is valid —
    // the requirement says "even if empty string"). In the component the href
    // is constructed as `${apiBase}/auth/spotify` where apiBase defaults to ''.
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
    expect(href).toBe(`${apiBase}/auth/spotify`);
  });

  /**
   * Test 3 — `?error=access_denied` renders inline error notice (Req 2.5)
   *
   * When the OAuth callback returns with `?error=access_denied`, the page must
   * display a `<p role="alert">` inline error without navigating away.
   */
  test('renders <p role="alert"> when ?error=access_denied is present', async () => {
    // Override useSearchParams for this test to simulate the error query param
    mockUseSearchParams.mockReturnValue(new URLSearchParams('error=access_denied'));

    const { container } = await renderLandingPage();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.tagName).toBe('P');
  });

  /**
   * Test 4 — Heading words present in DOM (Req 2.6)
   *
   * The three title words "SPOTIFY", "PLAYLIST", and "CLEANER" must all be
   * present in the rendered output, together spelling the full product name.
   */
  test('heading words "SPOTIFY", "PLAYLIST", and "CLEANER" are all present in the DOM', async () => {
    const { container } = await renderLandingPage();

    const allText = container.textContent ?? '';

    expect(allText).toContain('SPOTIFY');
    expect(allText).toContain('PLAYLIST');
    expect(allText).toContain('CLEANER');
  });

  /**
   * Test 5 — No emoji characters in rendered output (Req 2.7)
   *
   * The landing page must contain no emoji Unicode characters anywhere in its
   * text content, in accordance with the design system rule (Req 1.7).
   */
  test('rendered output contains no emoji Unicode characters', async () => {
    const { container } = await renderLandingPage();

    const allText = container.textContent ?? '';

    // Emoji Unicode ranges:
    //   U+1F600–U+1F64F  Emoticons
    //   U+1F300–U+1F5FF  Misc Symbols and Pictographs
    //   U+1F680–U+1F6FF  Transport and Map Symbols
    //   U+1F700–U+1F77F  Alchemical Symbols
    //   U+1F780–U+1F7FF  Geometric Shapes Extended
    //   U+1F800–U+1F8FF  Supplemental Arrows-C
    //   U+1F900–U+1F9FF  Supplemental Symbols and Pictographs
    //   U+1FA00–U+1FA6F  Chess Symbols
    //   U+1FA70–U+1FAFF  Symbols and Pictographs Extended-A
    //   U+2600–U+26FF    Miscellaneous Symbols
    //   U+2700–U+27BF    Dingbats
    //   U+FE00–U+FE0F    Variation Selectors (used with emoji)
    //   U+200D           Zero Width Joiner (used in emoji sequences)
    const emojiRegex =
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/u;

    expect(emojiRegex.test(allText)).toBe(false);
  });
});
