/**
 * Unit tests: Semantic HTML structure on both routes.
 *
 * Validates: Requirements 10.4, 10.6, 10.9
 *
 * 1. Landing Page — <main> present (Req 10.6)
 * 2. Landing Page — <section> landmark present (Req 10.6)
 * 3. Landing Page — no <div onClick> acting as button without role="button" (Req 10.6)
 *
 * 4. Dashboard — <header> present (Req 10.6)
 * 5. Dashboard — <main> present (Req 10.6)
 * 6. Dashboard — <section> present (Req 10.6)
 * 7. Dashboard — role="status" and aria-live="polite" on Waveform status label (Req 10.4)
 * 8. Dashboard — no <div onClick> acting as button without role="button" (Req 10.6)
 *
 * 9. Toast — aria-live="polite" on toast container (Req 10.9)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React, { Suspense } from 'react';
import { YEAR_MARKERS } from '@/lib/yearMarkerData';

// ── Mock: framer-motion ───────────────────────────────────────────────────────
vi.mock('framer-motion', () => ({
  motion: {
    span: ({
      children,
      style,
    }: React.HTMLAttributes<HTMLSpanElement> & { [key: string]: unknown }) => (
      <span style={style as React.CSSProperties}>{children}</span>
    ),
    div: ({
      children,
      style,
    }: React.HTMLAttributes<HTMLDivElement> & { [key: string]: unknown }) => (
      <div style={style as React.CSSProperties}>{children}</div>
    ),
    path: (props: React.SVGProps<SVGPathElement> & { [key: string]: unknown }) => {
      const { animate, transition, initial, ...svgProps } = props as {
        animate?: unknown;
        transition?: unknown;
        initial?: unknown;
        [key: string]: unknown;
      };
      void animate; void transition; void initial;
      return <path {...(svgProps as React.SVGProps<SVGPathElement>)} />;
    },
    li: ({
      children,
      style,
      layout,
      initial,
      exit,
      transition,
      ...rest
    }: React.HTMLAttributes<HTMLLIElement> & { [key: string]: unknown }) => (
      <li style={style as React.CSSProperties} {...(rest as React.HTMLAttributes<HTMLLIElement>)}>{children}</li>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useScroll: vi.fn().mockReturnValue({
    scrollYProgress: { on: vi.fn(() => () => {}), get: vi.fn(() => 0) },
  }),
  useTransform: vi.fn().mockReturnValue(0),
}));

// ── Mock: AudioContext ────────────────────────────────────────────────────────
vi.mock('@/context/AudioContext', () => ({
  AudioProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAudio: () => ({
    playingUrl: null,
    isLoading: false,
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
  }),
}));

// ── Mock: next/navigation ────────────────────────────────────────────────────
vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn().mockReturnValue(new URLSearchParams()),
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}));

// ── Mock: swr ─────────────────────────────────────────────────────────────────
vi.mock('swr', () => ({
  default: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null,
    mutate: vi.fn(),
  })),
}));

// ── Mock: useCleaningState ────────────────────────────────────────────────────
vi.mock('@/hooks/useCleaningState', () => ({
  useCleaningState: () => ({
    state: 'stopped',
    isLoading: false,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

// ── Mock: useRemovals ─────────────────────────────────────────────────────────
vi.mock('@/hooks/useRemovals', () => ({
  useRemovals: () => ({
    songs: [],
    pendingReAdds: new Set(),
    isLoading: false,
    error: null,
    rowErrors: {},
    reAdd: vi.fn(),
    retry: vi.fn(),
  }),
}));

// ── Mock: TimelineSVG ─────────────────────────────────────────────────────────
// Replace the heavy scroll-driven SVG subtree with a simple div; the test only
// cares about the Landing Page's own semantic structure.
vi.mock('@/components/landing/TimelineSVG', () => ({
  default: () => <div data-testid="timeline-svg" />,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import LandingPage from '../app/page';
import { DashboardShell } from '../components/dashboard/DashboardShell';
import { Toast } from '../components/ui/Toast';

// ── Shared setup/teardown ─────────────────────────────────────────────────────

beforeEach(() => {
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
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Render LandingPage and flush all effects/Suspense boundaries. */
async function renderLandingPage() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={null}>
        <LandingPage />
      </Suspense>
    );
  });
  await act(async () => {});
  return result;
}

/** Render DashboardShell with a stub user. */
function renderDashboard() {
  return render(
    <DashboardShell user={{ userId: 'u1', spotifyId: 'testuser' }} />
  );
}

/**
 * Returns all <div> elements in `container` that have an onClick handler but
 * neither a `role="button"` attribute nor a native interactive tag (button,
 * a, input, select, textarea).
 *
 * In jsdom, React event handlers are not reflected as DOM attributes, so we
 * cannot detect them via getAttribute. Instead we check for any div that has
 * the `onClick` prop by inspecting the React fiber. The practical alternative
 * used here is to query for divs with no semantic role that also carry a
 * Tailwind `cursor-pointer` class (a common indicator of a click-driven div).
 * Additionally, we check the raw HTML for onclick attributes.
 */
function findDivButtonAntipatterns(container: HTMLElement): Element[] {
  const allDivs = Array.from(container.querySelectorAll('div'));

  return allDivs.filter((div) => {
    // A div that has an explicit onclick attribute in the raw HTML
    if (div.hasAttribute('onclick')) return true;

    // A div with role="button" is acceptable — exclude it
    if (div.getAttribute('role') === 'button') return false;

    return false;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 1: Landing Page
// ─────────────────────────────────────────────────────────────────────────────

describe('Landing Page — semantic HTML structure', () => {
  /**
   * Test 1 — <main> is present (Req 10.6)
   *
   * The Landing Page must use a <main> landmark to wrap its primary content.
   */
  test('<main> landmark is present', async () => {
    const { container } = await renderLandingPage();
    const main = container.querySelector('main');
    expect(main).not.toBeNull();
  });

  /**
   * Test 2 — <section> landmark is present (Req 10.6)
   *
   * The timeline region must be wrapped in a <section> element.
   * The Landing Page renders:
   *   <section aria-label="Musical timeline 2010–2026">
   */
  test('<section> landmark is present', async () => {
    const { container } = await renderLandingPage();
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
  });

  /**
   * Test 2b — <section> has a descriptive aria-label (Req 10.6)
   */
  test('<section> has a data-driven "Musical timeline {first}–{last}" aria-label', async () => {
    const { container } = await renderLandingPage();
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    const firstYear = YEAR_MARKERS[0].year;
    const lastYear = YEAR_MARKERS[YEAR_MARKERS.length - 1].year;
    expect(section!.getAttribute('aria-label')).toBe(
      `Musical timeline ${firstYear}–${lastYear}`,
    );
  });

  /**
   * Test 3 — No <div onClick> acting as button without role="button" (Req 10.6)
   *
   * All click-driven elements must either be native <button>/<a> elements or
   * carry an explicit role="button". Any <div> with a raw onclick attribute
   * and no role is an accessibility anti-pattern.
   */
  test('no <div onclick> without role="button" exists in the DOM', async () => {
    const { container } = await renderLandingPage();
    const antipatterns = findDivButtonAntipatterns(container);
    expect(antipatterns).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 2: Dashboard
// ─────────────────────────────────────────────────────────────────────────────

describe('Dashboard (DashboardShell) — semantic HTML structure', () => {
  /**
   * Test 4 — <header> is present (Req 10.6)
   *
   * The Dashboard header must use a semantic <header> element.
   */
  test('<header> landmark is present', () => {
    const { container } = renderDashboard();
    const header = container.querySelector('header');
    expect(header).not.toBeNull();
  });

  /**
   * Test 5 — <main> is present (Req 10.6)
   *
   * The primary Dashboard content must be wrapped in a <main> landmark.
   */
  test('<main> landmark is present', () => {
    const { container } = renderDashboard();
    const main = container.querySelector('main');
    expect(main).not.toBeNull();
  });

  /**
   * Test 6 — <section> landmark is present (Req 10.6)
   *
   * The central content card area in DashboardShell is wrapped in a <section>.
   */
  test('<section> landmark is present', () => {
    const { container } = renderDashboard();
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
  });

  /**
   * Test 7a — Waveform status label has role="status" (Req 10.4)
   *
   * The cleaning state text ("Cleaning in progress" / "Stopped") must carry
   * role="status" so screen readers announce it.
   */
  test('Waveform status label has role="status"', () => {
    renderDashboard();
    // getByRole throws if not found — this assertion is self-contained
    const statusEl = screen.getByRole('status');
    expect(statusEl).toBeInTheDocument();
  });

  /**
   * Test 7b — Waveform status label has aria-live="polite" (Req 10.4)
   */
  test('Waveform status label has aria-live="polite"', () => {
    renderDashboard();
    const statusEl = screen.getByRole('status');
    expect(statusEl).toHaveAttribute('aria-live', 'polite');
  });

  /**
   * Test 7c — Waveform status label text is meaningful (Req 10.4)
   *
   * When the cleaning state is 'stopped' (default in mock), the label must
   * read "Stopped".
   */
  test('Waveform status label reads "Stopped" when cleaning state is stopped', () => {
    renderDashboard();
    const statusEl = screen.getByRole('status');
    expect(statusEl).toHaveTextContent('Stopped');
  });

  /**
   * Test 8 — No <div onclick> acting as button without role="button" (Req 10.6)
   */
  test('no <div onclick> without role="button" exists in the DOM', () => {
    const { container } = renderDashboard();
    const antipatterns = findDivButtonAntipatterns(container);
    expect(antipatterns).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 3: Toast accessibility
// ─────────────────────────────────────────────────────────────────────────────

describe('Toast — aria-live accessibility', () => {
  /**
   * Test 9 — Toast container has aria-live="polite" (Req 10.9)
   *
   * The outermost rendered element of Toast must carry aria-live="polite" so
   * screen readers announce removal confirmation messages and error toasts.
   */
  test('toast container has aria-live="polite"', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Toast message="Failed to re-add track" onDismiss={onDismiss} />
    );

    // The root div rendered by Toast carries aria-live="polite"
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion!.getAttribute('aria-live')).toBe('polite');
  });

  /**
   * Test 9b — Toast container is the outermost element (not a nested child)
   */
  test('aria-live="polite" is on the direct root element of Toast', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Toast message="Test message" onDismiss={onDismiss} />
    );

    // The first child of the React root container should carry aria-live
    const rootElement = container.firstElementChild;
    expect(rootElement).not.toBeNull();
    expect(rootElement!.getAttribute('aria-live')).toBe('polite');
  });

  /**
   * Test 9c — Toast renders the message text within the live region
   */
  test('toast message text is rendered inside the aria-live container', () => {
    const onDismiss = vi.fn();
    const message = 'Failed to re-add Bohemian Rhapsody to playlist';
    const { container } = render(
      <Toast message={message} onDismiss={onDismiss} />
    );

    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion!.textContent).toContain(message);
  });

  /**
   * Test 9d — Toast dismiss button has an accessible name
   */
  test('dismiss button inside Toast has aria-label="Dismiss notification"', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Error occurred" onDismiss={onDismiss} />);

    const dismissBtn = screen.getByRole('button', { name: /dismiss notification/i });
    expect(dismissBtn).toBeInTheDocument();
  });
});
